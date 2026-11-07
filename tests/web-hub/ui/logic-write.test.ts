import { describe, expect, it } from "vitest";
import {
  buildWriteView,
  formatByteSize,
  isStandardWriteSuccess,
  measureContent,
} from "../../../src/web-hub/ui/src/logic/writeView.js";

const enc = new TextEncoder();

describe("buildWriteView — gating", () => {
  it("non-write tool ⇒ null", () => {
    expect(buildWriteView("edit", { path: "a.ts", content: "x" })).toBeNull();
    expect(buildWriteView("read", { path: "a.ts", content: "x" })).toBeNull();
  });

  it.each([undefined, null, [], 5, {}, { path: "a", content: 1 }, { path: "a", content: null }, "plain text", "[1]"])(
    "unusable args %j ⇒ null",
    (args) => {
      expect(buildWriteView("write", args)).toBeNull();
    },
  );

  it("string-ified JSON is parsed (intentional superset); invalid JSON ⇒ null", () => {
    const v = buildWriteView("write", JSON.stringify({ path: "/x/a.ts", content: "a\nb" }));
    expect(v).not.toBeNull();
    expect(v!.content).toBe("a\nb");
    expect(v!.path).toBe("/x/a.ts");
    expect(buildWriteView("write", '{"path":"/x/a.ts","content":"a')).toBeNull();
  });

  it("missing path still yields a code view without path / lang", () => {
    const v = buildWriteView("write", { content: "hi" });
    expect(v).toMatchObject({ path: null, lang: null, content: "hi", lines: 1, bytes: 2 });
    expect(buildWriteView("write", { path: 3, content: "hi" })!.path).toBeNull();
    expect(buildWriteView("write", { path: "", content: "hi" })!.path).toBeNull();
  });

  it("keeps content verbatim (no trim, \\r kept)", () => {
    const c = "  a\r\n b \r\n\n";
    expect(buildWriteView("write", { path: "p", content: c })!.content).toBe(c);
  });
});

describe("measureContent", () => {
  it("empty ⇒ 0 lines / 0 bytes but still a view", () => {
    expect(measureContent("")).toEqual({ lines: 0, bytes: 0 });
    expect(buildWriteView("write", { path: "a.ts", content: "" })).toMatchObject({ lines: 0, bytes: 0 });
  });

  it.each([
    ["a", 1],
    ["a\n", 1],
    ["a\n\n", 2],
    ["a\r\nb\r\n", 2],
    ["a\rb", 2],
    ["a\r\nb", 2],
    ["\n", 1],
    ["a\r\n\r\nb", 3],
    ["a\n\r", 2],
  ])("lines of %j = %i", (c, n) => {
    expect(measureContent(c).lines).toBe(n);
  });

  it.each(["中", "😀", "é", "a\r\nb", "x😀y中é\n", "\ud800", "\ud800a", "\udc00", "😀\ud83d"])(
    "bytes of %j match TextEncoder",
    (c) => {
      expect(measureContent(c).bytes).toBe(enc.encode(c).length);
    },
  );

  it("explicit byte values", () => {
    expect(measureContent("中").bytes).toBe(3);
    expect(measureContent("😀").bytes).toBe(4);
    expect(measureContent("é").bytes).toBe(2);
  });
});

describe("summary / size / language / success match", () => {
  it("formats compact English tokens", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(buildWriteView("write", { path: "a.ts", content: "a\nb\n" })!.summary).toBe("2 lines · 4 B");
    expect(buildWriteView("write", { path: "a.ts", content: "x".repeat(2048) })!.summary).toBe("1 lines · 2.0 KB");
  });

  it("language from basename (both separators); unknown ⇒ null", () => {
    expect(buildWriteView("write", { path: "/x/a.ts", content: "" })!.lang).toBe("typescript");
    expect(buildWriteView("write", { path: "C:\\x\\a.py", content: "" })!.lang).toBe("python");
    expect(buildWriteView("write", { path: "a.unknownext", content: "" })!.lang).toBeNull();
    expect(buildWriteView("write", { path: "/x/noext", content: "" })!.lang).toBeNull();
    expect(() => buildWriteView("write", { path: "/x/.env", content: "" })).not.toThrow();
    expect(buildWriteView("write", { path: "/x/dir/", content: "" })!.lang).toBeNull();
  });

  it("standard success is the exact pinned string only", () => {
    const v = buildWriteView("write", { path: "/x/a.ts", content: "c" })!;
    expect(isStandardWriteSuccess(v, "Successfully wrote to /x/a.ts")).toBe(true);
    expect(isStandardWriteSuccess(v, "Successfully wrote to /x/a.ts\n")).toBe(false);
    expect(isStandardWriteSuccess(v, "Successfully wrote 1 bytes to /x/a.ts")).toBe(false);
    expect(isStandardWriteSuccess(v, "Successfully wrote to /x/b.ts")).toBe(false);
    expect(isStandardWriteSuccess(v, undefined)).toBe(false);
    const noPath = buildWriteView("write", { content: "c" })!;
    expect(isStandardWriteSuccess(noPath, "Successfully wrote to null")).toBe(false);
  });
});
