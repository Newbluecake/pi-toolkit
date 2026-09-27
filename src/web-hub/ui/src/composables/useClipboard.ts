/**
 * Copy-to-clipboard (vue-plan.md v2.1 §6.4, §5.2 — P1). `CopyButton.vue` (P4) renders the
 * fallback UI; this composable only decides *why* a copy attempt did or didn't happen —
 * `navigator.clipboard` requires a secure context, so plain-HTTP LAN access (plan §6.7's
 * plaintext banner) is expected to hit `"insecure-context"` and fall back to select+toast.
 */
export type ClipboardFailureReason = "insecure-context" | "unavailable" | "denied";
export type ClipboardResult = { readonly ok: true } | { readonly ok: false; readonly reason: ClipboardFailureReason };

export interface ClipboardWindow {
  readonly isSecureContext: boolean;
  readonly navigator: { readonly clipboard?: { writeText(text: string): Promise<void> } };
}

export interface ClipboardHandle {
  copy(text: string): Promise<ClipboardResult>;
}

export function useClipboard(win: ClipboardWindow): ClipboardHandle {
  return {
    async copy(text) {
      if (!win.isSecureContext) return { ok: false, reason: "insecure-context" };
      const clipboard = win.navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") return { ok: false, reason: "unavailable" };
      try {
        await clipboard.writeText(text);
        return { ok: true };
      } catch {
        return { ok: false, reason: "denied" };
      }
    },
  };
}
