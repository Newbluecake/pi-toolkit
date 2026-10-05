// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createUploads,
  MAX_CHUNK_ATTEMPTS,
  MAX_CONCURRENT_UPLOADS,
  type UploadSource,
} from "../../../src/web-hub/ui/src/composables/useUploads.js";
import type { UploadTransport } from "../../../src/web-hub/ui/src/transport/types.js";
import { UPLOAD_ATTACH_MAX_PER_MSG, UPLOAD_FILE_MAX_BYTES } from "../../../src/web-hub/protocol/upload.js";

/**
 * web-hub-upload plan §包 U4b: `useUploads` — tray admission (count/size/fingerprint), the
 * §4.3 scheduler (2 concurrent files per agent), the begin→chunk→commit driver with all of
 * §4.3's resume rules (idempotent begin `received`, timeout⇒begin-recheck, ≤3 attempts per
 * offset, 404 ⇒ failed + retry-under-fresh-id), tray removal (abort signal + abort endpoint),
 * and E_UPLOAD_GONE's `ready → failed` path. All state changes are asserted through the tray
 * ref — U4a's `attachmentReduce` is the reducer under everything.
 */

type Outcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; message?: string; retryable: boolean; retryAfterS?: number; received?: number };

interface BeginCall {
  agentKey: string;
  id: string;
  name: string;
  size: number;
  mime?: string;
}
interface ChunkCall {
  id: string;
  offset: number;
  bytes: Uint8Array;
  signal?: AbortSignal;
}

const flush = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Pattern-filled fake File: `slice(start,end)` returns exactly `data[start,end)`. */
function fakeFile(
  name: string,
  size: number,
  opts: { type?: string; lastModified?: number } = {},
): UploadSource & { data: Uint8Array } {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i % 251;
  return {
    name,
    size,
    type: opts.type ?? "",
    lastModified: opts.lastModified ?? 1_700_000_000_000,
    slice: (start = 0, end = size) => ({
      arrayBuffer: async () => data.slice(start, end).buffer,
    }),
    data,
  };
}

interface Handlers {
  begin?: (call: BeginCall, attempt: number) => Outcome | Promise<Outcome>;
  chunk?: (call: ChunkCall, attempt: number) => Outcome | Promise<Outcome>;
  commit?: (call: { id: string }, attempt: number) => Outcome | Promise<Outcome>;
  abort?: (call: { id: string }) => Outcome | Promise<Outcome>;
}

function harness(handlers: Handlers = {}, opts: { chunkBytes?: number; gatedChunk?: boolean } = {}) {
  const chunkBytes = opts.chunkBytes ?? 4;
  const calls = {
    begin: [] as BeginCall[],
    chunk: [] as ChunkCall[],
    commit: [] as { id: string }[],
    abort: [] as { id: string }[],
  };
  const sizes = new Map<string, number>(); // id → declared size, so commit replies like the hub
  const counters = new Map<string, number>();
  const attemptOf = (key: string): number => {
    const v = (counters.get(key) ?? 0) + 1;
    counters.set(key, v);
    return v;
  };
  // gated-chunk machinery: chunk promises park until `release()` (or the merged abort fires,
  // emulating the real transports' external-signal merge — pinned separately in
  // transport-contract.test.ts).
  let inflight = 0;
  let maxInflight = 0;
  const waiters: Array<() => void> = [];
  const transport: UploadTransport = {
    begin: async (p) => {
      calls.begin.push(p as BeginCall);
      sizes.set(p.id, p.size);
      const attempt = attemptOf(`begin:${p.id}`);
      const out = handlers.begin
        ? await handlers.begin(p as BeginCall, attempt)
        : { ok: true as const, data: { id: p.id, chunkBytes, maxBytes: UPLOAD_FILE_MAX_BYTES, received: 0 } };
      return out;
    },
    chunk: (p, signal) => {
      const call: ChunkCall = { ...p, ...(signal !== undefined ? { signal } : {}) };
      calls.chunk.push(call);
      const attempt = attemptOf(`chunk:${p.id}:${p.offset}`);
      if (handlers.chunk) return Promise.resolve(handlers.chunk(call, attempt));
      if (!opts.gatedChunk) {
        return Promise.resolve({ ok: true as const, data: { received: p.offset + p.bytes.length } });
      }
      return new Promise((resolve) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        let settled = false;
        const done = (outcome: Outcome): void => {
          if (settled) return;
          settled = true;
          inflight--;
          resolve(outcome as never);
        };
        waiters.push(() => done({ ok: true, data: { received: p.offset + p.bytes.length } }));
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", () => done({ ok: false, error: "E_ABORT", retryable: false }), {
            once: true,
          });
        }
      }) as Promise<never>;
    },
    commit: async (p) => {
      calls.commit.push(p);
      const attempt = attemptOf(`commit:${p.id}`);
      const out = handlers.commit
        ? await handlers.commit(p, attempt)
        : {
            ok: true as const,
            data: { id: p.id, path: `/uploads/s-1/${p.id}/file.png`, size: sizes.get(p.id) ?? 0, mime: "image/png" },
          };
      return out;
    },
    abort: async (p) => {
      calls.abort.push(p);
      const out = handlers.abort ? await handlers.abort(p) : { ok: true as const, data: { ok: true } };
      return out;
    },
  };
  let seq = 0;
  const uploads = createUploads({
    upload: transport,
    newId: () => `id${String(++seq).padStart(20, "0")}`,
  });
  const drain = async (): Promise<void> => {
    for (;;) {
      const round = waiters.splice(0);
      if (round.length === 0) {
        await flush();
        if (waiters.length === 0) return;
        continue;
      }
      for (const w of round) w();
      await flush();
    }
  };
  return { uploads, calls, drain, stats: () => ({ inflight, maxInflight, waiters: waiters.length }) };
}

