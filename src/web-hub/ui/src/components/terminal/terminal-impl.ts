import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { installTerminalStyleAttributes } from "./style-attributes.js";
import { FitAddon } from "@xterm/addon-fit";
import { version } from "@xterm/xterm/package.json";
import xtermCss from "@xterm/xterm/css/xterm.css?url";
import terminalCss from "./terminal.css?url";
import { captureTerminalStyles } from "./constructed-styles.js";

/** P0 only: local test bytes, no transport, shell, settings or capability changes. */
export async function mountTerminalSpike(container: HTMLElement, compatible = true, preferWebgl = true) {
  const doc = container.ownerDocument;
  const links: HTMLLinkElement[] = [];
  const abort = new AbortController();
  const terminal = new Terminal({
    allowProposedApi: false,
    fontSize: 14,
    cursorBlink: false,
    minimumContrastRatio: 7,
    scrollback: 100,
    linkHandler: { activate() {} },
    theme: { background: "#102030", foreground: "#e0e8f0" },
  });
  let releaseAttributes: (() => void) | undefined;
  let styles: { dispose(): void } | undefined;
  const fit = new FitAddon();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    try {
      terminal.dispose();
    } finally {
      styles?.dispose();
      releaseAttributes?.();
      for (const link of links) link.remove();
      container.replaceChildren();
    }
  };
  try {
    // ?url keeps both stylesheets out of the first-screen CSS despite cssCodeSplit:false.
    await Promise.all(
      [xtermCss, terminalCss].map(
        (href) =>
          new Promise<void>((resolve, reject) => {
            const link = doc.createElement("link");
            links.push(link);
            link.rel = "stylesheet";
            link.href = href;
            const finish = (error?: Error) => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", cancelled);
              link.removeEventListener("load", loaded);
              link.removeEventListener("error", failed);
              if (error) reject(error);
              else resolve();
            };
            const loaded = () => finish();
            const failed = () => finish(new Error("Terminal stylesheet failed to load"));
            const cancelled = () => finish(new Error("Terminal stylesheet load cancelled"));
            const timer = setTimeout(() => finish(new Error("Terminal stylesheet deadline exceeded")), 5_000);
            link.addEventListener("load", loaded, { once: true });
            link.addEventListener("error", failed, { once: true });
            abort.signal.addEventListener("abort", cancelled, { once: true });
            doc.head.appendChild(link);
          }),
      ),
    );
    if (disposed) throw new Error("Terminal disposed before open");
    terminal.loadAddon(fit);
    // Suppress clipboard/title/hyperlink side effects for controlled spike sequences.
    for (const osc of [0, 1, 2, 8, 52]) terminal.parser.registerOscHandler(osc, () => true);
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        event.key === "F6"
      ) {
        event.preventDefault();
        doc.querySelector<HTMLButtonElement>("[data-terminal-focus]")?.focus();
        return false;
      }
      return true;
    });
    if (compatible) {
      releaseAttributes = installTerminalStyleAttributes(container);
      styles = captureTerminalStyles(container, version, () => terminal.open(container));
    } else terminal.open(container); // Explicit browser negative control only (P0 entry, not a user feature).
    container.dataset["renderer"] = "dom";
    if (compatible && preferWebgl) {
      // Public addon, exact same upstream commit as core. DOM is the initial fallback.
      const canvas = doc.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (gl) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        const webgl = new WebglAddon(true);
        try {
          terminal.loadAddon(webgl);
          container.dataset["renderer"] = "webgl";
          webgl.onContextLoss(() => {
            // Do not silently recreate an unbridged DOM renderer after open.
            dispose();
            container.textContent = "Terminal unavailable: WebGL context lost; reopen required";
          });
        } catch (error) {
          dispose();
          webgl.dispose();
          throw new Error(`Terminal unavailable: WebGL activation failed (${String(error)})`);
        }
      }
    }
    fit.fit();
    return {
      terminal,
      fit: () => fit.fit(),
      write: (bytes: string) => new Promise<void>((resolve) => terminal.write(bytes, resolve)),
      theme: () => {
        terminal.options.theme = { background: "#f0e0d0", foreground: "#203040" };
      },
      font: () => {
        terminal.options.fontSize = 18;
        fit.fit();
      },
      focus: () => terminal.focus(),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
