import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { handleBatchTidyCommand } from "../../../src/memory/tidy/batch-command.js";
import { DEFAULT_TIDY_BATCH_SETTINGS } from "../../../src/memory/tidy/batch-settings.js";
import { memoryDirFor, type MemoryPaths } from "../../../src/memory/paths.js";
import type { SelectionCandidate } from "../../../src/memory/tidy/selection.js";
import {
  createSelectionComponent,
  decodeSelectionInput,
  openSelectionView,
  renderSelectionView,
  SelectionViewModel,
  type SelectionColorize,
} from "../../../src/memory/tidy/selection-view.js";

function candidate(overrides: Partial<SelectionCandidate> = {}): SelectionCandidate {
  return { name: "c.md", bytes: 1024, ...overrides };
}

function modelOf(list: readonly SelectionCandidate[], selected: Iterable<string> = []): SelectionViewModel {
  return new SelectionViewModel({ candidates: list, selected: new Set(selected) });
}

describe("decodeSelectionInput", () => {
  it("maps movement, toggling and terminal keys", () => {
    expect(decodeSelectionInput("\x1b")).toEqual({ type: "cancel" });
    expect(decodeSelectionInput("\r")).toEqual({ type: "continue" });
    expect(decodeSelectionInput("\x1b[A")).toEqual({ type: "up" });
    expect(decodeSelectionInput("\x1b[B")).toEqual({ type: "down" });
    expect(decodeSelectionInput("k")).toEqual({ type: "up" });
    expect(decodeSelectionInput("j")).toEqual({ type: "down" });
    expect(decodeSelectionInput(" ")).toEqual({ type: "toggle" });
    expect(decodeSelectionInput("v")).toEqual({ type: "view" });
    expect(decodeSelectionInput("s")).toEqual({ type: "suggested" });
    expect(decodeSelectionInput("c")).toEqual({ type: "clear" });
    expect(decodeSelectionInput("\x1b[5~")).toEqual({ type: "pageUp" });
    expect(decodeSelectionInput("\x1b[6~")).toEqual({ type: "pageDown" });
    expect(decodeSelectionInput("x")).toBeUndefined();
  });
});

describe("SelectionViewModel", () => {
  const list = [
    candidate({ name: "one.md", suggested: true }),
    candidate({ name: "two.md", signals: ["S2"] }),
    candidate({ name: "three.md", signals: ["S4"] }),
    candidate({ name: "blocked.md", conflict: true }),
  ];

  it("keeps the cursor on the row that was just toggled", () => {
    const model = modelOf(list, ["one.md"]);
    model.handleInput("\x1b[B");
    model.handleInput("\x1b[B");
    expect(model.snapshot().cursor).toBe(2);
    model.handleInput(" ");
    const after = model.snapshot();
    expect(after.cursor).toBe(2);
    expect(after.selected.has("three.md")).toBe(true);
    expect(after.selected.has("one.md")).toBe(true);
    model.handleInput(" ");
    expect(model.snapshot().selected.has("three.md")).toBe(false);
    expect(model.snapshot().cursor).toBe(2);
  });

  it("refuses to toggle conflict rows and keeps their cursor position", () => {
    const model = modelOf(list, ["one.md"]);
    model.handleInput("\x1b[A"); // wraps 0 → last (conflict row)
    expect(model.snapshot().cursor).toBe(3);
    model.handleInput(" ");
    const after = model.snapshot();
    expect(after.cursor).toBe(3);
    expect([...after.selected]).toEqual(["one.md"]);
  });

  it("suggested/clear reuse the selection reducer semantics", () => {
    const model = modelOf(list, ["two.md"]);
    model.handleInput("s");
    expect([...model.snapshot().selected]).toEqual(["one.md"]);
    model.handleInput("c");
    expect(model.snapshot().selected.size).toBe(0);
  });

  it("view/enter/esc close the model with an event and keep the cursor", () => {
    const model = modelOf(list, ["one.md"]);
    model.handleInput("j");
    model.handleInput("v");
    expect(model.snapshot()).toMatchObject({ closed: true, event: { kind: "view", name: "two.md" } });
    const again = modelOf(list, ["one.md"]);
    again.handleInput("\r");
    expect(again.snapshot().event).toEqual({ kind: "confirm" });
    const third = modelOf(list, ["one.md"]);
    third.handleInput("\x1b");
    expect(third.snapshot().event).toEqual({ kind: "cancel" });
  });

  it("ignores input after closing", () => {
    const model = modelOf(list);
    model.handleInput("\x1b");
    model.handleInput("j");
    expect(model.snapshot().cursor).toBe(0);
  });
});

