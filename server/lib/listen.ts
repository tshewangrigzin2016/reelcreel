export const serverAddress = {
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
};

export function startupError(error: unknown): string {
  if ((error as { code?: string } | null)?.code === "EADDRINUSE") {
    return `API port ${serverAddress.port} is already in use. Stop the existing app with Ctrl+C in its terminal before running bun dev again, or choose a different PORT (and YTD_DATA_DIR for a separate instance).`;
  }
  return error instanceof Error ? error.message : String(error);
}
