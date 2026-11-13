/** Isolated P0 WebGL-only host. Never imported by the SPA; no shell/transport. */
import type { mountTerminalSpike, WebglUiState } from "./terminal-impl.js";

type Spike = Awaited<ReturnType<typeof mountTerminalSpike>>;
const root = document.querySelector<HTMLElement>("[data-terminal-spike]");
if (root) {
  const surface = document.createElement("div");
  surface.className = "terminal-spike-surface";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "P0 本地测试数据；仅支持 WebGL。Ctrl+Shift+F6：退出终端输入焦点。";
  let current: Spike | undefined;
  let pending = false;
  let generation = 0;
  const button = (label: string, action: () => void | Promise<void>, attr: string) => {
    const control = document.createElement("button");
    control.textContent = label;
    control.setAttribute(attr, "");
    control.addEventListener("click", () => {
      void Promise.resolve()
        .then(action)
        .catch((error: unknown) => {
          status.textContent = `终端未启动或操作未完成：${error instanceof Error ? error.message : "请重开终端。"}`;
          root.dataset["error"] = "true";
          if (!current) root.dataset["state"] = "unavailable";
        });
    });
    root.appendChild(control);
    return control;
  };
  const publish = () => {
    const terminal = current?.terminal;
    if (!terminal) return;
    root.dataset["rows"] = String(terminal.rows);
    root.dataset["cols"] = String(terminal.cols);
    root.dataset["fontSize"] = String(terminal.options.fontSize);
    root.dataset["contrast"] = String(terminal.options.minimumContrastRatio);
    root.dataset["bufferText"] = Array.from(
      { length: terminal.buffer.active.length },
      (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? "",
    ).join("\n");
  };
  const seed = async (instance: Spike, mine: number) => {
    await instance.write(
      "P0 terminal ready\r\n\x1b[31mRED\x1b[0m 中文\r\n\x1b[38;2;12;34;56mTRUECOLOR\x1b[48;2;210;200;190mBG\x1b[0m\r\n",
    );
    if (mine !== generation) return;
    publish();
    root.dataset["ready"] = "true";
    root.dataset["error"] = "false";
  };
  const stateChanged = (state: WebglUiState, mine: number) => {
    if (mine !== generation) return;
    status.textContent = state.reason;
    root.dataset["state"] = state.phase;
    root.dataset["rebuilds"] = String(state.rebuilds);
    if (state.phase !== "ready") {
      delete root.dataset["ready"];
      delete root.dataset["bufferText"];
    }
    open.disabled = state.phase === "starting" || state.phase === "recovering" || state.phase === "ready";
    if (state.phase === "ready" && state.rebuilds > 0 && current) {
      void seed(current, mine).catch((error: unknown) => {
        if (mine === generation) {
          status.textContent = `界面重放失败，请重开终端。${String(error)}`;
          root.dataset["error"] = "true";
        }
      });
    }
  };
  const open = button(
    "Open WebGL terminal spike",
    async () => {
      if (pending || current?.terminal) return;
      current?.dispose();
      current = undefined;
      pending = true;
      open.disabled = true;
      root.dataset["state"] = "starting";
      root.dataset["rebuilds"] = "0";
      const mine = ++generation;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const module = await Promise.race([
          import("./terminal-impl.js"),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("终端组件加载超时，请重试。")), 5_000);
          }),
        ]);
        const instance = await module.mountTerminalSpike(surface, {
          onStateChange: (state) => stateChanged(state, mine),
        });
        if (mine !== generation) {
          instance.dispose();
          return;
        }
        current = instance;
        await seed(instance, mine);
      } finally {
        clearTimeout(timer);
        pending = false;
        open.disabled = !!current?.terminal;
      }
    },
    "data-terminal-open",
  );
  button("Focus terminal", () => current?.focus(), "data-terminal-focus");
  button(
    "Resize / maximize",
    () => {
      surface.classList.toggle("is-large");
      current?.fit();
      publish();
    },
    "data-terminal-resize",
  );
  button("Theme", () => current?.theme(), "data-terminal-theme");
  button(
    "Font",
    () => {
      current?.font();
      publish();
    },
    "data-terminal-font",
  );
  button(
    "Replay / alternate screen / OSC",
    async () => {
      await current?.write(
        "\x1b[?1049hALTERNATE\x1b[?1049l\r\nREPLAY\x1b]52;c;UE9JU09O\x07\x1b]2;POISON\x07\x1b]8;;/probe-sink/\x07TEXT\x1b]8;;\x07",
      );
      publish();
      root.dataset["replayed"] = "true";
    },
    "data-terminal-replay",
  );
  button(
    "Dispose",
    () => {
      generation++;
      current?.dispose();
      current = undefined;
      delete root.dataset["ready"];
      root.dataset["state"] = "disposed";
      open.disabled = pending;
      root.dataset["disposed"] = "true";
      status.textContent = "终端界面已关闭。";
    },
    "data-terminal-dispose",
  );
  root.append(status, surface);
  window.addEventListener(
    "pagehide",
    () => {
      generation++;
      current?.dispose();
    },
    { once: true },
  );
}
