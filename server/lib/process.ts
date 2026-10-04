import type { Subprocess } from "bun";
export interface ProcessOptions {
  argv: string[];
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: (line: string) => void;
  onErrLine?: (line: string) => void;
}
export function managedProcess(opts: ProcessOptions) {
  opts.signal?.throwIfAborted();
  const proc = Bun.spawn(opts.argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: opts.cwd,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let stderr = "",
    stopped = false,
    stopReason = "";
  let releaseStop!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const read = async (
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ) => {
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, i).trim());
          buffer = buffer.slice(i + 1);
        }
        if (buffer.length > 8_000_000)
          throw new Error("Process output exceeded the line limit.");
      }
      buffer += decoder.decode();
      if (buffer.trim()) onLine(buffer.trim());
    } finally {
      reader.releaseLock();
    }
  };
  let cancelPromise: Promise<void> | undefined;
  const cancel = (): Promise<void> =>
    (cancelPromise ??= (async () => {
      stopped = true;
      // Kill the Windows tree before its parent disappears, including ffmpeg children.
      if (process.platform === "win32" && proc.exitCode === null) {
        try {
          const kill = Bun.spawn(
            ["taskkill", "/pid", String(proc.pid), "/t", "/f"],
            { stdout: "ignore", stderr: "ignore", timeout: 3000 },
          );
          await kill.exited;
        } catch {}
      }
      try {
        proc.kill("SIGKILL");
      } catch {}
      await Promise.allSettled(readers.map((reader) => reader.cancel()));
      releaseStop();
    })());
  const onAbort = () => {
    stopReason = "Process cancelled.";
    void cancel();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        stopReason = "Process timed out after " + opts.timeoutMs + "ms.";
        void cancel();
      }, opts.timeoutMs)
    : undefined;
  const streams = Promise.all([
    read(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      if (!stopped) opts.onLine?.(line);
    }),
    read(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      stderr = (stderr + line + "\n").slice(-64000);
      if (!stopped) opts.onErrLine?.(line);
    }),
  ]);
  const done = (async () => {
    try {
      const result = await Promise.race([
        Promise.all([streams, proc.exited]).then(([, code]) => code),
        stoppedPromise.then(() => -1),
      ]);
      return stopped ? -1 : result;
    } catch (error) {
      await cancel();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  })();
  return {
    proc: proc as Subprocess,
    done,
    cancel,
    stderrText: () => (stderr + stopReason).slice(-64000),
  };
}
