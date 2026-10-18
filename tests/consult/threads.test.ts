import { describe, expect, it } from "vitest";
import {
  createConsultThreads,
  type ConsultThreads,
  type ThreadLease,
  type BeginParams,
} from "../../src/consult/threads.js";
import type { AnchorIdentity } from "../../src/core/types.js";

/**
 * cache-thread plan §4 / R2-1…R2-3: the thread registry state machine. Fully
 * deterministic: injected in-memory fs + clock, no timers, no real files.
 */

const MiB = 1024 * 1024;

function makeEnv(limits?: Parameters<typeof createConsultThreads>[0]["limits"]) {
  const sizes = new Map<string, number>();
  const removed: string[] = [];
  let t = 1_000_000;
  let idSeq = 0;
  const threads = createConsultThreads({
    epoch: "ce_test",
    now: () => t,
    newId: () => `th_${++idSeq}`,
    fs: {
      size: (p) => sizes.get(p),
      remove: (p) => {
        removed.push(p);
        sizes.delete(p);
      },
    },
    ...(limits === undefined ? {} : { limits }),
  });
  return {
    threads,
    sizes,
    removed,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

const ORIGINAL = "/s/expert.jsonl";
const baseIdentity = (): AnchorIdentity => ({
  k: 7,
  block: 0,
  blockType: "text",
  blockHash: "bh",
  prefixHash: "ph",
  systemHash: "sh",
  toolsHash: "th",
  route: { provider: "p", model: "m", api: "anthropic-messages" },
  ttl: "",
});

function params(over: Partial<BeginParams> = {}): BeginParams {
  return { askerRunId: "r_ASK", expertRunId: "r_EXP", originalFile: ORIGINAL, ...over };
}

/** begin → openFork → settle(eligible) → onReaped(disposed:true): a full promoted consult. */
function promote(
  env: ReturnType<typeof makeEnv>,
  forkPath: string,
  over: {
    begin?: Partial<BeginParams>;
    eligible?: boolean;
    tokens?: number;
    base?: AnchorIdentity;
    size?: number;
  } = {},
): ThreadLease {
  env.sizes.set(forkPath, over.size ?? 1 * MiB);
  const lease = env.threads.begin(params(over.begin))!;
  expect(lease).toBeDefined();
  expect(env.threads.openFork(lease, forkPath)).toBe(true);
  env.threads.settle(forkPath, {
    eligible: over.eligible ?? true,
    consultRunId: `r_${forkPath}`,
    tokens: over.tokens ?? 1000,
    ...(over.base === undefined ? {} : { base: over.base }),
  });
  env.threads.finish(lease);
  env.threads.onReaped(forkPath, { disposed: true });
  return lease;
}

function ensureOriginal(env: ReturnType<typeof makeEnv>, size = 2 * MiB): void {
  env.sizes.set(ORIGINAL, size);
}

describe("threads: lease modes", () => {
  it("first consult is a new thread forked from the original, keep:true, seq 1", () => {
    const env = makeEnv();
    ensureOriginal(env);
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "new", seq: 1, retained: 0, keep: true, sourceFile: ORIGINAL });
    expect(lease.base).toBeUndefined();
    expect(lease.head).toBeUndefined();
  });

  it("promotes only after BOTH eligible (settle) and sealed (onReaped disposed:true) — either order", () => {
    for (const order of ["settle-first", "reap-first"] as const) {
      const env = makeEnv();
      ensureOriginal(env);
      env.sizes.set("/f/1", 3 * MiB);
      const lease = env.threads.begin(params())!;
      env.threads.openFork(lease, "/f/1");
      env.threads.finish(lease);
      if (order === "settle-first") {
        env.threads.settle("/f/1", { eligible: true, tokens: 500, base: baseIdentity() });
        expect(env.threads.views()[0]!.headFile).toBeUndefined(); // not sealed yet ⇒ no head
        expect(env.threads.onReaped("/f/1", { disposed: true })).toBe("keep");
      } else {
        expect(env.threads.onReaped("/f/1", { disposed: true })).toBe("keep"); // retained, undecided
        expect(env.threads.views()[0]!.headFile).toBeUndefined();
        env.threads.settle("/f/1", { eligible: true, tokens: 500, base: baseIdentity() });
      }
      const view = env.threads.views()[0]!;
      expect(view.headFile).toBe("/f/1");
      expect(view.seq).toBe(1);
      expect(env.removed).toEqual([]);
      expect(env.threads.isHead("/f/1")).toBe(true);
    }
  });

  it("the next consult continues from the head, sees base (first promotion only), seq 2", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1", { base: baseIdentity() });
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "continued", seq: 2, retained: 1, keep: true, sourceFile: "/f/1" });
    expect(lease.base).toEqual(baseIdentity());
    expect(lease.head?.tokens).toBe(1000);
    env.threads.finish(lease);
  });

  it("promoting #2 deletes the old head and never updates base", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1", { base: baseIdentity() });
    const other = { ...baseIdentity(), prefixHash: "OTHER" };
    promote(env, "/f/2", { base: other });
    expect(env.removed).toEqual(["/f/1"]);
    const lease = env.threads.begin(params())!;
    expect(lease.sourceFile).toBe("/f/2");
    expect(lease.base?.prefixHash).toBe("ph"); // frozen at first promotion
    expect(lease.seq).toBe(3);
  });

  it("an ineligible candidate is deleted once sealed and never becomes the head", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    const before = env.removed.length;
    promote(env, "/f/2", { eligible: false });
    expect(env.removed.slice(before)).toEqual(["/f/2"]);
    expect(env.threads.views()[0]!.headFile).toBe("/f/1");
    expect(env.threads.views()[0]!.seq).toBe(1);
  });

  it("a not-sealed (disposed:false / absent info) candidate is deleted and never adopted (R2-1)", () => {
    for (const info of [{ disposed: false }, undefined]) {
      const env = makeEnv();
      ensureOriginal(env);
      env.sizes.set("/f/1", MiB);
      const lease = env.threads.begin(params())!;
      env.threads.openFork(lease, "/f/1");
      env.threads.settle("/f/1", { eligible: true, tokens: 1 });
      env.threads.finish(lease);
      expect(env.threads.onReaped("/f/1", info)).toBe("delete");
      expect(env.threads.views()[0]!.headFile).toBeUndefined();
      expect(env.threads.stats().forks).toBe(0);
      expect(env.threads.stats().promotions).toBe(0);
    }
  });

  it("a duplicate onReaped on a retained head never deletes it", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    expect(env.threads.onReaped("/f/1", { disposed: true })).toBe("keep");
    expect(env.threads.onReaped("/f/1")).toBe("keep");
    expect(env.threads.isHead("/f/1")).toBe(true);
  });

  it("an unknown path is simply 'delete' (non-thread consults keep the legacy deletion)", () => {
    const env = makeEnv();
    expect(env.threads.onReaped("/f/other", { disposed: true })).toBe("delete");
  });
});

