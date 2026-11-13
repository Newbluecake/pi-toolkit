/** Isolated P0 host entry. Never imported by the SPA; only the local probe loads it. */
import type { mountTerminalSpike } from "./terminal-impl.js";

type Spike = Awaited<ReturnType<typeof mountTerminalSpike>>;
const root = document.querySelector<HTMLElement>("[data-terminal-spike]");
if (root) {
  const surface = document.createElement("div");
  surface.className = "terminal-spike-surface";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "P0 local bytes only. Ctrl+Shift+F6: leave terminal input focus.";
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
          status.textContent = error instanceof Error ? error.message : "Terminal spike failed";
          root.dataset["error"] = "true";
        });
    });
    root.appendChild(control);
    return control;
  };
  const publish = () => {
    if (!current) return;
    root.dataset["rows"] = String(current.terminal.rows);
    root.dataset["cols"] = String(current.terminal.cols);
    root.dataset["fontSize"] = String(current.terminal.options.fontSize);
    root.dataset["bufferText"] = Array.from(
      { length: current.terminal.buffer.active.length },
      (_, i) => current!.terminal.buffer.active.getLine(i)?.translateToString(true) ?? "",
    ).join("\n");
  };
  const open = button(
    "Open terminal spike",
    async () => {
      if (pending || current) return;
      pending = true;
      open.disabled = true;
      const mine = ++generation;
      try {
        const { mountTerminalSpike } = await import("./terminal-impl.js");
        const query = new URL(location.href).searchParams;
        const instance = await mountTerminalSpike(surface, !query.has("negative"), query.get("renderer") !== "dom");
        if (mine !== generation) {
          instance.dispose();
          return;
        }
        current = instance;
        await instance.write(
          "P0 terminal ready\r\n\x1b[31mRED\x1b[0m \u4e2d\u6587\r\n\x1b[38;2;12;34;56mTRUECOLOR\x1b[48;2;210;200;190mBG\x1b[0m\r\n",
        );
        publish();
        root.dataset["ready"] = "true";
        root.dataset["error"] = "false";
        status.textContent = "P0 ready. Ctrl+Shift+F6: leave terminal input focus.";
      } finally {
        pending = false;
        open.disabled = !!current;
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
      open.disabled = pending;
      root.dataset["disposed"] = "true";
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
