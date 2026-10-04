/**
 * web-hub-upload plan §包 U1: pure protocol functions — `sanitizeUploadName`, `normalizeMime`,
 * `formatAttachmentBlock`/`parseAttachmentBlock`, `bucketFor`, `parseUploadMeta`.
 */
import { describe, expect, it } from "vitest";
import {
  UPLOAD_ATTACH_MAX_PER_MSG,
  UPLOAD_BUCKET_MAX_BYTES,
  UPLOAD_CHUNK_BODY_MS,
  UPLOAD_CHUNK_BYTES_LAN,
  UPLOAD_CHUNK_BYTES_LOOPBACK,
  UPLOAD_FILE_MAX_BYTES,
  UPLOAD_INFLIGHT_HUB,
  UPLOAD_INFLIGHT_PER_PRINCIPAL,
  UPLOAD_TOTAL_MAX_BYTES,
  UPLOAD_TOTAL_MS,
  bucketFor,
  formatAttachmentBlock,
  formatAttachmentSize,
  normalizeMime,
  parseAttachmentBlock,
  parseUploadMeta,
  sanitizeUploadName,
  type AttachmentItem,
  type UploadMetaV1,
} from "../../../src/web-hub/protocol/upload.js";

describe("constants (plan §1.3/§2.4)", () => {
  it("chunk double-tier + deadline ordering (deadline-nesting invariant, §1.3)", () => {
    expect(UPLOAD_CHUNK_BYTES_LAN).toBeLessThan(UPLOAD_CHUNK_BYTES_LOOPBACK);
    expect(UPLOAD_CHUNK_BODY_MS).toBeLessThan(UPLOAD_TOTAL_MS);
    expect(UPLOAD_TOTAL_MS).toBeLessThan(15_000); // < LAN_REQUEST_TIMEOUT_MS
  });

  it("limits match §2.4's table", () => {
    expect(UPLOAD_FILE_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(UPLOAD_BUCKET_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(UPLOAD_TOTAL_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(UPLOAD_INFLIGHT_PER_PRINCIPAL).toBe(4);
    expect(UPLOAD_INFLIGHT_HUB).toBe(16);
    expect(UPLOAD_ATTACH_MAX_PER_MSG).toBe(20);
  });
});

describe("sanitizeUploadName (§2.3)", () => {
  const cases: Array<[unknown, string]> = [
    ["../../etc/passwd", "passwd"],
    ["C:\\a\\b.txt", "b.txt"],
    [".bashrc", "bashrc"],
    ["-rf", "rf"],
    ["a b?.png", "a_b_.png"],
    ["$(x)", "_x_"],
    ["`backtick`.png", "_backtick_.png"],
    ["\u202Eevil.exe.png", "_evil.exe.png"], // U+202E bidi override stripped to `_`
    ["", "file"],
    [".", "file"],
    ["..", "file"],
    ["x.part", "x.part_"],
    ["meta.json", "meta.json_"],
  ];

  it.each(cases)("sanitizeUploadName(%j) === %j", (raw, want) => {
    expect(sanitizeUploadName(raw)).toBe(want);
  });

  it("non-string inputs fall back to 'file'", () => {
    for (const v of [undefined, null, 42, {}, []]) {
      expect(sanitizeUploadName(v)).toBe("file");
    }
  });

  it("preserves a long ASCII extension while truncating an overlong name to ≤120 UTF-8 bytes", () => {
    const longStem = "a".repeat(200);
    const out = sanitizeUploadName(`${longStem}.png`);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(120);
    expect(out.endsWith(".png")).toBe(true);
  });

  it("preserves the extension for a very long multi-byte (Chinese) name", () => {
    const longStem = "中".repeat(100);
    const out = sanitizeUploadName(`${longStem}.pdf`);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("never produces a name ending in .part or exactly meta.json, even after truncation", () => {
    expect(sanitizeUploadName("x".repeat(200) + ".part")).not.toMatch(/\.part$/);
    expect(sanitizeUploadName("meta.json")).not.toBe("meta.json");
  });

  it("collapses runs of replaced characters", () => {
    expect(sanitizeUploadName("a   b")).toBe("a_b");
  });

  it("result always matches the allowed character set plus leading underscore residue", () => {
    const out = sanitizeUploadName('évil//name:*?"<>|\u0000\u0007.png');
    expect(out).toMatch(/^[\p{L}\p{N}._-]+$/u);
  });
});

describe("normalizeMime (§1.2 #2 — injection table)", () => {
  const rejected: unknown[] = [
    "text/plain\n- /etc/passwd",
    "\r",
    "image/png; charset=x",
    "图片/png",
    `image/${"a".repeat(65)}`, // subtype > 64 chars
    "",
    "not-a-mime",
    "a/b/c",
    42,
    null,
    undefined,
    "a".repeat(130) + "/x",
  ];

  it.each(rejected)("normalizeMime(%j) is dropped (undefined)", (raw) => {
    expect(normalizeMime(raw)).toBeUndefined();
  });

  it("trims and lowercases a valid mime", () => {
    expect(normalizeMime(" IMAGE/PNG ")).toBe("image/png");
  });

  it("accepts a valid mime unchanged (already lowercase)", () => {
    expect(normalizeMime("application/pdf")).toBe("application/pdf");
  });

  it("accepts RFC 7230 token punctuation", () => {
    expect(normalizeMime("application/vnd.api+json")).toBe("application/vnd.api+json");
  });
});

describe("bucketFor (§2.1)", () => {
  it("uses s-<sessionId> when sessionId sanitizes cleanly", () => {
    expect(bucketFor({ sessionId: "abc123_-", agentKey: "a1-xyz" })).toBe("s-abc123_-");
  });

  it("falls back to a-<agentKey> when sessionId is missing or dirty", () => {
    expect(bucketFor({ agentKey: "a1-xyz" })).toBe("a-a1-xyz");
    expect(bucketFor({ sessionId: "has space", agentKey: "a1-xyz" })).toBe("a-a1-xyz");
    expect(bucketFor({ sessionId: "", agentKey: "a1-xyz" })).toBe("a-a1-xyz");
    expect(bucketFor({ sessionId: "x".repeat(65), agentKey: "a1-xyz" })).toBe("a-a1-xyz");
  });
});

describe("formatAttachmentSize", () => {
  it.each([
    [0, "0 B"],
    [834, "834 B"],
    [1024, "1.0 KB"],
    [182344, "178 KB"],
    [1024 * 1024 * 1.4, "1.4 MB"],
  ])("formatAttachmentSize(%d) === %j", (n, want) => {
    expect(formatAttachmentSize(n)).toBe(want);
  });
});

describe("formatAttachmentBlock / parseAttachmentBlock (§3.1)", () => {
  function items(n: number): AttachmentItem[] {
    return Array.from({ length: n }, (_, i) => ({
      path: `/home/u/.pi/agent/web-hub/uploads/s-abc/${i}/file${i}.png`,
      mime: i % 2 === 0 ? "image/png" : null,
      sizeLabel: formatAttachmentSize(1000 * (i + 1)),
    }));
  }

  it("matches the frozen snapshot shape", () => {
    const block = formatAttachmentBlock([
      { path: "/home/u/.pi/agent/web-hub/uploads/s-3f2a/Xy7/screenshot.png", mime: "image/png", sizeLabel: "182 KB" },
      {
        path: "/home/u/.pi/agent/web-hub/uploads/s-3f2a/Ab9/report_v2.pdf",
        mime: null,
        sizeLabel: "1.4 MB",
      },
    ]);
    expect(block).toBe(
      [
        "[web-hub attachments] The user attached 2 file(s), saved on this machine and kept for at least 24 hours (7 days once sent):",
        "- /home/u/.pi/agent/web-hub/uploads/s-3f2a/Xy7/screenshot.png (image/png, 182 KB)",
        "- /home/u/.pi/agent/web-hub/uploads/s-3f2a/Ab9/report_v2.pdf (unknown type, 1.4 MB)",
        "Paths can be passed to the read tool as-is; quote them when using a shell.",
      ].join("\n"),
    );
  });

  it("line count is always 2 + file count, for any input size", () => {
    for (const n of [1, 2, 5, 20]) {
      const block = formatAttachmentBlock(items(n))!;
      expect(block.split("\n").length).toBe(2 + n);
    }
  });

  it("empty items list ⇒ undefined (no block)", () => {
    expect(formatAttachmentBlock([])).toBeUndefined();
  });

  it("round-trips through parseAttachmentBlock", () => {
    for (const n of [1, 2, 5, 20]) {
      const list = items(n);
      const block = formatAttachmentBlock(list)!;
      expect(parseAttachmentBlock(block)).toEqual(list);
    }
  });

  it("re-formatting the parsed result reproduces the exact same text", () => {
    const list = items(3);
    const block = formatAttachmentBlock(list)!;
    const parsed = parseAttachmentBlock(block)!;
    expect(formatAttachmentBlock(parsed)).toBe(block);
  });

  it("parses correctly when embedded in surrounding prose (the composer prepends user text)", () => {
    const list = items(2);
    const block = formatAttachmentBlock(list)!;
    const full = `Please look at these.\n\n${block}`;
    expect(parseAttachmentBlock(full)).toEqual(list);
  });

  it("refuses to generate a block when a path contains a newline", () => {
    expect(
      formatAttachmentBlock([{ path: "/home/u/evil\n- /etc/passwd", mime: null, sizeLabel: "1 B" }]),
    ).toBeUndefined();
    expect(
      formatAttachmentBlock([{ path: "/home/u/evil\r\nmore", mime: "image/png", sizeLabel: "1 B" }]),
    ).toBeUndefined();
  });

  it("refuses to generate a block when a sizeLabel contains control characters or parens", () => {
    const bad: AttachmentItem[] = [
      { path: "/home/u/a.png", mime: "image/png", sizeLabel: "1 B)\n- /etc/passwd (0 B" },
      { path: "/home/u/b.png", mime: "image/png", sizeLabel: "1 B\r\nmore" },
      { path: "/home/u/c.png", mime: "image/png", sizeLabel: "1 B\x00" },
      { path: "/home/u/d.png", mime: "image/png", sizeLabel: "1 (B)" },
    ];
    for (const item of bad) {
      expect(formatAttachmentBlock([item]), JSON.stringify(item)).toBeUndefined();
    }
  });

  it("mime injection cannot forge extra list/footer lines — line count stays 2 + file count", () => {
    const malicious: AttachmentItem[] = [
      { path: "/home/u/a.png", mime: "text/plain\n- /etc/passwd", sizeLabel: "1 B" },
      { path: "/home/u/b.png", mime: "\r", sizeLabel: "1 B" },
      { path: "/home/u/c.png", mime: "image/png; charset=x", sizeLabel: "1 B" },
      { path: "/home/u/d.png", mime: "图片/png", sizeLabel: "1 B" },
    ];
    const block = formatAttachmentBlock(malicious)!;
    expect(block.split("\n").length).toBe(2 + malicious.length);
    for (const line of block.split("\n").slice(1, -1)) {
      expect(line).toMatch(/\(unknown type, 1 B\)$/);
    }
  });

  it("parseAttachmentBlock returns undefined for text with no well-formed block", () => {
    expect(parseAttachmentBlock("just some ordinary text")).toBeUndefined();
    expect(parseAttachmentBlock("")).toBeUndefined();
  });

  it("parseAttachmentBlock rejects a mismatched declared count or missing footer", () => {
    const block = formatAttachmentBlock(items(2))!;
    const lines = block.split("\n");
    // drop the footer
    expect(parseAttachmentBlock(lines.slice(0, -1).join("\n"))).toBeUndefined();
    // claim 3 files but only provide 2
    const tampered = lines[0]!.replace("attached 2 file(s)", "attached 3 file(s)");
    expect(parseAttachmentBlock([tampered, ...lines.slice(1)].join("\n"))).toBeUndefined();
  });
});

describe("parseUploadMeta (§2.2.3)", () => {
  function validMeta(): UploadMetaV1 {
    return {
      v: 1,
      id: "cmd-abc123",
      principal: "lan:u3",
      agentKey: "a123-ab12cd",
      bucket: "s-abc123",
      safeName: "shot.png",
      size: 182344,
      mime: "image/png",
      sha256: "a".repeat(64),
      committedAt: 1_790_000_000_000,
      referencedAt: null,
    };
  }

  it("accepts a valid v1 record and round-trips it", () => {
    const meta = validMeta();
    expect(parseUploadMeta(meta)).toEqual({ ok: true, meta });
  });

  it("accepts mime:null and a numeric referencedAt", () => {
    const meta = { ...validMeta(), mime: null, referencedAt: 1_790_000_100_000 };
    expect(parseUploadMeta(meta)).toEqual({ ok: true, meta });
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, 42, "x", [], true]) {
      expect(parseUploadMeta(v).ok).toBe(false);
    }
  });

  it("rejects a wrong/missing v (not exactly 1)", () => {
    for (const v of [2, 0, "1", undefined, null]) {
      expect(parseUploadMeta({ ...validMeta(), v })).toEqual({ ok: false, error: "bad-version" });
    }
  });

  it("rejects each required field missing individually", () => {
    const required: Array<keyof UploadMetaV1> = [
      "id",
      "principal",
      "agentKey",
      "bucket",
      "safeName",
      "size",
      "sha256",
      "committedAt",
    ];
    for (const key of required) {
      const meta = validMeta() as unknown as Record<string, unknown>;
      delete meta[key];
      expect(parseUploadMeta(meta).ok, `missing ${key}`).toBe(false);
    }
  });

  it("rejects wrong-typed fields", () => {
    expect(parseUploadMeta({ ...validMeta(), size: "182344" }).ok).toBe(false);
    expect(parseUploadMeta({ ...validMeta(), size: -1 }).ok).toBe(false);
    expect(parseUploadMeta({ ...validMeta(), committedAt: "x" }).ok).toBe(false);
    expect(parseUploadMeta({ ...validMeta(), referencedAt: "x" }).ok).toBe(false);
    expect(parseUploadMeta({ ...validMeta(), mime: 42 }).ok).toBe(false);
    expect(parseUploadMeta({ ...validMeta(), mime: "text/plain\nx" }).ok).toBe(false);
    expect(parseUploadMeta({ ...validMeta(), sha256: "not-hex" }).ok).toBe(false);
    expect(parseUploadMeta({ ...validMeta(), sha256: "A".repeat(64) }).ok).toBe(false); // must be lowercase
  });
});