const stateOf = (h: ReturnType<typeof harness>, agentKey = "A") =>
  h.uploads.tray(agentKey).value.map((x) => ({ id: x.id, state: x.state, bytes: x.uploadedBytes, error: x.error }));

describe("useUploads: tray admission (§2.4/§2.5 — U4b's share of the U4a split)", () => {
  it("rejects files over UPLOAD_FILE_MAX_BYTES (100 MiB) as too-large, admits the rest", () => {
    const h = harness();
    const r = h.uploads.add("A", [fakeFile("big.bin", UPLOAD_FILE_MAX_BYTES + 1), fakeFile("ok.bin", 10)]);
    expect(r.added).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(["too-large"]);
    expect(h.uploads.tray("A").value).toHaveLength(1);
    expect(h.uploads.tray("A").value[0]!.name).toBe("ok.bin");
  });

  it(`caps the tray at UPLOAD_ATTACH_MAX_PER_MSG (${UPLOAD_ATTACH_MAX_PER_MSG})`, () => {
    const h = harness();
    const files = Array.from({ length: UPLOAD_ATTACH_MAX_PER_MSG + 2 }, (_, i) => fakeFile(`f${i}.bin`, 1));
    const r = h.uploads.add("A", files);
    expect(r.added).toHaveLength(UPLOAD_ATTACH_MAX_PER_MSG);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected.every((x) => x.reason === "too-many")).toBe(true);
  });

  it("dedups by fingerprint (name+size+lastModified+type) — the same File twice keeps one entry", () => {
    const h = harness();
    const a = fakeFile("a.png", 10, { type: "image/png", lastModified: 5 });
    const b = fakeFile("a.png", 10, { type: "image/png", lastModified: 5 }); // identical fingerprint
    const c = fakeFile("a.png", 11, { type: "image/png", lastModified: 5 }); // different size
    const r = h.uploads.add("A", [a, b, c]);
    expect(r.added).toHaveLength(2);
    expect(r.rejected.map((x) => x.reason)).toEqual(["duplicate"]);
  });

  it("rejects junk (non-file values) as invalid; valid items carry name/size/mime (empty type ⇒ null)", () => {
    const h = harness();
    const r = h.uploads.add("A", [null, "x", 5, fakeFile("m.png", 3, { type: "image/png" }), fakeFile("t.bin", 3)]);
    expect(r.rejected.filter((x) => x.reason === "invalid")).toHaveLength(3);
    const tray = h.uploads.tray("A").value;
    expect(tray[0]!.mime).toBe("image/png");
    expect(tray[1]!.mime).toBeNull();
    // The driver starts synchronously on add (§4.3), so the two admitted items may already be
    // uploading — "queued" itself is U4a's reducer state, matrix-tested in logic-upload.test.ts.
    expect(tray.every((x) => x.state === "uploading" || x.state === "queued")).toBe(true);
    expect(tray.every((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x.id))).toBe(true);
  });

  it("trays are per-agent and survive independently (§4.3 Composer-local state)", () => {
    const h = harness();
    h.uploads.add("A", [fakeFile("a.bin", 1)]);
    h.uploads.add("B", [fakeFile("b.bin", 2)]);
    expect(h.uploads.tray("A").value.map((x) => x.name)).toEqual(["a.bin"]);
    expect(h.uploads.tray("B").value.map((x) => x.name)).toEqual(["b.bin"]);
  });
});

