/** System fonts only: no downloads/assets, no CSP or licence/provenance expansion.
 * Prefer real named monospace families before Linux's ui-monospace/monospace aliases:
 * those aliases can resolve to proportional Noto Sans CJK on otherwise capable hosts.
 */
export const TERMINAL_FONT_FAMILY =
  '"SFMono-Regular", "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Noto Sans Mono CJK SC", Menlo, Consolas, "Courier New", ui-monospace, monospace';
export const TERMINAL_FONT_WAIT_MS = 500;

export function terminalFontsReady(doc: Document, size: number): Promise<void> {
  try {
    if (!doc.fonts) return Promise.resolve();
    return Promise.all([doc.fonts.load(`${size}px ${TERMINAL_FONT_FAMILY}`, "Wim中文"), doc.fonts.ready]).then(
      () => undefined,
      () => undefined, // System-font availability must not prevent the terminal opening.
    );
  } catch {
    return Promise.resolve();
  }
}
/** Wait before xterm's first measurement, but never wedge on a browser FontFaceSet. */
export async function waitTerminalFonts(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = () => {};
  try {
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        cancelled = resolve;
        signal.addEventListener("abort", cancelled, { once: true });
        timer = setTimeout(resolve, TERMINAL_FONT_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancelled);
  }
}

/** A removable late-ready subscription must not retain a disposed terminal forever. */
export function watchTerminalFonts(doc: Document, ready: Promise<void>, remeasure: () => void): () => void {
  let effect: (() => void) | undefined = remeasure;
  const loaded = () => {
    try {
      effect?.();
    } catch {
      /* Font readiness cannot close a shell. */
    }
  };
  doc.fonts?.addEventListener("loadingdone", loaded);
  void ready.then(loaded, () => {});
  return () => {
    effect = undefined;
    doc.fonts?.removeEventListener("loadingdone", loaded);
  };
}

/** Non-secret UI preference; only read when the enabled lazy TerminalPanel mounts. */
const FONT_SIZE_KEY = "pwh_terminal_font_size";
function fontStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
export function loadTerminalFontSize(storage: Pick<Storage, "getItem"> | undefined = fontStorage()): number {
  try {
    const raw = storage?.getItem(FONT_SIZE_KEY);
    const size = Number(raw);
    return raw && Number.isInteger(size) && size >= 10 && size <= 24 ? size : 14;
  } catch {
    return 14;
  }
}
export function saveTerminalFontSize(
  size: number,
  storage: Pick<Storage, "setItem"> | undefined = fontStorage(),
): void {
  if (!Number.isInteger(size) || size < 10 || size > 24) return;
  try {
    storage?.setItem(FONT_SIZE_KEY, String(size));
  } catch {
    /* preference only */
  }
}
