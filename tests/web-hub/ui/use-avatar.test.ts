// @vitest-environment node
import { readFileSync } from "node:fs";
import { ref } from "vue";
import { describe, expect, it } from "vitest";
import { useAvatar } from "../../../src/web-hub/ui/src/composables/useAvatar.js";
import type { AvatarFetchOutcome, AvatarWriteOutcome } from "../../../src/web-hub/protocol/avatar.js";
import type { AvatarTransport } from "../../../src/web-hub/ui/src/transport/types.js";

const png = new Blob([readFileSync("tests/fixtures/web-hub-avatar/chrome-canvas.png")], { type: "image/png" });
const v = "a".repeat(64);
const w = "b".repeat(64);
const x = "c".repeat(64);
const A = { pid: 1, startedAt: 10 };
const B = { pid: 2, startedAt: 20 };
const dataA = "data:image/png;base64,QQ==";
const dataB = "data:image/png;base64,Qg==";

type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function reader(): {
  result: string | ArrayBuffer | null;
  addEventListener(type: "load" | "error", fn: () => void): void;
  readAsDataURL(blob: Blob): void;
} {
  const listeners = new Map<string, () => void>();
  const out = {
    result: null as string | ArrayBuffer | null,
    addEventListener(type: "load" | "error", fn: () => void): void {
      listeners.set(type, fn);
    },
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then((bytes) => {
        out.result = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
        listeners.get("load")?.();
      });
    },
  };
  return out;
}
function makeTransport(
  fetch: (opts: { readonly signal: AbortSignal }) => Promise<AvatarFetchOutcome>,
  upload: (bytes: Uint8Array, opts?: { readonly signal?: AbortSignal }) => Promise<AvatarWriteOutcome> = async () => ({
    ok: false,
    error: "E_UNSUPPORTED",
  }),
): AvatarTransport {
  return { fetch, upload, remove: async () => ({ ok: false, error: "E_UNSUPPORTED" }) };
}
function makeHandle(transport: AvatarTransport): ReturnType<typeof useAvatar> {
  return useAvatar({ transport, createFileReader: reader });
}
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
function okFetch(etag: string): AvatarFetchOutcome {
  return { ok: true, bytes: png, etag, side: 256 };
}
function okWrite(hub: typeof A | typeof B, gen: number, value: string): AvatarWriteOutcome {
  return {
    ok: true,
    data: { hub: { pid: hub.pid, startedAt: hub.startedAt }, avatar: { gen, v: value, side: 256, bytes: 1 } },
  };
}

