import {
  makeSubject,
  share,
  pipe,
  merge,
  filter,
  fromValue,
  delay,
  mergeMap,
  takeUntil,
} from 'wonka';
import {
  Exchange,
  Operation,
  CombinedError,
  OperationResult,
} from '@urql/core';
import { sourceT } from 'wonka/dist/types/src/Wonka_types.gen';

interface RetryExchangeOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  randomDelay?: boolean;
  maxNumberAttempts?: number;
  /** Conditionally determine whether an error should be retried */
  retryIf?: (e: CombinedError) => boolean;
}

export const retryExchange = ({
  initialDelayMs,
  maxDelayMs,
  randomDelay,
  maxNumberAttempts,
  retryIf: retryIfOption,
}: RetryExchangeOptions): Exchange => {
  const MIN_DELAY = initialDelayMs || 1000;
  const MAX_DELAY = maxDelayMs || 15000;
  const MAX_ATTEMPTS = maxNumberAttempts || 2;
  const RANDOM_DELAY = randomDelay || true;

  const retryIf =
    retryIfOption || ((err: CombinedError) => err && err.networkError);

  return ({ forward, dispatchDebug }) => ops$ => {
    const sharedOps$ = pipe(ops$, share);
    const { source: retry$, next: nextRetryOperation } = makeSubject<
      Operation
    >();

    const retryWithBackoff$ = pipe(
      retry$,
      mergeMap((op: Operation) => {
        const { key, context } = op;
        const retryCount = (context.retryCount || 0) + 1;
        let delayAmount = context.retryDelay || MIN_DELAY;

        const backoffFactor = Math.random() + 1.5;
        // if randomDelay is enabled and it won't exceed the max delay, apply a random
        // amount to the delay to avoid thundering herd problem
        if (RANDOM_DELAY && delayAmount * backoffFactor < MAX_DELAY) {
          delayAmount *= backoffFactor;
        }

        // We stop the retries if a teardown event for this operation comes in
        // But if this event comes through regularly we also stop the retries, since it's
        // basically the query retrying itself, no backoff should be added!
        const teardown$ = pipe(
          sharedOps$,
          filter(op => {
            return (
              (op.operationName === 'query' ||
                op.operationName === 'teardown') &&
              op.key === key
            );
          })
        );

        dispatchDebug({
          type: 'retryAttempt',
          message: `The operation has failed and a retry has been triggered (${retryCount} / ${MAX_ATTEMPTS})`,
          operation: op,
          data: {
            retryCount,
          },
        });

        // Add new retryDelay and retryCount to operation
        return pipe(
          fromValue({
            ...op,
            context: {
              ...op.context,
              retryDelay: delayAmount,
              retryCount,
            },
          }),
          delay(delayAmount),
          // Stop retry if a teardown comes in
          takeUntil(teardown$)
        );
      })
    );

    const result$ = pipe(
      merge([sharedOps$, retryWithBackoff$]),
      forward,
      share,
      filter(res => {
        // Only retry if the error passes the conditional retryIf function (if passed)
        // or if the error contains a networkError
        if (!res.error || !retryIf(res.error)) {
          return true;
        }

        const maxNumberAttemptsExceeded =
          (res.operation.context.retryCount || 0) >= MAX_ATTEMPTS - 1;

        if (!maxNumberAttemptsExceeded) {
          // Send failed responses to be retried by calling next on the retry$ subject
          // Exclude operations that have been retried more than the specified max
          nextRetryOperation(res.operation);
          return false;
        }

        dispatchDebug({
          type: 'retryExhausted',
          message:
            'Maximum number of retries has been reached. No further retries will be performed.',
          operation: res.operation,
        });

        return true;
      })
    ) as sourceT<OperationResult>;

    return result$;
  };
};