describe("renderSelectionView", () => {
  const long: SelectionCandidate[] = Array.from({ length: 10 }, (_, i) =>
    candidate({ name: `file-${i}.md`, bytes: (i + 1) * 512, signals: ["S2"] }),
  );

  it("renders every line at or below the requested width, plain and colored", () => {
    const model = modelOf(long, ["file-2.md"]);
    model.handleInput("G"); // cursor → last row
    const snapshot = model.snapshot();
    const colored: SelectionColorize = (tone, text) => (tone === "muted" ? `\x1b[2m${text}\u001b[22m` : text);
    for (const width of [60, 80, 100]) {
      for (const colorize of [undefined, colored]) {
        const lines = renderSelectionView(snapshot, { width, maxVisible: 5, ...(colorize ? { colorize } : {}) });
        expect(lines.length).toBeGreaterThan(5);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(visibleWidth(lines[0]!)).toBe(width); // border row is always full width
      }
    }
  });

  it("scrolls so the cursor stays visible and reports the position", () => {
    const model = modelOf(long);
    model.handleInput("G");
    const lines = renderSelectionView(model.snapshot(), { width: 80, maxVisible: 5 }).join("\n");
    expect(lines).toContain("file-9.md");
    expect(lines).toContain("(10/10)");
    expect(lines).not.toContain("file-0.md");
    expect(lines.match(/\[[ x]\]/gu)?.length ?? 0).toBe(5); // exactly one window of rows
  });

  it("shows checkbox, size, signals, conflict marker and the selected totals", () => {
    const list = [
      candidate({ name: "old.md", bytes: 2048, signals: ["S1"], suggested: true }),
      candidate({ name: "clash.md", bytes: 512, signals: ["S4"], conflict: true }),
    ];
    const model = modelOf(list, ["old.md"]);
    const lines = renderSelectionView(model.snapshot(), { width: 80 }).join("\n");
    expect(lines).toContain("[x] old.md");
    expect(lines).toContain("2KiB");
    expect(lines).toContain("S1");
    expect(lines).toContain("[-] clash.md");
    expect(lines).toContain("conflict");
    expect(lines).toContain("1 selected · 2KiB");
  });
});

describe("createSelectionComponent", () => {
  const list = [candidate({ name: "a.md" }), candidate({ name: "b.md" }), candidate({ name: "c.md" })];

  it("finishes via done on enter and re-renders on plain movement", () => {
    const model = modelOf(list);
    const done = vi.fn();
    const requestRender = vi.fn();
    const component = createSelectionComponent({ model, done, requestRender });
    component.handleInput("j");
    expect(done).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledTimes(1);
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ kind: "confirm" });
    component.handleInput("\x1b"); // ignored after close
    expect(done).toHaveBeenCalledTimes(1);
    expect(component.render(80).every((line) => visibleWidth(line) <= 80)).toBe(true);
  });
});

interface CustomSession {
  component: Component;
  done: (event: unknown) => void;
}

/** Records every ui.custom component so tests can feed keys and read renders. */
function customRecorder() {
  const sessions: CustomSession[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const custom = vi.fn(
    async (
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (event: unknown) => void) => unknown,
    ): Promise<unknown> => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((r) => {
        resolve = r;
      });
      const component = (await factory(
        { requestRender: () => {}, terminal: { rows: 40 } },
        theme,
        { matches: () => false },
        resolve,
      )) as Component;
      sessions.push({ component, done: resolve });
      return promise;
    },
  );
  return { custom, sessions };
}

