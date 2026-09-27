// optimize-plan §4.2 / §10 I group (todo #22 P2): normalizeMemoryCall's
// alias/mutex/ignore rules, driven directly against `MemoryToolParamsV2`
// literals (no fixtures needed — this is a pure function over params).

import { describe, expect, test } from "vitest";
import { normalizeMemoryCall } from "../../src/memory/normalize.js";
import type { MemoryToolParamsV2 } from "../../src/memory/tool-surface.js";

function call(params: Partial<MemoryToolParamsV2>) {
  return normalizeMemoryCall(params as MemoryToolParamsV2);
}

describe("normalizeMemoryCall — op resolution (§4.2 rule 5)", () => {
  test("no command/action ⇒ view", () => {
    expect(call({}).op).toBe("view");
  });
  test("action:list ⇒ view", () => {
    expect(call({ action: "list" }).op).toBe("view");
  });
  test("action:write / action:append pass through as their own op", () => {
    expect(call({ action: "write", name: "a.md", content: "x" }).op).toBe("write");
    expect(call({ action: "append", name: "a.md", content: "x" }).op).toBe("append");
  });
  test("command:create ⇒ create", () => {
    expect(call({ command: "create", path: "a.md", file_text: "x" }).op).toBe("create");
  });
  test("command and action together always error, even when superficially compatible", () => {
    expect(() => call({ command: "view", action: "list" })).toThrow(/mutually exclusive/);
  });
});

describe("normalizeMemoryCall — target alias family (path/name/old_path)", () => {
  test("single alias resolves", () => {
    expect(call({ command: "view", path: "a.md" }).target).toBe("a.md");
    expect(call({ action: "list" }).target).toBeUndefined();
  });
  test("two aliases, same value ⇒ accepted with a note", () => {
    const n = call({ command: "view", path: "a.md", name: "a.md" });
    expect(n.target).toBe("a.md");
    expect(n.notes).toContain("path and name both given (same value)");
  });
  test("two aliases, different values ⇒ conflict error", () => {
    expect(() => call({ command: "view", path: "a.md", name: "b.md" })).toThrow(
      /conflicting path\/name: "a\.md" vs "b\.md"/,
    );
  });
  test("search has no target slot — path given is ignored with a note", () => {
    const n = call({ command: "search", query: "x", path: "a.md" });
    expect(n.target).toBeUndefined();
    expect(n.notes).toContain("ignored params: path");
  });
});

describe("normalizeMemoryCall — body alias family (rule 2: wrong alias for an op with a body slot ⇒ error)", () => {
  test("create takes file_text (or content); accepts either", () => {
    expect(call({ command: "create", path: "a.md", file_text: "x" }).body).toBe("x");
    expect(call({ command: "create", path: "a.md", content: "x" }).body).toBe("x");
  });
  test("create + insert_text ⇒ error naming the accepted fields", () => {
    expect(() => call({ command: "create", path: "a.md", insert_text: "x" })).toThrow(
      /create takes file_text \(or content\)/,
    );
  });
  test("insert takes insert_text (or content); file_text is the wrong alias ⇒ error", () => {
    expect(call({ command: "insert", path: "a.md", insert_line: 1, insert_text: "x" }).body).toBe("x");
    expect(call({ command: "insert", path: "a.md", insert_line: 1, content: "x" }).body).toBe("x");
    expect(() => call({ command: "insert", path: "a.md", insert_line: 1, file_text: "x" })).toThrow(
      /insert takes insert_text \(or content\)/,
    );
  });
  test("action:append accepts content or insert_text; file_text is wrong", () => {
    expect(call({ action: "append", name: "a.md", content: "x" }).body).toBe("x");
    expect(call({ action: "append", name: "a.md", insert_text: "x" }).body).toBe("x");
    expect(() => call({ action: "append", name: "a.md", file_text: "x" })).toThrow(
      /append takes content \(or insert_text\)/,
    );
  });
  test("view has no body slot — old_str given is ignored (§4.2's own example)", () => {
    const n = call({ command: "view", path: "a.md", old_str: "x" });
    expect(n.notes).toContain("ignored params: old_str");
  });
  test("body mutex: file_text + content same value ⇒ note; different ⇒ conflict", () => {
    const same = call({ command: "create", path: "a.md", file_text: "x", content: "x" });
    expect(same.body).toBe("x");
    expect(same.notes).toContain("file_text and content both given (same value)");
    expect(() => call({ command: "create", path: "a.md", file_text: "x", content: "y" })).toThrow(
      /conflicting file_text\/content/,
    );
  });
});

