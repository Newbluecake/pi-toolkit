/**
 * `useMdImageLoader.ts`'s `createMdImageLoader` (md-preview-html plan): the per-document
 * markdown inline-image scheduler — ≤2 concurrent fetches, ≤24 images per document, a 32 MiB
 * total decoded budget, a per-fetch timeout, and `release()`/`dispose()` aborts (component
 * unmount / file switch / mode switch). Transport-agnostic: `fetchImage` is a fake here.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createMdImageLoader,
  MD_IMAGE_BUDGET_BYTES,
  MD_IMAGE_CONCURRENCY,
  MD_IMAGE_MAX_PER_DOC,
  type MdImageFetchResult,
} from "../../../src/web-hub/ui/src/composables/useMdImageLoader.js";

const OK: MdImageFetchResult = { ok: true, dataUrl: "data:image/png;base64,AA==", bytes: 10 };

/** Flush the loader's microtask queue (fetchImage is invoked via Promise.resolve().then). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface Deferred {
  promise: Promise<MdImageFetchResult>;
  resolve: (r: MdImageFetchResult) => void;
  signal?: AbortSignal;
}

function deferredFetcher() {
  const calls: Deferred[] = [];
  const fetchImage = vi.fn((_path: string, signal: AbortSignal) => {
    let resolve!: (r: MdImageFetchResult) => void;
    const promise = new Promise<MdImageFetchResult>((res) => {
      resolve = res;
    });
    const d: Deferred = { promise, resolve, signal };
    calls.push(d);
    return promise;
  });
  return { fetchImage, calls };
}

describe("createMdImageLoader", () => {
  it("runs at most `concurrency` fetches in flight, FIFO", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage, concurrency: 2 });
    loader.load("/a");
    loader.load("/b");
    loader.load("/c");
    loader.load("/d");
    await tick();
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.signal)).toBeDefined();
    calls[0]!.resolve(OK);
    await tick();
    expect(fetchImage).toHaveBeenCalledTimes(3);
    calls[1]!.resolve(OK);
    await tick();
    expect(fetchImage).toHaveBeenCalledTimes(4);
    calls[2]!.resolve(OK);
    calls[3]!.resolve(OK);
    await tick();
    loader.dispose();
  });

  it("defaults: 24 images / 2 in flight / 32 MiB budget", () => {
    expect(MD_IMAGE_MAX_PER_DOC).toBe(24);
    expect(MD_IMAGE_CONCURRENCY).toBe(2);
    expect(MD_IMAGE_BUDGET_BYTES).toBe(32 * 1024 * 1024);
  });

  it("beyond `maxImages` the slot is an immediate placeholder (limit), never fetched", async () => {
    const { fetchImage } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage, maxImages: 2 });
    loader.load("/a");
    loader.load("/b");
    const third = loader.load("/c");
    await tick();
    expect(third.state.value).toBe("placeholder");
    expect(third.reason.value).toBe("limit");
    expect(fetchImage).toHaveBeenCalledTimes(2);
    loader.dispose();
  });

  it("successful loads flip the slot to ready with the data URL", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage });
    const slot = loader.load("/a");
    await tick();
    calls[0]!.resolve({ ok: true, dataUrl: "data:image/png;base64,BB==", bytes: 5 });
    await tick();
    expect(slot.state.value).toBe("ready");
    expect(slot.dataUrl.value).toBe("data:image/png;base64,BB==");
    loader.dispose();
  });

  it("a remount of an already-loaded path is served from cache: no refetch, no admission spent", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage, maxImages: 2 });
    const a = loader.load("/a");
    const b = loader.load("/b");
    await tick();
    calls[0]!.resolve(OK);
    calls[1]!.resolve(OK);
    await tick();
    expect([a.state.value, b.state.value]).toEqual(["ready", "ready"]);
    a.release();
    b.release();
    // rendered → source → rendered: every image mounts again
    const a2 = loader.load("/a");
    const b2 = loader.load("/b");
    expect([a2.state.value, b2.state.value]).toEqual(["ready", "ready"]);
    expect(a2.dataUrl.value).toBe(OK.ok ? OK.dataUrl : null);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    // a third DISTINCT path still hits the per-document limit
    expect(loader.load("/c").reason.value).toBe("limit");
    loader.dispose();
  });

  it("once the decoded byte budget is spent, later images are the placeholder (budget)", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage, concurrency: 1, budgetBytes: 100 });
    const a = loader.load("/a");
    const b = loader.load("/b");
    const c = loader.load("/c");
    await tick();
    calls[0]!.resolve({ ok: true, dataUrl: "data:image/png;base64,A", bytes: 60 });
    await tick();
    expect(a.state.value).toBe("ready");
    // 60 < 100 ⇒ the second image still loads
    expect(fetchImage).toHaveBeenCalledTimes(2);
    calls[1]!.resolve({ ok: true, dataUrl: "data:image/png;base64,B", bytes: 60 });
    await tick();
    expect(b.state.value).toBe("ready");
    // 120 ≥ 100 ⇒ the third never fetches
    expect(c.state.value).toBe("placeholder");
    expect(c.reason.value).toBe("budget");
    expect(fetchImage).toHaveBeenCalledTimes(2);
    loader.dispose();
  });

  it("a fetch exceeding its timeout lands on the placeholder (timeout)", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImage } = deferredFetcher();
      const loader = createMdImageLoader({ fetchImage, timeoutMs: 1000 });
      const slot = loader.load("/a");
      await vi.advanceTimersByTimeAsync(0); // let fetchImage start
      await vi.advanceTimersByTimeAsync(1000); // fire the deadline
      expect(slot.state.value).toBe("placeholder");
      expect(slot.reason.value).toBe("timeout");
      loader.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("release() aborts the in-flight fetch; a late result never reaches the slot", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage });
    const slot = loader.load("/a");
    await tick();
    slot.release();
    expect(calls[0]!.signal?.aborted).toBe(true);
    calls[0]!.resolve(OK);
    await tick();
    expect(slot.state.value).toBe("loading"); // untouched
    expect(slot.dataUrl.value).toBeNull();
    loader.dispose();
  });

  it("release() of a QUEUED slot admits the next one instead", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage, concurrency: 1 });
    loader.load("/a");
    const b = loader.load("/b");
    const c = loader.load("/c");
    await tick();
    expect(fetchImage).toHaveBeenCalledTimes(1);
    b.release(); // queued — drops out
    calls[0]!.resolve(OK);
    await tick();
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(fetchImage.mock.calls[1]?.[0]).toBe("/c");
    void c;
    loader.dispose();
  });

  it("fetch failures map to the placeholder with their reason (denied/tooLarge/…)", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage, concurrency: 3 });
    const denied = loader.load("/a");
    const tooLarge = loader.load("/b");
    const failed = loader.load("/c");
    await tick();
    calls[0]!.resolve({ ok: false, reason: "denied" });
    calls[1]!.resolve({ ok: false, reason: "tooLarge" });
    calls[2]!.resolve({ ok: false, reason: "failed" });
    await tick();
    expect([denied.state.value, denied.reason.value]).toEqual(["placeholder", "denied"]);
    expect([tooLarge.state.value, tooLarge.reason.value]).toEqual(["placeholder", "tooLarge"]);
    expect([failed.state.value, failed.reason.value]).toEqual(["placeholder", "failed"]);
    loader.dispose();
  });

  it("dispose() aborts everything in flight and later loads are limit placeholders", async () => {
    const { fetchImage, calls } = deferredFetcher();
    const loader = createMdImageLoader({ fetchImage });
    loader.load("/a");
    await tick();
    loader.dispose();
    expect(calls[0]!.signal?.aborted).toBe(true);
    const late = loader.load("/b");
    expect(late.state.value).toBe("placeholder");
  });
});
