/**
 * Copy-to-clipboard (vue-plan.md v2.1 §6.4, §5.2 — P1). `CopyButton.vue` (P4) renders the
 * fallback UI; this composable only decides *why* a copy attempt did or didn't happen —
 * `navigator.clipboard` requires a secure context, so plain-HTTP LAN access (plan §6.7's
 * plaintext banner) used to hit `"insecure-context"` and fall back to select+announce.
 *
 * 2026-10-12 LAN copy fix: before giving up, try the legacy `document.execCommand("copy")`
 * path — deprecated but still functional in Chrome/Edge/Safari and, crucially, NOT gated on
 * a secure context (only on a user gesture, which every call site has: copy is always a
 * click). Verified live on the LAN build (http, isSecureContext=false): execCommand returns
 * true and the text really lands on the clipboard. The legacy path copies through a
 * textarea's `.value`, so newlines/whitespace survive byte-exactly (the old select-a-span
 * fallback collapsed them — `white-space: normal` serialization). Only when BOTH paths fail
 * do we report a failure reason and callers fall back to select+announce.
 */
export type ClipboardFailureReason = "insecure-context" | "unavailable" | "denied";
export type ClipboardResult = { readonly ok: true } | { readonly ok: false; readonly reason: ClipboardFailureReason };

/** Minimal structural surface the legacy execCommand path needs (the real `window.document`
 * satisfies it; tests inject a fake). Optional — a document-less window skips the legacy
 * path, keeping the pre-fix behavior for pure-window fakes. */
export interface ClipboardDocument {
  createElement(tag: "textarea"): {
    value: string;
    style: { cssText: string };
    setAttribute(name: string, value: string): void;
    select(): void;
    setSelectionRange?(start: number, end: number): void;
    remove(): void;
  };
  body: { appendChild(node: unknown): void };
  execCommand?(command: "copy"): boolean;
  getSelection?(): { removeAllRanges(): void } | null;
}

export interface ClipboardWindow {
  readonly isSecureContext: boolean;
  readonly navigator: { readonly clipboard?: { writeText(text: string): Promise<void> } };
  readonly document?: ClipboardDocument | undefined;
}

export interface ClipboardHandle {
  copy(text: string): Promise<ClipboardResult>;
}

/** Legacy execCommand copy (see the header comment): off-screen readonly textarea, select,
 * execCommand, clean up. Returns true only when the browser actually accepted the copy. */
function legacyCopy(doc: ClipboardDocument, text: string): boolean {
  if (typeof doc.execCommand !== "function") return false;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  doc.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange?.(0, text.length); // iOS Safari needs the explicit range
    return doc.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    ta.remove();
    doc.getSelection?.()?.removeAllRanges();
  }
}

export function useClipboard(win: ClipboardWindow): ClipboardHandle {
  return {
    async copy(text) {
      const clipboard = win.navigator.clipboard;
      if (win.isSecureContext && clipboard !== undefined && typeof clipboard.writeText === "function") {
        try {
          await clipboard.writeText(text);
          return { ok: true };
        } catch {
          // fall through to the legacy path before declaring failure — a transient deny can
          // still be copyable via execCommand within the same user gesture.
        }
      }
      if (win.document !== undefined && legacyCopy(win.document, text)) return { ok: true };
      if (!win.isSecureContext) return { ok: false, reason: "insecure-context" };
      if (clipboard === undefined || typeof clipboard.writeText !== "function")
        return { ok: false, reason: "unavailable" };
      return { ok: false, reason: "denied" };
    },
  };
}
