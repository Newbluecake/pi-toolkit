/**
 * Pre-send attachment image preview (2026-10 feature: 「通过输入框上传的图片支持预览（不
 * 点击发送的情况下，并且支持放大）」) — thumbnails for the composer's attachment tray plus a
 * zoomable viewer, both fed from the LOCAL source file (any tray state: queued / uploading /
 * ready / failed — the pixels are identical, and a hub-side fetch would additionally depend on
 * the preview scope/caps being available).
 *
 * Source policy (follows web-hub-preview plan v3 §6.1 D1/HP8, enforced by
 * `tests/web-hub/ui/source-scan.test.ts`): every URL handed to `<img>` is a `data:` URL —
 * `createObjectURL`/`blob:` is banned outright because the hub CSP (`img-src 'self' data:`)
 * is deliberately NOT relaxed. Consequences this module owns:
 *
 * - **thumbnails are DOWNSCALED through a canvas** (`createImageBitmap` → ≤ `THUMB_MAX_EDGE`
 *   px → `toDataURL("image/webp")`) — a tray may hold up to `UPLOAD_ATTACH_MAX_PER_MSG`
 *   files of up to 100 MiB each, so a full-file data URL per row is not an option; a thumb
 *   is a few KB instead. No `createObjectURL` is used even transiently (the bitmap comes
 *   straight from the Blob). Decode failures (broken image, exotic codec, missing browser
 *   API — e.g. under happy-dom) degrade silently to the tray's icon row.
 * - **the viewer reads the full file as one transient `data:` URL** only while its dialog is
 *   open (`readAsDataURL` on open, dropped on close/supersede). Both paths are capped at
 *   `PREVIEW_IMAGE_MAX_BYTES.loopback` (16 MiB) — the same budget the hub's loopback preview
 *   endpoint applies — so a 100 MiB attachment never turns into a ~133 MB base64 string.
 *
 * Lifecycle: a watcher over the tray items generates missing thumbs, prunes cache entries
 * whose item left the tray (removed / sent / re-keyed by retry — the data:-URL analog of
 * "revoke on remove"; there is nothing to `revoke()` for a data: URL, dropping the string is
 * the whole cleanup), and closes an open viewer whose item disappeared. `onScopeDispose`
 * clears everything; all async results are dropped after dispose via a disposed flag.
 *
 * Test seam: `createBitmap` / `createCanvas` / `createFileReader` are injectable for the same
 * reason `usePreview` injects its `FileReader` (node has no canvas/FileReader); the real
 * wiring (AttachmentTray) passes none and the defaults reach the browser globals lazily.
 */
import { onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from "vue";
import { PREVIEW_IMAGE_MAX_BYTES } from "@protocol/preview.js";
import type { FileReaderLike } from "./usePreview.js";
import type { Attachment } from "../types.js";

/** Longest-edge cap (CSS px) for tray thumbnails — thumbs render ≤28px (44px coarse), so
 * 128 covers 2x-density displays with room to spare while staying a few KB as WebP. */
export const THUMB_MAX_EDGE = 128;

/** Byte cap for BOTH the thumbnail decode and the full-viewer data: URL — mirrors the hub
 * preview endpoint's loopback image budget (`PREVIEW_IMAGE_MAX_BYTES.loopback`, 16 MiB). */
export const ATTACH_PREVIEW_MAX_BYTES = PREVIEW_IMAGE_MAX_BYTES.loopback;

/** Structural slice of `ImageBitmap` the thumb pipeline needs (injectable for tests). */
export interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

/** Structural slice of an HTML canvas (2d) the thumb pipeline needs. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): { drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void } | null;
  toDataURL(mime: string, quality?: number): string;
}

export interface AttachmentPreviewOptions {
  /** Reactive tray items (the composer's `uploads.tray(key)` array). */
  readonly items: () => readonly Attachment[];
  /** `(id) => File | undefined` — `UploadsHandle.source`, bound to the current agent. */
  readonly sourceOf: (id: string) => unknown;
  /** Test seams; defaults reach the browser globals lazily (never at module scope). */
  readonly createBitmap?: (src: unknown) => Promise<unknown>;
  readonly createCanvas?: () => CanvasLike | null;
  readonly createFileReader?: () => FileReaderLike;
}

/** The viewer dialog's state machine: `loading → ready | tooLarge | error` (one open at a
 * time; a new `open` supersedes the in-flight read via `seq`). */
export type AttachmentViewerState =
  | { readonly phase: "loading"; readonly id: string; readonly name: string; readonly size: number }
  | {
      readonly phase: "ready";
      readonly id: string;
      readonly name: string;
      readonly size: number;
      readonly dataUrl: string;
    }
  | { readonly phase: "tooLarge"; readonly id: string; readonly name: string; readonly size: number }
  | { readonly phase: "error"; readonly id: string; readonly name: string; readonly size: number };

export function isImageAttachment(item: Attachment): boolean {
  return item.mime !== null && item.mime.startsWith("image/");
}

function defaultCreateBitmap(src: unknown): Promise<unknown> {
  if (typeof createImageBitmap !== "function") return Promise.reject(new Error("createImageBitmap unavailable"));
  return createImageBitmap(src as Blob);
}

function defaultCreateCanvas(): CanvasLike | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const c: unknown = document.createElement("canvas");
  if (c === null || typeof (c as CanvasLike).toDataURL !== "function") return null;
  return c as CanvasLike;
}

function defaultFileReader(): FileReaderLike {
  return new FileReader() as unknown as FileReaderLike;
}

