// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PROMPT_MAX_UTF8_BYTES,
  attachmentReduce,
  canSendWithAttachments,
  chunkBytesFor,
  classifyPaste,
  collectDrop,
  composePrompt,
  fileFingerprint,
  pastedName,
  planChunks,
  uploadAvailability,
  utf8Len,
} from "../../../src/web-hub/ui/src/logic/upload.js";
import {
  UPLOAD_CHUNK_BYTES_LAN,
  UPLOAD_CHUNK_BYTES_LOOPBACK,
  formatAttachmentSize,
  parseAttachmentBlock,
} from "../../../src/web-hub/protocol/upload.js";

/**
 * web-hub-upload plan §包 U4a: the composer's pure upload helpers. The tray state machine is
 * covered as a full (state × event) matrix — every cell pins one rule of §4.2/§4.3 plus the
 * author rulings recorded in the module header (`queued` blocks send; `retry` swaps in the new
 * id; `removing` swallows late transport events; `ready → error` is the E_UPLOAD_GONE path).
 */

const LIMIT = 48 * 1024; // §3.2 / hub PROMPT_TEXT_MAX_BYTES — pinned by the first describe

type AState = "queued" | "uploading" | "ready" | "failed" | "removing";
type Att = { id: string; name: string; size: number; mime: string | null; state: AState; [k: string]: unknown };

const file = (name: string, type = "", size = 10) => ({ name, type, size });
const att = (state: AState, extra: Record<string, unknown> = {}): Att => ({
  id: "u1",
  name: "a.png",
  size: 1000,
  mime: "image/png",
  state,
  ...extra,
});
const ready = (path: string, mime: string | null = "image/png", size = 1000): Att => ({
  ...att("ready"),
  path,
  mime,
  size,
});

// -- DataTransfer fakes: index+length accessors only, exactly what the logic reads. -----------
const dt = (o: { items?: unknown[]; files?: unknown[]; types?: string[] }) => o as never;
const fileItem = (f: unknown, type = "") => ({ kind: "file", type, getAsFile: () => f });
const textItem = (type = "text/plain") => ({ kind: "string", type, getAsFile: () => null });

describe("constants stay in sync with the protocol/hub layers", () => {
  it("PROMPT_MAX_UTF8_BYTES mirrors the hub's /api/cmd text cap (48 KiB)", () => {
    expect(PROMPT_MAX_UTF8_BYTES).toBe(LIMIT);
  });

  it("chunkBytesFor re-exports the protocol tier constants (never copied); unknown kinds are undefined", () => {
    expect(chunkBytesFor("loopback")).toBe(UPLOAD_CHUNK_BYTES_LOOPBACK);
    expect(chunkBytesFor("lan")).toBe(UPLOAD_CHUNK_BYTES_LAN);
    expect(chunkBytesFor("nope")).toBeUndefined();
    // own-property lookup only — no prototype bleed
    expect(chunkBytesFor("constructor")).toBeUndefined();
    expect(chunkBytesFor("toString")).toBeUndefined();
  });
});

describe("utf8Len", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["é", 2],
    ["中", 3],
    ["😀", 4], // surrogate pair → 4 UTF-8 bytes, not 2 UTF-16 units
    ["a中😀", 8],
    ["\uD800", 3], // lone surrogate encodes as U+FFFD per WHATWG
  ])("%j → %d bytes", (s, n) => {
    expect(utf8Len(s)).toBe(n);
  });

  it("non-strings are 0, not a throw", () => {
    expect(utf8Len(42)).toBe(0);
    expect(utf8Len(null)).toBe(0);
    expect(utf8Len(undefined)).toBe(0);
  });
});