describe("normalizeMemoryCall — str_replace old/new (no aliasing)", () => {
  test("old_str/new_str pass through untouched for str_replace", () => {
    const n = call({ command: "str_replace", path: "a.md", old_str: "x", new_str: "y" });
    expect(n.oldStr).toBe("x");
    expect(n.newStr).toBe("y");
  });
  test("new_str omitted ⇒ undefined (deletion semantics, §4.3)", () => {
    expect(call({ command: "str_replace", path: "a.md", old_str: "x" }).newStr).toBeUndefined();
  });
  test("old_str/new_str given to a non-str_replace op are ignored", () => {
    const n = call({ command: "create", path: "a.md", file_text: "x", old_str: "y" });
    expect(n.notes).toContain("ignored params: old_str");
  });
});

describe("normalizeMemoryCall — view_range / section / insert_line / query, each scoped to their own op", () => {
  test("view_range only applies to view", () => {
    expect(call({ command: "view", path: "a.md", view_range: [1, 5] }).viewRange).toEqual([1, 5]);
    const n = call({ command: "create", path: "a.md", file_text: "x", view_range: [1, 5] });
    expect(n.notes).toContain("ignored params: view_range");
  });
  test("section applies to view and insert", () => {
    expect(call({ command: "view", path: "a.md", section: "S" }).section).toBe("S");
    expect(call({ command: "insert", path: "a.md", section: "S", insert_text: "x" }).section).toBe("S");
    const n = call({ command: "delete", path: "a.md", section: "S" });
    expect(n.notes).toContain("ignored params: section");
  });
  test("insert_line only applies to insert", () => {
    expect(call({ command: "insert", path: "a.md", insert_line: 3, insert_text: "x" }).insertLine).toBe(3);
    const n = call({ command: "view", path: "a.md", insert_line: 3 });
    expect(n.notes).toContain("ignored params: insert_line");
  });
  test("query only applies to search", () => {
    expect(call({ command: "search", query: "hello world" }).query).toBe("hello world");
    const n = call({ command: "view", path: "a.md", query: "hello" });
    expect(n.notes).toContain("ignored params: query");
  });
});

describe("normalizeMemoryCall — dest (new_path, rename only)", () => {
  test("rename resolves both target and dest", () => {
    const n = call({ command: "rename", old_path: "a.md", new_path: "b.md" });
    expect(n.target).toBe("a.md");
    expect(n.dest).toBe("b.md");
  });
  test("new_path given to a non-rename op is ignored", () => {
    const n = call({ command: "view", path: "a.md", new_path: "b.md" });
    expect(n.notes).toContain("ignored params: new_path");
  });
});

describe("normalizeMemoryCall — legacy forms and official Anthropic examples (§10 I7)", () => {
  test("legacy action:list / write / append all succeed", () => {
    expect(call({ action: "list" }).op).toBe("view");
    expect(call({ action: "write", name: "a.md", content: "x" }).op).toBe("write");
    expect(call({ action: "append", name: "a.md", content: "x" }).op).toBe("append");
  });

  // Anthropic memory tool (`memory_20250818`) documented request-body
  // examples, transcribed verbatim from
  // https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
  // (accessed 2026-09-27) — each must normalize successfully with no error.
  test("official view example", () => {
    const n = call({ command: "view", path: "/memories/notes.txt", view_range: [1, 10] });
    expect(n.op).toBe("view");
    expect(n.target).toBe("/memories/notes.txt");
    expect(n.viewRange).toEqual([1, 10]);
  });
  test("official create example", () => {
    const n = call({
      command: "create",
      path: "/memories/notes.txt",
      file_text: "Meeting notes:\n- Discussed project timeline\n- Next steps defined\n",
    });
    expect(n.op).toBe("create");
    expect(n.body).toContain("Meeting notes");
  });
  test("official str_replace example", () => {
    const n = call({
      command: "str_replace",
      path: "/memories/preferences.txt",
      old_str: "Favorite color: blue",
      new_str: "Favorite color: green",
    });
    expect(n.oldStr).toBe("Favorite color: blue");
    expect(n.newStr).toBe("Favorite color: green");
  });
  test("official insert example", () => {
    const n = call({
      command: "insert",
      path: "/memories/todo.txt",
      insert_line: 2,
      insert_text: "- Review memory tool documentation\n",
    });
    expect(n.insertLine).toBe(2);
    expect(n.body).toContain("Review memory tool documentation");
  });
  test("official delete example", () => {
    const n = call({ command: "delete", path: "/memories/old_file.txt" });
    expect(n.op).toBe("delete");
    expect(n.target).toBe("/memories/old_file.txt");
  });
  test("official rename example", () => {
    const n = call({ command: "rename", old_path: "/memories/draft.txt", new_path: "/memories/final.txt" });
    expect(n.target).toBe("/memories/draft.txt");
    expect(n.dest).toBe("/memories/final.txt");
  });
});
