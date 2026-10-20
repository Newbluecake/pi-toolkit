/**
 * Preview injection keys (web-hub-preview plan v3 §4.6, package PV5).
 *
 * Two channels, both provided LATER by the wiring package (PV6 — App.vue / TxAssistant);
 * this package only ships the keys and the components that consume them:
 *
 * - `PREVIEW_CTX` — App-level provide: the `usePreview` handle (PV4's state machine) plus
 *   the plaintext-warning flag (§5.2 明文 LAN：预览面板常驻警告 — password mode over http:).
 *   Absent ⇒ `PathText` renders its no-ctx DOM-equivalent plain text and `PreviewHost`
 *   renders nothing at all (the §4.6 truth table already made every path unclickable).
 * - `PATH_REFERENCES_SUSPENDED` — §4.6 流式抑制: `TxAssistant` provides
 *   `computed(() => props.assistant.streaming)`; while it is true `PathText` renders plain
 *   text (no ref scan), and a settled message re-scans once when the flag flips back.
 */
import type { InjectionKey, Ref } from "vue";
import type { MdImageLoader } from "../../composables/useMdImageLoader.js";
import type { PreviewHandle } from "../../types.js";

export interface PreviewContext {
  /** PV4 `usePreview`'s handle — the App-level preview state machine. */
  readonly handle: PreviewHandle;
  /** §5.2: plaintext transport (LAN http:) — PreviewHost shows the standing warning. */
  readonly plaintext: boolean;
}

export const PREVIEW_CTX: InjectionKey<PreviewContext> = Symbol("web-hub-preview");

/** §4.6 流式抑制 flag (a `Ref<boolean>` covers the `ComputedRef<boolean>` TxAssistant provides). */
export const PATH_REFERENCES_SUSPENDED: InjectionKey<Readonly<Ref<boolean>>> = Symbol(
  "web-hub-path-references-suspended",
);

/**
 * Base directory for resolving RELATIVE markdown link targets inside a file preview
 * (`PreviewText` provides the previewed file's directory). Absent / `null` ⇒ the session cwd
 * (`scope.cwd`) — the same base relative path chips use in transcript messages.
 */
export const PREVIEW_BASE_DIR: InjectionKey<Readonly<Ref<string | null>>> = Symbol("web-hub-preview-base-dir");

/**
 * md-preview-html plan: the per-document markdown inline-image loader (`PreviewText` creates
 * one per mount and provides it; `MdImage` consumes it). Absent ⇒ `MdImage` renders its
 * placeholder without ever fetching (the transcript never provides one and never sees
 * `image` nodes — the parser only emits them in preview mode).
 */
export const MD_IMAGE_LOADER: InjectionKey<MdImageLoader> = Symbol("web-hub-md-image-loader");