describe("fileFingerprint (§2.5: name+size+lastModified+type)", () => {
  const f = { name: "a.png", size: 10, lastModified: 99, type: "image/png" };

  it("identical fields ⇒ identical key; every differing field separates", () => {
    expect(fileFingerprint(f)).toBe(fileFingerprint({ ...f }));
    for (const k of ["name", "size", "lastModified", "type"] as const) {
      expect(fileFingerprint(f)).not.toBe(fileFingerprint({ ...f, [k]: `${String(f[k])}x` }));
    }
  });

  it("field boundaries cannot bleed into each other (JSON tuple, not naive concat)", () => {
    expect(fileFingerprint({ name: "ab", size: 3, lastModified: 1, type: "x" })).not.toBe(
      fileFingerprint({ name: "a", size: "b3,1,x" as never, lastModified: 1, type: "x" }),
    );
  });

  it("junk inputs are empty strings (caller skips falsy fingerprints)", () => {
    for (const junk of [null, undefined, 42, "f", {}]) expect(fileFingerprint(junk)).toBe("");
  });
});

describe("pastedName (§2.3: pasted-YYYYMMDD-HHMMSS[-n].<ext>, local time)", () => {
  const at = new Date(2026, 0, 2, 3, 4, 5); // local components ⇒ TZ-independent expectation

  it("formats the stamp with zero padding and maps the ext from the validated mime", () => {
    expect(pastedName("image/png", at)).toBe("pasted-20260102-030405.png");
    for (const [mime, ext] of [
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
      ["image/gif", "gif"],
      ["image/bmp", "bmp"],
      ["image/avif", "avif"],
      ["image/svg+xml", "svg"],
      ["text/plain", "txt"],
    ] as const) {
      expect(pastedName(mime, at)).toBe(`pasted-20260102-030405.${ext}`);
    }
  });

  it("unmapped / absent mime ⇒ .bin; seq suffix only from integer 2 up", () => {
    expect(pastedName("image/x-custom", at)).toBe("pasted-20260102-030405.bin");
    expect(pastedName(null, at)).toBe("pasted-20260102-030405.bin");
    expect(pastedName(undefined, at)).toBe("pasted-20260102-030405.bin");
    expect(pastedName("image/png", at, 1)).toBe("pasted-20260102-030405.png");
    expect(pastedName("image/png", at, 0)).toBe("pasted-20260102-030405.png");
    expect(pastedName("image/png", at, 1.5)).toBe("pasted-20260102-030405.png");
    expect(pastedName("image/png", at, 2)).toBe("pasted-20260102-030405-2.png");
    expect(pastedName("image/png", at, 12)).toBe("pasted-20260102-030405-12.png");
  });

  it("accepts a numeric timestamp (same result as the Date form) and degrades on invalid input", () => {
    expect(pastedName("image/png", at.getTime())).toBe("pasted-20260102-030405.png");
    expect(pastedName("image/png", Number.NaN)).toBe(pastedName("image/png", 0));
    expect(pastedName("image/png", Number.NaN)).toMatch(/^pasted-\d{8}-\d{6}\.png$/); // never throws
  });
});