describe("useUploads: the begin → chunk loop → commit driver (§4.3)", () => {
  it("happy path: sequential chunks at the hub's chunkBytes, byte-exact slices, commit, ready", async () => {
    const h = harness({}, { chunkBytes: 4 });
    const f = fakeFile("shot.png", 10, { type: "image/png" });
    const r = h.uploads.add("A", [f]);
    await flush();
    const id = r.added[0]!;
    expect(h.calls.begin).toHaveLength(1);
    expect(h.calls.begin[0]).toMatchObject({ agentKey: "A", name: "shot.png", size: 10, mime: "image/png" });
    expect(h.calls.chunk.map((c) => c.offset)).toEqual([0, 4, 8]);
    for (const c of h.calls.chunk) {
      expect(Array.from(c.bytes)).toEqual(Array.from(f.data.slice(c.offset, c.offset + c.bytes.length)));
    }
    expect(h.calls.commit).toHaveLength(1);
    const item = h.uploads.tray("A").value[0]!;
    expect(item.state).toBe("ready");
    expect(item.path).toBe(`/uploads/s-1/${id}/file.png`);
    expect(item.uploadedBytes).toBe(10);
    expect(item.mime).toBe("image/png");
  });

  it("a zero-size file skips chunking entirely and commits straight away", async () => {
    const h = harness();
    h.uploads.add("A", [fakeFile("empty.bin", 0)]);
    await flush();
    expect(h.calls.chunk).toHaveLength(0);
    expect(h.calls.commit).toHaveLength(1);
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
  });

  it("resume: begin's idempotent received>0 replans from there — the landed prefix is never re-sent", async () => {
    const h = harness({
      begin: (call, attempt) => ({
        ok: true,
        data: { id: call.id, chunkBytes: 4, maxBytes: UPLOAD_FILE_MAX_BYTES, received: attempt === 1 ? 6 : 6 },
      }),
    });
    h.uploads.add("A", [fakeFile("a.bin", 10)]);
    await flush();
    expect(h.calls.chunk.map((c) => c.offset)).toEqual([6]);
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
  });

  it("chunk timeout ⇒ idempotent begin re-check, same offset retried (§4.3), then succeeds", async () => {
    const h = harness({
      chunk: (call, attempt) =>
        attempt === 1
          ? { ok: false, error: "E_DEADLINE", retryable: true }
          : { ok: true, data: { received: call.offset + call.bytes.length } },
    });
    h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    expect(h.calls.chunk.map((c) => c.offset)).toEqual([0, 0]); // same offset retried
    expect(h.calls.begin).toHaveLength(2); // begin re-check took the authoritative received
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
  });

  it("chunk timeout that actually LANDED: begin re-check advances received — no wasted re-send", async () => {
    const h = harness({
      chunk: (call, attempt) =>
        call.offset === 0 && attempt === 1
          ? { ok: false, error: "E_NETWORK", retryable: true }
          : { ok: true, data: { received: call.offset + call.bytes.length } },
      begin: (call, attempt) => ({
        ok: true,
        data: { id: call.id, chunkBytes: 4, maxBytes: UPLOAD_FILE_MAX_BYTES, received: attempt === 1 ? 0 : 4 },
      }),
    });
    h.uploads.add("A", [fakeFile("a.bin", 8)]);
    await flush();
    expect(h.calls.chunk.map((c) => c.offset)).toEqual([0, 4]); // offset 4 landed server-side; only the rest is sent
    expect(h.calls.begin).toHaveLength(2);
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
  });

  it(`same-offset failures stop at MAX_CHUNK_ATTEMPTS (${MAX_CHUNK_ATTEMPTS}) ⇒ failed with the transient error`, async () => {
    const h = harness({
      chunk: () => ({ ok: false, error: "E_NETWORK", retryable: true }),
    });
    h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    expect(h.calls.chunk).toHaveLength(MAX_CHUNK_ATTEMPTS);
    const item = h.uploads.tray("A").value[0]!;
    expect(item.state).toBe("failed");
    expect(item.error).toBe("E_NETWORK");
    expect(item.retryable).toBe(true);
  });

  it("409 E_UPLOAD_OFFSET resyncs from the reply's received without a begin round-trip", async () => {
    const h = harness({
      chunk: (call) =>
        call.offset === 0
          ? { ok: false, error: "E_UPLOAD_OFFSET", received: 4, retryable: false }
          : { ok: true, data: { received: call.offset + call.bytes.length } },
    });
    h.uploads.add("A", [fakeFile("a.bin", 8)]);
    await flush();
    expect(h.calls.chunk.map((c) => c.offset)).toEqual([0, 4]);
    expect(h.calls.begin).toHaveLength(1);
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
  });

  it("404 mid-upload ⇒ failed (retryable — the 404 default is false), retry() starts over under a FRESH id", async () => {
    let failChunks = true; // only the FIRST upload's chunks 404 — the retry must succeed
    const h = harness({
      chunk: (call) =>
        failChunks
          ? { ok: false, error: "E_NOT_FOUND", retryable: false }
          : { ok: true, data: { received: call.offset + call.bytes.length } },
    });
    const r = h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    const id1 = r.added[0]!;
    const item = h.uploads.tray("A").value[0]!;
    expect(item.state).toBe("failed");
    expect(item.retryable).toBe(true); // U4b: 404 means hub restart/void — retry with a new id helps
    failChunks = false;
    h.uploads.retry("A", id1);
    await flush();
    const item2 = h.uploads.tray("A").value[0]!;
    expect(item2.id).not.toBe(id1);
    expect(item2.state).toBe("ready");
    expect(h.calls.begin.map((b) => b.id)).toEqual([id1, item2.id]);
    expect(h.calls.abort.map((a) => a.id)).toEqual([id1]); // the abandoned partial is voided
  });

  it("begin failures map straight into the failed state (E_BUSY exhausted ⇒ retryable; E_UPLOAD_DISABLED ⇒ not)", async () => {
    const h = harness({ begin: () => ({ ok: false, error: "E_BUSY", retryable: true, retryAfterS: 1 }) });
    h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    expect(h.uploads.tray("A").value[0]!).toMatchObject({ state: "failed", error: "E_BUSY", retryable: true });

    const h2 = harness({
      begin: () => ({
        ok: false,
        error: "E_UPLOAD_DISABLED",
        message: "agent does not advertise upload capability",
        retryable: false,
      }),
    });
    h2.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    expect(h2.uploads.tray("A").value[0]!).toMatchObject({
      state: "failed",
      error: "E_UPLOAD_DISABLED",
      retryable: false,
    });
  });

  it("begin's maxBytes below the file size fails E_UPLOAD_TOO_LARGE (hub-side cap drift, defensive)", async () => {
    const h = harness({
      begin: (call) => ({ ok: true, data: { id: call.id, chunkBytes: 4, maxBytes: 2, received: 0 } }),
    });
    h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    expect(h.calls.chunk).toHaveLength(0);
    expect(h.uploads.tray("A").value[0]!).toMatchObject({ state: "failed", error: "E_UPLOAD_TOO_LARGE" });
  });
});

