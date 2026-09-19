import { describe, expect, it, vi } from "vitest";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { DEFERRED_RELOAD_COMMAND, createReloadEditorFactory, wrapReloadEditor } from "../../src/reload/editor.js";

interface FakeEditor extends EditorComponent {
  text: string;
  inputs: string[];
}

function fakeEditor(initial = ""): FakeEditor {
  const editor: FakeEditor = {
    text: initial,
    inputs: [],
    getText: () => editor.text,
    setText: (text: string) => {
      editor.text = text;
    },
    handleInput: (data: string) => {
      editor.inputs.push(data);
    },
    render: () => [editor.text],
    invalidate: () => undefined,
  };
  return editor;
}

describe("wrapReloadEditor", () => {
  it("rewrites an exact /reload on plain Enter before forwarding", () => {
    const inner = fakeEditor("/reload");
    const wrapped = wrapReloadEditor(inner);
    wrapped.handleInput("\r");
    expect(inner.text).toBe(DEFERRED_RELOAD_COMMAND);
    expect(inner.inputs).toEqual(["\r"]);
  });

  it("rewrites with surrounding whitespace and on \\n", () => {
    const inner = fakeEditor("  /reload ");
    wrapReloadEditor(inner).handleInput("\n");
    expect(inner.text).toBe(DEFERRED_RELOAD_COMMAND);
  });

  it("leaves non-exact input untouched", () => {
    for (const text of ["/reload x", "reload", "/reloads", "hello /reload"]) {
      const inner = fakeEditor(text);
      wrapReloadEditor(inner).handleInput("\r");
      expect(inner.text).toBe(text);
      expect(inner.inputs).toEqual(["\r"]);
    }
  });

  it("never rewrites on non-Enter keys", () => {
    const inner = fakeEditor("/reload");
    const wrapped = wrapReloadEditor(inner);
    wrapped.handleInput("a");
    wrapped.handleInput("\x1b[A"); // arrow up
    expect(inner.text).toBe("/reload");
    expect(inner.inputs).toEqual(["a", "\x1b[A"]);
  });

  it("forwards render/invalidate and property sets to the inner editor", () => {
    const inner = fakeEditor("abc");
    const wrapped = wrapReloadEditor(inner);
    expect(wrapped.render(80)).toEqual(["abc"]);
    const onSubmit = vi.fn();
    wrapped.onSubmit = onSubmit;
    expect(inner.onSubmit).toBe(onSubmit);
    expect(wrapped.getText()).toBe("abc");
    wrapped.setText("xyz");
    expect(inner.text).toBe("xyz");
  });

  it("returns a non-rewritable editor unwrapped (defense)", () => {
    const bare = { render: () => [""], invalidate: () => undefined } as unknown as EditorComponent;
    expect(wrapReloadEditor(bare)).toBe(bare);
  });
});

describe("createReloadEditorFactory", () => {
  it("wraps the previous factory's editor", () => {
    const inner = fakeEditor("/reload");
    const factory = createReloadEditorFactory(() => inner);
    const editor = factory(null as never, null as never, null as never);
    editor.handleInput("\r");
    expect(inner.text).toBe(DEFERRED_RELOAD_COMMAND);
  });

  it("installs a CustomEditor when no previous factory exists", () => {
    const factory = createReloadEditorFactory(undefined);
    const theme = { borderColor: (s: string) => s };
    const editor = factory(null as never, theme as never, null as never);
    expect(typeof editor.handleInput).toBe("function");
    expect(editor.getText()).toBe("");
  });
});