describe("classifyPaste (§4.1 entry 1 — the three paste situations)", () => {
  it("no files ⇒ never intervene (browser default paste proceeds)", () => {
    expect(classifyPaste(dt({ items: [textItem()], types: ["text/plain"] }))).toEqual({
      files: [],
      hasText: true,
      preventDefault: false,
    });
    expect(classifyPaste(dt({ items: [], types: [] }))).toEqual({
      files: [],
      hasText: false,
      preventDefault: false,
    });
  });

  it("files without text/plain ⇒ preventDefault, every file becomes an attachment", () => {
    const a = file("shot.png", "image/png");
    const b = file("note.txt");
    const r = classifyPaste(dt({ items: [fileItem(a, "image/png"), fileItem(b)], types: ["Files"] }));
    expect(r).toEqual({ files: [a, b], hasText: false, preventDefault: true });
  });

  it("files AND text (Office copy / Finder file name) ⇒ text pastes normally, files attach too", () => {
    const a = file("cells.png", "image/png");
    const r = classifyPaste(dt({ items: [textItem(), fileItem(a, "image/png")], types: ["text/plain", "Files"] }));
    expect(r).toEqual({ files: [a], hasText: true, preventDefault: false });
  });

  it("defensive shapes: getAsFile() null skipped, dt.files fallback, missing/absent dt", () => {
    // folder-ish item whose getAsFile() is null must not produce an attachment nor break the loop
    expect(classifyPaste(dt({ items: [{ kind: "file", type: "", getAsFile: () => null }] }))).toEqual({
      files: [],
      hasText: false,
      preventDefault: false,
    });
    const f = file("dropped.txt");
    expect(classifyPaste(dt({ files: [f], types: ["Files"] }))).toEqual({
      files: [f],
      hasText: false,
      preventDefault: true,
    });
    // text/plain is also detected through string-kind items when `types` is absent
    expect(classifyPaste(dt({ items: [textItem(), fileItem(file("a.png", "image/png"), "image/png")] }))).toMatchObject(
      { files: [file("a.png", "image/png")], hasText: true, preventDefault: false },
    );
    expect(classifyPaste(null)).toEqual({ files: [], hasText: false, preventDefault: false });
    expect(classifyPaste(undefined)).toEqual({ files: [], hasText: false, preventDefault: false });
  });
});

describe("collectDrop (§4.1 entry 2 — directory refusal)", () => {
  it("plain files pass through in order", () => {
    const a = file("a.txt");
    const b = file("b.png", "image/png");
    expect(collectDrop(dt({ items: [fileItem(a, "text/plain"), fileItem(b, "image/png")] }))).toEqual({
      ok: true,
      files: [a, b],
    });
  });

  it("a directory entry rejects the WHOLE drop (no partial acceptance), names carried for the hint", () => {
    const r = collectDrop(
      dt({
        items: [
          fileItem(file("a.txt")),
          {
            kind: "file",
            type: "",
            getAsFile: () => null,
            webkitGetAsEntry: () => ({ isDirectory: true, name: "docs" }),
          },
        ],
      }),
    );
    expect(r).toEqual({ ok: false, reason: "directory", names: ["docs"] });
  });

  it("non-directory entries and a throwing webkitGetAsEntry fall back to the file path", () => {
    const f = file("a.txt");
    expect(
      collectDrop(
        dt({
          items: [
            {
              kind: "file",
              type: "",
              getAsFile: () => f,
              webkitGetAsEntry: () => ({ isDirectory: false, name: "a.txt" }),
            },
            {
              kind: "file",
              type: "",
              getAsFile: () => f,
              webkitGetAsEntry: () => {
                throw new Error("x");
              },
            },
          ],
        }),
      ),
    ).toEqual({ ok: true, files: [f, f] });
  });

  it("items missing ⇒ dt.files fallback (no directory detection possible there); absent dt is empty", () => {
    const f = file("a.txt");
    expect(collectDrop(dt({ files: [f] }))).toEqual({ ok: true, files: [f] });
    expect(collectDrop(null)).toEqual({ ok: true, files: [] });
  });
});

