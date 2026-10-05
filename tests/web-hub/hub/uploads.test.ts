/**
 * web-hub-upload plan §包 U2: `hub/uploads.ts` — the UploadStore state machine.
 *
 * Covers the regular acceptance list of plan §6-U2 (sequential write + commit, permissions,
 * idempotency, three-level + principal quotas, principal-scoped dedup, reference TTL semantics,
 * unref'd timers) and the six **hard gates** (#16):
 *   1. symlink (#3), 2. no-replace commit (v3 #4), 3. crash recovery (#5),
 *   4. short write (#6), 5. deadline poisoning (#7), 6. close (#13).
 *
 * Time travel for TTL/quota tests goes through the injected `now()` clock (never fake timers —
 * the store's deadline races use real, unref'd timers). Fault injection goes through
 * `UploadFsDeps` fakes layered over a real tmpdir; injected `link` failures always spare the
 * `.probe-*` names so the constructor probe still succeeds unless the test targets the probe.
 */
import {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatAttachmentBlock, type UploadMetaV1 } from "../../../src/web-hub/protocol/upload.js";
import {
  defaultUploadFsDeps,
  DIR_SYNC_FLAGS,
  type ReadableUploadFileHandle,
  type UploadFileHandle,
  type UploadFsDeps,
} from "../../../src/web-hub/hub/upload-fs.js";
import {
  createUploadStore,
  DEFAULT_UPLOAD_LIMITS,
  UploadStoreError,
  type BeginParams,
  type CommitResult,
  type OpenForPreviewParams,
  type OpenForPreviewResult,
  type RecoverReport,
  type UploadAuditEvent,
  type UploadLimits,
  type UploadStore,
} from "../../../src/web-hub/hub/uploads.js";
import { memLog, type MemLog } from "./helpers.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Clock {
  now(): number;
  advance(ms: number): void;
}

/** Real-time-backed clock with a controllable offset: deadlines decay in real time (as in
 *  production) while `advance()` still allows TTL time-travel. A frozen clock would make
 *  `remaining` never decay and let timed-out bodies sprint to completion. */
function makeClock(): Clock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance: (ms) => {
      offset += ms;
    },
  };
}

const realFs = defaultUploadFsDeps();
const P1 = "loopback:token";
const P2 = "lan:u2";
const P3 = "lan:u3";

let root: string;
let clock: Clock;
let log: MemLog;
let audits: UploadAuditEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wh-uploads-"));
  clock = makeClock();
  log = memLog();
  audits = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkStore(
  over: { limits?: Partial<UploadLimits>; fs?: Partial<UploadFsDeps>; root?: string } = {},
): UploadStore {
  const sink = audits; // late async audits (poison cleanup etc.) must land in THIS test's array
  return createUploadStore({
    root: over.root ?? root,
    now: clock.now,
    log,
    audit: (e) => sink.push(e),
    limits: over.limits,
    fs: over.fs,
  });
}

const dl = (ms = 5_000) => ({ at: clock.now() + ms });

let idSeq = 0;
const nid = (): string => `upid${String(++idSeq).padStart(4, "0")}aaaa1111`;

function beginP(over: Partial<BeginParams> = {}): BeginParams {
  return {
    principal: P1,
    agentKey: "a4242-nonce12",
    sessionId: "sess123",
    id: nid(),
    name: "f.txt",
    size: 8,
    ...over,
  };
}

async function upload(
  store: UploadStore,
  content: string | Buffer,
  over: Partial<BeginParams> = {},
): Promise<CommitResult> {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const p = beginP({ size: bytes.length, ...over });
  await store.begin(p, dl());
  await store.chunk({ principal: p.principal, id: p.id, offset: 0, bytes }, dl());
  return store.commit({ principal: p.principal, id: p.id }, dl());
}

async function waitFor(pred: () => boolean, ms = 4_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor: condition never met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function expectCode(
  fn: () => Promise<unknown>,
  code: string,
  extra?: Record<string, unknown>,
): Promise<UploadStoreError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UploadStoreError);
  const e = caught as UploadStoreError;
  expect(e.code).toBe(code);
  if (extra !== undefined) expect({ ...e.extra }).toMatchObject(extra);
  return e;
}

/** Wrap real `open` so each returned handle's methods go through `hook`. */
function hookedHandles(
  hook: (fh: UploadFileHandle) => Partial<UploadFileHandle>,
): (path: string, flags: number, mode?: number) => Promise<UploadFileHandle> {
  return async (path, flags, mode) => {
    const fh = await realFs.open(path, flags, mode);
    return { ...plainDelegate(fh), ...hook(fh) } as UploadFileHandle;
  };
}

function plainDelegate(fh: UploadFileHandle): ReadableUploadFileHandle {
  const readable = fh as ReadableUploadFileHandle; // real fs handles always carry read()
  return {
    write: (buf, off, len, pos) => fh.write(buf, off, len, pos),
    read: (buf, off, len, pos) => readable.read(buf, off, len, pos),
    truncate: (n) => fh.truncate(n),
    datasync: () => fh.datasync(),
    sync: () => fh.sync(),
    stat: () => fh.stat(),
    close: () => fh.close(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// regular acceptance
// ---------------------------------------------------------------------------

describe("begin/chunk/commit happy path (§1.2/§2.2)", () => {
  it("sequential chunks commit with correct content, size and 0600/0700 permissions", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 9 });
    await store.begin(p, dl());
    expect((await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("aaa") }, dl())).received).toBe(
      3,
    );
    expect((await store.chunk({ principal: P1, id: p.id, offset: 3, bytes: Buffer.from("bbb") }, dl())).received).toBe(
      6,
    );
    expect((await store.chunk({ principal: P1, id: p.id, offset: 6, bytes: Buffer.from("ccc") }, dl())).received).toBe(
      9,
    );
    const res = await store.commit({ principal: P1, id: p.id }, dl());
    expect(res.size).toBe(9);
    expect(res.mime).toBeNull();
    expect(res.dedup).toBeUndefined();
    expect(readFileSync(res.path, "utf8")).toBe("aaabbbccc");
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
    for (const d of [root, `${root}/s-sess123`, `${root}/s-sess123/${p.id}`]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    const meta = readJson(`${root}/s-sess123/${p.id}/meta.json`) as UploadMetaV1;
    expect(meta.v).toBe(1);
    expect(meta.safeName).toBe("f.txt");
    expect(meta.diskName).toBe(`${p.id}.txt`);
    expect(meta.size).toBe(9);
    expect(existsSync(`${root}/s-sess123/${p.id}/${p.id}.txt.part`)).toBe(false);
    expect(store.inflight()).toBe(0);
    expect(store.stats().committedFiles).toBe(1);
    expect(store.stats().committedBytes).toBe(9);
  });

  it("mime is normalized; a dropped mime is recorded in the begin audit line", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "x", { name: "i.png", mime: " IMAGE/PNG " });
    expect(res.mime).toBe("image/png");
    await upload(store, "y", { name: "j.png", mime: "text/plain\n- /etc/passwd" });
    expect(audits.find((a) => a.phase === "request" && a.op === "begin" && a.mimeDropped === true)).toBeDefined();
    expect(audits.find((a) => a.phase === "request" && a.op === "commit")!.bytes).toBe(1);
  });

  it("begin is idempotent for identical params and reports current received", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 6 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    const r2 = await store.begin(p, dl());
    expect(r2.received).toBe(3);
    expect(r2.maxBytes).toBe(DEFAULT_UPLOAD_LIMITS.fileMaxBytes);
    await expectCode(() => store.begin({ ...p, size: 7 }, dl()), "E_UPLOAD_CONFLICT");
    await expectCode(() => store.begin({ ...p, principal: P2 }, dl()), "E_NOT_FOUND");
  });

  it("chunk offset rules: dup for a retried chunk, 409 with received on mismatch, 413 past size", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 6 });
    await store.begin(p, dl());
    const first = await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    expect(first).toEqual({ received: 3 });
    const retry = await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    expect(retry).toEqual({ received: 3, dup: true });
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 1, bytes: Buffer.from("xyz") }, dl()),
      "E_UPLOAD_OFFSET",
      { received: 3 },
    );
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 3, bytes: Buffer.alloc(4) }, dl()),
      "E_UPLOAD_TOO_LARGE",
    );
  });

  it("cross-principal access is a flat 404 (no existence leak)", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    await expectCode(
      () => store.chunk({ principal: P2, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl()),
      "E_NOT_FOUND",
    );
    await expectCode(() => store.commit({ principal: P2, id: p.id }, dl()), "E_NOT_FOUND");
    await expectCode(() => store.abort({ principal: P2, id: p.id }, dl()), "E_NOT_FOUND");
  });

  it("commit is idempotent; a committed id cannot be reused by begin", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "hello");
    const again = await store.commit({ principal: P1, id: res.id }, dl());
    expect(again.path).toBe(res.path);
    await expectCode(() => store.begin({ ...beginP(), id: res.id }, dl()), "E_UPLOAD_CONFLICT");
    await expectCode(() => store.begin({ ...beginP({ principal: P2 }), id: res.id }, dl()), "E_NOT_FOUND");
  });

  it("in-flight admission limits (§2.4) reject with E_RATE", async () => {
    const store = mkStore({ limits: { inflightPerPrincipal: 2, inflightHub: 3 } });
    await store.recover();
    await store.begin(beginP(), dl()); // P1 #1
    await store.begin(beginP(), dl()); // P1 #2
    await expectCode(() => store.begin(beginP(), dl()), "E_RATE", { retryAfterS: 1 }); // per-principal
    await store.begin(beginP({ principal: P2 }), dl()); // hub #3
    await expectCode(() => store.begin(beginP({ principal: P3 }), dl()), "E_RATE"); // hub cap
    await expectCode(() => store.begin(beginP({ principal: P2 }), dl()), "E_RATE"); // still hub cap
  });

  it("file size limit rejects at begin", async () => {
    const store = mkStore({ limits: { fileMaxBytes: 4 } });
    await store.recover();
    await expectCode(() => store.begin(beginP({ size: 5 }), dl()), "E_UPLOAD_TOO_LARGE");
    await expectCode(() => store.begin(beginP({ size: -1 }), dl()), "E_UPLOAD_TOO_LARGE");
  });

  it("a zero-size upload commits an empty file", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "");
    expect(res.size).toBe(0);
    expect(statSync(res.path).size).toBe(0);
  });
});