export function useAttachmentPreview(opts: AttachmentPreviewOptions): {
  /** id → small `data:image/…` thumbnail (readonly reactive record). */
  readonly thumbs: Readonly<Ref<Readonly<Record<string, string>>>>;
  readonly viewer: Readonly<Ref<AttachmentViewerState | null>>;
  thumbOf(id: string): string | undefined;
  /** Non-image / `removing` items are a no-op; oversized items open straight to `tooLarge`. */
  openPreview(item: Attachment): void;
  closePreview(): void;
} {
  const createBitmap = opts.createBitmap ?? defaultCreateBitmap;
  const createCanvas = opts.createCanvas ?? defaultCreateCanvas;
  const createFileReader = opts.createFileReader ?? defaultFileReader;

  const thumbs = shallowRef<Record<string, string>>({});
  const thumbsReadonly = readonly(thumbs) as Readonly<Ref<Readonly<Record<string, string>>>>;
  const viewer = ref<AttachmentViewerState | null>(null);
  const viewerReadonly = readonly(viewer);

  const inflight = new Set<string>();
  let disposed = false;
  /** Supersedes an in-flight viewer read: only the latest open commits. */
  let viewerSeq = 0;

  async function makeThumb(src: unknown): Promise<string | undefined> {
    let bitmap: BitmapLike;
    try {
      bitmap = (await createBitmap(src)) as BitmapLike;
    } catch {
      return undefined; // no bitmap API / undecodable file — icon fallback
    }
    try {
      if (
        typeof bitmap !== "object" ||
        bitmap === null ||
        !Number.isFinite(bitmap.width) ||
        bitmap.width <= 0 ||
        !Number.isFinite(bitmap.height) ||
        bitmap.height <= 0
      ) {
        return undefined;
      }
      const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = createCanvas();
      if (canvas === null) return undefined;
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (ctx === null) return undefined;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/webp", 0.75);
      return url.startsWith("data:image/") ? url : undefined;
    } finally {
      bitmap.close?.();
    }
  }

  function readViewerDataUrl(id: string, name: string, size: number, src: unknown): void {
    const seq = ++viewerSeq;
    let reader: FileReaderLike;
    try {
      reader = createFileReader();
    } catch {
      viewer.value = { phase: "error", id, name, size };
      return;
    }
    reader.addEventListener("load", () => {
      if (disposed || seq !== viewerSeq) return;
      const result = reader.result;
      const cur = viewer.value;
      if (cur === null || cur.id !== id || cur.phase !== "loading") return;
      if (typeof result !== "string" || !result.startsWith("data:image/")) {
        viewer.value = { phase: "error", id, name: cur.name, size: cur.size };
        return;
      }
      viewer.value = { phase: "ready", id, name: cur.name, size: cur.size, dataUrl: result };
    });
    reader.addEventListener("error", () => {
      if (disposed || seq !== viewerSeq) return;
      const cur = viewer.value;
      if (cur !== null && cur.id === id && cur.phase === "loading") {
        viewer.value = { phase: "error", id, name: cur.name, size: cur.size };
      }
    });
    try {
      reader.readAsDataURL(src as Blob);
    } catch {
      viewer.value = { phase: "error", id, name, size };
    }
  }

  watch(
    opts.items,
    (items) => {
      if (disposed) return;
      const live = new Set<string>();
      for (const it of items) {
        live.add(it.id);
        // Generate: image items within the byte cap whose pixels we can still reach.
        if (
          isImageAttachment(it) &&
          it.size <= ATTACH_PREVIEW_MAX_BYTES &&
          thumbs.value[it.id] === undefined &&
          !inflight.has(it.id)
        ) {
          const src = opts.sourceOf(it.id);
          if (src !== undefined) {
            inflight.add(it.id);
            void makeThumb(src)
              .then((url) => {
                if (!disposed && url !== undefined) thumbs.value = { ...thumbs.value, [it.id]: url! };
              })
              .finally(() => inflight.delete(it.id));
          }
        }
      }
      // Prune: cache entries whose item left the tray (removed / sent / retry re-key) — a
      // data: URL has no revoke(), dropping the string IS the cleanup.
      const stale = Object.keys(thumbs.value).filter((k) => !live.has(k));
      if (stale.length > 0) {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(thumbs.value)) if (live.has(k)) next[k] = v;
        thumbs.value = next;
      }
      // An open viewer whose item left the tray closes (its File may be gone with it).
      const v = viewer.value;
      if (v !== null && !live.has(v.id)) viewer.value = null;
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    disposed = true;
    inflight.clear();
    thumbs.value = {};
    viewer.value = null;
  });

  return {
    thumbs: thumbsReadonly,
    viewer: viewerReadonly,
    thumbOf: (id) => thumbs.value[id],
    openPreview(item: Attachment): void {
      if (disposed || !isImageAttachment(item) || item.state === "removing") return;
      if (item.size > ATTACH_PREVIEW_MAX_BYTES) {
        viewerSeq += 1; // supersede any in-flight read
        viewer.value = { phase: "tooLarge", id: item.id, name: item.name, size: item.size };
        return;
      }
      const src = opts.sourceOf(item.id);
      if (src === undefined) {
        viewerSeq += 1;
        viewer.value = { phase: "error", id: item.id, name: item.name, size: item.size };
        return;
      }
      viewer.value = { phase: "loading", id: item.id, name: item.name, size: item.size };
      readViewerDataUrl(item.id, item.name, item.size, src);
    },
    closePreview(): void {
      viewerSeq += 1;
      viewer.value = null;
    },
  };
}