describe("threads: pending / branch / reset / fresh", () => {
  it("while the previous answer is unsealed the next consult is 'pending': source = previous head, never kept", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    env.sizes.set("/f/2", MiB);
    const l2 = env.threads.begin(params())!;
    env.threads.openFork(l2, "/f/2");
    env.threads.settle("/f/2", { eligible: true, tokens: 10 });
    env.threads.finish(l2); // outcome known, session not yet disposed
    const l3 = env.threads.begin(params())!;
    expect(l3).toMatchObject({ mode: "pending", keep: false, sourceFile: "/f/1", retained: 1, seq: 2 });
    env.threads.finish(l3);
    // never copy an unsealed file: the head is still /f/1
    expect(env.threads.views()[0]!.headFile).toBe("/f/1");
  });

  it("a concurrent second consult while the first is in flight is a 'branch' off the head and is never promoted", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    env.sizes.set("/f/2", MiB);
    env.sizes.set("/f/3", MiB);
    const a = env.threads.begin(params())!;
    env.threads.openFork(a, "/f/2");
    const b = env.threads.begin(params())!;
    expect(b).toMatchObject({ mode: "branch", keep: false, sourceFile: "/f/1", retained: 1 });
    env.threads.openFork(b, "/f/3");
    env.threads.settle("/f/3", { eligible: true, tokens: 5 }); // even "eligible", a branch cannot keep
    env.threads.finish(b);
    expect(env.threads.onReaped("/f/3", { disposed: true })).toBe("delete");
    expect(env.threads.views()[0]!.headFile).toBe("/f/1");
    env.threads.settle("/f/2", { eligible: true, tokens: 9 });
    env.threads.finish(a);
    env.threads.onReaped("/f/2", { disposed: true });
    expect(env.threads.views()[0]!.headFile).toBe("/f/2");
    expect(env.threads.views()[0]!.seq).toBe(2);
  });

  it("branch with no head yet reports retained 0 and falls back to the original", () => {
    const env = makeEnv();
    ensureOriginal(env);
    const a = env.threads.begin(params())!;
    const b = env.threads.begin(params())!;
    expect(b).toMatchObject({ mode: "branch", keep: false, sourceFile: ORIGINAL, retained: 0 });
    env.threads.finish(a);
    env.threads.finish(b);
  });

  it("fresh drops the thread (head deleted), starts a new thread id at seq 1 and keeps its answer", () => {
    const env = makeEnv();
    ensureOriginal(env);
    const first = promote(env, "/f/1");
    const lease = env.threads.begin(params({ fresh: true }))!;
    expect(lease.mode).toBe("fresh");
    expect(lease.keep).toBe(true);
    expect(lease.seq).toBe(1);
    expect(lease.threadId).not.toBe(first.threadId);
    expect(lease.sourceFile).toBe(ORIGINAL);
    expect(env.removed).toContain("/f/1");
    env.threads.finish(lease);
  });

  it.each([
    ["context", { headGuard: () => "context" as const }],
    ["cost", { headGuard: () => "cost" as const }],
  ])("reset(%s): thread dropped, forks the original, answer is one-off (not kept)", (reason, extra) => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    const lease = env.threads.begin(params(extra))!;
    expect(lease).toMatchObject({ mode: "reset", reason, keep: false, seq: 1, sourceFile: ORIGINAL });
    expect(env.removed).toContain("/f/1");
    env.threads.finish(lease);
    // the next consult starts a new thread cleanly
    const next = env.threads.begin(params())!;
    expect(next).toMatchObject({ mode: "new", seq: 1, keep: true });
    env.threads.finish(next);
  });

  it("reset(seq-cap) after the eighth promotion", () => {
    const env = makeEnv({ maxPromotions: 3 });
    ensureOriginal(env);
    for (let i = 1; i <= 3; i++) promote(env, `/f/${i}`);
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "reset", reason: "seq-cap", keep: false });
    expect(env.removed).toContain("/f/3");
    env.threads.finish(lease);
  });

  it("reset(identity) when the original session file signature changed or the head vanished", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1", { begin: { sourceKey: "100:1" } });
    const lease = env.threads.begin(params({ sourceKey: "100:2" }))!;
    expect(lease).toMatchObject({ mode: "reset", reason: "identity", keep: false });
    env.threads.finish(lease);

    const env2 = makeEnv();
    ensureOriginal(env2);
    promote(env2, "/f/1");
    env2.sizes.delete("/f/1");
    const l2 = env2.threads.begin(params())!;
    expect(l2).toMatchObject({ mode: "reset", reason: "identity" });
    env2.threads.finish(l2);
    const forced = env2.threads.begin(params({ forceReset: "identity" }))!;
    expect(forced.mode).toBe("reset");
  });

  it("reset(size): oversized head ⇒ reset; oversized ORIGINAL ⇒ untracked one-off (no thread record)", () => {
    const env = makeEnv({ maxSourceBytes: 10 * MiB });
    ensureOriginal(env);
    promote(env, "/f/1", { size: 5 * MiB });
    env.sizes.set("/f/1", 11 * MiB); // grew beyond the cap after promotion
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "reset", reason: "size", keep: false });
    env.threads.finish(lease);

    const env2 = makeEnv({ maxSourceBytes: 10 * MiB });
    env2.sizes.set(ORIGINAL, 11 * MiB);
    const big = env2.threads.begin(params())!;
    expect(big).toMatchObject({ mode: "reset", reason: "size", keep: false });
    expect(env2.threads.views()).toEqual([]);
    env2.threads.finish(big);
  });
});

