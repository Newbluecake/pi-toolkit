// Contract pin: the editor chain pi-toolkit installs (SessionNavEditor, optionally wrapped by the
// deferred-reload Proxy) must keep pi's app-level key actions alive. pi's
// `setCustomEditorComponent` (interactive-mode.js) only copies `defaultEditor.actionHandlers` onto a
// custom editor when `"actionHandlers" in editor && editor.actionHandlers instanceof Map`, and
// `CustomEditor.handleInput` then dispatches `app.message.dequeue` (Alt+Up → handleDequeue →
// restoreQueuedMessagesToEditor) through that map. If a toolkit editor ever stops satisfying the
// duck-typed check, or swallows Alt+Up before the action dispatch, restoring queued steering messages
// silently breaks — no error, the key just does nothing.

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager as PiKeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type EditorComponent,
  type KeybindingDefinitions,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createReloadEditorFactory, wrapReloadEditor } from "../../src/reload/editor.js";
import { SessionNavEditor } from "../../src/session-nav/index.js";

type Ctor = ConstructorParameters<typeof SessionNavEditor>;

/**
 * pi-coding-agent exports its KeybindingsManager only as a type, so build the same thing from pi-tui's
 * manager: the tui.* editor defaults plus the app.* defaults CustomEditor.handleInput consults
 * (`app.message.dequeue` = alt+up on non-Windows, from pi's core/keybindings). No user config is read.
 */
function defaultKeybindings(): PiKeybindingsManager {
  const definitions = {
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape" },
    "app.exit": { defaultKeys: "ctrl+d" },
    "app.clipboard.pasteImage": { defaultKeys: "ctrl+v" },
    "app.message.dequeue": { defaultKeys: "alt+up" },
  } as unknown as KeybindingDefinitions;
  const manager = new KeybindingsManager(definitions);
  setKeybindings(manager);
  return manager as unknown as PiKeybindingsManager;
}

const tui = { requestRender: () => undefined } as unknown as Ctor[0];
const theme = { borderColor: (text: string) => text } as unknown as Ctor[1];

/** Alt+Up as the terminal sends it (xterm modifier form, what tmux `M-Up` emits). */
const ALT_UP = "\x1b[1;3A";

/**
 * Mirrors pi's `setCustomEditorComponent` handler hand-over (duck typing — "instanceof fails across
 * jiti module boundaries"). `copied` reports whether the copy branch was taken at all.
 */
function installLikePi(
  customEditor: EditorComponent,
  defaultEditor: CustomEditor,
): { copied: boolean; editor: CustomEditor } {
  const editor = customEditor as unknown as CustomEditor;
  if ("actionHandlers" in editor && editor.actionHandlers instanceof Map) {
    if (!editor.onEscape) editor.onEscape = () => defaultEditor.onEscape?.();
    if (!editor.onCtrlD) editor.onCtrlD = () => defaultEditor.onCtrlD?.();
    if (!editor.onPasteImage) editor.onPasteImage = () => defaultEditor.onPasteImage?.();
    if (!editor.onExtensionShortcut) editor.onExtensionShortcut = (data) => defaultEditor.onExtensionShortcut?.(data);
    for (const [action, handler] of defaultEditor.actionHandlers) editor.actionHandlers.set(action, handler);
    return { copied: true, editor };
  }
  return { copied: false, editor };
}

function makeDefaultEditor(keybindings: PiKeybindingsManager): { editor: CustomEditor; dequeue: () => number } {
  const editor = new CustomEditor(tui, theme as never, keybindings);
  const dequeue = vi.fn();
  editor.onAction("app.message.dequeue", dequeue);
  return { editor, dequeue: () => dequeue.mock.calls.length };
}