const asCustom = (fn: unknown): ExtensionUIContext["custom"] => fn as ExtensionUIContext["custom"];

describe("openSelectionView", () => {
  const list = [
    candidate({ name: "one.md", suggested: true }),
    candidate({ name: "two.md", signals: ["S2"] }),
    candidate({ name: "three.md", signals: ["S4"] }),
  ];

  it("resolves the terminal event and preserves cursor/selection across re-opens", async () => {
    const rec = customRecorder();
    const model = modelOf(list, ["one.md"]);
    const first = openSelectionView({ custom: asCustom(rec.custom) }, model);
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(1));
    rec.sessions[0]!.component.handleInput("j");
    rec.sessions[0]!.component.handleInput(" ");
    rec.sessions[0]!.component.handleInput("v");
    await expect(first).resolves.toEqual({ kind: "view", name: "two.md" });
    const preserved = model.snapshot();
    expect(preserved.cursor).toBe(1);
    expect(preserved.selected.has("two.md")).toBe(true);
    const second = openSelectionView({ custom: asCustom(rec.custom) }, model);
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(2));
    expect(rec.sessions[1]!.component.render(80).join("\n")).toContain("[x] two.md");
    rec.sessions[1]!.component.handleInput("\x1b");
    await expect(second).resolves.toEqual({ kind: "cancel" });
  });

  it("resolves cancel when the dialog signal aborts after opening", async () => {
    const rec = customRecorder();
    const controller = new AbortController();
    const promise = openSelectionView({ custom: asCustom(rec.custom) }, modelOf(list), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(1));
    controller.abort();
    await expect(promise).resolves.toEqual({ kind: "cancel" });
  });

  it("resolves cancel immediately for an already-aborted signal", async () => {
    const rec = customRecorder();
    const promise = openSelectionView({ custom: asCustom(rec.custom) }, modelOf(list), {
      signal: AbortSignal.abort(),
    });
    await expect(promise).resolves.toEqual({ kind: "cancel" });
  });

  it("resolves undefined when custom never engages the factory (inert stub)", async () => {
    const custom = vi.fn(async () => undefined);
    const event = await openSelectionView({ custom: asCustom(custom) }, modelOf(list));
    expect(event).toBeUndefined();
  });

  it("resolves undefined when custom throws", async () => {
    const custom = vi.fn(async () => {
      throw new Error("no focus");
    });
    const event = await openSelectionView({ custom: asCustom(custom) }, modelOf(list));
    expect(event).toBeUndefined();
  });
});

function fixture(): { cwd: string; paths: MemoryPaths; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "tidy-selection-"));
  const cwd = join(root, "project");
  const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "archive"), { recursive: true });
  mkdirSync(join(dir, ".trash"), { recursive: true });
  // Names force the candidate order (snapshot lists alphabetically):
  // 0 = a-clash.md (S4, conflict), 1 = b-old.md (S1, suggested), 2 = c-stale.md (S2).
  writeFileSync(join(dir, "memory.md"), "- [Old](b-old.md)\n- [Stale](c-stale.md)\n- [Done](a-clash.md)\n");
  writeFileSync(join(dir, "a-clash.md"), "---\nsource: agent\nstatus: active\n---\ndone\n");
  writeFileSync(join(dir, "archive", "a-clash.md"), "---\nsource: agent\n---\nalready archived\n");
  writeFileSync(join(dir, "b-old.md"), "---\nsource: agent\nstatus: archived\n---\nold\n");
  writeFileSync(join(dir, "c-stale.md"), "---\nsource: agent\nstatus: stale\n---\nstale\n");
  return { cwd, paths, dir };
}

function settings() {
  return {
    coreBytes: 1600,
    topicMaxBytes: 16_384,
    tidy: {
      agentType: "Plan",
      model: "",
      timeoutMs: 30_000,
      maxInputBytes: 49_152,
      maxOutputBytes: 65_536,
      maxCostUsd: 2,
      maxTurns: 4,
      batch: { ...DEFAULT_TIDY_BATCH_SETTINGS },
    },
  };
}