describe("planChunks (§1.3 — parameterized tiers)", () => {
  it("slices ceil-wise with a short last chunk, starting at `received`", () => {
    expect(planChunks(0, 4)).toEqual({ ok: true, chunks: [], remaining: 0 });
    expect(planChunks(3, 4)).toEqual({ ok: true, chunks: [{ offset: 0, bytes: 3 }], remaining: 3 });
    expect(planChunks(8, 4)).toEqual({
      ok: true,
      chunks: [
        { offset: 0, bytes: 4 },
        { offset: 4, bytes: 4 },
      ],
      remaining: 8,
    });
    expect(planChunks(10, 4)).toEqual({
      ok: true,
      chunks: [
        { offset: 0, bytes: 4 },
        { offset: 4, bytes: 4 },
        { offset: 8, bytes: 2 },
      ],
      remaining: 10,
    });
    expect(planChunks(10, 4, 5)).toEqual({
      ok: true,
      chunks: [
        { offset: 5, bytes: 4 },
        { offset: 9, bytes: 1 },
      ],
      remaining: 5,
    });
    expect(planChunks(10, 4, 10)).toEqual({ ok: true, chunks: [], remaining: 0 });
  });

  it("the two tiers split a 100 MiB file into 25 / 100 requests (§1.3's stated rationale)", () => {
    const size = 100 * 1024 * 1024;
    expect(planChunks(size, chunkBytesFor("loopback")).chunks).toHaveLength(25);
    expect(planChunks(size, chunkBytesFor("lan")).chunks).toHaveLength(100);
  });

  it("malformed numbers refuse instead of mis-slicing", () => {
    expect(planChunks(-1, 4)).toEqual({ ok: false, reason: "size" });
    expect(planChunks(1.5, 4)).toEqual({ ok: false, reason: "size" });
    expect(planChunks(Number.NaN, 4)).toEqual({ ok: false, reason: "size" });
    expect(planChunks("8", 4)).toEqual({ ok: false, reason: "size" });
    expect(planChunks(8, 0)).toEqual({ ok: false, reason: "chunk-bytes" });
    expect(planChunks(8, -4)).toEqual({ ok: false, reason: "chunk-bytes" });
    expect(planChunks(8, 1.5)).toEqual({ ok: false, reason: "chunk-bytes" });
    expect(planChunks(8, 4, -1)).toEqual({ ok: false, reason: "received" });
    expect(planChunks(8, 4, 9)).toEqual({ ok: false, reason: "received" });
    expect(planChunks(8, 4, 0.5)).toEqual({ ok: false, reason: "received" });
  });
});