describe("threads: side leases (branch/pending) run the head admission (follow-up r_38A7HG4K)", () => {
  /** A thread with a promoted head (/f/1) and a keep-writer (/f/2) in flight ⇒ the next begin is a branch. */
  function branchSetup(limits?: Parameters<typeof makeEnv>[0]) {
    const env = makeEnv(limits);
    ensureOriginal(env);
    promote(env, "/f/1", { size: 2 * MiB });
    env.sizes.set("/f/2", MiB);
    const writer = env.threads.begin(params())!;
    env.threads.openFork(writer, "/f/2");
    return { env, writer };
  }

  it.each([
    ["context", { headGuard: () => "context" as const }],
    ["cost", { headGuard: () => "cost" as const }],
  ])(
    "branch over the %s line ⇒ original session + reset(%s), retained 0; the writer's thread survives",
    (reason, extra) => {
      const { env, writer } = branchSetup();
      const lease = env.threads.begin(params(extra))!;
      expect(lease).toMatchObject({ mode: "reset", reason, keep: false, retained: 0, seq: 1, sourceFile: ORIGINAL });
      expect(lease.head).toBeUndefined();
      expect(lease.base).toBeUndefined();
      expect(env.threads.views()).toHaveLength(1);
      expect(env.threads.views()[0]!.headFile).toBe("/f/1"); // head untouched
      env.threads.finish(lease);
      // the writer still promotes normally afterwards
      env.threads.settle("/f/2", { eligible: true, tokens: 1 });
      env.threads.finish(writer);
      env.threads.onReaped("/f/2", { disposed: true });
      expect(env.threads.views()[0]!.headFile).toBe("/f/2");
    },
  );

  it("a branch that passes the guard still forks the head (mode branch, retained = head seq)", () => {
    const { env } = branchSetup();
    const lease = env.threads.begin(params({ headGuard: () => undefined }))!;
    expect(lease).toMatchObject({ mode: "branch", keep: false, retained: 1, seq: 2, sourceFile: "/f/1" });
    env.threads.finish(lease);
  });

  it("branch with the head file gone ⇒ truthful reset(identity) from the original (follow-up #3)", () => {
    const { env } = branchSetup();
    env.sizes.delete("/f/1");
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "reset", reason: "identity", retained: 0, sourceFile: ORIGINAL });
    env.threads.finish(lease);
  });

  it("branch when the original session signature changed ⇒ reset(identity); oversized head ⇒ reset(size)", () => {
    const a = makeEnv();
    ensureOriginal(a);
    promote(a, "/f/1", { begin: { sourceKey: "1:1" } });
    const w = a.threads.begin(params({ sourceKey: "1:1" }))!;
    a.sizes.set("/f/2", MiB);
    a.threads.openFork(w, "/f/2");
    const l = a.threads.begin(params({ sourceKey: "1:2" }))!;
    expect(l).toMatchObject({ mode: "reset", reason: "identity" });

    const { env } = branchSetup({ maxSourceBytes: 10 * MiB });
    env.sizes.set("/f/1", 11 * MiB);
    const big = env.threads.begin(params())!;
    expect(big).toMatchObject({ mode: "reset", reason: "size", sourceFile: ORIGINAL });
  });

  it("branch with no head yet stays an honest branch with retained 0 from the original (no fake reset)", () => {
    const env = makeEnv();
    ensureOriginal(env);
    const writer = env.threads.begin(params())!;
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "branch", retained: 0, seq: 1, sourceFile: ORIGINAL });
    expect(lease.reason).toBeUndefined();
    env.threads.finish(lease);
    env.threads.finish(writer);
  });

  it("pending runs the head budget pre-check: over budget ⇒ original session + reset(budget) (follow-up #4)", () => {
    const env = makeEnv({ budgetBytes: 9 * MiB });
    ensureOriginal(env, 1 * MiB);
    promote(env, "/f/1", { size: 4 * MiB });
    // #2 finished (settled) but not sealed ⇒ candidate pending; its 3 MiB copy + head 4 MiB (+4 MiB reserved for the writer) already fill 9 MiB
    env.sizes.set("/f/2", 3 * MiB);
    const writer = env.threads.begin(params())!;
    env.threads.openFork(writer, "/f/2");
    env.threads.settle("/f/2", { eligible: true, tokens: 1 });
    env.threads.finish(writer);
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "reset", reason: "budget", keep: false, retained: 0, sourceFile: ORIGINAL });
    env.threads.finish(lease);
  });

  it("pending with no head and a fitting original keeps the honest pending form (retained 0)", () => {
    const env = makeEnv();
    ensureOriginal(env);
    env.sizes.set("/f/1", MiB);
    const writer = env.threads.begin(params())!;
    env.threads.openFork(writer, "/f/1");
    env.threads.settle("/f/1", { eligible: true, tokens: 1 });
    env.threads.finish(writer);
    const lease = env.threads.begin(params())!;
    expect(lease).toMatchObject({ mode: "pending", retained: 0, seq: 1, keep: false, sourceFile: ORIGINAL });
    env.threads.finish(lease);
  });

  it("side leases never create or drop thread records (no gen bump on the writer's thread)", () => {
    const { env, writer } = branchSetup();
    const gen = env.threads.views()[0]!.gen;
    const l = env.threads.begin(params({ headGuard: () => "context" }))!;
    env.threads.finish(l);
    expect(env.threads.views()[0]!.gen).toBe(gen);
    env.threads.finish(writer);
  });
});

