/**
 * web-hub-preview-windows plan r2 §9/评审 #7 (W2): the per-window download chain, MOVED
 * VERBATIM from `PreviewHost.vue` (preview-download, 2026-10 用户拍板) so each preview window
 * owns an independent `dlBusy`/`dlFailed` pair (§10.2: "每个窗口的下载相互独立").
 *
 * What lives here (all previously inline in the host):
 * - `download()` — the header 「下载」 button (text/image phases): re-fetch through the SAME
 *   `GET /api/preview` endpoint and save via `saveBlob` (Blob → objectURL → `a[download]`);
 *   with `preview.download.v1` a TRUNCATED text preview saves the COMPLETE file (`download=1`).
 * - `downloadUnsupported()` — the unsupported phase's `download=1` offer (cap-gated).
 * - `downloadCap` / `downloadSession` — the cap check and the live session-pair derivation.
 *
 * The `createObjectURL` source-scan exception moved with it (source-scan.test.ts): the
 * objectURL is handed to an `<a download>` anchor ONLY — navigated for SAVE, never loaded
 * into the page as a resource (no CSP relaxation needed; the preview itself uses `data:` URLs).
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { clientImageBudget } from "@logic/preview.js";
import { PREVIEW_DOWNLOAD_HUB_CAP } from "@protocol/version.js";
import type { HubHandle } from "../types.js";
import type { PreviewViewDir } from "./usePreview.js";

/** Structural slice of `HUB_CTX` the chain needs — keeps the composable unit-testable. */
export interface PreviewDownloadHub {
  readonly state: HubHandle["state"];
  readonly preview?: HubHandle["preview"];
}

export interface UsePreviewDownloadOptions {
  readonly hub: PreviewDownloadHub | null;
  /** Reactive getter for the window's CURRENT view (the caller keeps it fresh). */
  readonly view: () => PreviewViewDir;
}

export interface PreviewDownloadHandle {
  readonly dlBusy: Readonly<Ref<boolean>>;
  readonly dlFailed: Readonly<Ref<boolean>>;
  /** Header button visibility: text/image phases with a preview transport. */
  readonly downloadable: ComputedRef<boolean>;
  /** `preview.download.v1` + the transport method (the unsupported-phase offer). */
  readonly downloadCap: ComputedRef<boolean>;
  /** The caller invokes this on every view-identity change (phase/path) — stale failure/copy reset. */
  resetForView(): void;
  download(): Promise<void>;
  downloadUnsupported(): Promise<void>;
}

/** basename of the download path; a lossy name (U+FFFD from a lossy decode) is never written
 *  to disk as-is — degrade to "download". */
export function downloadNameOf(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 && slash < p.length - 1 ? p.slice(slash + 1) : p;
  return base === "" || base.includes("\uFFFD") ? "download" : base;
}

