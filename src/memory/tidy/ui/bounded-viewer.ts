import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

/** The viewer is deliberately small: it never edits or copies the displayed data. */
export const VIEWER_MAX_MS = 600_000;

export interface BoundedViewerOptions {
  signal?: AbortSignal;
  maxMs?: number;
}

/** Show a scrollable, deadline-bounded read-only view in the TUI. */
export async function showBoundedViewer(
  ui: Pick<ExtensionUIContext, "custom">,
  title: string,
  value: string,
  options: BoundedViewerOptions = {},
): Promise<void> {
  const maxMs = Math.max(1, options.maxMs ?? VIEWER_MAX_MS);
  await ui.custom((tui, theme, keybindings, done) => {
    const lines = value.split("\n");
    let offset = 0;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      done(undefined);
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, maxMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const component = new Container();
    const text = new Text("", 1, 0);
    component.addChild(text);
    const render = (): void => {
      const height = Math.max(1, tui.terminal.rows - 5);
      const visible = lines.slice(offset, offset + height);
      text.setText(
        [
          theme.fg("accent", title),
          theme.fg("dim", `lines ${offset + 1}-${Math.min(lines.length, offset + height)} / ${lines.length}`),
          ...visible,
          theme.fg("dim", "↑/↓ scroll · PgUp/PgDn · q/Esc close"),
        ].join("\n"),
      );
      tui.requestRender();
    };
    const page = (): number => Math.max(1, tui.terminal.rows - 5);
    const input = (data: string): void => {
      if (keybindings.matches(data, "tui.select.cancel") || data === "q" || data === "Q" || data === "\u001b") {
        finish();
        return;
      }
      const amount = page();
      if (data === "\u001b[A" || data === "k") offset = Math.max(0, offset - 1);
      else if (data === "\u001b[B" || data === "j") offset = Math.min(Math.max(0, lines.length - amount), offset + 1);
      else if (data === "\u001b[5~") offset = Math.max(0, offset - amount);
      else if (data === "\u001b[6~") offset = Math.min(Math.max(0, lines.length - amount), offset + amount);
      render();
    };
    // ui.custom owns input routing while this component is active.
    (component as Container & { handleInput?: (data: string) => void }).handleInput = input;
    render();
    return component;
  });
}
