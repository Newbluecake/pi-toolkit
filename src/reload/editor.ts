/**
 * Deferred /reload — editor wrapping.
 *
 * pi consumes its built-in `/reload` before the extension `input` event, so
 * the only interception point is the CustomEditor submit path (same trick as
 * session-nav's SessionNavEditor). session-nav already occupies
 * `ctx.ui.setEditorComponent`, so instead of replacing we WRAP: read the
 * previously installed factory via `ctx.ui.getEditorComponent()`, build its
 * editor, and return a proxy whose handleInput rewrites an exact `/reload`
 * submission into `/agent reload` (our extension command, which can defer).
 * Everything else — render, invalidate, callbacks the host assigns like
 * onSubmit — forwards straight to the inner editor.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { shouldRewriteReload } from "./defer.js";

/** pi-coding-agent does not re-export its EditorFactory type; this is the same shape. */
export type EditorFactoryLike = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/** What an exact `/reload` submission is rewritten to. */
export const DEFERRED_RELOAD_COMMAND = "/agent reload";

/** Structural check: we need getText/setText to rewrite in place (defense — a foreign editor without them is returned unwrapped). */
function isRewritableEditor(editor: EditorComponent): editor is EditorComponent & {
  getText(): string;
  setText(text: string): void;
} {
  return typeof editor.getText === "function" && typeof editor.setText === "function";
}

/**
 * Wrap an editor so an exact `/reload` + plain Enter submits
 * `/agent reload` instead. A Proxy (not a literal forwarding object) so the
 * many optional EditorComponent/CustomEditor members — onSubmit/onChange
 * assignments by the host, history, autocomplete, keybinding handlers — all
 * keep working untouched. Non-plain-Enter keys (Shift+Enter newline, etc.)
 * never trigger the rewrite.
 */
export function wrapReloadEditor(inner: EditorComponent): EditorComponent {
  if (!isRewritableEditor(inner)) return inner;
  return new Proxy(inner, {
    get(target, prop, _receiver) {
      if (prop === "handleInput") {
        return (data: string) => {
          if (data === "\r" || data === "\n") {
            if (shouldRewriteReload(target.getText())) target.setText(DEFERRED_RELOAD_COMMAND);
          }
          target.handleInput(data);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
}

/**
 * The factory installed over whatever was there before: build the previous
 * factory's editor (or a plain CustomEditor when nobody registered one) and
 * wrap it. Must be installed AFTER session-nav's own session_start handler
 * ran, so `prev` is the SessionNavEditor factory and the rewrite layers on
 * top of (not instead of) its clear/resume rewriting.
 */
export function createReloadEditorFactory(prev: EditorFactoryLike | undefined): EditorFactoryLike {
  return (tui, theme, keybindings) => {
    const inner = prev ? prev(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
    return wrapReloadEditor(inner);
  };
}
