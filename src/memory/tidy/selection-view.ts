import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fmtKiB, reduceSelection, selectedTotal, type SelectionCandidate, type SelectionState } from "./selection.js";

/**
 * Multi-select overlay for `/mem tidy --batch` archive selection.
 *
 * The bounded `ctx.ui.select` loop re-opens a fresh dialog on every toggle,
 * and pi's `ExtensionUIDialogOptions` has no initial-cursor parameter — so the
 * cursor always jumped back to the top. This module replaces that loop with a
 * real `ctx.ui.custom` list (same three-layer split as the settings editor):
 *
 *  1. {@link decodeSelectionInput} — pure key decoding (pi-tui `matchesKey`,
 *     so legacy escapes, Kitty CSI-u and modifyOtherKeys all work).
 *  2. {@link SelectionViewModel} — cursor + selection state; every selection
 *     mutation goes through `selection.ts`'s `reduceSelection`, so conflict
 *     rows stay untoggleable and suggested/clear keep their exact semantics.
 *     The model outlives the component: viewing a file or cancelling the
 *     final confirm simply re-opens the component with cursor/selection intact.
 *  3. {@link renderSelectionView} + {@link createSelectionComponent} +
 *     {@link openSelectionView} — lines out / keys in / `ui.custom` binding.
 *
 * `batch-command.ts` falls back to the old select loop when `ctx.ui.custom` is
 * unavailable.
 */

export const SELECTION_VIEW_MAX_MS = 600_000;

export type SelectionInputAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "home" }
  | { type: "end" }
  | { type: "toggle" }
  | { type: "suggested" }
  | { type: "clear" }
  | { type: "view" }
  | { type: "continue" }
  | { type: "cancel" };

function isPrintable(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data);
}

function printableText(data: string): string | undefined {
  return decodeKittyPrintable(data) ?? (isPrintable(data) ? data : undefined);
}

/** Decode one raw stdin chunk into a selection action, or `undefined` to ignore it. */
export function decodeSelectionInput(data: string): SelectionInputAction | undefined {
  if (matchesKey(data, "escape")) return { type: "cancel" };
  if (matchesKey(data, "enter")) return { type: "continue" };
  if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) return { type: "up" };
  if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) return { type: "down" };
  if (matchesKey(data, "pageUp")) return { type: "pageUp" };
  if (matchesKey(data, "pageDown")) return { type: "pageDown" };
  if (matchesKey(data, "home")) return { type: "home" };
  if (matchesKey(data, "end")) return { type: "end" };
  if (matchesKey(data, "space")) return { type: "toggle" };
  switch (printableText(data)) {
    case "k":
      return { type: "up" };
    case "j":
      return { type: "down" };
    case "g":
      return { type: "home" };
    case "G":
      return { type: "end" };
    case "v":
      return { type: "view" };
    case "s":
      return { type: "suggested" };
    case "c":
      return { type: "clear" };
    default:
      return undefined;
  }
}

/** Why the component finished: view a file (loop re-opens after), run the confirm, or give up. */
export type SelectionViewEvent = { kind: "view"; name: string } | { kind: "confirm" } | { kind: "cancel" };

export interface SelectionViewSnapshot {
  candidates: readonly SelectionCandidate[];
  selected: ReadonlySet<string>;
  cursor: number;
  closed: boolean;
  /** Terminal reason the component finished; set exactly when `closed` is true. */
  event: SelectionViewEvent | undefined;
}

/**
 * Cursor + selection state machine. Selection mutations are delegated to
 * `reduceSelection` (single source of truth); this class only owns the cursor
 * and the close/event flags, and deliberately keeps the cursor put on toggle.
 */
export class SelectionViewModel {
  private selection: SelectionState;
  private cursorIndex = 0;
  private closedFlag = false;
  private eventValue: SelectionViewEvent | undefined;

  constructor(state: SelectionState) {
    this.selection = { candidates: state.candidates, selected: new Set(state.selected) };
  }

