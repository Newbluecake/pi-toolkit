import { Terminal, type ITheme } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { version } from "@xterm/xterm/package.json";
import xtermCss from "@xterm/xterm/css/xterm.css?url";
import terminalCss from "./terminal.css?url";
import { TERMINAL_FONT_FAMILY, terminalFontsReady, waitTerminalFonts, watchTerminalFonts } from "./fonts.js";
import { captureTerminalStyles } from "./constructed-styles.js";
import { createWebglLifecycle, type WebglUiState } from "./webgl-lifecycle.js";

export type { WebglUiState } from "./webgl-lifecycle.js";

function requireWebgl2(doc: Document): void {
  try {
    const gl = doc.createElement("canvas").getContext("webgl2");
    if (!gl || gl.isContextLost()) throw new Error("unavailable");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    throw new Error("当前浏览器不支持或无法使用 WebGL2，终端未启动。请启用 WebGL 后重试。");
  }
}

/** WebGL-only renderer. It has no authority to close/restart a background shell. */
export async function mountTerminal(
  container: HTMLElement,
  options: {
    onStateChange?(state: WebglUiState): void;
    onEscapeFocus?(): void;
    signal?: AbortSignal;
  } = {},
) {
  const doc = container.ownerDocument;
  try {
    requireWebgl2(doc);
  } catch (error) {
    try {
      options.onStateChange?.({ phase: "unavailable", rebuilds: 0, reason: (error as Error).message });
    } catch {
      /* UI port only */
    }
    throw error;
  } // No xterm instance, CSS, transient DOM renderer or fallback when unavailable.
  const links: HTMLLinkElement[] = [];
  const abort = new AbortController();
  let fontSize = 14;
  let theme: ITheme = { background: "#102030", foreground: "#e0e8f0" };
  let disposed = false;
  let suppressState = false;

  const lifecycle = createWebglLifecycle({
    onStateChange(state) {
      container.dataset["renderer"] = state.phase === "ready" ? "webgl" : "none";
      if (!suppressState) options.onStateChange?.(state);
    },
    async create(signal, onLoss) {
      if (signal.aborted) throw new Error("终端初始化已取消。");
      requireWebgl2(doc);
      const fontsReady = terminalFontsReady(doc, fontSize);
      await waitTerminalFonts(fontsReady, signal); // Inside the existing 3s renderer budget.
      if (signal.aborted) throw new Error("终端初始化已取消。");
      const stage = doc.createElement("div");
      stage.className = "terminal-spike-viewport is-initializing";
      stage.setAttribute("aria-hidden", "true");
      stage.inert = true;
      container.appendChild(stage);
      const terminal = new Terminal({
        allowProposedApi: false,
        fontSize,
        fontFamily: TERMINAL_FONT_FAMILY,
        minimumContrastRatio: 7,
        cursorBlink: false,
        scrollback: 1000,
        linkHandler: { activate() {} },
        theme,
      });
      const fit = new FitAddon();
      let bridge: { dispose(): void } | undefined;
      let addon: WebglAddon | undefined;
      let stopped = false;
      let rendererCanvas: HTMLCanvasElement | undefined;
      let rendererContext: WebGL2RenderingContext | undefined;
      const writes = new Set<(error: Error) => void>();
      let cancelReady = () => {};
      let removeContextLoss = () => {};
      let removeFontsReady = () => {};
      const dispose = () => {
        if (stopped) return;
        stopped = true;
        signal.removeEventListener("abort", cancelled);
        cancelReady();
        removeContextLoss();
        removeFontsReady();
        for (const reject of writes) reject(new Error("终端界面已重建或关闭，写入已取消。"));
        // Each cleanup is isolated: a failed third-party disposer must not leave a
        // hidden stage or constructed sheet behind. Core must precede addon cleanup.
        for (const cleanup of [
          () => terminal.dispose(),
          () => addon?.dispose(),
          () => bridge?.dispose(),
          () => stage.remove(),
        ]) {
          try {
            cleanup();
          } catch {
            /* best-effort UI resource cleanup */
          }
        }
      };
      const session = {
        terminal,
        fit: () => {
          fit.fit();
          // Public renderer facts for browser acceptance; no xterm private fields/VT content.
          stage.dataset["terminalFontFamily"] = String(terminal.options.fontFamily);
          stage.dataset["terminalFontSize"] = String(terminal.options.fontSize);
          stage.dataset["terminalCols"] = String(terminal.cols);
        },
        dispose,
        write(bytes: string | Uint8Array) {
          return new Promise<void>((resolve, reject) => {
            if (stopped) {
              reject(new Error("终端界面已关闭。"));
              return;
            }
            const finish = (error?: Error) => {
              clearTimeout(timer);
              writes.delete(fail);
              if (error) reject(error);
              else resolve();
            };
            const fail = (error: Error) => finish(error);
            const timer = setTimeout(() => fail(new Error("终端界面写入超时。")), 2_000);
            writes.add(fail);
            try {
              terminal.write(bytes, () => finish());
            } catch {
              fail(new Error("终端界面写入失败。"));
            }
          });
        },
      };
      const remeasureFonts = () => {
        if (stopped || signal.aborted) return;
        // xterm ignores identical option writes. Both values select the same system font;
        // the public fontFamily option change explicitly triggers CharSizeService.measure.
        terminal.options.fontFamily = `${TERMINAL_FONT_FAMILY}, monospace`;
        terminal.options.fontFamily = TERMINAL_FONT_FAMILY;
        session.fit();
        terminal.refresh(0, terminal.rows - 1);
      };
      let rejectReady: (error: Error) => void = () => {};
      const cancelled = () => {
        dispose();
        rejectReady(new Error("WebGL 初始化已取消。"));
      };
      signal.addEventListener("abort", cancelled, { once: true });
      try {
        return await new Promise<typeof session>((resolve, reject) => {
          rejectReady = reject;
          const rendered = terminal.onRender(() => {
            if (stopped || signal.aborted) return;
            const canvas = rendererCanvas;
            const gl = rendererContext;
            if (!canvas || !gl || gl.isContextLost() || canvas.width < 1 || canvas.height < 1) return;
            rendered.dispose();
            signal.removeEventListener("abort", cancelled);
            stage.classList.remove("is-initializing");
            stage.removeAttribute("aria-hidden");
            stage.inert = false;
            resolve(session);
          });
          cancelReady = () => rendered.dispose();
          terminal.loadAddon(fit);
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
              if (options.onEscapeFocus) options.onEscapeFocus();
              else
                container
                  .closest("[data-terminal-spike]")
                  ?.querySelector<HTMLButtonElement>("[data-terminal-focus]")
                  ?.focus();
              return false;
            }
            return true;
          });
          // xterm 6.0.0 transiently initializes DOM styles during open. Never expose that renderer:
          // the stage is hidden, and WebGL is synchronously installed before the first render frame.
          bridge = captureTerminalStyles(stage, version, () => terminal.open(stage));
          addon = new WebglAddon(true);
          addon.onContextLoss(onLoss);
          terminal.loadAddon(addon); // Any throw disposes the hidden stage; never returns a DOM fallback.
          // Link decoration is a separate 2D canvas. Identify the actual WebGL canvas
          // through the public context API, not a private addon field or canvas ordering.
          for (const candidate of stage.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas")) {
            const context = candidate.getContext("webgl2");
            if (context && !context.isContextLost()) {
              rendererCanvas = candidate;
              rendererContext = context;
              break;
            }
          }
          const canvas = rendererCanvas;
          if (!canvas) throw new Error("WebGL 渲染器未建立，终端未启动。");
          canvas.dataset["terminalWebglCanvas"] = "true";
          const lost = (event: Event) => {
            event.preventDefault();
            // Own the native event before the addon's delayed restoration timer/logging.
            event.stopImmediatePropagation();
            onLoss();
          };
          canvas.addEventListener("webglcontextlost", lost, true);
          removeContextLoss = () => canvas.removeEventListener("webglcontextlost", lost, true);
          session.fit();
          terminal.refresh(0, terminal.rows - 1); // Public onRender excludes redraw-only startup frames.
          removeFontsReady = watchTerminalFonts(doc, fontsReady, remeasureFonts); // Late font readiness after the bounded wait.
        });
      } catch (error) {
        dispose();
        throw new Error(`WebGL 初始化失败，终端未启动。${error instanceof Error ? error.message : ""}`);
      }
    },
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener("abort", dispose);
    abort.abort();
    lifecycle.dispose();
    for (const link of links) link.remove();
    container.replaceChildren();
  };
  try {
    if (options.signal?.aborted) throw new Error("终端界面已取消。");
    options.signal?.addEventListener("abort", dispose, { once: true });
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
            const failed = () => finish(new Error("终端样式表加载失败，终端未启动。"));
            const cancelled = () => finish(new Error("终端样式表加载已取消。"));
            const timer = setTimeout(() => finish(new Error("终端样式表加载超时，终端未启动。")), 5_000);
            link.addEventListener("load", loaded, { once: true });
            link.addEventListener("error", failed, { once: true });
            abort.signal.addEventListener("abort", cancelled, { once: true });
            doc.head.appendChild(link);
          }),
      ),
    );
    await lifecycle.start();
    return {
      get terminal() {
        return lifecycle.current?.terminal;
      },
      get state() {
        return lifecycle.state;
      },
      fit: () => lifecycle.current?.fit(),
      write: (bytes: string | Uint8Array) =>
        lifecycle.current?.write(bytes) ?? Promise.reject(new Error("WebGL 终端未就绪，请稍后重试或重开终端。")),
      theme: () => {
        theme = { background: "#f0e0d0", foreground: "#203040" };
        if (lifecycle.current) lifecycle.current.terminal.options.theme = theme;
      },
      setFontSize: (size: number) => {
        fontSize = Math.max(10, Math.min(24, Math.round(size)));
        if (lifecycle.current) {
          lifecycle.current.terminal.options.fontSize = fontSize;
          lifecycle.current.fit();
        }
      },
      font: () => {
        fontSize = 18;
        if (lifecycle.current) {
          lifecycle.current.terminal.options.fontSize = fontSize;
          lifecycle.current.fit();
        }
      },
      focus: () => lifecycle.current?.terminal.focus(),
      dispose,
    };
  } catch (error) {
    suppressState = true;
    dispose();
    throw error;
  }
}