describe("attachmentReduce (§4.2/§4.3 — full state × event matrix)", () => {
  const STATES = ["queued", "uploading", "ready", "failed", "removing"] as const;
  /** expected target state per source state; `=` means no-op (same reference), `null` removal. */
  const MATRIX: Record<string, Record<(typeof STATES)[number], string>> = {
    start: { queued: "uploading", uploading: "=", ready: "=", failed: "=", removing: "=" },
    progress: { queued: "=", uploading: "uploading", ready: "=", failed: "=", removing: "=" },
    committed: { queued: "=", uploading: "ready", ready: "=", failed: "=", removing: "=" },
    error: { queued: "failed", uploading: "failed", ready: "failed", failed: "=", removing: "=" },
    retry: { queued: "=", uploading: "=", ready: "=", failed: "queued", removing: "=" },
    removing: { queued: "removing", uploading: "removing", ready: "removing", failed: "removing", removing: "=" },
    removed: { queued: "null", uploading: "null", ready: "null", failed: "null", removing: "null" },
  };
  const EVENTS: Record<string, any> = {
    start: { type: "start" },
    progress: { type: "progress", received: 50 },
    committed: { type: "committed", path: "/up/x/a.png", size: 1000, mime: "image/png" },
    error: { type: "error", error: "E_NETWORK", retryable: true },
    retry: { type: "retry", id: "u2" },
    removing: { type: "removing" },
    removed: { type: "removed" },
  };

  for (const [type, row] of Object.entries(MATRIX)) {
    it.each(STATES)(`%s × %s`, (state) => {
      const item = att(state, state === "uploading" ? { uploadedBytes: 40 } : {});
      const result = attachmentReduce(item, EVENTS[type]!);
      const expected = row[state];
      if (expected === "=") expect(result).toBe(item);
      else if (expected === "null") expect(result).toBeNull();
      else expect(result?.state).toBe(expected);
    });
  }

  it("junk items/events are returned unchanged; unknown event types never throw", () => {
    const item = att("queued");
    expect(attachmentReduce(null, { type: "start" })).toBeNull();
    expect(attachmentReduce(item, null)).toBe(item);
    expect(attachmentReduce(item, { type: "wat" })).toBe(item);
    expect(attachmentReduce(item, {})).toBe(item);
  });

  it("progress: begin's idempotent `received` flows through too, clamped to size and never regressing", () => {
    expect(attachmentReduce(att("uploading", { uploadedBytes: 40 }), { type: "progress", received: 50 })).toMatchObject(
      {
        uploadedBytes: 50,
      },
    );
    expect(attachmentReduce(att("uploading", { uploadedBytes: 80 }), { type: "progress", received: 50 })).toMatchObject(
      {
        uploadedBytes: 80,
      },
    ); // dup/409-offset replies must not flicker the bar
    expect(
      attachmentReduce(att("uploading", { uploadedBytes: 0 }), { type: "progress", received: 5000 }),
    ).toMatchObject({ uploadedBytes: 1000 }); // clamped to size
    const same = att("uploading", { uploadedBytes: 40 });
    expect(attachmentReduce(same, { type: "progress", received: 40 })).toBe(same); // byte-identical ⇒ same ref
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
      const item = att("uploading", { uploadedBytes: 40 });
      expect(attachmentReduce(item, { type: "progress", received: bad })).toBe(item); // non-finite ⇒ no-op
    }
  });

  it("committed normalizes mime to string|null, keeps item.size when the event omits it, resets error fields", () => {
    const r = attachmentReduce(att("uploading", { uploadedBytes: 10 }), {
      type: "committed",
      path: "/up/x/a.png",
      mime: undefined,
    });
    expect(r).toMatchObject({ state: "ready", path: "/up/x/a.png", size: 1000, mime: null, uploadedBytes: 1000 });
    const junk = att("uploading");
    expect(attachmentReduce(junk, { type: "committed", size: 5 })).toBe(junk); // junk path ⇒ no-op
    expect(
      attachmentReduce(att("uploading", { size: 7 }), { type: "committed", path: "/p", mime: "text/plain" }),
    ).toMatchObject({ state: "ready", size: 7, mime: "text/plain" });
    expect(
      attachmentReduce(att("uploading", { error: "E_BUSY", message: "scan" }) as never, {
        type: "committed",
        path: "/p",
      }),
    ).toMatchObject({ state: "ready", error: undefined, message: undefined });
  });

  it("error defaults retryable:true / E_INTERNAL and keeps the message (E_UPLOAD_GONE reaches `ready` too)", () => {
    expect(
      attachmentReduce(att("uploading"), { type: "error", error: "E_UPLOAD_QUOTA", retryable: false }),
    ).toMatchObject({ state: "failed", error: "E_UPLOAD_QUOTA", retryable: false });
    expect(attachmentReduce(att("uploading"), { type: "error", error: "E_BUSY", message: "scan" })).toMatchObject({
      state: "failed",
      error: "E_BUSY",
      retryable: true,
      message: "scan",
    });
    expect(attachmentReduce(att("uploading"), { type: "error" })).toMatchObject({
      state: "failed",
      error: "E_INTERNAL",
      retryable: true,
    });
    expect(
      attachmentReduce(att("queued"), { type: "error", error: "E_UPLOAD_TOO_LARGE", retryable: false }),
    ).toMatchObject({
      state: "failed",
      error: "E_UPLOAD_TOO_LARGE",
      retryable: false,
    });
    expect(attachmentReduce(ready("/p"), { type: "error", error: "E_UPLOAD_GONE", retryable: true })).toMatchObject({
      state: "failed",
      error: "E_UPLOAD_GONE",
      retryable: true,
    });
  });

  it("retry swaps in the NEW id (§4.3: 404 ⇒ start over) and clears every transfer field", () => {
    const r = attachmentReduce(
      att("failed", {
        error: "E_NOT_FOUND",
        retryable: true,
        message: "hub restarted",
        uploadedBytes: 900,
        path: "/old",
      }),
      { type: "retry", id: "u9" },
    );
    expect(r).toEqual({
      id: "u9",
      name: "a.png",
      size: 1000,
      mime: "image/png",
      state: "queued",
      uploadedBytes: 0,
      path: undefined,
      error: undefined,
      retryable: undefined,
      message: undefined,
    });
    const junk = att("failed");
    expect(attachmentReduce(junk, { type: "retry", id: "" })).toBe(junk); // junk id ⇒ no-op
    expect(attachmentReduce(junk, { type: "retry" })).toBe(junk);
  });

  it("is pure: the input item is never mutated", () => {
    const item = Object.freeze(att("queued"));
    expect(() => attachmentReduce(item, { type: "start" })).not.toThrow();
    const next = attachmentReduce(item, { type: "start" })!;
    expect(next).not.toBe(item);
    expect(item.state).toBe("queued");
  });
});