describe("useAvatar §4.3 R1–R4 ordering", () => {
  it("R2: reply before frame is retained, while a later stale frame is dropped", async () => {
    const upload = deferred<AvatarWriteOutcome>();
    const handle = makeHandle(
      makeTransport(
        async () => ({ ok: false, error: "E_ABORT" }),
        () => upload.promise,
      ),
    );
    const request = handle.upload(new Uint8Array([1]), dataA);
    upload.resolve(okWrite(A, 2, v));
    await request;
    handle.observe({ hub: A, avatar: { gen: 1, v: w } });
    expect(handle.best.value).toEqual({ id: "1:10", gen: 2, v });
    expect(handle.src.value).toBe(dataA);
  });

  it("R2/R3: frame before reply lets the newer reply supersede and abort the old fetch", async () => {
    const oldFetch = deferred<AvatarFetchOutcome>();
    const upload = deferred<AvatarWriteOutcome>();
    let aborted = false;
    const handle = makeHandle(
      makeTransport(
        ({ signal }) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return oldFetch.promise;
        },
        () => upload.promise,
      ),
    );
    handle.observe({ hub: A, avatar: { gen: 1, v } });
    const request = handle.upload(new Uint8Array([1]), dataB);
    upload.resolve(okWrite(A, 2, w));
    await request;
    expect(handle.best.value).toEqual({ id: "1:10", gen: 2, v: w });
    expect(aborted).toBe(true);
    oldFetch.resolve(okFetch(`"${v}"`));
    await flush();
    expect(handle.best.value?.v).toBe(w);
  });

  it("R1: a stale-generation frame arriving late cannot replace the best frame", () => {
    const handle = makeHandle(makeTransport(async () => ({ ok: false, error: "E_ABORT" })));
    handle.observe({ hub: A, avatar: { gen: 2, v } });
    handle.observe({ hub: A, avatar: { gen: 1, v: w } });
    expect(handle.best.value).toEqual({ id: "1:10", gen: 2, v });
  });

  it("R1: a hub identity change resets the generation baseline", () => {
    const handle = makeHandle(makeTransport(async () => ({ ok: false, error: "E_ABORT" })));
    handle.observe({ hub: A, avatar: { gen: 9, v } });
    handle.observe({ hub: B, avatar: { gen: 1, v: w } });
    expect(handle.best.value).toEqual({ id: "2:20", gen: 1, v: w });
  });

  it("R2: a late reply from an old hub process is dropped", async () => {
    const uploads: Array<Deferred<AvatarWriteOutcome>> = [];
    const handle = makeHandle(
      makeTransport(
        async () => ({ ok: false, error: "E_ABORT" }),
        () => {
          const wait = deferred<AvatarWriteOutcome>();
          uploads.push(wait);
          return wait.promise;
        },
      ),
    );
    handle.observe({ hub: A, avatar: { gen: 1, v } });
    const oldReply = handle.upload(new Uint8Array([1]), dataA);
    handle.observe({ hub: B, avatar: { gen: 1, v: w } });
    uploads[0]!.resolve(okWrite(A, 99, x));
    await oldReply;
    expect(handle.best.value).toEqual({ id: "2:20", gen: 1, v: w });
  });

  it("R1: A→B→A accepts the new process even when its generation is lower", () => {
    const handle = makeHandle(makeTransport(async () => ({ ok: false, error: "E_ABORT" })));
    handle.observe({ hub: A, avatar: { gen: 8, v } });
    handle.observe({ hub: B, avatar: { gen: 1, v: w } });
    handle.observe({ hub: A, avatar: { gen: 1, v: x } });
    expect(handle.best.value).toEqual({ id: "1:10", gen: 1, v: x });
  });

  it("R4: an ETag that differs from the observed v is discarded", async () => {
    const fetch = deferred<AvatarFetchOutcome>();
    const handle = makeHandle(makeTransport(() => fetch.promise));
    handle.observe({ hub: A, avatar: { gen: 1, v } });
    fetch.resolve(okFetch(`"${w}"`));
    await flush();
    expect(handle.src.value).toBeNull();
  });

  it("R4: a failed old fetch cannot clear a later successful v", async () => {
    const first = deferred<AvatarFetchOutcome>();
    const second = deferred<AvatarFetchOutcome>();
    let calls = 0;
    const handle = makeHandle(makeTransport(() => (++calls === 1 ? first.promise : second.promise)));
    handle.observe({ hub: A, avatar: { gen: 1, v } });
    handle.observe({ hub: A, avatar: { gen: 2, v: w } });
    second.resolve(okFetch(`"${w}"`));
    await flush();
    expect(handle.src.value).toMatch(/^data:image\/png;base64,/);
    first.reject(new Error("late old failure"));
    await flush();
    expect(handle.src.value).toMatch(/^data:image\/png;base64,/);
  });

  it("R1/R2: interleaved writes on two browser instances converge on the latest gen", async () => {
    const waits: Array<Deferred<AvatarWriteOutcome>> = [];
    const fetches: Array<Deferred<AvatarFetchOutcome>> = [];
    const transport = makeTransport(
      () => {
        const wait = deferred<AvatarFetchOutcome>();
        fetches.push(wait);
        return wait.promise;
      },
      () => {
        const wait = deferred<AvatarWriteOutcome>();
        waits.push(wait);
        return wait.promise;
      },
    );
    const left = makeHandle(transport);
    const right = makeHandle(transport);
    const leftWrite = left.upload(new Uint8Array([1]), dataA);
    const rightWrite = right.upload(new Uint8Array([2]), dataB);
    waits[1]!.resolve(okWrite(A, 2, w));
    waits[0]!.resolve(okWrite(A, 1, v));
    await Promise.all([leftWrite, rightWrite]);
    left.observe({ hub: A, avatar: { gen: 2, v: w } });
    right.observe({ hub: A, avatar: { gen: 2, v: w } });
    fetches[0]!.resolve(okFetch(`"${w}"`));
    await flush();
    expect(left.best.value).toEqual({ id: "1:10", gen: 2, v: w });
    expect(right.best.value).toEqual({ id: "1:10", gen: 2, v: w });
    expect(left.src.value).toMatch(/^data:image\/png;base64,/);
    expect(right.src.value).toMatch(/^data:image\/png;base64,/);
  });
});
