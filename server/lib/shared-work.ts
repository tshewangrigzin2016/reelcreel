export class SharedWork<T> {
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<T>; users: number }
  >();
  run(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      const next = {
        controller,
        promise: Promise.resolve().then(() => work(controller.signal)),
        users: 0,
      };
      entry = next;
      this.pending.set(key, next);
      void next.promise
        .finally(() => {
          if (this.pending.get(key) === next) this.pending.delete(key);
        })
        .catch(() => {});
    }
    const current = entry;
    current.users++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        if (--current.users === 0) current.controller.abort();
        return true;
      };
      const abort = () => {
        if (finish()) reject(signal?.reason ?? new Error("Cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      current.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }
}