/** Blob → objectURL → `a[download]` (the ONLY sanctioned save chain: the endpoint requires
 *  `X-PWH: 1`, so a plain `<a href>` navigation can never authenticate). The objectURL is
 *  revoked a macrotask after the click handed it to the browser. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a); // Firefox requires the anchor in the DOM
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function usePreviewDownload(opts: UsePreviewDownloadOptions): PreviewDownloadHandle {
  const dlBusy = ref(false);
  const dlFailed = ref(false);

  /** Only file phases (text/image — markdown IS the text phase) offer download; dir and every
   *  failure phase don't. The button also requires the preview transport (a component-level
   *  fake without HUB_CTX never renders a dead button). */
  const downloadable = computed(
    () => (opts.view().phase === "image" || opts.view().phase === "text") && opts.hub?.preview !== undefined,
  );

  /** The `preview.download.v1` cap gates the download surface for NON-previewable files (the
   *  unsupported phase's offer); previewable files keep the plain `fetch`-based button
   *  regardless (it predates the cap). The transport method itself is required too. */
  const downloadCap = computed(() => {
    const h = opts.hub?.state.value.hub;
    const caps = h !== null && h !== undefined && typeof h === "object" ? (h as { caps?: unknown }).caps : undefined;
    return Array.isArray(caps) && caps.includes(PREVIEW_DOWNLOAD_HUB_CAP) && opts.hub?.preview?.download !== undefined;
  });

  /** The fetch needs a live session pair (the endpoint's ③/⑤ gate) — re-derived from the
   *  selected agent EXACTLY like `usePreview`'s scope derivation (a scope change closes the
   *  window, so an open window's derivation is stable for the click's lifetime). */
  const downloadSession = computed(() => {
    const st = opts.hub?.state.value;
    if (st === undefined || st === null) return null;
    const selected = st.selected;
    if (selected === null || selected === undefined) return null;
    const agent = st.agents.get(selected);
    const session =
      agent?.session ?? (agent?.card !== undefined ? (agent.card as { session?: unknown }).session : undefined);
    const sessionId =
      session !== null && typeof session === "object" ? (session as { sessionId?: unknown }).sessionId : undefined;
    if (typeof sessionId !== "string" || sessionId === "") return null;
    return { agentKey: selected, sessionId };
  });

  function resetForView(): void {
    dlFailed.value = false;
  }

  async function download(): Promise<void> {
    const preview = opts.hub?.preview;
    const sess = downloadSession.value;
    const v = opts.view();
    if (preview === undefined || sess === null || dlBusy.value) return;
    if (v.phase !== "image" && v.phase !== "text") return;
    const path = v.path;
    dlBusy.value = true;
    dlFailed.value = false;
    try {
      // chunked-plan D11: a text preview may be only a prefix of the file (256 KiB chunks) —
      // when the hub declares `preview.download.v1` save the COMPLETE file via `download=1`.
      const dl = opts.hub?.preview?.download;
      if (v.phase === "text" && downloadCap.value && dl !== undefined) {
        const full = await dl(
          { agentKey: sess.agentKey, sessionId: sess.sessionId, path },
          { signal: new AbortController().signal },
        );
        if (!full.ok) {
          dlFailed.value = true;
          return;
        }
        saveBlob(full.blob, downloadNameOf(path));
        return;
      }
      const out = await preview.fetch(
        { agentKey: sess.agentKey, sessionId: sess.sessionId, path },
        { signal: new AbortController().signal, maxPixels: clientImageBudget() },
      );
      if (!out.ok || out.kind === "dir") {
        dlFailed.value = true;
        return;
      }
      // Content-Type 用响应头原值: image 的 Blob 已带 sniffed mime；text 端点恒为 text/plain
      const blob = out.kind === "image" ? out.blob : new Blob([out.text], { type: "text/plain;charset=utf-8" });
      saveBlob(blob, downloadNameOf(path));
    } catch {
      dlFailed.value = true;
    } finally {
      dlBusy.value = false;
    }
  }

  /** The unsupported phase's download offer (preview-download): re-fetch through the SAME
   *  endpoint with `download=1` — the hub then serves raw octet-stream bytes of ANY admitted
   *  regular file (no sniff/kind gate). Rendered only under `downloadCap`. */
  async function downloadUnsupported(): Promise<void> {
    const dl = opts.hub?.preview?.download;
    const sess = downloadSession.value;
    const v = opts.view();
    if (dl === undefined || sess === null || dlBusy.value) return;
    if (v.phase !== "unsupported") return;
    const path = v.path;
    dlBusy.value = true;
    dlFailed.value = false;
    try {
      const out = await dl(
        { agentKey: sess.agentKey, sessionId: sess.sessionId, path },
        { signal: new AbortController().signal },
      );
      if (!out.ok) {
        dlFailed.value = true;
        return;
      }
      saveBlob(out.blob, downloadNameOf(path));
    } catch {
      dlFailed.value = true;
    } finally {
      dlBusy.value = false;
    }
  }

  return {
    dlBusy,
    dlFailed,
    downloadable,
    downloadCap,
    resetForView,
    download,
    downloadUnsupported,
  };
}