describe("three-level quotas (§2.4/§2.6)", () => {
  it("bucket-level: over-cap begin throws 507 with the earliest expiry hint", async () => {
    const store = mkStore({ limits: { fileMaxBytes: 5, bucketMaxBytes: 10, totalMaxBytes: 100 } });
    await store.recover();
    await upload(store, "aaaaa"); // 5 bytes committed at t0
    await store.begin(beginP({ size: 5 }), dl()); // 5 committed + 5 in-flight = 10 fits
    const expiryHi = clock.now() + DEFAULT_UPLOAD_LIMITS.unreferencedTtlMs;
    const err = await expectCode(() => store.begin(beginP({ size: 1 }), dl()), "E_UPLOAD_QUOTA");
    expect(err.extra.earliestExpiryAt).toBeGreaterThan(expiryHi - 60_000); // ≈ committedAt + 24h
    expect(err.extra.earliestExpiryAt).toBeLessThanOrEqual(expiryHi);
  });

  it("an unreferenced file >1h old is quota-evictable; <1h is not", async () => {
    const store = mkStore({ limits: { fileMaxBytes: 5, bucketMaxBytes: 5, totalMaxBytes: 100 } });
    await store.recover();
    const old = await upload(store, "aaaaa"); // fills the bucket exactly
    await expectCode(() => store.begin(beginP({ size: 1 }), dl()), "E_UPLOAD_QUOTA"); // <1h: nothing evictable
    clock.advance(3_600_001);
    await store.begin(beginP({ size: 1 }), dl()); // >1h: the committed file is evicted
    expect(existsSync(old.path)).toBe(false);
    expect(store.stats().committedFiles).toBe(0);
  });

  it("global-level cap evicts oldest-first across buckets", async () => {
    const store = mkStore({ limits: { fileMaxBytes: 5, bucketMaxBytes: 10, totalMaxBytes: 12 } });
    await store.recover();
    const first = await upload(store, "aaaaa", { sessionId: "s1" });
    clock.advance(1_000);
    await upload(store, "bbbbb", { sessionId: "s2" });
    await expectCode(() => store.begin(beginP({ size: 3, sessionId: "s3" }), dl()), "E_UPLOAD_QUOTA");
    clock.advance(3_600_001);
    await store.begin(beginP({ size: 3, sessionId: "s3" }), dl());
    expect(existsSync(first.path)).toBe(false); // oldest evicted
    expect(store.stats().committedFiles).toBe(1);
  });

  it("principal-in-bucket counts towards the same cap (§2.4)", async () => {
    const store = mkStore({ limits: { fileMaxBytes: 12, bucketMaxBytes: 20, totalMaxBytes: 100 } });
    await store.recover();
    const p1file = await upload(store, "aaaaaaaaaaaa", { principal: P1 }); // bucket 12/20
    // P2's own total (11) is under the cap, but the shared bucket (and principal-in-bucket)
    // cap is the same 20: 12 + 11 > 20 and nothing is evictable while fresh
    await expectCode(() => upload(store, "bbbbbbbbbbb", { principal: P2 }), "E_UPLOAD_QUOTA");
    clock.advance(3_600_001);
    const p2file = await upload(store, "bbbbbbbbbbb", { principal: P2 }); // now evicts P1's file
    expect(existsSync(p1file.path)).toBe(false);
    expect(existsSync(p2file.path)).toBe(true);
  });
});

describe("dedup (§2.5 #9)", () => {
  it("same principal + bucket + content + name dedups to the old path", async () => {
    const store = mkStore();
    await store.recover();
    const first = await upload(store, "same-bytes");
    const second = await upload(store, "same-bytes");
    expect(second.dedup).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.size).toBe(first.size);
    expect(existsSync(first.path)).toBe(true);
    expect(store.stats().committedFiles).toBe(1);
    const third = await store.commit({ principal: P1, id: second.id }, dl()); // idempotent
    expect(third.dedup).toBe(true);
    expect(third.path).toBe(first.path);
    expect(store.stats().counters.dedupHits).toBe(1);
  });

  it("different principal / bucket / name each store their own copy", async () => {
    const store = mkStore();
    await store.recover();
    const a = await upload(store, "same-bytes");
    const b = await upload(store, "same-bytes", { principal: P2 });
    const c = await upload(store, "same-bytes", { sessionId: "other9" });
    const d = await upload(store, "same-bytes", { name: "g.txt" });
    expect(new Set([a.path, b.path, c.path, d.path]).size).toBe(4);
    expect(store.stats().committedFiles).toBe(4);
  });

  it("a dedup hit re-verifies the old file; a stale entry is ignored", async () => {
    const store = mkStore();
    await store.recover();
    const first = await upload(store, "same-bytes");
    rmSync(first.path); // old file vanished on disk behind the index
    const second = await upload(store, "same-bytes");
    expect(second.dedup).toBeUndefined();
    expect(second.path).not.toBe(first.path);
    expect(existsSync(second.path)).toBe(true);
    // the stale first entry stays indexed until the next startup scan cleans it
    expect(store.stats().committedFiles).toBe(2);
  });
});

describe("reference pinning + TTL (§2.6 v3 #8)", () => {
  function promptFor(paths: Array<{ path: string; mime: string | null }>): string {
    const block = formatAttachmentBlock(paths.map((p) => ({ path: p.path, mime: p.mime, sizeLabel: "1 KB" })));
    expect(block).toBeDefined();
    return `please look at this\n\n${block!}`;
  }

  it("pin → settle(referenced) switches TTL to 7 days and survives both sweeps", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "ref-bytes");
    const pin = store.pinForPrompt({ principal: P1, text: promptFor([res]) });
    expect(pin.ok).toBe(true);
    if (!pin.ok) return;
    expect(pin.token.ids).toEqual([res.id]);
    store.settlePins(pin.token, "referenced");

    clock.advance(25 * 3_600_000); // unreferenced TTL long past
    expect((await store.sweep("tick")).evicted).toEqual([]);
    expect((await store.sweep("quota")).evicted).toEqual([]); // referenced: never quota-evicted
    expect(existsSync(res.path)).toBe(true);

    clock.advance(7 * 24 * 3_600_000); // past referencedAt + 7d
    const report = await store.sweep("tick");
    expect(report.evicted.map((e) => e.reason)).toEqual(["ttl"]);
    expect(existsSync(res.path)).toBe(false);
    expect(store.stats().referencedFiles).toBe(0);
  });

  it("settle(released) leaves the file unreferenced: 24h TTL, quota-evictable at >1h", async () => {
    const store = mkStore({ limits: { fileMaxBytes: 5, bucketMaxBytes: 5 } });
    await store.recover();
    const res = await upload(store, "aaaaa");
    const pin = store.pinForPrompt({ principal: P1, text: promptFor([res]) });
    expect(pin.ok).toBe(true);
    if (!pin.ok) return;
    store.settlePins(pin.token, "released");
    expect(store.stats().referencedFiles).toBe(0);
    await expectCode(() => store.begin(beginP({ size: 1 }), dl()), "E_UPLOAD_QUOTA"); // <1h: not evictable
    clock.advance(3_600_001);
    await store.begin(beginP({ size: 1 }), dl()); // released ⇒ evictable
    expect(existsSync(res.path)).toBe(false);
  });

  it("a pinned file is exempt even before settle (in-flight prompt protection)", async () => {
    const store = mkStore({ limits: { fileMaxBytes: 5, bucketMaxBytes: 5 } });
    await store.recover();
    const res = await upload(store, "aaaaa");
    clock.advance(2 * 3_600_000);
    const pin = store.pinForPrompt({ principal: P1, text: promptFor([res]) });
    expect(pin.ok).toBe(true);
    await expectCode(() => store.begin(beginP({ size: 1 }), dl()), "E_UPLOAD_QUOTA"); // pins > 0
    store.settlePins(pin.token, "released");
    await store.begin(beginP({ size: 1 }), dl()); // pins back to 0 ⇒ evictable
    expect(existsSync(res.path)).toBe(false);
  });

  it("someone else's transcript path is ignored — neither pinned nor gone", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "mine");
    const pin = store.pinForPrompt({ principal: P2, text: promptFor([res]) });
    expect(pin).toEqual({ ok: true, token: { ids: [] } });
  });

  it("an entry mid-eviction yields { ok:false, gone:[id] }", async () => {
    let releaseRm: (() => void) | undefined;
    const store = mkStore({
      fs: {
        rm: (p, o) =>
          new Promise<void>((resolve) => {
            releaseRm = () => realFs.rm(p, o).then(resolve, resolve);
          }),
      },
    });
    await store.recover();
    const res = await upload(store, "gone");
    clock.advance(25 * 3_600_000);
    const sweepPromise = store.sweep("tick");
    await waitFor(() => releaseRm !== undefined);
    const pin = store.pinForPrompt({ principal: P1, text: promptFor([res]) });
    expect(pin).toEqual({ ok: false, gone: [res.id] });
    releaseRm!();
    await sweepPromise;
    expect(existsSync(res.path)).toBe(false);
  });

  it("flushReferences persists referencedAt atomically; failure keeps it dirty; no budget ⇒ timeout", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "flush");
    const pin = store.pinForPrompt({ principal: P1, text: promptFor([res]) });
    expect(pin.ok).toBe(true);
    if (!pin.ok) return;
    store.settlePins(pin.token, "referenced");
    const refBefore = clock.now();
    expect(await store.flushReferences([res.id], dl())).toBe("ok");
    const meta = readJson(`${root}/s-sess123/${res.id}/meta.json`) as UploadMetaV1;
    expect(meta.referencedAt).toBeGreaterThanOrEqual(refBefore); // real clock: settle ≤ flush read
    expect(meta.referencedAt).toBeLessThanOrEqual(clock.now());
    expect(await store.flushReferences([res.id], { at: clock.now() - 1 })).toBe("ok"); // clean ⇒ no-op

    // failure path: rename throws ⇒ "error" and the entry stays dirty
    let breakMetaRenames = false;
    const broken = mkStore({
      fs: {
        rename: (from, to) => {
          if (breakMetaRenames && to.endsWith("/meta.json")) {
            const e = new Error("io") as Error & { code: string };
            e.code = "EIO";
            return Promise.reject(e);
          }
          return realFs.rename(from, to);
        },
      },
    });
    await broken.recover();
    const res2 = await upload(broken, "flush2");
    breakMetaRenames = true; // only the flush retry fails, not the commit itself
    const pin2 = broken.pinForPrompt({ principal: P1, text: promptFor([res2]) });
    expect(pin2.ok).toBe(true);
    if (!pin2.ok) return;
    broken.settlePins(pin2.token, "referenced");
    expect(await broken.flushReferences([res2.id], dl())).toBe("error");
    expect(await broken.flushReferences([res2.id], { at: clock.now() - 1 })).toBe("timeout"); // dirty + no budget
  });

  it("sweep retries dirty reference persistence first (§2.6)", async () => {
    let breakMetaRenames = false;
    const store = mkStore({
      fs: {
        rename: (from, to) => {
          if (breakMetaRenames && to.endsWith("/meta.json")) {
            const e = new Error("io") as Error & { code: string };
            e.code = "EIO";
            return Promise.reject(e);
          }
          return realFs.rename(from, to);
        },
      },
    });
    await store.recover();
    const res = await upload(store, "retry-me");
    breakMetaRenames = true; // commit's own meta write already succeeded; only flushes fail now
    const pin = store.pinForPrompt({ principal: P1, text: promptFor([res]) });
    expect(pin.ok).toBe(true);
    if (!pin.ok) return;
    store.settlePins(pin.token, "referenced");
    expect(await store.flushReferences([res.id], dl())).toBe("error"); // still dirty
    breakMetaRenames = false;
    const report = await store.sweep("tick"); // §2.6: sweep retries ALL dirty entries first
    expect(report.evicted).toEqual([]);
    const meta = readJson(`${root}/s-sess123/${res.id}/meta.json`) as UploadMetaV1;
    expect(meta.referencedAt).not.toBeNull(); // persisted by the sweep's retry
    expect(await store.flushReferences([res.id], { at: clock.now() - 1 })).toBe("ok"); // clean ⇒ no budget needed
  });
});