describe(`useUploads: scheduling (§4.3 — ≤${MAX_CONCURRENT_UPLOADS} concurrent files per agent, sequential chunks)`, () => {
  it("a third file stays queued until a running one settles; two files' chunks overlap in flight", async () => {
    const h = harness({}, { chunkBytes: 4, gatedChunk: true });
    h.uploads.add("A", [fakeFile("a.bin", 8), fakeFile("b.bin", 8), fakeFile("c.bin", 8)]);
    await flush();
    // Cap: only two files ever began.
    expect(h.calls.begin.map((b) => b.name).sort()).toEqual(["a.bin", "b.bin"]);
    await h.drain();
    expect(h.calls.begin).toHaveLength(3);
    expect(h.calls.commit).toHaveLength(3);
    expect(h.stats().maxInflight).toBe(MAX_CONCURRENT_UPLOADS); // a.bin's and b.bin's chunks were both parked
    expect(stateOf(h)).toEqual([
      { id: expect.any(String), state: "ready", bytes: 8, error: undefined },
      { id: expect.any(String), state: "ready", bytes: 8, error: undefined },
      { id: expect.any(String), state: "ready", bytes: 8, error: undefined },
    ]);
  });

  it("a slot freed by a FAILED upload also admits the queued one (its begin fails instantly)", async () => {
    const h = harness(
      {
        begin: (call) =>
          call.name === "bad.bin"
            ? { ok: false, error: "E_UPLOAD_QUOTA", retryable: true }
            : { ok: true, data: { id: call.id, chunkBytes: 4, maxBytes: UPLOAD_FILE_MAX_BYTES, received: 0 } },
      },
      { chunkBytes: 4, gatedChunk: true },
    );
    h.uploads.add("A", [fakeFile("bad.bin", 4), fakeFile("ok1.bin", 4), fakeFile("ok2.bin", 4)]);
    await flush();
    // bad.bin's begin failed on the first microtask hop, freeing its slot while ok1's chunk is
    // still parked — so ok2 was admitted without waiting for ok1 to finish.
    expect(h.calls.begin.map((b) => b.name)).toEqual(["bad.bin", "ok1.bin", "ok2.bin"]);
    expect(h.stats().inflight).toBe(MAX_CONCURRENT_UPLOADS); // ok1 + ok2 parked; bad is done
    await h.drain();
    expect(h.uploads.tray("A").value.map((x) => [x.name, x.state])).toEqual([
      ["bad.bin", "failed"],
      ["ok1.bin", "ready"],
      ["ok2.bin", "ready"],
    ]);
  });
});