  /** Live selection state (candidates + selected set) for the driving loop. */
  get state(): SelectionState {
    return this.selection;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  snapshot(): SelectionViewSnapshot {
    return {
      candidates: this.selection.candidates,
      selected: this.selection.selected,
      cursor: this.cursorIndex,
      closed: this.closedFlag,
      event: this.eventValue,
    };
  }

  handleInput(data: string): void {
    const action = decodeSelectionInput(data);
    if (action) this.apply(action);
  }

  /** Clear the terminal close flags for a fresh `ui.custom` session (cursor/selection stay). */
  reopen(): void {
    this.closedFlag = false;
    this.eventValue = undefined;
  }

  apply(action: SelectionInputAction): void {
    if (this.closedFlag || this.selection.candidates.length === 0) return;
    switch (action.type) {
      case "up":
      case "down": {
        const len = this.selection.candidates.length;
        this.cursorIndex = (this.cursorIndex + (action.type === "up" ? -1 : 1) + len) % len;
        return;
      }
      case "pageUp":
      case "pageDown": {
        const len = this.selection.candidates.length;
        const step = Math.max(1, Math.min(10, len - 1));
        const next = this.cursorIndex + (action.type === "pageUp" ? -step : step);
        this.cursorIndex = Math.min(len - 1, Math.max(0, next));
        return;
      }
      case "home":
        this.cursorIndex = 0;
        return;
      case "end":
        this.cursorIndex = this.selection.candidates.length - 1;
        return;
      case "toggle":
        this.selection = reduceSelection(this.selection, {
          kind: "toggle",
          name: this.selection.candidates[this.cursorIndex]!.name,
        });
        return;
      case "suggested":
        this.selection = reduceSelection(this.selection, { kind: "suggested" });
        return;
      case "clear":
        this.selection = reduceSelection(this.selection, { kind: "clear" });
        return;
      case "view":
        this.close({ kind: "view", name: this.selection.candidates[this.cursorIndex]!.name });
        return;
      case "continue":
        this.close({ kind: "confirm" });
        return;
      case "cancel":
        this.close({ kind: "cancel" });
        return;
    }
  }

  private close(event: SelectionViewEvent): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.eventValue = event;
  }
}

export type SelectionTone = "title" | "muted" | "cursor" | "name" | "nameSelected" | "box" | "conflict";
export type SelectionColorize = (tone: SelectionTone, text: string) => string;

const PLAIN: SelectionColorize = (_tone, text) => text;

/** Minimal theme surface used by the list (satisfied by pi's `Theme`). */
export interface SelectionTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export function selectionThemeColorize(theme: SelectionTheme | undefined): SelectionColorize {
  if (!theme) return PLAIN;
  return (tone, text) => {
    try {
      switch (tone) {
        case "title":
          return theme.bold(theme.fg("accent", text));
        case "muted":
          return theme.fg("dim", text);
        case "cursor":
          return theme.fg("accent", text);
        case "nameSelected":
          return theme.bold(theme.fg("accent", text));
        case "name":
          return theme.fg("text", text);
        case "box":
          return theme.fg("dim", text);
        case "conflict":
          return theme.fg("error", text);
      }
    } catch {
      return text; // a theme missing a color must never break the overlay
    }
  };
}

export interface SelectionRenderOptions {
  width: number;
  /** Rows shown at once (the list scrolls around the cursor). Default 12. */
  maxVisible?: number;
  colorize?: SelectionColorize;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Pure renderer: snapshot → bordered lines. Every line is truncated AND padded
 * to the inner width (pi-tui's compositor only fills covered columns, so
 * padding is what keeps the chat scrollback from bleeding through the overlay).
 */
export function renderSelectionView(snapshot: SelectionViewSnapshot, options: SelectionRenderOptions): string[] {
  const color = options.colorize ?? PLAIN;
  const width = Math.max(24, options.width);
  const maxVisible = Math.max(3, options.maxVisible ?? 12);
  const inner = width - 4;
  const fit = (line: string): string => {
    const cut = truncateToWidth(line, inner);
    return cut + " ".repeat(Math.max(0, inner - visibleWidth(cut)));
  };
  const total = selectedTotal({
    candidates: snapshot.candidates,
    selected: snapshot.selected,
  });
  const totals = `${total.files} selected · ${fmtKiB(total.bytes)}`;
  const lines: string[] = [
    fit(color("title", "Archive memory files")),
    fit(color("muted", `${totals} · conflict rows cannot be archived`)),
  ];
  const rows = snapshot.candidates;
  const cursor = clamp(snapshot.cursor, 0, Math.max(0, rows.length - 1));
  const start = clamp(cursor - Math.floor(maxVisible / 2), 0, Math.max(0, rows.length - maxVisible));
  const end = Math.min(start + maxVisible, rows.length);
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    const focused = i === cursor;
    const checked = snapshot.selected.has(row.name);
    const box = row.conflict ? color("conflict", "[-]") : checked ? color("nameSelected", "[x]") : color("box", "[ ]");
    const prefix = focused ? color("cursor", "›") : " ";
    const signal = row.conflict ? " conflict" : row.signals?.length ? ` ${row.signals.join(" ")}` : "";
    const suffix = `${signal}${row.reason ? ` — ${row.reason}` : ""}`;
    const detail = row.conflict ? color("conflict", suffix) : color("muted", suffix);
    lines.push(
      fit(
        `${prefix} ${box} ${color(focused ? "nameSelected" : "name", row.name)} ${color("muted", `· ${fmtKiB(row.bytes)}`)}${detail}`,
      ),
    );
  }
  if (start > 0 || end < rows.length) lines.push(fit(color("muted", `  (${cursor + 1}/${rows.length})`)));
  lines.push(fit(color("muted", totals)));
  lines.push(
    fit(color("muted", " ↑↓ move · space toggle · v view · s suggested · c clear · enter continue · esc cancel")),
  );
  const border = (text: string): string => color("muted", text);
  const top = border("╭" + "─".repeat(width - 2) + "╮");
  const bottom = border("╰" + "─".repeat(width - 2) + "╯");
  const empty = border("│") + " ".repeat(width - 2) + border("│");
  const boxed = lines.map((line) => border("│") + " " + line + " " + border("│"));
  return [top, empty, ...boxed, empty, bottom];
}