describe("composePrompt (§3.1)", () => {
  const A = ready("/up/s1/x1/a.png", "image/png", 186368); // 186368 B = "182 KB"
  const B = ready("/up/s1/x2/report_v2.pdf", null, 1_468_006); // 1.4 MB

  it("no attachments ⇒ body passes through untouched, with its UTF-8 byte count", () => {
    expect(composePrompt("hello")).toEqual({ ok: true, text: "hello", bytes: 5 });
    expect(composePrompt("", [])).toEqual({ ok: true, text: "", bytes: 0 });
    expect(composePrompt("中", [])).toEqual({ ok: true, text: "中", bytes: 3 });
    expect(composePrompt(undefined, [])).toEqual({ ok: true, text: "", bytes: 0 });
  });

  it("body + attachments ⇒ body, blank line, fixed-English block (round-trips through the protocol parser)", () => {
    const r = composePrompt("look at these", [A, B]);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text.startsWith("look at these\n\n[web-hub attachments] The user attached 2 file(s),")).toBe(true);
    expect(text.endsWith("quote them when using a shell.")).toBe(true);
    expect(text).toContain(`- ${A.path as string} (image/png, ${formatAttachmentSize(186368)})`);
    expect(text).toContain(`- ${B.path as string} (unknown type, ${formatAttachmentSize(1_468_006)})`);
    expect(parseAttachmentBlock(text)).toEqual([
      { path: A.path, mime: "image/png", sizeLabel: "182 KB" },
      { path: B.path, mime: null, sizeLabel: "1.4 MB" },
    ]);
  });

  it("empty or whitespace-only body ⇒ the block alone (§3.1: 正文为空 ⇒ 只发附件块)", () => {
    const block = composePrompt("", [A]) as { text: string };
    expect((composePrompt("", [A]) as { text: string }).text).toBe(block.text);
    expect((composePrompt("   \n  ", [A]) as { text: string }).text).toBe(block.text);
    expect(block.text.startsWith("[web-hub attachments]")).toBe(true);
  });

  it("formatAttachmentBlock refusal (path with a newline) ⇒ attachment-block, never a silent drop", () => {
    expect(composePrompt("hi", [ready("/up/x/ev\nil.png")])).toEqual({ ok: false, reason: "attachment-block" });
    expect(composePrompt("hi", [A, ready("/up/x/ev\nil.png")])).toEqual({ ok: false, reason: "attachment-block" });
    // malformed entries refuse too — same never-silently-drop rule
    expect(composePrompt("hi", [null])).toEqual({ ok: false, reason: "attachment-block" });
    expect(composePrompt("hi", [{}])).toEqual({ ok: false, reason: "attachment-block" });
  });

  it("48 KiB boundary: exactly at the cap passes, one byte over refuses — text-only and composed", () => {
    expect(composePrompt("a".repeat(LIMIT))).toEqual({ ok: true, text: "a".repeat(LIMIT), bytes: LIMIT });
    expect(composePrompt("a".repeat(LIMIT + 1))).toEqual({ ok: false, reason: "too-large", bytes: LIMIT + 1 });

    const blockBytes = utf8Len((composePrompt("", [A]) as { text: string }).text);
    const budget = LIMIT - blockBytes - 2; // body + "\n\n" + block === LIMIT exactly
    expect(budget).toBeGreaterThan(0);
    expect(composePrompt("a".repeat(budget), [A])).toMatchObject({ ok: true, bytes: LIMIT });
    expect(composePrompt("a".repeat(budget + 1), [A])).toEqual({ ok: false, reason: "too-large", bytes: LIMIT + 1 });

    // multi-byte bodies: the cap is UTF-8 BYTES, not chars (3-byte 中, 1-byte a padding)
    const n = Math.floor(budget / 3);
    const pad = budget - 3 * n;
    const body = "中".repeat(n) + "a".repeat(pad);
    expect(utf8Len(body)).toBe(budget);
    expect(composePrompt(body, [A])).toMatchObject({ ok: true, bytes: LIMIT });
    expect(composePrompt(`${body}中`, [A])).toEqual({ ok: false, reason: "too-large", bytes: LIMIT + 3 });
  });
});

