/**
 * Race-free "free port" allocator for tests that must pre-reserve a FIXED port (the hub's
 * LAN listener keys its host allow-list on the CONFIGURED port, so `port: 0` is not an
 * option there) or a fixed contiguous port range (the port-proxy suites).
 *
 * Why not `listen(0)` → read port → `close()` → re-bind later: the port `listen(0)` hands
 * out comes from the kernel's ephemeral range (`ip_local_port_range`, 32768-60999 on
 * Linux/CI), so between our `close()` and the real bind ANY parallel vitest worker's
 * `listen(0)` or outbound `connect()` can be given the same port — the CI flake
 * `listen EADDRINUSE … 0.0.0.0:43503` in lan-rollout & friends.
 *
 * This helper instead:
 *  - allocates from BELOW the ephemeral range (the kernel never auto-assigns those), and
 *    clear of the product's own defaults (webHub.port 7878, proxy range 7900-7949);
 *  - partitions that region into per-vitest-worker blocks (`VITEST_POOL_ID`, falling back
 *    to `VITEST_WORKER_ID`, then `process.pid`) so parallel workers of one run never share
 *    candidates;
 *  - probes every candidate by ACTUALLY binding it (127.0.0.1 and 0.0.0.0 — the LAN
 *    listener binds 0.0.0.0) and closing before returning it, skipping failures;
 *  - never returns the same port twice in one process until the worker's block wraps.
 */
import { createServer } from "node:net";

/** Allocation region: below Linux's default ephemeral floor (32768), above the product
 * defaults (7878 / 7900-7949) and common dev-service ports. */
const REGION_MIN = 10_000;
const REGION_MAX = 32_000; // exclusive

/** Fixed worker partition count; `VITEST_POOL_ID % WORKER_BLOCKS` picks a worker's block. */
const WORKER_BLOCKS = 16;
const BLOCK_SIZE = Math.floor((REGION_MAX - REGION_MIN) / WORKER_BLOCKS);

function workerSlot(): number {
  const raw = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? (n - 1) % WORKER_BLOCKS : process.pid % WORKER_BLOCKS;
}

const BLOCK_START = REGION_MIN + workerSlot() * BLOCK_SIZE;
const BLOCK_END = BLOCK_START + BLOCK_SIZE; // exclusive

// The cursor walks this worker's block. The pid offset decorrelates same-slot workers of
// separate concurrent `vitest run` invocations (which share pool ids).
let cursor = BLOCK_START + (process.pid % BLOCK_SIZE);
const lapStart = cursor;
const returned = new Set<number>();

function nextCandidate(): number {
  const p = cursor;
  cursor = cursor + 1 >= BLOCK_END ? BLOCK_START : cursor + 1;
  if (cursor === lapStart) returned.clear(); // full lap: ports may be handed out again
  return p;
}

/** Bind-probe one port on 127.0.0.1 AND 0.0.0.0; both must succeed (closed afterwards). */
async function probe(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "0.0.0.0"] as const) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => {
        srv.close(() => resolve(true));
      });
      srv.listen(port, host);
    });
    if (!ok) return false;
  }
  return true;
}

/** A bindable fixed port from this worker's block (never repeated until the block wraps). */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < BLOCK_SIZE; attempt++) {
    const candidate = nextCandidate();
    if (returned.has(candidate)) continue;
    if (await probe(candidate)) {
      returned.add(candidate);
      return candidate;
    }
  }
  throw new Error(`freePort: no bindable port left in worker block [${BLOCK_START}, ${BLOCK_END})`);
}

/** `n` contiguous bindable ports from this worker's block, returned as `[base, last]`
 * (inclusive). All n ports are probe-bound before the range is returned. */
export async function freePortRange(n: number): Promise<[number, number]> {
  if (!Number.isInteger(n) || n < 1 || n > BLOCK_SIZE) {
    throw new RangeError(`freePortRange: n must be an integer in [1, ${BLOCK_SIZE}], got ${n}`);
  }
  for (let attempt = 0; attempt < BLOCK_SIZE; attempt++) {
    const base = nextCandidate();
    if (base + n > BLOCK_END) continue; // the whole range must fit inside the worker's block
    let taken = false;
    for (let p = base; p < base + n; p++) {
      if (returned.has(p)) {
        taken = true;
        break;
      }
    }
    if (taken) continue;
    let allFree = true;
    for (let p = base; p < base + n; p++) {
      if (!(await probe(p))) {
        allFree = false;
        break;
      }
    }
    if (!allFree) continue;
    for (let p = base; p < base + n; p++) returned.add(p);
    return [base, base + n - 1];
  }
  throw new Error(`freePortRange: no ${n}-port run left in worker block [${BLOCK_START}, ${BLOCK_END})`);
}