describe("useUploads: removal (§4.2 — abort the in-flight request AND call the abort endpoint)", () => {
  it("removing an uploading item: signal aborted, abort endpoint called, item leaves the tray", async () => {
    const h = harness({}, { chunkBytes: 4, gatedChunk: true });
    const r = h.uploads.add("A", [fakeFile("a.bin", 64)]);
    const id = r.added[0]!;
    await flush();
    expect(h.uploads.tray("A").value[0]!.state).toBe("uploading");
    h.uploads.remove("A", id);
    await flush();
    // The in-flight chunk's merged signal fired…
    const lastChunk = h.calls.chunk.at(-1)!;
    expect(lastChunk.signal?.aborted).toBe(true);
    // …and the abort endpoint was asked to delete the begun upload's server state.
    expect(h.calls.abort.map((a) => a.id)).toEqual([id]);
    expect(h.uploads.tray("A").value).toHaveLength(0);
    expect(h.calls.commit).toHaveLength(0);
  });

  it("removing a QUEUED (never begun) item sends no abort request and drops immediately", async () => {
    const h = harness({}, { chunkBytes: 4, gatedChunk: true });
    const r = h.uploads.add("A", [fakeFile("a.bin", 64), fakeFile("b.bin", 64), fakeFile("c.bin", 4)]);
    const queuedId = r.added[2]!;
    await flush();
    expect(h.uploads.tray("A").value.find((x) => x.id === queuedId)!.state).toBe("queued");
    h.uploads.remove("A", queuedId);
    await flush();
    expect(h.calls.abort).toHaveLength(0);
    expect(h.uploads.tray("A").value.find((x) => x.id === queuedId)).toBeUndefined();
    await h.drain();
  });

  it("removing a READY item still calls the abort endpoint (§2.6: the committed file is deleted)", async () => {
    const h = harness();
    const r = h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    const id = r.added[0]!;
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
    h.uploads.remove("A", id);
    await flush();
    expect(h.calls.abort.map((a) => a.id)).toEqual([id]);
    expect(h.uploads.tray("A").value).toHaveLength(0);
  });

  it("dispose() aborts everything and clears all trays", async () => {
    const h = harness({}, { chunkBytes: 4, gatedChunk: true });
    h.uploads.add("A", [fakeFile("a.bin", 64)]);
    h.uploads.add("B", [fakeFile("b.bin", 64)]);
    await flush();
    h.uploads.dispose();
    await flush();
    for (const c of h.calls.chunk) expect(c.signal?.aborted).toBe(true);
    expect(h.uploads.tray("A").value).toHaveLength(0);
    expect(h.uploads.tray("B").value).toHaveLength(0);
  });
});

