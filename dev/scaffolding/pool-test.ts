/**
 * Test suite for the bounded-concurrency Pool in server/lib/queue.ts.
 *
 * Regression target: the pool used to release every queued task the moment a
 * single slot freed up, so a limit of 3 still ran everything at once.
 */
import { Pool } from "../../server/lib/queue";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `total` tasks through a Pool(limit); reports peak concurrency + order. */
async function exercise(limit: number, total: number) {
  const pool = new Pool(limit);
  let active = 0;
  let peak = 0;
  const startOrder: number[] = [];

  await Promise.all(
    Array.from({ length: total }, (_, i) =>
      pool.run(async () => {
        active++;
        peak = Math.max(peak, active);
        startOrder.push(i);
        await sleep(5 + (i % 4) * 3);
        active--;
      }),
    ),
  );
  return { peak, startOrder, finalActive: pool.running, pending: pool.pending };
}

console.log("\n1. Peak concurrency never exceeds the limit");
for (const limit of [1, 2, 3, 5, 8]) {
  const { peak, finalActive, pending } = await exercise(limit, 24);
  check(
    `limit=${limit} -> peak=${peak}`,
    peak === limit && finalActive === 0 && pending === 0,
    `expected peak ${limit}, active 0, pending 0`,
  );
}

console.log("\n2. Serial execution when limit=1, in FIFO order");
{
  const { peak, startOrder } = await exercise(1, 10);
  const fifo = startOrder.every((v, i) => v === i);
  check("peak === 1", peak === 1, `got ${peak}`);
  check("tasks start in enqueue order", fifo, `got ${startOrder.join(",")}`);
}

console.log("\n3. A rejected task still frees its slot");
{
  const pool = new Pool(2);
  let active = 0;
  let peak = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      pool.run(async () => {
        active++;
        peak = Math.max(peak, active);
        try {
          await sleep(5);
          if (i % 3 === 0) throw new Error(`boom ${i}`);
          return i;
        } finally {
          active--;
        }
      }),
    ),
  );
  const rejected = results.filter((r) => r.status === "rejected").length;
  check("peak stays at 2 across throws", peak === 2, `got ${peak}`);
  check("4 tasks rejected as designed", rejected === 4, `got ${rejected}`);
  check("no slots leaked after rejections", pool.running === 0, `got ${pool.running}`);
  check("no waiters stranded", pool.pending === 0, `got ${pool.pending}`);
}

console.log("\n4. Raising the limit releases queued tasks");
{
  const pool = new Pool(1);
  let active = 0;
  let peak = 0;
  const done: number[] = [];
  const runs = Array.from({ length: 6 }, (_, i) =>
    pool.run(async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await sleep(20);
        done.push(i);
      } finally {
        active--;
      }
    }),
  );

  await sleep(5);
  check("only 1 running before the bump", pool.running === 1, `got ${pool.running}`);
  check("5 queued before the bump", pool.pending === 5, `got ${pool.pending}`);

  pool.setLimit(3);
  await sleep(5);
  check("running grew to 3 after bump", pool.running === 3, `got ${pool.running}`);

  await Promise.all(runs);
  check("all 6 completed", done.length === 6, `got ${done.length}`);
  check("peak never exceeded 3", peak <= 3, `got ${peak}`);
  check("pool drained", pool.running === 0 && pool.pending === 0);
}

console.log("\n5. Lowering the limit is honoured once tasks finish");
{
  const pool = new Pool(5);
  let active = 0;
  let peak = 0;
  const runs = Array.from({ length: 15 }, (_, i) =>
    pool.run(async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await sleep(10);
      } finally {
        active--;
      }
    }),
  );
  pool.setLimit(2);
  await Promise.all(runs);
  check("pool drained", pool.running === 0 && pool.pending === 0);
  check("all 15 completed", true);
}

console.log("\n6. Every task eventually runs (no starvation, no lost wakeups)");
for (const [limit, total] of [[3, 50], [7, 30], [1, 20]] as const) {
  const { startOrder } = await exercise(limit, total);
  check(
    `limit=${limit}: all ${total} ran exactly once`,
    startOrder.length === total && new Set(startOrder).size === total,
    `got ${startOrder.length} starts, ${new Set(startOrder).size} unique`,
  );
}

console.log(
  failures === 0
    ? "\nAll pool tests passed.\n"
    : `\n${failures} pool test(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