describe("canSendWithAttachments (§3.2 sendGate truth table)", () => {
  const base = { enabled: true, sending: false, text: "hi", attachments: [] as Att[] };

  it("baseline: plain text sends; the composed text/bytes ride along for doSend to emit", () => {
    expect(canSendWithAttachments(base)).toEqual({ ok: true, text: "hi", bytes: 2 });
  });

  it.each<[string, Record<string, unknown>]>([
    ["disabled", { enabled: false }],
    ["sending", { sending: true }],
    ["empty", { text: "" }],
    ["empty (whitespace-only body)", { text: "  \n " }],
    ["queued", { attachments: [att("queued")] }],
    ["uploading", { attachments: [att("uploading", { uploadedBytes: 5 })] }],
    ["failed", { attachments: [att("failed", { error: "E_BUSY" })] }],
  ])("reason: %s", (_name, patch) => {
    const r = canSendWithAttachments({ ...base, ...patch } as never);
    expect(r).toMatchObject({ ok: false, reason: _name === "empty (whitespace-only body)" ? "empty" : _name });
  });

  it("empty body + a ready attachment sends (block-only prompt); removing items never block nor compose", () => {
    const r = canSendWithAttachments({ ...base, text: "", attachments: [ready("/p/a.png")] });
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text.startsWith("[web-hub attachments]")).toBe(true);
    expect(canSendWithAttachments({ ...base, attachments: [att("removing", { path: "/p/old" })] })).toEqual({
      ok: true,
      text: "hi",
      bytes: 2,
    }); // dropped from the composition
  });

  it("tray reason = the first blocking item's state in tray order", () => {
    expect(canSendWithAttachments({ ...base, attachments: [att("failed"), att("uploading")] })).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(canSendWithAttachments({ ...base, attachments: [att("uploading"), att("failed")] })).toMatchObject({
      ok: false,
      reason: "uploading",
    });
  });

  it("command mode (default: parseSlash) blocks attachments and folds the policy deny early-exit", () => {
    const cmd = { ...base, text: "/model x" };
    expect(canSendWithAttachments({ ...cmd, attachments: [ready("/p/a.png")] })).toMatchObject({
      ok: false,
      reason: "command-attachments",
    });
    expect(canSendWithAttachments({ ...cmd, policy: "allow" })).toMatchObject({ ok: true });
    expect(canSendWithAttachments({ ...cmd, policy: "confirm" })).toMatchObject({ ok: true });
    expect(canSendWithAttachments({ ...cmd, policy: "deny" })).toMatchObject({ ok: false, reason: "command-policy" });
    expect(canSendWithAttachments(cmd)).toMatchObject({ ok: false, reason: "command-policy" }); // no policy ⇒ deny
    // `//` escape never parses as a command ⇒ attachments ride along
    expect(
      canSendWithAttachments({ ...base, text: "//not-a-command", attachments: [ready("/p/a.png")] }),
    ).toMatchObject({ ok: true });
  });

  it("commandRouted override: DetailDock's routing decision wins over the local parseSlash guess", () => {
    // commandsEnabled=false ⇒ "/foo" is plain text, attachments allowed
    expect(
      canSendWithAttachments({ ...base, text: "/foo", commandRouted: false, attachments: [ready("/p/a.png")] }),
    ).toMatchObject({ ok: true });
    // commandsEnabled=true ⇒ routed regardless of sendAsText, so attachments are blocked
    expect(
      canSendWithAttachments({ ...base, text: "//foo", commandRouted: true, attachments: [ready("/p/a.png")] }),
    ).toMatchObject({ ok: false, reason: "command-attachments" });
    expect(canSendWithAttachments({ ...base, text: "hi", commandRouted: true, policy: "allow" })).toMatchObject({
      ok: true,
    });
    expect(canSendWithAttachments({ ...base, text: "hi", commandRouted: true, policy: "deny" })).toMatchObject({
      ok: false,
      reason: "command-policy",
    });
  });

  it("compose failures propagate: too-large and attachment-block come back with bytes/reason", () => {
    expect(canSendWithAttachments({ ...base, text: "a".repeat(LIMIT + 1) })).toEqual({
      ok: false,
      reason: "too-large",
      bytes: LIMIT + 1,
    });
    expect(canSendWithAttachments({ ...base, attachments: [ready("/p/ev\nil.png")] })).toMatchObject({
      ok: false,
      reason: "attachment-block",
    });
  });

  it("missing/junk params never open the gate", () => {
    expect(canSendWithAttachments()).toMatchObject({ ok: false, reason: "disabled" });
    expect(canSendWithAttachments({} as never)).toMatchObject({ ok: false, reason: "disabled" });
    expect(canSendWithAttachments({ enabled: true, sending: 1 as never, text: "x" })).toMatchObject({ ok: true }); // only === true counts
    expect(canSendWithAttachments({ enabled: true, text: "x", attachments: "junk" as never })).toMatchObject({
      ok: true,
    });
  });
});