describe("useUploads: E_UPLOAD_GONE (§2.6 v3 #8 — ready → failed, re-upload on retry)", () => {
  it("failGone moves ready items to failed E_UPLOAD_GONE retryable; retry re-uploads from scratch", async () => {
    const h = harness();
    const r = h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    const id = r.added[0]!;
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
    h.uploads.failGone("A", [id, "not-an-id"]);
    const item = h.uploads.tray("A").value[0]!;
    expect(item.state).toBe("failed");
    expect(item.error).toBe("E_UPLOAD_GONE");
    expect(item.retryable).toBe(true);
    // The File is still retained — retry re-uploads under a fresh id and reaches ready again.
    h.uploads.retry("A", id);
    await flush();
    const again = h.uploads.tray("A").value[0]!;
    expect(again.state).toBe("ready");
    expect(again.id).not.toBe(id);
    expect(h.calls.begin).toHaveLength(2);
  });
});

describe("useUploads: progress reporting", () => {
  it("uploadedBytes follows the authoritative received and never exceeds size", async () => {
    const h = harness(
      {
        chunk: (call) => ({ ok: true, data: { received: Math.min(call.offset + call.bytes.length + 2, 10) } }),
      },
      { chunkBytes: 4 },
    );
    h.uploads.add("A", [fakeFile("a.bin", 10)]);
    await flush();
    const item = h.uploads.tray("A").value[0]!;
    expect(item.state).toBe("ready");
    expect(item.uploadedBytes).toBe(10);
  });
});

describe("useUploads: discard (§3.2 post-send tray clear — U5 patch, NEVER the abort endpoint)", () => {
  it("discard clears ready items without calling abort; a user remove still calls abort", async () => {
    const h = harness();
    const r = h.uploads.add("A", [fakeFile("a.bin", 4)]);
    await flush();
    const id = r.added[0]!;
    expect(h.uploads.tray("A").value[0]!.state).toBe("ready");
    h.uploads.discard?.("A");
    await flush();
    // The just-sent prompt references the hub path — an abort would delete the committed file.
    expect(h.calls.abort).toHaveLength(0);
    expect(h.uploads.tray("A").value).toHaveLength(0);

    // Contrast (plan-author ruling §6-U5 ④): the tray's user remove button still aborts.
    const r2 = h.uploads.add("A", [fakeFile("b.bin", 4)]);
    await flush();
    h.uploads.remove("A", r2.added[0]!);
    await flush();
    expect(h.calls.abort.map((a) => a.id)).toEqual([r2.added[0]!]);
  });

  it("discard aborts the in-flight fetch locally (controller only) and never hits the abort endpoint", async () => {
    const h = harness({}, { chunkBytes: 4, gatedChunk: true });
    h.uploads.add("A", [fakeFile("a.bin", 64)]);
    await flush();
    expect(h.uploads.tray("A").value[0]!.state).toBe("uploading");
    h.uploads.discard?.("A");
    await flush();
    expect(h.calls.chunk[0]!.signal?.aborted).toBe(true);
    expect(h.calls.abort).toHaveLength(0);
    expect(h.uploads.tray("A").value).toHaveLength(0);
  });

  it("discard(ids) drops only the listed ids and tolerates unknown ones", async () => {
    const h = harness();
    const r = h.uploads.add("A", [fakeFile("a.bin", 4), fakeFile("b.bin", 4)]);
    await flush();
    const [keep, drop] = r.added;
    h.uploads.discard?.("A", [drop!, "not-an-id"]);
    await flush();
    expect(h.calls.abort).toHaveLength(0);
    expect(h.uploads.tray("A").value.map((x) => x.id)).toEqual([keep]);
  });
});