describe("threads: generation fence + epoch + close (R2-2, §4.3)", () => {
  it("asker terminal closes the thread: a late sealed+eligible result only deletes, never revives it", () => {
    const env = makeEnv();
    ensureOriginal(env);
    env.sizes.set("/f/1", MiB);
    const lease = env.threads.begin(params())!;
    env.threads.openFork(lease, "/f/1");
    env.threads.onRunTerminal("r_ASK");
    expect(env.threads.views()).toEqual([]);
    env.threads.settle("/f/1", { eligible: true, tokens: 1 });
    env.threads.finish(lease);
    expect(env.threads.onReaped("/f/1", { disposed: true })).toBe("delete");
    expect(env.threads.views()).toEqual([]);
    expect(env.threads.stats().promotions).toBe(0);
  });

  it("a result arriving after fresh / reset / FIFO eviction cannot promote into the NEW generation", () => {
    const env = makeEnv({ maxThreads: 1 });
    ensureOriginal(env);
    env.sizes.set("/f/old", MiB);
    const old = env.threads.begin(params())!;
    env.threads.openFork(old, "/f/old");
    // fresh while the old consult is still running: old thread dropped
    env.threads.finish(old);
    const fresh = env.threads.begin(params({ fresh: true }))!;
    env.sizes.set("/f/new", MiB);
    env.threads.openFork(fresh, "/f/new");
    env.threads.settle("/f/old", { eligible: true, tokens: 1 });
    expect(env.threads.onReaped("/f/old", { disposed: true })).toBe("delete");
    expect(env.threads.views()[0]!.headFile).toBeUndefined();
    env.threads.settle("/f/new", { eligible: true, tokens: 2 });
    env.threads.finish(fresh);
    expect(env.threads.onReaped("/f/new", { disposed: true })).toBe("keep");
    expect(env.threads.views()[0]!.headFile).toBe("/f/new");

    // FIFO eviction: a different (asker, expert) pair at maxThreads=1 evicts the first thread
    const other = env.threads.begin(params({ askerRunId: "r_OTHER" }))!;
    expect(env.threads.views().map((v) => v.askerRunId)).toEqual(["r_OTHER"]);
    expect(env.removed).toContain("/f/new");
    env.threads.finish(other);
  });

  it("interleavings: abort / dispose / eviction / success in every order leave exactly one consistent state", () => {
    const events = ["settle", "reap", "terminal"] as const;
    const perms: Array<readonly (typeof events)[number][]> = [];
    const permute = (rest: readonly (typeof events)[number][], acc: (typeof events)[number][]): void => {
      if (rest.length === 0) {
        perms.push(acc);
        return;
      }
      rest.forEach((e, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, e]));
    };
    permute(events, []);
    expect(perms).toHaveLength(6);
    for (const perm of perms) {
      const env = makeEnv();
      ensureOriginal(env);
      env.sizes.set("/f/1", MiB);
      const lease = env.threads.begin(params())!;
      env.threads.openFork(lease, "/f/1");
      env.threads.finish(lease);
      for (const e of perm) {
        if (e === "settle") env.threads.settle("/f/1", { eligible: true, tokens: 7 });
        if (e === "reap") env.threads.onReaped("/f/1", { disposed: true });
        if (e === "terminal") env.threads.onRunTerminal("r_ASK");
      }
      const terminalFirst =
        perm.indexOf("terminal") < perm.indexOf("settle") || perm.indexOf("terminal") < perm.indexOf("reap");
      const view = env.threads.views()[0];
      if (terminalFirst) {
        expect(view).toBeUndefined();
        expect(env.threads.stats().promotions).toBe(0);
      } else {
        // terminal came last: thread dropped after promotion ⇒ head deleted
        expect(view).toBeUndefined();
      }
      // no leaked in-flight record in any order
      expect(env.threads.stats().forks).toBe(0);
      expect(env.threads.stats().usedBytes).toBe(0);
    }
  });

  it("close() deletes heads and reaped candidates; late onReaped after close only deletes (epoch fence)", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    env.sizes.set("/f/2", MiB);
    const lease = env.threads.begin(params())!;
    env.threads.openFork(lease, "/f/2"); // in flight, not reaped
    env.threads.close();
    expect(env.removed).toContain("/f/1");
    expect(env.removed).not.toContain("/f/2"); // never before its session is gone
    expect(env.threads.stats().closed).toBe(true);
    // late result on the closed registry
    env.threads.settle("/f/2", { eligible: true, tokens: 1 });
    expect(env.threads.onReaped("/f/2", { disposed: true })).toBe("delete");
    expect(env.threads.views()).toEqual([]);
    expect(env.threads.begin(params())).toBeUndefined();
    expect(env.threads.openFork(lease, "/f/9")).toBe(false);
    env.threads.close(); // idempotent
  });

  it("two registries have independent epochs: a stale registry's callback cannot touch the new one's heads", () => {
    const a = makeEnv();
    const b = makeEnv();
    ensureOriginal(a);
    ensureOriginal(b);
    promote(a, "/f/shared");
    a.threads.close();
    promote(b, "/f/b");
    expect(a.threads.onReaped("/f/b", { disposed: true })).toBe("delete"); // unknown to the stale registry
    expect(b.threads.isHead("/f/b")).toBe(true);
  });
});