describe("uploadAvailability (§5.1 truth table)", () => {
  const HUB = ["cmd.v1", "upload.v1", "ctl.v2"];
  const card = (upload?: boolean, uploadLan?: boolean) => ({ upload, uploadLan });

  it.each<[string, any, boolean]>([
    ["token + hub upload.v1 + card.upload", { hubCaps: HUB, card: card(true), authMode: "token" }, true],
    ["password + both agent caps", { hubCaps: HUB, card: card(true, true), authMode: "password" }, true],
    ["hub missing upload.v1", { hubCaps: ["cmd.v1"], card: card(true), authMode: "token" }, false],
    ["agent missing upload.v1", { hubCaps: HUB, card: card(false), authMode: "token" }, false],
    ["agent card absent", { hubCaps: HUB, card: undefined, authMode: "token" }, false],
    ['LAN without upload.lan.v1 (uploads:"loopback")', { hubCaps: HUB, card: card(true), authMode: "password" }, false],
    ["LAN with uploadLan but no upload", { hubCaps: HUB, card: card(false, true), authMode: "password" }, false],
    ["unknown authMode", { hubCaps: HUB, card: card(true, true), authMode: "lan" }, false],
    ["hubCaps not an array", { hubCaps: "upload.v1", card: card(true), authMode: "token" }, false],
    ["no params at all", undefined, false],
  ])("%s ⇒ %s", (_name, p, expected) => {
    expect(uploadAvailability(p)).toBe(expected);
  });
});
