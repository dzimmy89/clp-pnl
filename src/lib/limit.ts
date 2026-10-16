/** Minimal concurrency limiter so bursts of RPC calls stay within provider limits. */
export function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
  };
}

/** Shared limiter for history reads (logs, receipts, blocks, archive calls). */
export const rpcLimit = createLimiter(6);