describe("threads: disk accounting (R2-3, §4.4)", () => {
  it("budget counts heads AND in-flight forks, including ones still growing; eviction reclaims idle LRU heads", () => {
    const env = makeEnv({ budgetBytes: 10 * MiB });
    ensureOriginal(env, 1 * MiB);
    // thread A (asker r_A): head 4 MiB
    promote(env, "/f/a", { begin: { askerRunId: "r_A" }, size: 4 * MiB });
    env.advance(1000);
    // thread B: head 4 MiB
    promote(env, "/f/b", { begin: { askerRunId: "r_B" }, size: 4 * MiB });
    expect(env.threads.stats().usedBytes).toBe(8 * MiB);
    // thread C starts a fork that GROWS beyond its reservation
    const c = env.threads.begin(params({ askerRunId: "r_C" }))!;
    env.sizes.set("/f/c", 1 * MiB);
    env.threads.openFork(c, "/f/c");
    env.sizes.set("/f/c", 5 * MiB); // grew: 8 + 5 = 13 MiB > 10 MiB budget
    expect(env.threads.stats().usedBytes).toBe(13 * MiB);
    // a new thread D needs room ⇒ evicts the LRU idle head (A), then B
    env.sizes.set(ORIGINAL, 3 * MiB);
    const d = env.threads.begin(params({ askerRunId: "r_D" }))!;
    expect(env.removed).toContain("/f/a");
    expect(d.mode).toBe("new");
    env.threads.finish(c);
    env.threads.finish(d);
  });

  it("promotion re-stats the real size: oversized-at-seal ⇒ not adopted, file deleted, old head kept", () => {
    const env = makeEnv({ maxSourceBytes: 10 * MiB });
    ensureOriginal(env);
    promote(env, "/f/1", { size: 2 * MiB });
    env.sizes.set("/f/2", 3 * MiB);
    const lease = env.threads.begin(params())!;
    env.threads.openFork(lease, "/f/2");
    env.threads.settle("/f/2", { eligible: true, tokens: 1 });
    env.threads.finish(lease);
    env.sizes.set("/f/2", 11 * MiB); // the consult kept appending until dispose
    expect(env.threads.onReaped("/f/2", { disposed: true })).toBe("delete");
    expect(env.threads.views()[0]!.headFile).toBe("/f/1");
    expect(env.threads.stats().refusedAdoptions).toBe(1);
  });

  it("promotion refused when the budget cannot fit even after evicting idle heads of other threads", () => {
    const env = makeEnv({ budgetBytes: 10 * MiB });
    ensureOriginal(env, 1 * MiB);
    promote(env, "/f/1", { size: 2 * MiB });
    env.sizes.set("/f/2", 2 * MiB);
    const lease = env.threads.begin(params())!;
    env.threads.openFork(lease, "/f/2");
    env.threads.settle("/f/2", { eligible: true, tokens: 1 });
    env.threads.finish(lease);
    // afterwards another thread's consult is in flight and holds 9 MiB (busy ⇒ not evictable)
    const other = env.threads.begin(params({ askerRunId: "r_O" }))!;
    env.sizes.set("/f/o", 9 * MiB);
    env.threads.openFork(other, "/f/o");
    expect(env.threads.onReaped("/f/2", { disposed: true })).toBe("delete");
    expect(env.threads.stats().refusedAdoptions).toBe(1);
    expect(env.threads.views().find((v) => v.askerRunId === "r_ASK")!.headFile).toBe("/f/1");
    env.threads.finish(other);
  });

  it("budget exhaustion on a new thread degrades to reset(budget) one-off", () => {
    const env = makeEnv({ budgetBytes: 4 * MiB });
    ensureOriginal(env, 3 * MiB);
    const busy = env.threads.begin(params({ askerRunId: "r_BUSY" }))!; // reserves 3 MiB, busy
    const lease = env.threads.begin(params({ askerRunId: "r_NEW" }))!;
    expect(lease).toMatchObject({ mode: "reset", reason: "budget", keep: false });
    env.threads.finish(busy);
    env.threads.finish(lease);
  });

  it("at most maxThreads threads: the stalest idle one is evicted first (heads deleted)", () => {
    const env = makeEnv({ maxThreads: 2 });
    ensureOriginal(env);
    promote(env, "/f/a", { begin: { askerRunId: "r_A" } });
    env.advance(10);
    promote(env, "/f/b", { begin: { askerRunId: "r_B" } });
    env.advance(10);
    const c = env.threads.begin(params({ askerRunId: "r_C" }))!;
    expect(
      env.threads
        .views()
        .map((v) => v.askerRunId)
        .sort(),
    ).toEqual(["r_B", "r_C"]);
    expect(env.removed).toContain("/f/a");
    env.threads.finish(c);
  });
});

