import { serverAddress, startupError } from "./lib/listen";

// Run outside watch mode: Bun keeps watching after a startup crash, which
// otherwise leaves Vite running against an older, unrelated API process.
try {
  const reservation = Bun.serve({
    ...serverAddress,
    fetch: () => new Response(null, { status: 503 }),
  });
  await reservation.stop(true);
} catch (error) {
  console.error(startupError(error));
  process.exit(1);
}
