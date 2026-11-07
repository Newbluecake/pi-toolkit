import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKdfUpgrader, type KdfUpgrader } from "../../../src/web-hub/hub/kdf-upgrade.js";
import { createKdf, KDF_LEGACY, KDF_PHASE2 } from "../../../src/web-hub/hub/kdf.js";
import type {
  KdfParams,
  LanUserRecord,
  PasswordRehashInput,
  PasswordRehashResult,
  PortOptions,
} from "../../../src/web-hub/hub/ports.js";
import { memLog } from "./helpers.js";

function latch<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const user = (id = 1): LanUserRecord => ({
  id,
  username: "secret-user",
  kdf: "scrypt",
  ...KDF_LEGACY,
  salt: new Uint8Array(16).fill(19),
  hash: new Uint8Array(32).fill(23),
  epoch: 7,
  createdAt: 1,
  updatedAt: 2,
});
const jobs: KdfUpgrader[] = [];
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function setup() {
  const log = memLog();
  const run = vi.fn(async (_password: string, _params: KdfParams, _opts?: PortOptions) => new Uint8Array(32).fill(31));
  const rehashPassword = vi.fn(
    async (_input: PasswordRehashInput, _opts?: PortOptions): Promise<PasswordRehashResult> => ({ ok: true }),
  );
  const deps = { kdf: { run }, store: { rehashPassword }, log, now: Date.now, target: KDF_PHASE2 };
  return { deps, run, rehashPassword, log };
}
function make(deps: Parameters<typeof createKdfUpgrader>[0]) {
  const job = createKdfUpgrader(deps);
  jobs.push(job);
  return job;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  jobs.splice(0).forEach((job) => job.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#66 P2 bounded KDF upgrader", () => {
  it("defers KDF, uses fresh salt/target, snapshots CAS bytes without epoch and never calls setPassword", async () => {
    const h = setup(),
      job = make(h.deps),
      record = user();
    job.maybeRehash(record, "plaintext-secret");
    expect(h.run).not.toHaveBeenCalled();
    record.salt.fill(99);
    record.hash.fill(99);
    record.epoch++;
    await flush();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0]![1]).toMatchObject({ n: 131072, r: 8, p: 1, keyLen: 32 });
    const call = h.rehashPassword.mock.calls[0]![0];
    expect(call).toMatchObject({
      userId: 1,
      old: { salt: new Uint8Array(16).fill(19), hash: new Uint8Array(32).fill(23) },
    });
    expect(call).not.toHaveProperty("epoch");
    expect(call.next.salt).not.toEqual(new Uint8Array(16).fill(19));
    expect(h.log.lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops concurrent same-user and different-user work, without retaining a queue", async () => {
    const h = setup(),
      gate = latch<Uint8Array>();
    h.run.mockReturnValueOnce(gate.promise);
    const job = make(h.deps);
    for (let i = 0; i < 1000; i++) job.maybeRehash(user(i % 256), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(1);
    gate.resolve(new Uint8Array(32));
    await flush();
    expect(h.rehashPassword).toHaveBeenCalledTimes(1);
    job.maybeRehash(user(2), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("skips equal/stronger, corrupt records and stores without the optional op", async () => {
    const h = setup(),
      job = make(h.deps);
    job.maybeRehash({ ...user(), ...KDF_PHASE2 }, "secret");
    job.maybeRehash({ ...user(), n: 65536, p: 2 }, "secret");
    job.maybeRehash({ ...user(), n: 262144 }, "secret");
    make({ ...h.deps, store: {} }).maybeRehash(user(), "secret");
    await flush();
    expect(h.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries only at the five-minute boundary; errors never leak input or raw error payload", async () => {
    const h = setup();
    h.run.mockRejectedValue(new Error("plaintext-secret salt hash secret-user"));
    const job = make(h.deps);
    job.maybeRehash(user(), "plaintext-secret");
    await flush();
    vi.advanceTimersByTime(299999);
    job.maybeRehash(user(), "plaintext-secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    job.maybeRehash(user(), "plaintext-secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.log.lines).toHaveLength(2);
    for (const line of h.log.lines) {
      expect(line.data).toEqual({ userId: 1, fromCost: 262144, toCost: 1048576, code: "E_REHASH" });
      expect(JSON.stringify(line)).not.toMatch(/plaintext-secret|salt|hash|secret-user/);
    }
  });

  it("caps cooldown at 256, evicts oldest and clears expired entries", async () => {
    const h = setup();
    h.run.mockRejectedValue(new Error("failure"));
    const job = make(h.deps);
    for (let id = 1; id <= 257; id++) {
      job.maybeRehash(user(id), "secret");
      await flush();
    }
    expect(h.run).toHaveBeenCalledTimes(257);
    job.maybeRehash(user(2), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(257);
    job.maybeRehash(user(1), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(258);
    vi.advanceTimersByTime(300000);
    job.maybeRehash(user(257), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(259);
  });

  it("deadline aborts and logs once; an abort-ignoring KDF is quarantined and can never late-write", async () => {
    const h = setup(),
      gate = latch<Uint8Array>();
    h.run.mockReturnValueOnce(gate.promise);
    const job = make(h.deps);
    job.maybeRehash(user(), "secret");
    await flush();
    vi.advanceTimersByTime(20000);
    expect(h.run.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    expect(h.log.lines).toHaveLength(1);
    expect(h.log.lines[0]!.data).toMatchObject({ code: "E_DEADLINE" });
    job.maybeRehash(user(2), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(1);
    gate.resolve(new Uint8Array(32));
    await flush();
    expect(h.rehashPassword).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    job.maybeRehash(user(2), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("dispose aborts, clears timers, suppresses late writes and disables new work", async () => {
    const h = setup(),
      gate = latch<Uint8Array>();
    h.run.mockReturnValueOnce(gate.promise);
    const job = make(h.deps);
    job.maybeRehash(user(), "secret");
    await flush();
    job.dispose();
    job.dispose();
    expect(h.run.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve(new Uint8Array(32));
    await flush();
    job.maybeRehash(user(2), "secret");
    await flush();
    expect(h.rehashPassword).not.toHaveBeenCalled();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.log.lines).toEqual([]);
  });

  it.each(["invalid", "throw", "stale", "deadline"])("bounds DB failure: %s", async (kind) => {
    const h = setup(),
      gate = latch<{ ok: true }>();
    if (kind === "invalid") h.run.mockResolvedValue(new Uint8Array(31));
    if (kind === "throw") h.rehashPassword.mockRejectedValue(new Error("secret salt hash"));
    if (kind === "stale") h.rehashPassword.mockResolvedValue({ ok: false, reason: "stale" });
    if (kind === "deadline") h.rehashPassword.mockReturnValue(gate.promise);
    const job = make(h.deps);
    job.maybeRehash(user(), "secret");
    await flush();
    if (kind === "deadline") {
      vi.advanceTimersByTime(20000);
      gate.resolve({ ok: true });
      await flush();
    }
    expect(h.log.lines).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    job.maybeRehash(user(), "secret");
    await flush();
    expect(h.run).toHaveBeenCalledTimes(1);
    if (kind === "invalid") expect(h.rehashPassword).not.toHaveBeenCalled();
  });

  it("uses one unref'd timer and promptly returns KDF logical in-flight to zero on abort", async () => {
    vi.useRealTimers();
    const h = setup();
    let inFlight = 0,
      complete!: () => void;
    const physical = createKdf({
      scrypt: (_pw, _salt, _len, _opts, cb) => {
        complete = () => cb(null, Buffer.alloc(32));
      },
    });
    const run = vi.fn(async (pw: string, params: KdfParams, opts?: PortOptions) => {
      inFlight++;
      try {
        return await physical.run(pw, params, opts);
      } finally {
        inFlight--;
      }
    });
    const timers: Array<ReturnType<typeof setTimeout>> = [],
      realTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = realTimer(...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    const job = make({ ...h.deps, kdf: { run } });
    job.maybeRehash(user(), "secret");
    await flush();
    expect(inFlight).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.hasRef()).toBe(false);
    job.dispose();
    await flush();
    expect(inFlight).toBe(0);
    complete();
    await flush();
    expect(h.rehashPassword).not.toHaveBeenCalled();
  });
});

it("#66 P2 unfinished upgrade cannot keep a real Node process alive (unref deadline)", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { createKdfUpgrader } from ${JSON.stringify(new URL("../../../src/web-hub/hub/kdf-upgrade.ts", import.meta.url).href)};
    const job = createKdfUpgrader({ kdf: { run: () => new Promise(() => {}) }, store: { rehashPassword: () => { throw Error('late write'); } },
      log: { warn: () => { throw Error('deadline kept process alive'); } }, now: Date.now,
      target: { n: 131072, r: 8, p: 1, keyLen: 32, saltBytes: 16 } });
    job.maybeRehash({ id: 1, kdf: 'scrypt', n: 32768, r: 8, p: 1, salt: new Uint8Array(16), hash: new Uint8Array(32), epoch: 1 }, 'temporary-test-password');
    await Promise.resolve();
    process.stdout.write('scheduled\\n');
  `,
    ],
    { timeout: 5000 },
  );
  expect(stdout.trim()).toBe("scheduled");
});