describe("threads: soft idle TTL, lazily checked (§4.4)", () => {
  it("drops an idle thread at consult entry once idle > 60 min; no timer exists", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    env.advance(59 * 60 * 1000);
    env.threads.sweepIdle();
    expect(env.threads.views()).toHaveLength(1);
    env.advance(2 * 60 * 1000);
    // checkpoint 1: consult entry
    const lease = env.threads.begin(params())!;
    expect(lease.mode).toBe("new");
    expect(env.removed).toContain("/f/1");
    env.threads.finish(lease);
  });

  it("checkpoint 2: a terminal snapshot of ANY run sweeps; checkpoint 3: close()", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    env.advance(61 * 60 * 1000);
    env.threads.onRunTerminal("r_unrelated");
    expect(env.threads.views()).toEqual([]);
    expect(env.removed).toContain("/f/1");

    const env2 = makeEnv();
    ensureOriginal(env2);
    promote(env2, "/f/1");
    env2.threads.close();
    expect(env2.removed).toContain("/f/1");
  });

  it("without any checkpoint an idle head simply stays (disclosed lazy behaviour)", () => {
    const env = makeEnv();
    ensureOriginal(env);
    promote(env, "/f/1");
    env.advance(5 * 60 * 60 * 1000);
    expect(env.threads.views()[0]!.headFile).toBe("/f/1");
    expect(env.removed).toEqual([]);
  });
});

describe("threads: type surface", () => {
  it("exposes only closure-state operations (no module-scope state: two instances are independent)", () => {
    const x: ConsultThreads = makeEnv().threads;
    const y: ConsultThreads = makeEnv().threads;
    expect(x).not.toBe(y);
    expect(x.stats()).toEqual(y.stats());
  });
});