/** Bind the model + renderer to a pi TUI component; closes itself via `done`. */
export function createSelectionComponent(deps: {
  model: SelectionViewModel;
  colorize?: SelectionColorize;
  done: (event: SelectionViewEvent) => void;
  requestRender?: () => void;
  maxVisible?: number;
}): Component {
  let finished = false;
  const finish = (event: SelectionViewEvent): void => {
    if (finished) return;
    finished = true;
    deps.done(event);
  };
  return {
    render(width: number): string[] {
      return renderSelectionView(deps.model.snapshot(), {
        width,
        ...(deps.colorize === undefined ? {} : { colorize: deps.colorize }),
        ...(deps.maxVisible === undefined ? {} : { maxVisible: deps.maxVisible }),
      });
    },
    handleInput(data: string): void {
      deps.model.handleInput(data);
      if (deps.model.closed) finish(deps.model.snapshot().event ?? { kind: "cancel" });
      else deps.requestRender?.();
    },
    invalidate(): void {
      /* no cached state */
    },
  };
}

export interface SelectionViewOptions {
  signal?: AbortSignal;
  colorize?: SelectionColorize;
  maxVisible?: number;
}

/**
 * Open the list as a focused overlay. Resolves with the terminal event —
 * `{ kind: "view", name }` and `{ kind: "confirm" }` leave the model's
 * cursor/selection intact so the caller can re-open after the viewer or the
 * failed confirm without losing anything. An aborted `signal` (the
 * `withDialog` deadline) resolves `{ kind: "cancel" }` — never hangs.
 *
 * Resolves `undefined` when the host never actually engages the factory (a
 * `ctx.ui.custom` that exists but is a no-op stub, or one that throws): the
 * caller falls back to the bounded select loop instead of silently cancelling.
 */
export async function openSelectionView(
  ui: Pick<ExtensionUIContext, "custom">,
  model: SelectionViewModel,
  options: SelectionViewOptions = {},
): Promise<SelectionViewEvent | undefined> {
  let engaged = false;
  try {
    const result = await ui.custom<SelectionViewEvent | undefined>((tui, theme, _keybindings, done) => {
      engaged = true;
      model.reopen();
      let finished = false;
      const finish = (event: SelectionViewEvent): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        done(event);
      };
      const onAbort = (): void => finish({ kind: "cancel" });
      const timer = setTimeout(onAbort, SELECTION_VIEW_MAX_MS);
      timer.unref?.();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const component = createSelectionComponent({
        model,
        colorize: options.colorize ?? selectionThemeColorize(theme as unknown as SelectionTheme),
        done: finish,
        requestRender: () => tui.requestRender(),
        ...(options.maxVisible === undefined ? {} : { maxVisible: options.maxVisible }),
      });
      const dispose = (): void => {
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      return { ...component, dispose };
    });
    return engaged ? result : undefined;
  } catch {
    // A host custom that throws must degrade to the select loop, not fail tidy.
    return undefined;
  }
}