function context(cwd: string, ui: Record<string, unknown>): ExtensionCommandContext {
  return { cwd, mode: "tui", hasUI: true, ui } as unknown as ExtensionCommandContext;
}

describe("selectArchives wiring (batch-command)", () => {
  it("falls back to the legacy select loop when ui.custom is missing", async () => {
    const fx = fixture();
    const select = vi.fn(async (_title: string, values: string[]) => values[0]);
    const confirm = vi.fn(async () => true);
    await handleBatchTidyCommand("--batch --archive-only", context(fx.cwd, { notify: vi.fn(), select, confirm }), {
      paths: fx.paths,
      settings: settings(),
    });
    expect(select).toHaveBeenCalled();
    expect(select.mock.calls[0]![0]).toBe("Archive memory files");
    expect(confirm).toHaveBeenCalled();
    expect(existsSync(join(fx.dir, "b-old.md"))).toBe(false); // archived via the legacy loop
    expect(existsSync(join(fx.dir, "archive", "b-old.md"))).toBe(true);
  });

  it("falls back to the select loop when ui.custom exists but never engages (inert stub)", async () => {
    const fx = fixture();
    const select = vi.fn(async (_title: string, values: string[]) => values[0]);
    const confirm = vi.fn(async () => true);
    await handleBatchTidyCommand(
      "--batch --archive-only",
      context(fx.cwd, { notify: vi.fn(), select, confirm, custom: vi.fn(async () => undefined) }),
      { paths: fx.paths, settings: settings() },
    );
    expect(select).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalled();
    expect(existsSync(join(fx.dir, "archive", "b-old.md"))).toBe(true);
  });

  it("uses the overlay instead of select when ui.custom exists; esc cancels with nothing archived", async () => {
    const fx = fixture();
    const rec = customRecorder();
    const select = vi.fn();
    const run = handleBatchTidyCommand(
      "--batch --archive-only",
      context(fx.cwd, { notify: vi.fn(), select, confirm: vi.fn(async () => true), custom: rec.custom }),
      { paths: fx.paths, settings: settings() },
    );
    await vi.waitFor(() => expect(rec.custom).toHaveBeenCalled());
    expect(select).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(1));
    rec.sessions[0]!.component.handleInput("\x1b");
    await run;
    expect(existsSync(join(fx.dir, "b-old.md"))).toBe(true);
    expect(existsSync(join(fx.dir, "archive", "b-old.md"))).toBe(false);
  });

  it("keeps cursor and selection after a declined confirm and after viewing a file", async () => {
    const fx = fixture();
    const rec = customRecorder();
    const confirm = vi.fn(async (_title: string, message: string) => {
      expect(message).toContain("Move 1 files");
      return false;
    });
    const run = handleBatchTidyCommand(
      "--batch --archive-only",
      context(fx.cwd, { notify: vi.fn(), select: vi.fn(), confirm, custom: rec.custom }),
      { paths: fx.paths, settings: settings() },
    );
    // Enter → confirm declines → the list re-opens with the same state.
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(1));
    rec.sessions[0]!.component.handleInput("\r");
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(2));
    expect(rec.sessions[1]!.component.render(80).join("\n")).toContain("[x] b-old.md");
    // Move to c-stale.md (row 2), toggle it on, view it, come back.
    const list = rec.sessions[1]!;
    list.component.handleInput("j");
    list.component.handleInput("j");
    list.component.handleInput(" ");
    list.component.handleInput("v");
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(3));
    rec.sessions[2]!.component.handleInput("q"); // close the bounded viewer
    await vi.waitFor(() => expect(rec.sessions).toHaveLength(4));
    const lines = rec.sessions[3]!.component.render(80).join("\n");
    expect(lines).toContain("› [x] c-stale.md"); // cursor still on the viewed row
    expect(lines).toContain("[x] b-old.md");
    expect(lines).toContain("2 selected");
    rec.sessions[3]!.component.handleInput("\x1b");
    await run;
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(existsSync(join(fx.dir, "b-old.md"))).toBe(true);
  });
});