describe("toolkit editor chain keeps pi's app actions (Alt+Up → app.message.dequeue)", () => {
  it("sanity: the default key for app.message.dequeue is Alt+Up and the plain CustomEditor dispatches it", () => {
    const keybindings = defaultKeybindings();
    expect(keybindings.matches(ALT_UP, "app.message.dequeue" as never)).toBe(true);
    const { editor, dequeue } = makeDefaultEditor(keybindings);
    editor.handleInput(ALT_UP);
    expect(dequeue()).toBe(1);
  });

  it("SessionNavEditor satisfies pi's duck-typed hand-over check and dispatches Alt+Up", () => {
    const keybindings = defaultKeybindings();
    const { editor: defaultEditor, dequeue } = makeDefaultEditor(keybindings);
    const nav = new SessionNavEditor(tui, theme as never, keybindings);
    const { copied, editor } = installLikePi(nav, defaultEditor);
    expect(copied).toBe(true);
    editor.handleInput(ALT_UP);
    expect(dequeue()).toBe(1);
  });

  it("the reload Proxy over SessionNavEditor satisfies the check (has / instanceof Map) and dispatches Alt+Up", () => {
    const keybindings = defaultKeybindings();
    const { editor: defaultEditor, dequeue } = makeDefaultEditor(keybindings);
    const wrapped = wrapReloadEditor(new SessionNavEditor(tui, theme as never, keybindings));
    expect("actionHandlers" in wrapped).toBe(true);
    expect((wrapped as unknown as CustomEditor).actionHandlers).toBeInstanceOf(Map);
    const { copied, editor } = installLikePi(wrapped, defaultEditor);
    expect(copied).toBe(true);
    editor.handleInput(ALT_UP);
    expect(dequeue()).toBe(1);
  });

  it("handlers copied through the Proxy land in the inner editor's own map (not a detached copy)", () => {
    const keybindings = defaultKeybindings();
    const { editor: defaultEditor } = makeDefaultEditor(keybindings);
    const inner = new SessionNavEditor(tui, theme as never, keybindings);
    const { editor } = installLikePi(wrapReloadEditor(inner), defaultEditor);
    expect(editor.actionHandlers).toBe(inner.actionHandlers);
    expect(inner.actionHandlers.has("app.message.dequeue")).toBe(true);
  });

  it("the production chain (createReloadEditorFactory over the SessionNavEditor factory) dispatches Alt+Up", () => {
    const keybindings = defaultKeybindings();
    const { editor: defaultEditor, dequeue } = makeDefaultEditor(keybindings);
    const navFactory = (t: Ctor[0], th: Ctor[1], kb: Ctor[2]) => new SessionNavEditor(t, th, kb);
    const { copied, editor } = installLikePi(
      createReloadEditorFactory(navFactory)(tui, theme, keybindings),
      defaultEditor,
    );
    expect(copied).toBe(true);
    editor.handleInput(ALT_UP);
    editor.handleInput(ALT_UP);
    expect(dequeue()).toBe(2);
  });

  it("with no session-nav editor beneath, the reload wrapper falls back to a CustomEditor that still dispatches", () => {
    const keybindings = defaultKeybindings();
    const { editor: defaultEditor, dequeue } = makeDefaultEditor(keybindings);
    const { copied, editor } = installLikePi(
      createReloadEditorFactory(undefined)(tui, theme, keybindings),
      defaultEditor,
    );
    expect(copied).toBe(true);
    editor.handleInput(ALT_UP);
    expect(dequeue()).toBe(1);
  });

  it("Alt+Up leaves the draft text untouched and never triggers the Enter rewrites", () => {
    const keybindings = defaultKeybindings();
    const { editor: defaultEditor, dequeue } = makeDefaultEditor(keybindings);
    const { editor } = installLikePi(
      wrapReloadEditor(new SessionNavEditor(tui, theme as never, keybindings)),
      defaultEditor,
    );
    editor.setText("/reload");
    editor.handleInput(ALT_UP);
    expect(dequeue()).toBe(1);
    expect(editor.getText()).toBe("/reload");
  });
});