describe("abort (§2.5/§2.6)", () => {
  it("abort removes an in-flight upload and its directory; later ops are 404", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 5 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("ab") }, dl());
    await store.abort({ principal: P1, id: p.id }, dl());
    expect(existsSync(`${root}/s-sess123/${p.id}`)).toBe(false);
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 2, bytes: Buffer.from("cde") }, dl()),
      "E_NOT_FOUND",
    );
    await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_NOT_FOUND");
    expect(store.stats().inflightBytes).toBe(0);
  });

  it("abort removes a committed (tray-removed) upload", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "committed");
    await store.abort({ principal: P1, id: res.id }, dl());
    expect(existsSync(res.path)).toBe(false);
    expect(store.stats().committedFiles).toBe(0);
  });

  it("abort of an unknown id is 404", async () => {
    const store = mkStore();
    await store.recover();
    await expectCode(() => store.abort({ principal: P1, id: nid() }, dl()), "E_NOT_FOUND");
  });
});

describe("idle in-flight sweep (§2.6)", () => {
  it("an upload idle past 10 min is invalidated; one touched later survives", async () => {
    const store = mkStore();
    await store.recover();
    const a = beginP({ size: 5 });
    await store.begin(a, dl()); // lastActivity = t0
    clock.advance(300_000);
    const b = beginP({ size: 5 });
    await store.begin(b, dl());
    await store.chunk({ principal: P1, id: b.id, offset: 0, bytes: Buffer.from("ab") }, dl()); // lastActivity = t0+300s
    clock.advance(300_001); // now = t0+600_001: a idle 600_001 ⇒ evicted; b idle 300_001 ⇒ kept
    const report = await store.sweep("tick");
    expect(report.evicted.map((e) => e.id)).toEqual([a.id]);
    expect(existsSync(`${root}/s-sess123/${a.id}`)).toBe(false);
    expect(existsSync(`${root}/s-sess123/${b.id}`)).toBe(true);
    expect(store.stats().inflight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// hard gate 1 — symlink (#3)
// ---------------------------------------------------------------------------

describe("hard gate 1: symlink hardening (§2.2.1 #3)", () => {
  it("uploads root replaced by a symlink disables the feature for the whole lifetime", async () => {
    const target = mkdtempSync(join(tmpdir(), "wh-tgt-"));
    try {
      symlinkSync(target, `${root}/uploads-link`);
      const store = mkStore({ root: `${root}/uploads-link` });
      await store.recover();
      expect(store.stats().disabled).toBe(true);
      expect(store.stats().disabledReason).toBe("root-invalid");
      await expectCode(() => store.begin(beginP(), dl()), "E_UPLOAD_DISABLED");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("a symlinked bucket dir is rejected without deleting the link target", async () => {
    const store = mkStore();
    await store.recover();
    const victim = `${root}/victim-dir`;
    mkdirSync(victim);
    writeFileSync(`${victim}/keep.txt`, "keep");
    symlinkSync(victim, `${root}/s-sess123`);
    await expectCode(() => store.begin(beginP(), dl()), "E_UPLOAD_DISABLED");
    expect(readFileSync(`${victim}/keep.txt`, "utf8")).toBe("keep");
    expect(lstatSync(`${root}/s-sess123`).isSymbolicLink()).toBe(true);
  });

  it("a pre-existing id entry (incl. symlink) is a 409 conflict — ids are not reused", async () => {
    const store = mkStore();
    await store.recover();
    mkdirSync(`${root}/s-sess123`, { recursive: true });
    const id = nid();
    symlinkSync(`${root}/elsewhere-does-not-exist`, `${root}/s-sess123/${id}`);
    await expectCode(() => store.begin(beginP({ id }), dl()), "E_UPLOAD_CONFLICT");
  });

  it("a .part replaced by a symlink poisons the upload; the link target is never written", async () => {
    const store = mkStore();
    await store.recover();
    const victim = `${root}/victim.txt`;
    writeFileSync(victim, "untouched");
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    symlinkSync(victim, `${root}/s-sess123/${p.id}/${p.id}.txt.part`);
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl()),
      "E_INTERNAL",
    );
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    await waitFor(() => !existsSync(`${root}/s-sess123/${p.id}`));
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl()),
      "E_NOT_FOUND",
    );
  });

  it("a bucket dir replaced between begin and chunk is caught by the post-open chain verify", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    // move the bucket aside (keeping our <id>/) and replace it with a symlink — the §2.2.1
    // "same-uid attacker" residual, narrowed by the post-open identity re-check
    renameSync(`${root}/s-sess123`, `${root}/s-sess123.real`);
    symlinkSync(`${root}/s-sess123.real`, `${root}/s-sess123`);
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl()),
      "E_INTERNAL",
    );
    // not deleted by path (identity mismatch): our moved directory is untouched
    expect(existsSync(`${root}/s-sess123.real/${p.id}`)).toBe(true);
    const strayPart = `${root}/s-sess123.real/${p.id}/${p.id}.txt.part`;
    if (existsSync(strayPart)) expect(statSync(strayPart).size).toBe(0); // never written through
    expect(
      log.lines.some((l) => l.level === "error" && /chain mismatch/.test(`${l.msg}${JSON.stringify(l.data ?? {})}`)),
    ).toBe(true);
    await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// hard gate 2 — no-replace commit (v3 #4)
// ---------------------------------------------------------------------------

/** An injected `link` fault that spares the constructor probe's `.probe-*` names. */
function linkFault(
  inject: (from: string, to: string) => Promise<void> | undefined,
): (from: string, to: string) => Promise<void> {
  return (from, to) =>
    from.includes("/.probe-") ? realFs.link(from, to) : (inject(from, to) ?? realFs.link(from, to));
}

describe("hard gate 2: no-replace commit (§2.2.3 v3 #4)", () => {
  it("a pre-planted final yields E_UPLOAD_CONFLICT and keeps the planted content", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    const idDir = `${root}/s-sess123/${p.id}`;
    writeFileSync(`${idDir}/${p.id}.txt`, "PLANTED"); // external pre-creation
    const witness = `${root}/witness.txt`;
    linkSync(`${idDir}/${p.id}.txt`, witness); // the inode survives the id-dir removal
    await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_UPLOAD_CONFLICT");
    expect(readFileSync(witness, "utf8")).toBe("PLANTED");
    expect(existsSync(idDir)).toBe(false);
    expect(log.lines.some((l) => l.level === "error" && /external write/.test(l.msg))).toBe(true);
  });

  it("a pre-planted final symlink conflicts without touching its target", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    const victim = `${root}/victim2.txt`;
    writeFileSync(victim, "V");
    symlinkSync(victim, `${root}/s-sess123/${p.id}/${p.id}.txt`);
    await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_UPLOAD_CONFLICT");
    expect(readFileSync(victim, "utf8")).toBe("V");
  });

  for (const code of ["EPERM", "ENOTSUP", "EXDEV"] as const) {
    it(`link failing with ${code} ⇒ E_UPLOAD_DISABLED, dir deleted, never a rename to final`, async () => {
      const renames: Array<{ from: string; to: string }> = [];
      const store = mkStore({
        fs: {
          link: linkFault(() => {
            const e = new Error(code) as Error & { code: string };
            e.code = code;
            return Promise.reject(e);
          }),
          rename: (from, to) => {
            renames.push({ from, to });
            return realFs.rename(from, to);
          },
        },
      });
      await store.recover();
      const p = beginP({ size: 3 });
      await store.begin(p, dl());
      await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
      const idDir = `${root}/s-sess123/${p.id}`;
      await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_UPLOAD_DISABLED", {
        reason: "no-hardlink",
      });
      expect(existsSync(idDir)).toBe(false);
      expect(renames.filter((r) => r.to === `${idDir}/${p.id}.txt`)).toEqual([]);
    });
  }

  it("a failed constructor probe disables the store for its whole lifetime; no probe litter", async () => {
    const store = mkStore({
      fs: {
        link: () => {
          const e = new Error("EPERM") as Error & { code: string };
          e.code = "EPERM";
          return Promise.reject(e);
        },
      },
    });
    await store.recover();
    expect(store.stats().disabled).toBe(true);
    expect(store.stats().disabledReason).toBe("no-hardlink");
    await expectCode(() => store.begin(beginP(), dl()), "E_UPLOAD_DISABLED");
    await expectCode(() => store.begin(beginP(), dl()), "E_UPLOAD_DISABLED");
    expect(readdirSync(root).filter((n) => n.startsWith(".probe-"))).toEqual([]);
  });

  it("concurrent same-id commits serialize: the second gets the first's result, link runs once", async () => {
    const linkCalls: string[] = [];
    let releaseLink: (() => void) | undefined;
    const store = mkStore({
      fs: {
        link: linkFault((from, to) => {
          linkCalls.push(to);
          return new Promise<void>((resolve, reject) => {
            releaseLink = () => realFs.link(from, to).then(resolve, reject);
          });
        }),
      },
    });
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    const c1 = store.commit({ principal: P1, id: p.id }, dl());
    await waitFor(() => releaseLink !== undefined && linkCalls.length === 1);
    const c2 = store.commit({ principal: P1, id: p.id }, dl());
    await new Promise((r) => setTimeout(r, 50));
    expect(linkCalls.length).toBe(1); // second commit waits on the id lock
    releaseLink!();
    const [r1, r2] = await Promise.all([c1, c2]);
    expect(r2).toEqual(r1);
    expect(linkCalls.length).toBe(1);
    expect(readFileSync(r1.path, "utf8")).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// generated disk names (2026-10 rework: `<uploadId>.<ext>`, never the client's name)
// ---------------------------------------------------------------------------

describe("generated disk names (2026-10 rework)", () => {
  it("lands as <id>.<ext>; the sanitized original name survives in the record, not on disk", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "hello", { name: "final report.pdf" });
    expect(res.path).toBe(join(root, "s-sess123", res.id, `${res.id}.pdf`));
    expect(readFileSync(res.path, "utf8")).toBe("hello");
    // the dir holds exactly the generated file + meta.json — nothing named after the original
    expect(readdirSync(join(root, "s-sess123", res.id)).sort()).toEqual(["meta.json", `${res.id}.pdf`]);
    const meta = readJson(join(root, "s-sess123", res.id, "meta.json")) as UploadMetaV1;
    expect(meta.safeName).toBe("final_report.pdf"); // sanitized display name — the user's record
    expect(meta.diskName).toBe(`${res.id}.pdf`); // actual on-disk name
  });

  it("names without a legal ext land as the bare <id> (no dot, non-ASCII, over-long ext)", async () => {
    const store = mkStore();
    await store.recover();
    const a = await upload(store, "a", { name: "\u30ce\u30fc\u30c8\u8cc7\u6599" });
    expect(a.path).toBe(join(root, "s-sess123", a.id, a.id));
    const b = await upload(store, "b", { name: "a.\u65e5\u672c\u8a9e" });
    expect(b.path).toBe(join(root, "s-sess123", b.id, b.id));
    const c = await upload(store, "c", { name: `a.${"x".repeat(17)}` });
    expect(c.path).toBe(join(root, "s-sess123", c.id, c.id));
    for (const r of [a, b, c]) {
      const meta = readJson(join(root, "s-sess123", r.id, "meta.json")) as UploadMetaV1;
      expect(meta.diskName).toBe(r.id);
    }
  });

  it("a .part ext is reserved: the final lands as the bare <id> and survives the startup scan", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "xx", { name: "notes.part" });
    expect(res.path).toBe(join(root, "s-sess123", res.id, res.id));
    // a final named <id>.part would match the scan's orphan filter — this pins that it cannot
    const fresh = mkStore();
    const report = await fresh.recover();
    expect(report.committed).toBe(1);
    expect(report.anomalies).toBe(0);
    expect(existsSync(res.path)).toBe(true);
    const again = await upload(fresh, "xx", { name: "notes.part" });
    expect(again.dedup).toBe(true); // dedup key still the sanitized original name
    expect(again.path).toBe(res.path);
  });

  it("begin idempotency compares the SANITIZED ORIGINAL name, not the generated disk name", async () => {
    const store = mkStore();
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    // "./f.txt" sanitizes to "f.txt" (path-segment canonicalization) ⇒ idempotent resume
    const r2 = await store.begin({ ...p, name: "./f.txt" }, dl());
    expect(r2.received).toBe(0);
    // "g.txt" yields the SAME generated disk name (`${id}.txt`) yet is a different declared
    // name ⇒ conflict (comparing generated names would silently accept the swap)
    await expectCode(() => store.begin({ ...p, name: "g.txt" }, dl()), "E_UPLOAD_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// hard gate 3 — crash recovery (#5)
// ---------------------------------------------------------------------------

describe("hard gate 3: crash recovery (§2.2.4)", () => {
  const bucket = "s-sess123";

  function validMeta(over: {
    id: string;
    size?: number;
    sha256?: string;
    referencedAt?: number | null;
    committedAt?: number;
  }): UploadMetaV1 {
    return {
      v: 1,
      id: over.id,
      principal: P1,
      agentKey: "a4242-nonce12",
      bucket,
      safeName: "f.txt",
      size: over.size ?? 3,
      mime: null,
      sha256: over.sha256 ?? "a".repeat(64),
      committedAt: over.committedAt ?? clock.now(),
      referencedAt: over.referencedAt ?? null,
    };
  }

  function idDir(id: string): string {
    mkdirSync(join(root, bucket, id), { recursive: true });
    return join(root, bucket, id);
  }

  async function recoverOn(): Promise<{ store: UploadStore; report: RecoverReport }> {
    const store = mkStore();
    const report = await store.recover();
    return { store, report };
  }

  it("row 1: only .part ⇒ removed with reason orphan-part", async () => {
    const id = nid();
    writeFileSync(join(idDir(id), "f.txt.part"), "xx");
    const { report } = await recoverOn();
    expect(report.removed).toBe(1);
    expect(report.committed).toBe(0);
    expect(existsSync(join(root, bucket, id))).toBe(false);
    expect(audits.some((a) => a.phase === "recover" && a.reason === "orphan-part")).toBe(true);
  });

  it("row 2: .part + final (pre-unlink crash) ⇒ removed", async () => {
    const id = nid();
    const d = idDir(id);
    writeFileSync(join(d, "f.txt.part"), "x");
    writeFileSync(join(d, "f.txt"), "xx");
    const { report } = await recoverOn();
    expect(report.removed).toBe(1);
    expect(existsSync(d)).toBe(false);
  });

  it("row 3: final without meta.json (pre-rename crash, stray tmp) ⇒ removed", async () => {
    const id = nid();
    const d = idDir(id);
    writeFileSync(join(d, "f.txt"), "xx");
    writeFileSync(join(d, ".meta.abc123.tmp"), "{}");
    const { report } = await recoverOn();
    expect(report.removed).toBe(1);
    expect(existsSync(d)).toBe(false);
  });

  it("row 4: committed form ⇒ indexed (quota, dedup rebuilt, referencedAt TTL honored)", async () => {
    const sha = createHash("sha256").update("abc").digest("hex");
    const id = nid();
    const d = idDir(id);
    writeFileSync(join(d, "f.txt"), "abc");
    const committedAt = clock.now();
    writeFileSync(
      join(d, "meta.json"),
      JSON.stringify(validMeta({ id, size: 3, sha256: sha, committedAt, referencedAt: committedAt + 1_000 })),
    );
    clock.advance(2_000);
    const { store, report } = await recoverOn();
    expect(report.committed).toBe(1);
    expect(store.stats().committedBytes).toBe(3);

    // dedup index rebuilt: same principal/bucket/content/name hits the recovered entry
    const again = await upload(store, "abc", { name: "f.txt" });
    expect(again.dedup).toBe(true);
    expect(again.path).toBe(join(d, "f.txt"));
    const other = await upload(store, "abc", { name: "f.txt", principal: P2 });
    expect(other.dedup).toBeUndefined();

    // referencedAt honored: referenced file survives 25h (unreferenced TTL) and quota sweeps…
    clock.advance(25 * 3_600_000);
    await store.sweep("tick");
    expect(existsSync(join(d, "f.txt"))).toBe(true);
    // …and dies only past referencedAt + 7d
    clock.advance(7 * 24 * 3_600_000);
    const swept = await store.sweep("tick");
    expect(swept.evicted.map((e) => e.id)).toContain(id);
    expect(existsSync(join(d, "f.txt"))).toBe(false);
  });

  it("row 5: invalid meta / size mismatch / symlinked final ⇒ removed as anomaly", async () => {
    const a = nid();
    const da = idDir(a);
    writeFileSync(join(da, "f.txt"), "abc");
    writeFileSync(join(da, "meta.json"), "{not json");
    const b = nid();
    const db = idDir(b);
    writeFileSync(join(db, "f.txt"), "ab"); // size 2 ≠ meta.size 3
    writeFileSync(join(db, "meta.json"), JSON.stringify(validMeta({ id: b, size: 3 })));
    const c = nid();
    const dc = idDir(c);
    writeFileSync(join(dc, "victim.txt"), "z");
    symlinkSync(join(dc, "victim.txt"), join(dc, "f.txt"));
    writeFileSync(join(dc, "meta.json"), JSON.stringify(validMeta({ id: c, size: 3 })));
    const { report } = await recoverOn();
    expect(report.anomalies).toBe(3);
    expect(report.removed).toBe(3);
    expect(existsSync(da)).toBe(false);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(dc)).toBe(false);
  });

  it("row 4 (generated-name layout): diskName locates the file; dedup key stays on safeName", async () => {
    const sha = createHash("sha256").update("abc").digest("hex");
    const a = nid();
    const da = idDir(a);
    writeFileSync(join(da, `${a}.pdf`), "abc");
    writeFileSync(
      join(da, "meta.json"),
      JSON.stringify({
        ...validMeta({ id: a, size: 3, sha256: sha }),
        safeName: "final_report.pdf",
        diskName: `${a}.pdf`,
      }),
    );
    const b = nid();
    const db = idDir(b);
    writeFileSync(join(db, "f.txt"), "abc"); // present only under the legacy safeName
    writeFileSync(
      join(db, "meta.json"),
      JSON.stringify({ ...validMeta({ id: b, size: 3, sha256: sha }), diskName: `${b}.txt` }),
    );
    const { store, report } = await recoverOn();
    expect(report.committed).toBe(1);
    expect(report.anomalies).toBe(1);
    expect(existsSync(da)).toBe(true);
    expect(existsSync(db)).toBe(false);
    // dedup key rebuilt from safeName (not diskName): same content + same declared name hits
    const again = await upload(store, "abc", { name: "final_report.pdf" });
    expect(again.dedup).toBe(true);
    expect(again.path).toBe(join(da, `${a}.pdf`));
  });

  it("row 6: a symlinked <id>/ dir is not followed and not deleted", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wh-out-"));
    try {
      const id = nid();
      mkdirSync(join(root, bucket), { recursive: true });
      symlinkSync(outside, join(root, bucket, id));
      const { report } = await recoverOn();
      expect(report.anomalies).toBe(1);
      expect(existsSync(outside)).toBe(true);
      expect(lstatSync(join(root, bucket, id)).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("row 7: empty <id>/ and empty buckets are removed; probe litter is cleaned", async () => {
    idDir(nid());
    mkdirSync(join(root, "s-emptybucket"), { recursive: true });
    writeFileSync(join(root, ".probe-deadbeef"), "");
    writeFileSync(join(root, ".probe-deadbeef.l"), "");
    const { report } = await recoverOn();
    expect(report.removed).toBe(1); // the empty <id>/ (bucket removals aren't id-level)
    expect(readdirSync(root)).toEqual([]); // empty id + its now-empty bucket + empty bucket + probes
  });

  it("a slow scan keeps begin at E_BUSY until the scan completes", async () => {
    let releaseReaddir: (() => void) | undefined;
    const store = mkStore({
      fs: {
        readdir: (p) =>
          p === root
            ? new Promise<string[]>((resolve) => {
                releaseReaddir = () => resolve([]);
              })
            : realFs.readdir(p),
      },
    });
    const rp = store.recover();
    await waitFor(() => releaseReaddir !== undefined);
    await expectCode(() => store.begin(beginP(), dl()), "E_BUSY", { retryAfterS: 2 });
    releaseReaddir!();
    const report = await rp;
    expect(report.completed).toBe(true);
    await store.begin(beginP(), dl()); // no longer busy
  });
});

// ---------------------------------------------------------------------------
// hard gate 4 — short write (#6)
// ---------------------------------------------------------------------------

describe("hard gate 4: short write (§2.2.2 #6)", () => {
  it("a half-at-a-time write completes the upload end-to-end (writeAllAt loop)", async () => {
    const store = mkStore({
      fs: {
        open: hookedHandles((fh) => ({
          write: async (buf, off, len, pos) => {
            const half = Math.max(1, Math.floor(len / 2));
            const first = await fh.write(buf, off, half, pos);
            if (first.bytesWritten >= len) return first;
            const second = await fh.write(
              buf,
              off + first.bytesWritten,
              len - first.bytesWritten,
              pos + first.bytesWritten,
            );
            return { bytesWritten: first.bytesWritten + second.bytesWritten };
          },
        })),
      },
    });
    await store.recover();
    const res = await upload(store, "0123456789ABCDEF", { size: 16 });
    expect(readFileSync(res.path, "utf8")).toBe("0123456789ABCDEF");
    // hash correctness (§6 gate 4 "前者循环写完且 hash 正确"): a second upload of the same
    // content dedups onto the first — only possible if the incremental hash covered all bytes
    const second = await upload(store, "0123456789ABCDEF", { size: 16 });
    expect(second.dedup).toBe(true);
    expect(second.path).toBe(res.path);
  });

  it("write returning 0 keeps received unchanged, truncates the part back, and is retryable", async () => {
    let failNext = true;
    const store = mkStore({
      fs: {
        open: hookedHandles((fh) => ({
          write: async (buf, off, len, pos) => {
            if (failNext && len > 1) {
              failNext = false;
              await fh.write(buf, off, 1, pos); // a byte reaches the file …
              return { bytesWritten: 0 }; // … but the step reports a 0 short-write
            }
            return fh.write(buf, off, len, pos);
          },
        })),
      },
    });
    await store.recover();
    const p = beginP({ size: 4 });
    await store.begin(p, dl());
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abcd") }, dl()),
      "E_INTERNAL",
    );
    expect(statSync(`${root}/s-sess123/${p.id}/${p.id}.txt.part`).size).toBe(0); // truncated back to received=0
    const retry = await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abcd") }, dl());
    expect(retry.received).toBe(4);
    const res = await store.commit({ principal: P1, id: p.id }, dl());
    expect(readFileSync(res.path, "utf8")).toBe("abcd");
  });

  it("write throwing mid-upload with a working truncate is retryable at the same offset", async () => {
    let failNext = true;
    const store = mkStore({
      fs: {
        open: hookedHandles((fh) => ({
          write: async (buf, off, len, pos) => {
            if (failNext) {
              failNext = false;
              const e = new Error("ENOSPC") as Error & { code: string };
              e.code = "ENOSPC";
              throw e;
            }
            return fh.write(buf, off, len, pos);
          },
        })),
      },
    });
    await store.recover();
    const p = beginP({ size: 8 });
    await store.begin(p, dl());
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abcd") }, dl()),
      "E_INTERNAL",
    );
    expect((await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abcd") }, dl())).received).toBe(
      4,
    );
    await store.chunk({ principal: P1, id: p.id, offset: 4, bytes: Buffer.from("efgh") }, dl());
    const res = await store.commit({ principal: P1, id: p.id }, dl());
    expect(readFileSync(res.path, "utf8")).toBe("abcdefgh");
  });

  it("a failed truncate after a failed write poisons the upload and deletes the dir", async () => {
    let truncateBroken = false;
    const store = mkStore({
      fs: {
        open: hookedHandles((fh) => ({
          write: async () => {
            truncateBroken = true;
            const e = new Error("ENOSPC") as Error & { code: string };
            e.code = "ENOSPC";
            throw e;
          },
          truncate: (n) => {
            if (truncateBroken) {
              const e = new Error("EIO") as Error & { code: string };
              e.code = "EIO";
              return Promise.reject(e);
            }
            return fh.truncate(n);
          },
        })),
      },
    });
    await store.recover();
    const p = beginP({ size: 8 });
    await store.begin(p, dl());
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abcd") }, dl()),
      "E_INTERNAL",
    );
    await waitFor(() => !existsSync(`${root}/s-sess123/${p.id}`));
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abcd") }, dl()),
      "E_NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// hard gate 5 — deadline poisoning (#7)
// ---------------------------------------------------------------------------

describe("hard gate 5: deadline propagation and poisoning (§2.2.5 #7)", () => {
  it("a hung chunk write ⇒ E_DEADLINE, poisoned; the late completion changes nothing and the dir is deleted", async () => {
    let releaseWrite: (() => void) | undefined;
    let writeSettled = false;
    const store = mkStore({
      fs: {
        open: hookedHandles((fh) => ({
          write: (buf, off, len, pos) =>
            new Promise((resolve, reject) => {
              releaseWrite = () =>
                fh.write(buf, off, len, pos).then(
                  (r) => {
                    writeSettled = true;
                    resolve(r);
                  },
                  (e) => {
                    writeSettled = true; // the fd may already be closed by the poison path — settle either way
                    reject(e);
                  },
                );
            }),
        })),
      },
    });
    await store.recover();
    const p = beginP({ size: 6 });
    await store.begin(p, dl());
    expect(store.stats().inflightBytes).toBe(6);
    const chunkP = store.chunk(
      { principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") },
      { at: clock.now() + 120 },
    );
    await waitFor(() => releaseWrite !== undefined);
    await expectCode(() => chunkP, "E_DEADLINE");
    await expectCode(
      () => store.chunk({ principal: P1, id: p.id, offset: 3, bytes: Buffer.from("def") }, dl()),
      "E_NOT_FOUND",
    );
    await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_NOT_FOUND");
    releaseWrite!(); // the late fs result arrives — must not change any state
    await waitFor(() => writeSettled && !existsSync(`${root}/s-sess123/${p.id}`));
    expect(store.stats().inflightBytes).toBe(0); // quota rolled back
    expect(store.stats().committedFiles).toBe(0); // no index/meta ever created
    expect(audits.some((a) => a.phase === "reject" && a.code === "E_DEADLINE")).toBe(true);
  });

  it("a commit timeout leaves no committed form behind", async () => {
    let releaseLink: (() => void) | undefined;
    const store = mkStore({
      fs: {
        link: linkFault(
          (from, to) =>
            new Promise<void>((resolve, reject) => {
              releaseLink = () => realFs.link(from, to).then(resolve, reject);
            }),
        ),
      },
    });
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    const commitP = store.commit({ principal: P1, id: p.id }, { at: clock.now() + 120 });
    await waitFor(() => releaseLink !== undefined);
    await expectCode(() => commitP, "E_DEADLINE");
    releaseLink!();
    await waitFor(() => !existsSync(`${root}/s-sess123/${p.id}`));
    expect(store.stats().committedFiles).toBe(0);
    expect(store.stats().committedBytes).toBe(0);
  });

  it("an expired deadline at commit's dir fsync: syncDir never runs, no success reply, committed form removed", async () => {
    let dirSyncOpened = false;
    const store = mkStore({
      fs: {
        open: ((path: string, flags: number, mode?: number) => {
          if (flags === DIR_SYNC_FLAGS) dirSyncOpened = true; // syncDir's open(dir, O_RDONLY|O_DIRECTORY)
          return realFs.open(path, flags, mode);
        }) as UploadFsDeps["open"],
        rename: (from, to) =>
          realFs.rename(from, to).then(() => {
            // meta.json has landed (step 4) — now burn the rest of the request budget so the
            // advisory dir fsync (step 5) starts with an already-expired deadline
            if (to.endsWith("/meta.json")) clock.advance(10_000);
          }),
      },
    });
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    const idDir = `${root}/s-sess123/${p.id}`;
    // §2.2.5: the deadline lapses between meta write and dir fsync — the commit must NOT
    // return success (a meta.json is already on disk, so the poison must remove it)
    await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_DEADLINE");
    expect(dirSyncOpened).toBe(false); // 剩余 ≤ 0 ⇒ syncDir's open is never initiated
    await waitFor(() => !existsSync(idDir)); // poison cleanup removed the committed form
    expect(store.stats().committedFiles).toBe(0);
    expect(store.stats().committedBytes).toBe(0);
    // recovery agrees: no committed form left behind
    const store2 = mkStore();
    const report = await store2.recover();
    expect(report.committed).toBe(0);
    await store2.close();
  });

  it("a hung meta.json rename ⇒ E_DEADLINE, poisoned; the late rename changes nothing and the dir is deleted", async () => {
    let releaseRename: (() => void) | undefined;
    let renameSettled = false;
    const store = mkStore({
      fs: {
        rename: (from, to) => {
          if (!to.endsWith("/meta.json")) return realFs.rename(from, to);
          return new Promise<void>((resolve) => {
            releaseRename = () =>
              realFs.rename(from, to).then(
                () => {
                  renameSettled = true;
                  resolve();
                },
                () => {
                  // writeMetaAtomic's tmp cleanup is deadline-gated (§2.2.5): with the budget
                  // gone the unlink is never initiated and the tmp may linger in the doomed dir
                  renameSettled = true;
                  resolve();
                },
              );
          });
        },
      },
    });
    await store.recover();
    const p = beginP({ size: 3 });
    await store.begin(p, dl());
    await store.chunk({ principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") }, dl());
    const idDir = `${root}/s-sess123/${p.id}`;
    const commitP = store.commit({ principal: P1, id: p.id }, { at: clock.now() + 200 });
    await waitFor(() => releaseRename !== undefined);
    // no success reply is ever produced (§2.2.5)
    await expectCode(() => commitP, "E_DEADLINE");
    // poisoned: immediately out of the accepted set, state frozen
    await expectCode(() => store.commit({ principal: P1, id: p.id }, dl()), "E_NOT_FOUND");
    expect(store.stats().committedFiles).toBe(0);
    expect(store.stats().committedBytes).toBe(0);
    // the poison cleanup waits for the in-flight rename — release it late; it may even create
    // meta.json inside the doomed dir, but indexes/quota/meta must not change and the dir dies
    releaseRename!();
    await waitFor(() => renameSettled && !existsSync(idDir));
    expect(store.stats().committedFiles).toBe(0);
    expect(store.stats().inflightBytes).toBe(0);
    // and a fresh store over the same root sees no committed form left behind
    const store2 = mkStore();
    const report = await store2.recover();
    expect(report.committed).toBe(0);
    expect(store2.stats().committedFiles).toBe(0);
    await store2.close();
  });
});

// ---------------------------------------------------------------------------
// hard gate 6 — close (#13)
// ---------------------------------------------------------------------------

describe("hard gate 6: close (§2.6 #13)", () => {
  it("close() during a hung chunk write: ≤2s+ε, un-committed dirs gone, committed retained, late writes gated", async () => {
    const mutations: string[] = [];
    const track =
      <A extends unknown[]>(name: string, fn: (...a: A) => Promise<unknown>) =>
      (...a: A): Promise<unknown> => {
        mutations.push(name);
        return fn(...a);
      };
    let releaseWrite: (() => void) | undefined;
    let lateWriteLanded = false;
    const targetId = nid();
    const store = mkStore({
      fs: {
        mkdir: track("mkdir", realFs.mkdir) as UploadFsDeps["mkdir"],
        open: ((path: string, flags: number, mode?: number) => {
          mutations.push("open");
          return realFs.open(path, flags, mode).then((fh) => ({
            write: (buf: Buffer, off: number, len: number, pos: number) => {
              mutations.push("write");
              if (!path.includes(`/${targetId}/`)) return fh.write(buf, off, len, pos); // only the victim hangs
              return new Promise<{ bytesWritten: number }>((resolve) => {
                releaseWrite = () =>
                  // the underlying write REALLY lands late (POSIX: into the removed dir's
                  // unlinked inode) and its result settles back up THROUGH the wrapper layer —
                  // that is exactly the path the §2.6 #13 close gate must neutralize
                  fh.write(buf, off, len, pos).then((r) => {
                    lateWriteLanded = true;
                    resolve(r);
                  }, resolve);
              });
            },
            truncate: (n: number) => {
              mutations.push("truncate");
              return fh.truncate(n);
            },
            datasync: () => {
              mutations.push("datasync");
              return fh.datasync();
            },
            sync: () => {
              mutations.push("sync");
              return fh.sync();
            },
            stat: () => {
              mutations.push("stat");
              return fh.stat();
            },
            close: () => fh.close(), // fd hygiene: deliberately untracked
          }));
        }) as UploadFsDeps["open"],
        link: track("link", realFs.link) as UploadFsDeps["link"],
        unlink: track("unlink", realFs.unlink) as UploadFsDeps["unlink"],
        rename: track("rename", realFs.rename) as UploadFsDeps["rename"],
        rm: track("rm", realFs.rm) as UploadFsDeps["rm"],
        chmod: track("chmod", realFs.chmod) as UploadFsDeps["chmod"],
      },
    });
    await store.recover();
    const committed = await upload(store, "keep-me");
    const p = beginP({ id: targetId, size: 6 });
    await store.begin(p, dl());
    // no .catch here: the late-write's outcome at the store surface is part of the assertion
    const chunkP = store.chunk(
      { principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") },
      { at: clock.now() + 30_000 },
    );
    await waitFor(() => releaseWrite !== undefined);

    const t0 = Date.now();
    await store.close();
    expect(Date.now() - t0).toBeLessThan(2_600); // 2s settle + ε
    expect(existsSync(committed.path)).toBe(true); // committed retained
    expect(existsSync(`${root}/s-sess123/${p.id}`)).toBe(false); // un-committed removed

    const mark = mutations.length;
    const lateOpsBefore = store.stats().counters.lateOps;
    releaseWrite!(); // the hung write settles late — AFTER close returned
    // the close gate turns it into an observable no-op: a success reply is never produced
    await expectCode(() => chunkP, "E_DEADLINE");
    await waitFor(() => lateWriteLanded); // proof the late bytes really landed at the fs layer
    await new Promise((r) => setTimeout(r, 250));

    // zero OBSERVABLE side effects after close returned:
    expect(mutations.length).toBe(mark); // no further fs calls initiated through the wrapper
    expect(store.stats().counters.lateOps).toBeGreaterThan(lateOpsBefore); // the late write was dropped observably
    expect(log.lines.some((l) => l.level === "warn" && /store closed/.test(l.msg))).toBe(true);
    expect(store.stats().inflightBytes).toBe(0);
    // the committed INDEX is cleared by close() itself (its file on disk is asserted retained
    // above) — what matters is the late write changed nothing: no committed/inflight state reappeared
    expect(store.stats().committedFiles).toBe(0);

    await expectCode(() => store.begin(beginP(), dl()), "E_HUB_RESTARTING");
    await store.close(); // idempotent
  });
});

// ---------------------------------------------------------------------------
// unref'd timers (acceptance)
// ---------------------------------------------------------------------------

describe("all timers are unref'd (hasRef() === false)", () => {
  it("store lifecycle paths create no ref'd timers", async () => {
    const created: Array<{ hasRef(): boolean }> = [];
    const origSetTimeout = globalThis.setTimeout;
    const realSleep = (ms: number) => new Promise<void>((r) => origSetTimeout(r, ms));
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const t = origSetTimeout(fn, ms, ...(rest as []));
      created.push(t);
      return t;
    }) as typeof globalThis.setTimeout;
    try {
      let releaseWrite: (() => void) | undefined;
      const store = mkStore({
        fs: {
          open: hookedHandles(() => ({
            write: () =>
              new Promise<{ bytesWritten: number }>((resolve) => {
                releaseWrite = () => resolve({ bytesWritten: 0 });
              }),
          })),
        },
      });
      await store.recover();
      const p = beginP({ size: 3 });
      await store.begin(p, dl());
      const chunkP = store.chunk(
        { principal: P1, id: p.id, offset: 0, bytes: Buffer.from("abc") },
        { at: clock.now() + 80 },
      );
      while (releaseWrite === undefined) await realSleep(5);
      await expectCode(() => chunkP, "E_DEADLINE");
      releaseWrite!(); // raw write settles (as a short write) — poison cleanup proceeds
      for (let i = 0; i < 800 && existsSync(`${root}/s-sess123/${p.id}`); i++) await realSleep(5);
      expect(existsSync(`${root}/s-sess123/${p.id}`)).toBe(false);
      await store.close();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(created.length).toBeGreaterThan(0);
    for (const t of created) expect(t.hasRef()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// misc: stats / audit surfaces
// ---------------------------------------------------------------------------

describe("stats and audit surfaces", () => {
  it("stats reports scanning/counters; audit records requests and rejects; chunk success is unaudited", async () => {
    const store = mkStore();
    expect(store.stats().scanning).toBe(true); // recover not yet run
    const report = await store.recover();
    expect(report).toMatchObject({ completed: true, buckets: 0, ids: 0, committed: 0 });
    expect(store.stats().scanning).toBe(false);
    expect(store.stats().ready).toBe(true);

    await upload(store, "zz");
    await expectCode(() => store.begin(beginP({ id: "short" }), dl()), "E_BAD_REQUEST");
    const stats = store.stats();
    expect(stats.counters.requests).toBeGreaterThan(0);
    expect(stats.counters.rejects).toBe(1);
    expect(audits.filter((a) => a.phase === "request" && a.op === "begin").length).toBe(1);
    expect(audits.filter((a) => a.phase === "request" && a.op === "commit").length).toBe(1);
    expect(audits.filter((a) => a.phase === "reject" && a.code === "E_BAD_REQUEST").length).toBe(1);
    expect(audits.filter((a) => a.op === "chunk").length).toBe(0); // §5.4: chunk success has no audit line
  });
});

// ---------------------------------------------------------------------------
// web-hub-preview §4.2 — openForPreview (PV2b)
// ---------------------------------------------------------------------------

describe("preview read-back openForPreview (web-hub-preview §4.2, PV2b)", () => {
  const AGENT = "a4242-nonce12"; // beginP's agentKey — same default for preview requests
  const OTHER_SESSION = "sess999";

  function pv(over: Partial<OpenForPreviewParams> = {}): OpenForPreviewParams {
    return { principal: P1, listener: "lan", path: "", agentKey: AGENT, sessionId: "sess123", ...over };
  }

  function pvCtx(opts: { ms?: number; signal?: AbortSignal } = {}): {
    deadline: ReturnType<typeof dl>;
    signal: AbortSignal;
  } {
    return { deadline: dl(opts.ms ?? 5_000), signal: opts.signal ?? new AbortController().signal };
  }

  async function openPreview(
    store: UploadStore,
    over: Partial<OpenForPreviewParams> = {},
    ctx = pvCtx(),
  ): Promise<OpenForPreviewResult> {
    return store.openForPreview(pv(over), ctx);
  }

  function deny(r: OpenForPreviewResult, code: "E_BUSY" | "E_NOT_FOUND" | "E_PREVIEW_CHANGED" | "E_DEADLINE"): void {
    expect(r).toEqual({ ok: false, code });
  }

  interface CraftArgs {
    id?: string;
    bucket?: string;
    safeName: string;
    /** Present ⇒ the meta carries it (post-rework shape); absent ⇒ legacy meta with no field. */
    diskName?: string | undefined;
    content: string | Buffer;
    principal?: string;
    agentKey?: string;
    committedAt?: number;
    referencedAt?: number | null;
  }

  interface Crafted {
    id: string;
    path: string;
    meta: UploadMetaV1;
  }

  /** Lay down a crash-recovery-style committed upload by hand (bypasses begin/chunk/commit):
   *  `<root>/<bucket>/<id>/<fileName>` + meta.json, exactly what the startup scan expects. */
  function craft(over: CraftArgs): Crafted {
    const bucket = over.bucket ?? "s-sess123";
    const id = over.id ?? nid();
    const fileName = over.diskName ?? over.safeName;
    const bytes = typeof over.content === "string" ? Buffer.from(over.content, "utf8") : over.content;
    const dir = join(root, bucket, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), bytes);
    const meta: UploadMetaV1 = {
      v: 1,
      id,
      principal: over.principal ?? P1,
      agentKey: over.agentKey ?? AGENT,
      bucket,
      safeName: over.safeName,
      ...(over.diskName === undefined ? {} : { diskName: over.diskName }),
      size: bytes.length,
      mime: null,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      committedAt: over.committedAt ?? clock.now(),
      referencedAt: over.referencedAt ?? null,
    };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    return { id, path: join(dir, fileName), meta };
  }

  it("U3 matrix: owner / same-session peer / cross-session deny / session switch / loopback", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "hello!!", { name: "pic.png", mime: "image/png" });
    const oks: Array<Extract<OpenForPreviewResult, { ok: true }>> = [];

    // owner, same session (LAN) ⇒ own upload, shared:false
    const own = await openPreview(store, { path: res.path });
    expect(own).toMatchObject({
      ok: true,
      uploadId: res.id,
      shared: false,
      layout: "generated",
      size: 7,
      sha256: createHash("sha256").update("hello!!").digest("hex"),
    });
    if (own.ok) oks.push(own);

    // a LAN peer naming the SAME (visible) session ⇒ shared read (U3)
    const peer = await openPreview(store, { principal: P2, path: res.path });
    expect(peer).toMatchObject({ ok: true, uploadId: res.id, shared: true });
    if (peer.ok) oks.push(peer);

    // a peer with a DIFFERENT session's request ⇒ deny (no existence leak) — also with another agentKey
    deny(await openPreview(store, { principal: P2, path: res.path, sessionId: OTHER_SESSION }), "E_NOT_FOUND");
    deny(
      await openPreview(store, { principal: P2, path: res.path, agentKey: "a-other", sessionId: OTHER_SESSION }),
      "E_NOT_FOUND",
    );

    // owner AFTER the session switched (bucket no longer matches) ⇒ still reads their own upload
    const switched = await openPreview(store, { path: res.path, sessionId: OTHER_SESSION });
    expect(switched).toMatchObject({ ok: true, shared: false });
    if (switched.ok) oks.push(switched);

    // a peer after the session switched ⇒ deny
    deny(await openPreview(store, { principal: P2, path: res.path, sessionId: OTHER_SESSION }), "E_NOT_FOUND");

    // loopback (machine owner) ⇒ unrestricted, still flagged shared for audit when not the owner
    const loopback = await openPreview(store, {
      principal: P3,
      listener: "loopback",
      path: res.path,
      sessionId: OTHER_SESSION,
    });
    expect(loopback).toMatchObject({ ok: true, shared: true });
    if (loopback.ok) oks.push(loopback);

    for (const r of oks) await r.fh.close();
  });

  it("a-<agentKey> bucket: readable under the agent's current session by owner and peers; other agents deny", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "agentfile", { sessionId: undefined, name: "a.txt" });
    expect(res.path).toContain(join(root, `a-${AGENT}`));

    const own = await openPreview(store, { path: res.path, sessionId: "sess123" });
    expect(own).toMatchObject({ ok: true, shared: false }); // owner — sessionOk not even needed
    const peer = await openPreview(store, { principal: P2, path: res.path, sessionId: "sess123" });
    expect(peer).toMatchObject({ ok: true, shared: true }); // sessionOk via the a-bucket rule
    deny(
      await openPreview(store, { principal: P2, path: res.path, agentKey: "a-other", sessionId: "sess123" }),
      "E_NOT_FOUND",
    );
    for (const r of [own, peer]) if (r.ok) await r.fh.close();
  });

  it("a rec mid-eviction (state evicting) ⇒ E_NOT_FOUND", async () => {
    let gateId: string | null = null;
    const gate = deferred<void>();
    let rmStalled = false;
    const store = mkStore({
      fs: {
        rm: (p, opts) => {
          if (gateId !== null && p === join(root, "s-sess123", gateId)) {
            rmStalled = true;
            return gate.promise.then(() => realFs.rm(p, opts));
          }
          return realFs.rm(p, opts);
        },
      },
    });
    await store.recover();
    const res = await upload(store, "evictme");
    gateId = res.id;
    const abortP = store.abort({ principal: P1, id: res.id }, dl());
    await waitFor(() => rmStalled); // abort is now inside rm with the rec already `evicting`
    deny(await openPreview(store, { path: res.path }), "E_NOT_FOUND");
    gate.resolve();
    await abortP;
    expect(existsSync(join(root, "s-sess123", res.id))).toBe(false);
  });

  it("a path under the root but not in the index ⇒ E_NOT_FOUND with ZERO fs calls (as is a visibility deny)", async () => {
    let fsCalls = 0;
    const counted: UploadFsDeps = {
      ...realFs,
      lstat: (p) => (fsCalls++, realFs.lstat(p)),
      mkdir: (p, o) => (fsCalls++, realFs.mkdir(p, o)),
      chmod: (p, m) => (fsCalls++, realFs.chmod(p, m)),
      readdir: (p) => (fsCalls++, realFs.readdir(p)),
      open: (p, fl, m) => (fsCalls++, realFs.open(p, fl, m)),
      link: (a, b) => (fsCalls++, realFs.link(a, b)),
      unlink: (p) => (fsCalls++, realFs.unlink(p)),
      rename: (a, b) => (fsCalls++, realFs.rename(a, b)),
      rm: (p, o) => (fsCalls++, realFs.rm(p, o)),
      readFile: (p) => (fsCalls++, realFs.readFile(p)),
    };
    const store = mkStore({ fs: counted });
    await store.recover();
    const res = await upload(store, "counted");
    const before = fsCalls;
    deny(await openPreview(store, { path: join(root, "s-sess123", "nope0001aaaa1111zzzz", "f.txt") }), "E_NOT_FOUND");
    // checks 1–4 are all pre-fs: a visibility deny on an INDEXED path also never touches the disk
    deny(await openPreview(store, { principal: P2, path: res.path, sessionId: OTHER_SESSION }), "E_NOT_FOUND");
    expect(fsCalls).toBe(before);
    const ok = await openPreview(store, { path: res.path });
    expect(ok.ok).toBe(true);
    if (ok.ok) await ok.fh.close();
    expect(fsCalls).toBeGreaterThan(before); // control: a real open does
  });

  it("generated layout: the exact recorded path opens; any other spelling — including the ORIGINAL file name — denies", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "gen-bytes", { name: "final report.pdf" });
    const r = await openPreview(store, { path: res.path });
    expect(r).toMatchObject({ ok: true, layout: "generated", uploadId: res.id, size: 9, shared: false });
    if (r.ok) {
      await r.fh.close();
    }
    const dir = dirname(res.path);
    // the sanitized ORIGINAL name exists only inside meta.json — never as an openable path
    deny(await openPreview(store, { path: join(dir, "final_report.pdf") }), "E_NOT_FOUND");
    // trailing slash and a wrong bucket are plain byPath misses
    deny(await openPreview(store, { path: `${res.path}/` }), "E_NOT_FOUND");
    deny(await openPreview(store, { path: join(root, "s-sess999", res.id, basename(res.path)) }), "E_NOT_FOUND");
  });

  it("restart recovery (v3-3): an old-format upload (no meta.diskName) recovers onto the legacy branch, opens end-to-end, and its sha256 re-verifies", async () => {
    const bytes = "legacy-content-0123456789";
    const crafted = craft({ safeName: "old_file.txt", content: bytes, committedAt: clock.now() - 1000 });
    expect(readJson(join(dirname(crafted.path), "meta.json"))).not.toHaveProperty("diskName");
    const store = mkStore();
    const report = await store.recover();
    expect(report.committed).toBe(1);
    const r = await openPreview(store, { path: crafted.path });
    expect(r).toMatchObject({
      ok: true,
      layout: "legacy",
      uploadId: crafted.id,
      size: bytes.length,
      shared: false,
      sha256: crafted.meta.sha256,
    });
    if (r.ok) {
      // end-to-end read-back through the new positioned read(): whole file + sha256 re-check
      const buf = Buffer.alloc(bytes.length);
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await r.fh.read(buf, off, buf.length - off, off);
        if (bytesRead <= 0) break;
        off += bytesRead;
      }
      expect(off).toBe(bytes.length);
      expect(buf.toString("utf8")).toBe(bytes);
      expect(createHash("sha256").update(buf).digest("hex")).toBe(crafted.meta.sha256);
      await r.fh.close();
    }
    // the generated-form spelling of the same id does NOT open a legacy file
    deny(await openPreview(store, { path: join(dirname(crafted.path), `${crafted.id}.txt`) }), "E_NOT_FOUND");
  });

  it("structural re-check refuses a name that is neither the generated form nor the safeName (tampered meta)", async () => {
    // diskName locates the file for the scan, so this IS indexed — but preview must refuse it
    const crafted = craft({ safeName: "f.txt", diskName: "evil.pdf", content: "abcd" });
    const store = mkStore();
    const report = await store.recover();
    expect(report.committed).toBe(1);
    deny(await openPreview(store, { path: crafted.path }), "E_NOT_FOUND"); // basename evil.pdf ≠ safeName f.txt
    expect(existsSync(crafted.path)).toBe(true); // and nothing was deleted either
  });

  it("a legacy record whose safeName degenerates to the generated form still opens (classification is structural)", async () => {
    const id = nid();
    const crafted = craft({ id, safeName: `${id}.txt`, content: "degenerate" });
    const store = mkStore();
    await store.recover();
    const r = await openPreview(store, { path: crafted.path });
    // both branches open the same file here; the label follows the on-disk shape
    expect(r).toMatchObject({ ok: true, layout: "generated" });
    if (r.ok) await r.fh.close();
  });

  it("startup scan incomplete ⇒ E_BUSY; readable once the scan lands", async () => {
    let release: (() => void) | undefined;
    const store = mkStore({
      fs: {
        readdir: (p) =>
          p === root
            ? new Promise<string[]>((resolve) => {
                release = () => resolve([]);
              })
            : realFs.readdir(p),
      },
    });
    const rp = store.recover();
    await waitFor(() => release !== undefined);
    const unknown = join(root, "s-sess123", "x", "f.txt");
    deny(await openPreview(store, { path: unknown }), "E_BUSY");
    release!();
    await rp;
    deny(await openPreview(store, { path: unknown }), "E_NOT_FOUND"); // scan done ⇒ ordinary miss
  });

  it("a disabled store ⇒ E_NOT_FOUND; a closed store refuses preview opens (E_BUSY)", async () => {
    const disabled = mkStore({ root: "/bad\u0001root" });
    await disabled.recover();
    deny(await openPreview(disabled, { path: "/bad/x/y" }), "E_NOT_FOUND");

    const store = mkStore();
    await store.recover();
    const res = await upload(store, "bye");
    await store.close();
    deny(await openPreview(store, { path: res.path }), "E_BUSY");
  });

  it("dirChain replaced ⇒ E_PREVIEW_CHANGED, the anomaly is logged, and NOTHING is deleted", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "chain-bytes");
    // swap <id>/ for a symlink to an outside decoy dir holding an equally-sized file — a
    // deterministic identity change (rm+mkdir can re-use the freed inode on tmpfs)
    const outside = mkdtempSync(join(tmpdir(), "wh-pv-"));
    try {
      writeFileSync(join(outside, basename(res.path)), "decoybytes!");
      rmSync(dirname(res.path), { recursive: true, force: true });
      symlinkSync(outside, dirname(res.path));
      deny(await openPreview(store, { path: res.path }), "E_PREVIEW_CHANGED");
      expect(log.lines.some((l) => l.level === "error" && l.msg.includes("upload preview"))).toBe(true);
      // neither the replacement target nor the swapped link was deleted
      expect(lstatSync(dirname(res.path)).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, basename(res.path)))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("on-disk size ≠ recorded size ⇒ E_PREVIEW_CHANGED and the handle is closed again (no fd leak)", async () => {
    let opens = 0;
    let closes = 0;
    const store = mkStore({
      fs: {
        open: async (p, fl, m) => {
          opens++;
          const fh = await realFs.open(p, fl, m);
          return {
            ...plainDelegate(fh),
            close: async () => {
              closes++;
              await fh.close();
            },
          };
        },
      },
    });
    await store.recover();
    const res = await upload(store, "size-bytes-xx");
    writeFileSync(res.path, "now-longer-than-recorded"); // 23 bytes ≠ 14 recorded
    const o0 = opens;
    const c0 = closes;
    deny(await openPreview(store, { path: res.path }), "E_PREVIEW_CHANGED");
    expect(opens - o0).toBe(1); // exactly one preview open attempted…
    expect(closes - c0).toBe(1); // …and its handle was closed again
  });

  it("kind is decided by CONTENT, not the declared mime — the route-side sniff (fake here) reads via the returned handle", async () => {
    const store = mkStore();
    await store.recover();
    const pngMagic = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]);
    // sniff is PV2a's pure module; PV3 injects it at the route seam. This fake mirrors only its
    // magic-number contract to prove the store's plumbing never consults rec.mime.
    const fakeSniff = (sample: Uint8Array): "image" | "text" =>
      sample.length >= 4 && sample[0] === 0x89 && sample[1] === 0x50 && sample[2] === 0x4e && sample[3] === 0x47
        ? "image"
        : "text";
    const cases: Array<{ res: CommitResult; expected: "image" | "text" }> = [
      { res: await upload(store, "plain text content", { name: "lie.png", mime: "image/png" }), expected: "text" },
      { res: await upload(store, pngMagic, { name: "lie.txt", mime: "text/plain" }), expected: "image" },
    ];
    for (const { res, expected } of cases) {
      const r = await openPreview(store, { path: res.path });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const sample = Buffer.alloc(Math.min(r.size, 64 * 1024));
      let off = 0;
      while (off < sample.length) {
        const { bytesRead } = await r.fh.read(sample, off, sample.length - off, off);
        if (bytesRead <= 0) break;
        off += bytesRead;
      }
      expect(fakeSniff(sample.subarray(0, off))).toBe(expected);
      await r.fh.close();
    }
  });

  it("a preview read is NOT a reference: the unreferenced 24h TTL still evicts on schedule", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "ttl-bytes");
    const metaPath = join(dirname(res.path), "meta.json");
    const metaBefore = readFileSync(metaPath);
    clock.advance(23 * 3_600_000);
    const r = await openPreview(store, { path: res.path });
    expect(r.ok).toBe(true);
    if (r.ok) await r.fh.close();
    expect(readFileSync(metaPath).equals(metaBefore)).toBe(true); // no meta rewrite
    expect(store.stats().referencedFiles).toBe(0); // no reference gained
    expect((await store.sweep("tick")).evicted).toEqual([]); // 23h < 24h: untouched TTL
    clock.advance(2 * 3_600_000); // past committedAt + 24h
    expect((await store.sweep("tick")).evicted.map((e) => e.id)).toEqual([res.id]);
    expect(existsSync(res.path)).toBe(false);
  });

  it("a referenced upload keeps its referencedAt across a preview read (7d TTL intact)", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "refpv");
    const block = formatAttachmentBlock([{ path: res.path, mime: null, sizeLabel: "1 KB" }])!;
    const pin = store.pinForPrompt({ principal: P1, text: `x\n${block}` });
    expect(pin.ok).toBe(true);
    if (!pin.ok) return;
    store.settlePins(pin.token, "referenced");
    expect(store.stats().referencedFiles).toBe(1);
    const metaPath = join(dirname(res.path), "meta.json");
    await store.sweep("tick"); // flushReferences persists the now-dirty meta.json
    const metaBefore = readFileSync(metaPath);
    const referencedAt = (JSON.parse(metaBefore.toString("utf8")) as UploadMetaV1).referencedAt;
    expect(referencedAt).not.toBeNull();
    clock.advance(25 * 3_600_000); // past the 24h unreferenced TTL
    const r = await openPreview(store, { path: res.path });
    expect(r.ok).toBe(true);
    if (r.ok) await r.fh.close();
    expect(readFileSync(metaPath).equals(metaBefore)).toBe(true); // referencedAt untouched, no rewrite
    expect(store.stats().referencedFiles).toBe(1);
    expect((await store.sweep("tick")).evicted).toEqual([]); // referenced: survives
    clock.advance(7 * 24 * 3_600_000);
    expect((await store.sweep("tick")).evicted.map((e) => e.id)).toEqual([res.id]);
  });

  it("UploadFileHandle.read does positioned partial reads and returns 0 at/past EOF", async () => {
    const store = mkStore();
    await store.recover();
    const res = await upload(store, "0123456789abcdefghij"); // 20 bytes
    const r = await openPreview(store, { path: res.path });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = Buffer.alloc(3);
    expect((await r.fh.read(b, 0, 3, 2)).bytesRead).toBe(3);
    expect(b.toString("utf8")).toBe("234");
    expect((await r.fh.read(b, 1, 2, 18)).bytesRead).toBe(2); // partial window ending at EOF
    expect(b.toString("utf8", 1)).toBe("ij");
    expect((await r.fh.read(b, 0, 3, 20)).bytesRead).toBe(0); // at EOF
    expect((await r.fh.read(b, 0, 3, 100)).bytesRead).toBe(0); // past EOF
    await r.fh.close();
  });

  it("ctx.signal: pre-aborted fails fast with zero fs; abort mid-open ⇒ E_DEADLINE and the eventual fd is late-closed", async () => {
    let opens = 0;
    let closes = 0;
    let stallNext = false;
    const waiters: Array<() => void> = [];
    const store = mkStore({
      fs: {
        open: async (p, flags, mode) => {
          const fh = await realFs.open(p, flags, mode);
          opens++;
          const wrapped: UploadFileHandle = {
            ...plainDelegate(fh),
            close: async () => {
              closes++;
              await fh.close();
            },
          };
          if (stallNext) {
            stallNext = false;
            await new Promise<void>((r) => waiters.push(r));
          }
          return wrapped;
        },
      },
    });
    await store.recover();
    const res = await upload(store, "abortme");

    // pre-aborted: immediate E_DEADLINE, not even an open initiated
    const o0 = opens;
    deny(await openPreview(store, { path: res.path }, pvCtx({ signal: AbortSignal.abort() })), "E_DEADLINE");
    expect(opens).toBe(o0);

    // mid-flight: the abandoned open eventually resolves and is late-closed
    const ctl = new AbortController();
    stallNext = true;
    const pending = openPreview(store, { path: res.path }, pvCtx({ signal: ctl.signal }));
    await waitFor(() => opens === o0 + 1); // the preview open is now stalled inside fs.open
    ctl.abort();
    deny(await pending, "E_DEADLINE");
    for (const w of waiters.splice(0)) w();
    await waitFor(() => closes === opens); // late-close reaped the abandoned fd
  });
});
