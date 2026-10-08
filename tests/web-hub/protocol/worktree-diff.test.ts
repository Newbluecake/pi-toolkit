/**
 * worktree-diff plan v3 §5 D0（协议冻结验收）：`protocol/worktree-diff.ts` 的全部冻结面 —
 * 端点/cap/上限/预算常量及其 §1.9 五条关系钉、`validateWtRelPath` 正反例、
 * `WTDIFF_BASE_RE`、`isWtRequestableEntry` 真值表（#7「可展示但不可请求」）、两个 envelope
 * parser 的逐条拒绝条件 + 字节上限 ±1、`parseUnifiedPatch`（§3.2 全规则：计数驱动、
 * `\ No newline`、删除行以 `--` 开头、行/hunk 双上限边界、截断/非法输入）、固定 seed
 * 2000 例性质测试（计数自洽、行号单调）与线性操作计数（比值法）。
 *
 * `API_ERRORS` 的两个新码必须接在 `E_AGENT_ONLINE` 之后（§1.4：只尾部追加、不重排）；
 * `SSE_EVENTS` 完全不动（`spawn.test.ts` 钉住 `.at(-1) === "spawns"`）。
 */
import { describe, expect, it } from "vitest";
import { API_ERRORS, SSE_EVENTS, WTDIFF_ENDPOINTS } from "../../../src/web-hub/protocol/http-contract.js";
import { LAN_AUTH_CAP_MS } from "../../../src/web-hub/hub/req-deadline.js";
import { WTDIFF_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import {
  isWtRequestableEntry,
  parseUnifiedPatch,
  parseWtDiffFile,
  parseWtDiffFileList,
  validateWtRelPath,
  WTDIFF_ADMIT_MS,
  WTDIFF_AUTH_RESERVE_MS,
  WTDIFF_BASE_RE,
  WTDIFF_CHANGESET_TTL_MS,
  WTDIFF_CLIENT_TIMEOUT_MS,
  WTDIFF_CLOSE_MS,
  WTDIFF_DRIVERS_MAX,
  WTDIFF_FILE_BODY_MAX_BYTES,
  WTDIFF_FILE_PATH,
  WTDIFF_FILES_MAX,
  WTDIFF_FILES_PATH,
  WTDIFF_GIT_CMD_MS,
  WTDIFF_GIT_PHASE_MS,
  WTDIFF_LIST_BODY_MAX_BYTES,
  WTDIFF_NUMSTAT_MAX_BYTES,
  WTDIFF_PARSE_HUNKS_MAX,
  WTDIFF_PARSE_LINES_MAX,
  WTDIFF_PATCH_MAX_BYTES,
  WTDIFF_PATH_MAX_BYTES,
  WTDIFF_STATUSES,
  WTDIFF_STATUS_MAX_BYTES,
  WTDIFF_STEP_MS,
  WTDIFF_TRANSFER_RESERVE_MS,
  WTDIFF_UNTRACKED_READ_MAX_BYTES,
  WTDIFF_WT_LIST_MAX_BYTES,
  WTDIFF_WT_REALPATH_FANOUT_MAX,
  type WtDiffFileEntry,
} from "../../../src/web-hub/protocol/worktree-diff.js";

const enc = new TextEncoder();
const byteLen = (s: string): number => enc.encode(s).length;
const OID40 = "0123456789abcdef0123456789abcdef01234567";
const OID64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// constants, endpoints, caps, API_ERRORS tail (§1.3/§1.4)
// ---------------------------------------------------------------------------

describe("protocol/worktree-diff — frozen constants (§1.3)", () => {
  it("pins the endpoint paths and the hub cap (§1.4)", () => {
    expect(WTDIFF_FILES_PATH).toBe("/api/worktree-diff/files");
    expect(WTDIFF_FILE_PATH).toBe("/api/worktree-diff/file");
    expect(WTDIFF_HUB_CAP).toBe("wtdiff.v1");
  });

  it("pins the caps (§1.3 上限)", () => {
    expect(WTDIFF_FILES_MAX).toBe(1_000);
    expect(WTDIFF_STATUS_MAX_BYTES).toBe(512 * 1024);
    expect(WTDIFF_NUMSTAT_MAX_BYTES).toBe(256 * 1024);
    expect(WTDIFF_LIST_BODY_MAX_BYTES).toBe(256 * 1024);
    expect(WTDIFF_PATCH_MAX_BYTES).toBe(512 * 1024);
    expect(WTDIFF_FILE_BODY_MAX_BYTES).toBe(1024 * 1024);
    expect(WTDIFF_UNTRACKED_READ_MAX_BYTES).toBe(384 * 1024);
    expect(WTDIFF_PARSE_LINES_MAX).toBe(50_000);
    expect(WTDIFF_PARSE_HUNKS_MAX).toBe(10_000);
    expect(WTDIFF_WT_LIST_MAX_BYTES).toBe(256 * 1024);
    expect(WTDIFF_WT_REALPATH_FANOUT_MAX).toBe(64);
    expect(WTDIFF_DRIVERS_MAX).toBe(16);
    expect(WTDIFF_CHANGESET_TTL_MS).toBe(5_000);
    expect(WTDIFF_PATH_MAX_BYTES).toBe(4096);
  });

  it("pins the status enum's single source (§1.3 唯一来源)", () => {
    expect([...WTDIFF_STATUSES]).toEqual(["M", "A", "D", "R", "C", "T", "U", "?"]);
  });

  it("API_ERRORS: the two E_WTDIFF_* codes tail-append after E_AGENT_ONLINE, nothing reordered (§1.4)", () => {
    expect(API_ERRORS[API_ERRORS.length - 3]).toBe("E_AGENT_ONLINE");
    expect(API_ERRORS.slice(-2)).toEqual(["E_WTDIFF_DENIED", "E_WTDIFF_UNSUPPORTED"]);
    // all pre-existing codes keep their indices (append-only, never reorder)
    expect(API_ERRORS.indexOf("E_AGENT_ONLINE")).toBeGreaterThan(API_ERRORS.indexOf("E_PREVIEW_CHANGED"));
    // SSE_EVENTS untouched by D0
    expect(SSE_EVENTS[SSE_EVENTS.length - 1]).toBe("spawns");
    expect(SSE_EVENTS).not.toContain("spawns2" as unknown as (typeof SSE_EVENTS)[number]);
  });

  it("WTDIFF_ENDPOINTS pins the two-endpoint GET shape (§1.2)", () => {
    expect(WTDIFF_ENDPOINTS).toEqual([
      { method: "GET", path: "/api/worktree-diff/files" },
      { method: "GET", path: "/api/worktree-diff/file" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// budgets (§1.9 关系钉)
// ---------------------------------------------------------------------------

describe("protocol/worktree-diff — budget relations (§1.9)", () => {
  it("pins the budget constants", () => {
    expect(WTDIFF_ADMIT_MS).toBe(8_000);
    expect(WTDIFF_AUTH_RESERVE_MS).toBe(5_000);
    expect(WTDIFF_STEP_MS).toBe(2_000);
    expect(WTDIFF_GIT_PHASE_MS).toBe(14_000);
    expect(WTDIFF_GIT_CMD_MS).toBe(5_000);
    expect(WTDIFF_CLOSE_MS).toBe(1_000);
    expect(WTDIFF_TRANSFER_RESERVE_MS).toBe(10_000);
    expect(WTDIFF_CLIENT_TIMEOUT_MS).toBe(35_000);
  });

  it("ADMIT − AUTH_RESERVE ≥ LAN_AUTH_CAP_MS (8 − 5 ≥ 3; hub/req-deadline.ts)", () => {
    expect(WTDIFF_ADMIT_MS - WTDIFF_AUTH_RESERVE_MS).toBeGreaterThanOrEqual(LAN_AUTH_CAP_MS);
    expect(LAN_AUTH_CAP_MS).toBe(3_000);
  });

  it("2 × STEP ≤ AUTH_RESERVE (C1a + C1 keep a full step budget after auth)", () => {
    expect(2 * WTDIFF_STEP_MS).toBeLessThanOrEqual(WTDIFF_AUTH_RESERVE_MS);
  });

  it("4 × STEP + GIT_CMD ≤ GIT_PHASE (C0 + Cc + attrs read + pin fstat + C2 = 8 + 5 ≤ 14)", () => {
    expect(4 * WTDIFF_STEP_MS + WTDIFF_GIT_CMD_MS).toBeLessThanOrEqual(WTDIFF_GIT_PHASE_MS);
  });

  it("server wall clock 23s; 23s + TRANSFER_RESERVE ≤ CLIENT_TIMEOUT (23 + 10 ≤ 35)", () => {
    expect(WTDIFF_ADMIT_MS + WTDIFF_GIT_PHASE_MS + WTDIFF_CLOSE_MS).toBe(23_000);
    expect(23_000 + WTDIFF_TRANSFER_RESERVE_MS).toBeLessThanOrEqual(WTDIFF_CLIENT_TIMEOUT_MS);
  });

  it("byte/hunk stack ordering: PATCH < FILE_BODY, UNTRACKED_READ < PATCH, HUNKS < LINES", () => {
    expect(WTDIFF_PATCH_MAX_BYTES).toBeLessThan(WTDIFF_FILE_BODY_MAX_BYTES);
    expect(WTDIFF_UNTRACKED_READ_MAX_BYTES).toBeLessThan(WTDIFF_PATCH_MAX_BYTES);
    expect(WTDIFF_PARSE_HUNKS_MAX).toBeLessThan(WTDIFF_PARSE_LINES_MAX);
  });
});

// ---------------------------------------------------------------------------
// validateWtRelPath (§2.4)
// ---------------------------------------------------------------------------

describe("validateWtRelPath (§2.4)", () => {
  it("accepts plain, nested, dashed, dotfile and boundary-length paths", () => {
    for (const p of [
      "a.txt",
      "src/web-hub/protocol/worktree-diff.ts",
      "-rf", // leading dash is a legal file name — only ever appears after `--` (I4)
      "-rf /tmp/x",
      "..foo",
      "a..b",
      ".gitignore", // segment is ".gitignore", not ".git"
      "a/.gitignore",
      ".gitmodules",
      "x".repeat(4096), // exactly 4096 UTF-8 bytes
      "α".repeat(2048), // 2-byte char × 2048 = exactly 4096 bytes
      "𝄞".repeat(1024), // surrogate pair, 4 bytes each = exactly 4096 bytes
      "a\tb", // TAB round-trips losslessly — deliberately allowed (unlike CR/LF)
    ]) {
      expect(validateWtRelPath(p)).toBe(true);
    }
  });

  it("rejects empty, rooted, dot-segment, .git-segment, control-char and over-long paths", () => {
    for (const p of [
      "",
      ".git",
      "a/.git",
      "a/.git/b",
      "..",
      ".",
      "./x",
      "a/./b",
      "a/../b",
      "/abs",
      "a/", // trailing slash ⇒ empty segment
      "a//b",
      "a\0b",
      "a\rb",
      "a\nb",
      "a\nb\rc",
      "x".repeat(4097), // 4097 bytes — one over the cap
      "α".repeat(2049), // 4098 bytes via multibyte
      "𝄞".repeat(1024) + "x", // 4100 bytes via surrogate pair
    ]) {
      expect(validateWtRelPath(p)).toBe(false);
    }
  });

  it("never throws on non-string input (defensive)", () => {
    expect(validateWtRelPath(undefined as unknown as string)).toBe(false);
    expect(validateWtRelPath(null as unknown as string)).toBe(false);
    expect(validateWtRelPath(42 as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WTDIFF_BASE_RE
// ---------------------------------------------------------------------------

describe("WTDIFF_BASE_RE (§1.3)", () => {
  it("accepts exactly 40 or 64 lowercase hex chars", () => {
    expect(WTDIFF_BASE_RE.test(OID40)).toBe(true);
    expect(WTDIFF_BASE_RE.test(OID64)).toBe(true);
    expect(WTDIFF_BASE_RE.test("f".repeat(40))).toBe(true);
    expect(WTDIFF_BASE_RE.test("0".repeat(64))).toBe(true);
  });

  it("rejects wrong length, uppercase and non-hex", () => {
    for (const bad of [
      "a".repeat(39),
      "a".repeat(41),
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(40),
      "g".repeat(40),
      `${OID40}x`,
      ` ${OID40}`,
      "",
      "HEAD",
    ]) {
      expect(WTDIFF_BASE_RE.test(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isWtRequestableEntry truth table (#7)
// ---------------------------------------------------------------------------

describe("isWtRequestableEntry (#7 可展示但不可请求)", () => {
  const rows: Array<[WtDiffFileEntry, boolean, string]> = [
    [{ path: "a.txt", status: "M" }, true, "plain entry"],
    [{ path: "a.txt", status: "M", binary: true }, true, "binary is still requestable (answers kind:binary)"],
    [{ path: "a\rb.txt", status: "M" }, false, "CR in path"],
    [{ path: "a\nb.txt", status: "M" }, false, "LF in path"],
    [{ path: "a\tb.txt", status: "M" }, true, "TAB in path — losslessly encodable, formula keeps it requestable"],
    [{ path: "a\uFFFDb.txt", status: "M" }, false, "U+FFFD (lossy decode) in path"],
    [{ path: "x".repeat(4097), status: "M" }, false, "over-4096-byte path"],
    [{ path: "a/.git/b", status: "M" }, false, "illegal segment"],
    [{ path: "a.bin", status: "M", filtered: true }, false, "filter-managed (LFS…)"],
    [{ path: "new.txt", status: "R", orig: "old.txt" }, true, "rename with valid orig"],
    [{ path: "new.txt", status: "C", orig: "src.txt" }, true, "copy with valid orig"],
    [{ path: "new.txt", status: "R", orig: "old\ry.txt" }, false, "CR in orig"],
    [{ path: "new.txt", status: "R", orig: "o\uFFFDk" }, false, "U+FFFD in orig"],
    [{ path: "new\uFFFD.txt", status: "R", orig: "old.txt" }, false, "U+FFFD in path with orig"],
    [{ path: "u.txt", status: "?" }, true, "untracked is requestable (sythesized patch)"],
  ];

  it.each(rows)("%s", (entry, want) => {
    expect(isWtRequestableEntry(entry)).toBe(want);
  });

  it("never throws on a null entry (defensive)", () => {
    expect(isWtRequestableEntry(null as unknown as WtDiffFileEntry)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWtDiffFileList (§1.3 拒绝条件逐条 + 字节上限 ±1)
// ---------------------------------------------------------------------------

describe("parseWtDiffFileList (§1.3)", () => {
  const okBody = (): Record<string, unknown> => ({
    base: OID40,
    entries: [
      { path: "src/a.ts", status: "M", add: 3, del: 1 },
      { path: "new.ts", status: "R", orig: "old.ts", add: 1, del: 0 },
      { path: "logo.png", status: "A", binary: true },
      { path: "bad\uFFFDname", status: "M" },
    ],
    total: 4,
    truncated: false,
    limits: { status: false, files: false, bytes: false },
  });

  const parse = (body: unknown, byteLength = byteLen(JSON.stringify(body))): WtDiffFileList | null =>
    parseWtDiffFileList(body, byteLength);

  /** Replaces entries AND keeps total/truncated consistent, so each row below fails on its
   *  OWN condition only (never on the truncated-formula side effect of shrinking entries). */
  const setEntries = (b: Record<string, unknown>, entries: unknown): void => {
    b.entries = entries;
    b.total = Array.isArray(entries) ? entries.length : 0;
    b.truncated = false;
  };

  it("round-trips a full valid body (unknown fields ignored)", () => {
    const body = okBody();
    (body as Record<string, unknown>).futureField = { any: "thing" };
    const list = parse(body);
    expect(list).not.toBeNull();
    expect(list?.base).toBe(OID40);
    expect(list?.total).toBe(4);
    expect(list?.truncated).toBe(false);
    expect(list?.limits).toEqual({ status: false, files: false, bytes: false });
    expect(list?.entries).toStrictEqual([
      { path: "src/a.ts", status: "M", add: 3, del: 1 },
      { path: "new.ts", status: "R", orig: "old.ts", add: 1, del: 0 },
      { path: "logo.png", status: "A", binary: true },
      { path: "bad\uFFFDname", status: "M" },
    ]);
  });

  it("the lossy-name entry parses (可展示) yet is not requestable (不可请求)", () => {
    const list = parse(okBody());
    const lossy = list?.entries[3];
    expect(lossy).toBeDefined();
    expect(lossy && isWtRequestableEntry(lossy)).toBe(false);
    const clean = list?.entries[0];
    expect(clean && isWtRequestableEntry(clean)).toBe(true);
  });

  it("CR/LF/TAB paths parse but are not requestable (TAB stays requestable)", () => {
    const list = parse({
      base: OID40,
      entries: [
        { path: "a\rb", status: "M" },
        { path: "c\nd", status: "M" },
        { path: "e\tf", status: "M" },
        { path: "renamed", status: "R", orig: "o\rld" },
      ],
      total: 4,
      truncated: false,
      limits: { status: false, files: false, bytes: false },
    });
    expect(list).not.toBeNull();
    const [cr, lf, tab, ren] = list?.entries ?? [];
    expect(isWtRequestableEntry(cr)).toBe(false);
    expect(isWtRequestableEntry(lf)).toBe(false);
    expect(isWtRequestableEntry(tab)).toBe(true);
    expect(isWtRequestableEntry(ren)).toBe(false);
  });

  it("rejects off-contract byteLength values (cap ±1, non-integer, negative)", () => {
    const body = okBody();
    expect(parse(body, WTDIFF_LIST_BODY_MAX_BYTES)).not.toBeNull(); // exactly at the cap
    expect(parse(body, WTDIFF_LIST_BODY_MAX_BYTES + 1)).toBeNull(); // one over
    expect(parse(body, -1)).toBeNull();
    expect(parse(body, 1.5)).toBeNull();
    expect(parse(body, Number.NaN)).toBeNull();
    expect(parse(body, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rejects a non-object / array / null body", () => {
    expect(parse(null)).toBeNull();
    expect(parse([])).toBeNull();
    expect(parse("list")).toBeNull();
    expect(parse(undefined)).toBeNull();
  });

  it.each([
    ["base missing", (b: Record<string, unknown>) => delete b.base],
    ["base not hex", (b: Record<string, unknown>) => (b.base = "zz")],
    ["base uppercase hex", (b: Record<string, unknown>) => (b.base = "A".repeat(40))],
    ["entries missing", (b: Record<string, unknown>) => delete b.entries],
    ["entries not an array", (b: Record<string, unknown>) => (b.entries = {})],
    [
      "entries over FILES_MAX",
      (b: Record<string, unknown>) =>
        setEntries(
          b,
          Array.from({ length: 1001 }, () => ({ path: "f", status: "M" })),
        ),
    ],
    ["entry not an object", (b: Record<string, unknown>) => setEntries(b, ["f"])],
    ["path empty", (b: Record<string, unknown>) => setEntries(b, [{ path: "", status: "M" }])],
    ["path contains NUL", (b: Record<string, unknown>) => setEntries(b, [{ path: "a\0b", status: "M" }])],
    ["path over 4096 bytes", (b: Record<string, unknown>) => setEntries(b, [{ path: "x".repeat(4097), status: "M" }])],
    ["orig empty", (b: Record<string, unknown>) => setEntries(b, [{ path: "n", status: "R", orig: "" }])],
    [
      "orig over 4096 bytes",
      (b: Record<string, unknown>) => setEntries(b, [{ path: "n", status: "R", orig: "x".repeat(4097) }]),
    ],
    ["status outside the enum", (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "X" }])],
    ["status missing", (b: Record<string, unknown>) => setEntries(b, [{ path: "f" }])],
    ["orig with status M", (b: Record<string, unknown>) => setEntries(b, [{ path: "n", status: "M", orig: "o" }])],
    ["orig with status D", (b: Record<string, unknown>) => setEntries(b, [{ path: "n", status: "D", orig: "o" }])],
    ["add negative", (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "M", add: -1 }])],
    ["add non-integer", (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "M", add: 1.5 }])],
    [
      "del not a safe integer",
      (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "M", del: Number.MAX_SAFE_INTEGER + 2 }]),
    ],
    [
      "binary present but false",
      (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "M", binary: false }]),
    ],
    [
      "filtered present but string",
      (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "M", filtered: "yes" }]),
    ],
    [
      "filtered together with add",
      (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "M", filtered: true, add: 1 }]),
    ],
    [
      "filtered together with del",
      (b: Record<string, unknown>) => setEntries(b, [{ path: "f", status: "M", filtered: true, del: 0 }]),
    ],
    ["total below entries.length", (b: Record<string, unknown>) => (b.total = 0)],
    ["total missing", (b: Record<string, unknown>) => delete b.total],
    ["total negative", (b: Record<string, unknown>) => (b.total = -1)],
    ["limits missing", (b: Record<string, unknown>) => delete b.limits],
    [
      "limits.status non-boolean",
      (b: Record<string, unknown>) => (b.limits = { status: "no", files: false, bytes: false }),
    ],
    ["limits.files missing", (b: Record<string, unknown>) => (b.limits = { status: false, bytes: false })],
    [
      "limits.bytes non-boolean",
      (b: Record<string, unknown>) => (b.limits = { status: false, files: false, bytes: 1 }),
    ],
    ["truncated missing", (b: Record<string, unknown>) => delete b.truncated],
    ["truncated true while the formula says false", (b: Record<string, unknown>) => (b.truncated = true)],
    [
      "truncated false while limits.status is true",
      (b: Record<string, unknown>) => (b.limits = { status: true, files: false, bytes: false }),
    ],
    ["untrackedSkipped present but 0", (b: Record<string, unknown>) => (b.untrackedSkipped = 0)],
    ["numstatPartial present but false", (b: Record<string, unknown>) => (b.numstatPartial = false)],
    ["attrPartial present but null", (b: Record<string, unknown>) => (b.attrPartial = null)],
  ])("rejects: %s", (_name, mutate) => {
    const body = okBody();
    mutate(body);
    expect(parse(body)).toBeNull();
  });

  it("accepts every truncation-consistent shape (limits.files/status, total > entries)", () => {
    // files-capped: total 3 > entries 1 ⇒ truncated must be true
    const capped = parse({
      base: OID40,
      entries: [{ path: "f", status: "M" }],
      total: 3,
      truncated: true,
      limits: { status: false, files: true, bytes: false },
    });
    expect(capped?.total).toBe(3);
    expect(capped?.truncated).toBe(true);
    // status-capped with total === entries.length: truncated still true via limits.status
    const statusCapped = parse({
      base: OID40,
      entries: [{ path: "f", status: "M" }],
      total: 1,
      truncated: true,
      limits: { status: true, files: false, bytes: true },
    });
    expect(statusCapped?.truncated).toBe(true);
    // optional flags at true
    const flagged = parse({
      base: OID64,
      entries: [{ path: "f", status: "?", binary: true }],
      total: 1,
      truncated: false,
      limits: { status: false, files: false, bytes: false },
      untrackedSkipped: true,
      numstatPartial: true,
      attrPartial: true,
    });
    expect(flagged?.untrackedSkipped).toBe(true);
    expect(flagged?.numstatPartial).toBe(true);
    expect(flagged?.attrPartial).toBe(true);
    expect(flagged?.base).toBe(OID64);
  });
});

// ---------------------------------------------------------------------------
// parseWtDiffFile (§1.3 拒绝条件逐条 + 字节上限 ±1)
// ---------------------------------------------------------------------------

describe("parseWtDiffFile (§1.3)", () => {
  const okBody = (): Record<string, unknown> => ({
    base: OID40,
    path: "src/a.ts",
    kind: "patch",
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    bytes: byteLen("@@ -1 +1 @@\n-old\n+new\n"),
    truncated: false,
  });

  const parse = (body: unknown, byteLength = byteLen(JSON.stringify(body))) => parseWtDiffFile(body, byteLength);

  it("round-trips a full valid payload (orig + untracked + truncated)", () => {
    const body = okBody();
    body.orig = "old.ts";
    body.untracked = true;
    body.truncated = true;
    const p = parse(body);
    expect(p).toStrictEqual({
      base: OID40,
      path: "src/a.ts",
      orig: "old.ts",
      kind: "patch",
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      bytes: byteLen("@@ -1 +1 @@\n-old\n+new\n"),
      truncated: true,
      untracked: true,
    });
  });

  it('round-trips binary and empty kinds (patch must be "", bytes 0)', () => {
    for (const kind of ["binary", "empty"] as const) {
      const p = parse({ ...okBody(), kind, patch: "", bytes: 0 });
      expect(p?.kind).toBe(kind);
      expect(p?.patch).toBe("");
      expect(p?.bytes).toBe(0);
    }
  });

  it("rejects off-contract byteLength (cap ±1)", () => {
    const body = okBody();
    expect(parse(body, WTDIFF_FILE_BODY_MAX_BYTES)).not.toBeNull(); // exactly at the cap
    expect(parse(body, WTDIFF_FILE_BODY_MAX_BYTES + 1)).toBeNull(); // one over
    expect(parse(body, -1)).toBeNull();
    expect(parse(body, 0.5)).toBeNull();
  });

  it.each([
    ["base invalid", (b: Record<string, unknown>) => (b.base = "HEAD")],
    ["path rooted", (b: Record<string, unknown>) => (b.path = "/abs/path")],
    ["path with CR", (b: Record<string, unknown>) => (b.path = "a\rb")],
    ["path empty", (b: Record<string, unknown>) => (b.path = "")],
    ["path with a .git segment", (b: Record<string, unknown>) => (b.path = "a/.git/b")],
    ["orig invalid", (b: Record<string, unknown>) => (b.orig = "o\nld")],
    ["orig with a .git segment", (b: Record<string, unknown>) => (b.orig = "a/.git/b")],
    ["kind outside the enum", (b: Record<string, unknown>) => (b.kind = "text")],
    ["kind missing", (b: Record<string, unknown>) => delete b.kind],
    [
      "kind binary with a non-empty patch",
      (b: Record<string, unknown>) => ((b.kind = "binary"), (b.patch = "x"), (b.bytes = 1)),
    ],
    [
      "kind empty with a non-empty patch",
      (b: Record<string, unknown>) => ((b.kind = "empty"), (b.patch = "x"), (b.bytes = 1)),
    ],
    ["patch missing", (b: Record<string, unknown>) => delete b.patch],
    ["patch not a string", (b: Record<string, unknown>) => (b.patch = 7)],
    ["bytes missing", (b: Record<string, unknown>) => delete b.bytes],
    ["bytes ≠ patch UTF-8 length", (b: Record<string, unknown>) => (b.bytes = 999)],
    ["bytes negative", (b: Record<string, unknown>) => (b.bytes = -1)],
    ["truncated missing", (b: Record<string, unknown>) => delete b.truncated],
    ["truncated non-boolean", (b: Record<string, unknown>) => (b.truncated = "yes")],
    ["untracked present but false", (b: Record<string, unknown>) => (b.untracked = false)],
  ])("rejects: %s", (_name, mutate) => {
    const body = okBody();
    mutate(body);
    expect(parse(body)).toBeNull();
  });

  it("enforces the patch byte cap exactly (PATCH_MAX ±1)", () => {
    const at = "x".repeat(WTDIFF_PATCH_MAX_BYTES);
    expect(parse({ ...okBody(), patch: at, bytes: WTDIFF_PATCH_MAX_BYTES })).not.toBeNull();
    const over = "x".repeat(WTDIFF_PATCH_MAX_BYTES + 1);
    expect(parse({ ...okBody(), patch: over, bytes: WTDIFF_PATCH_MAX_BYTES + 1 })).toBeNull();
  });

  it("rejects a non-object body", () => {
    expect(parse(null)).toBeNull();
    expect(parse([1])).toBeNull();
    expect(parse("payload")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseUnifiedPatch (§3.2)
// ---------------------------------------------------------------------------

describe("parseUnifiedPatch (§3.2)", () => {
  it("parses a regular single-hunk modification with exact line kinds and numbers", () => {
    const p = parseUnifiedPatch(
      [
        "diff --git a/f.txt b/f.txt",
        "index 1234567..89abcde 100644",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,3 +1,3 @@ fn",
        " context",
        "-old",
        "+new",
        " tail",
        "",
      ].join("\n"),
    );
    expect(p.files).toHaveLength(1);
    expect(p.malformed).toBe(false);
    expect(p.complete).toBe(true);
    expect(p.lineCap).toBe(false);
    expect(p.hunkCap).toBe(false);
    expect(p.add).toBe(1);
    expect(p.del).toBe(1);
    const f = p.files[0]!;
    expect(f.hunks).toHaveLength(1);
    const h = f.hunks[0]!;
    expect(h.oldStart).toBe(1);
    expect(h.oldLines).toBe(3);
    expect(h.newStart).toBe(1);
    expect(h.newLines).toBe(3);
    expect(h.section).toBe("fn");
    expect(h.lines.map((l) => l.k)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(h.lines[0]).toStrictEqual({ k: "ctx", o: 1, n: 1, text: "context" });
    expect(h.lines[1]).toStrictEqual({ k: "del", o: 2, n: null, text: "old" });
    expect(h.lines[2]).toStrictEqual({ k: "add", o: null, n: 2, text: "new" });
    expect(h.lines[3]).toStrictEqual({ k: "ctx", o: 3, n: 3, text: "tail" });
  });

  it("parses multiple hunks in one file, each with its own cursors", () => {
    const p = parseUnifiedPatch(
      ["diff --git a/f b/f", "@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -10,2 +10,2 @@ later", " c", "-d", "+D"].join(
        "\n",
      ),
    );
    expect(p.files[0]!.hunks).toHaveLength(2);
    const h2 = p.files[0]!.hunks[1]!;
    expect(h2.oldStart).toBe(10);
    expect(h2.section).toBe("later");
    expect(h2.lines[0]).toStrictEqual({ k: "ctx", o: 10, n: 10, text: "c" });
    expect(p.add).toBe(2);
    expect(p.del).toBe(2);
    expect(p.complete).toBe(true);
  });

  it("parses a pure addition (@@ -0,0 +1,N @@) — every o is null", () => {
    const p = parseUnifiedPatch(
      [
        "diff --git a/n b/n",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/n",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ].join("\n"),
    );
    const f = p.files[0]!;
    expect(f.meta.newFile).toBe(true);
    expect(f.meta.newMode).toBe("100644");
    const h = f.hunks[0]!;
    expect(h.oldStart).toBe(0);
    expect(h.oldLines).toBe(0);
    expect(h.lines.every((l) => l.k === "add" && l.o === null)).toBe(true);
    expect(h.lines.map((l) => l.n)).toEqual([1, 2]);
    expect(p.add).toBe(2);
    expect(p.del).toBe(0);
  });

  it("parses a pure deletion (@@ -1,N +0,0 @@) — every n is null", () => {
    const p = parseUnifiedPatch(
      [
        "diff --git a/d b/d",
        "deleted file mode 100644",
        "--- a/d",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
      ].join("\n"),
    );
    const f = p.files[0]!;
    expect(f.meta.deleted).toBe(true);
    expect(f.meta.oldMode).toBe("100644");
    const h = f.hunks[0]!;
    expect(h.newStart).toBe(0);
    expect(h.newLines).toBe(0);
    expect(h.lines.every((l) => l.k === "del" && l.n === null)).toBe(true);
    expect(p.del).toBe(2);
    expect(p.add).toBe(0);
  });

  it("parses a rename with no hunks (similarity + rename from/to only)", () => {
    const p = parseUnifiedPatch(
      ["diff --git a/old name b/new name", "similarity index 90%", "rename from old name", "rename to new name"].join(
        "\n",
      ),
    );
    expect(p.files).toHaveLength(1);
    const f = p.files[0]!;
    expect(f.meta.renameFrom).toBe("old name");
    expect(f.meta.renameTo).toBe("new name");
    expect(f.meta.similarity).toBe(90);
    expect(f.hunks).toHaveLength(0);
    expect(p.complete).toBe(true);
  });

  it("parses a mode-only change (old mode / new mode, zero hunks)", () => {
    const p = parseUnifiedPatch(["diff --git a/f b/f", "old mode 100644", "new mode 100755"].join("\n"));
    const f = p.files[0]!;
    expect(f.meta.oldMode).toBe("100644");
    expect(f.meta.newMode).toBe("100755");
    expect(f.hunks).toHaveLength(0);
    expect(p.add).toBe(0);
    expect(p.del).toBe(0);
  });

  it("recognizes both binary forms", () => {
    const differ = parseUnifiedPatch(
      ["diff --git a/l.png b/l.png", "index 111..222 100644", "Binary files a/l.png and b/l.png differ"].join("\n"),
    );
    expect(differ.files[0]!.meta.binary).toBe(true);
    expect(differ.files[0]!.hunks).toHaveLength(0);
    const gitBin = parseUnifiedPatch(
      ["diff --git a/l.png b/l.png", "index 111..222 100644", "GIT binary patch", "literal 123", "zM"].join("\n"),
    );
    expect(gitBin.files[0]!.meta.binary).toBe(true);
    // the literal-data lines after the marker are unknown extended headers — ignored
    expect(gitBin.malformed).toBe(false);
    expect(gitBin.complete).toBe(true);
  });

  it("marks \\ No newline on BOTH sides (old and new)", () => {
    const p = parseUnifiedPatch(
      [
        "diff --git a/f b/f",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    const lines = p.files[0]!.hunks[0]!.lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]!.noEol).toBe(true);
    expect(lines[1]!.noEol).toBe(true);
    expect(p.complete).toBe(true); // counts closed by the sign lines; markers never count
  });

  it("attaches \\ No newline arriving while counts are still open", () => {
    const p = parseUnifiedPatch(
      ["diff --git a/f b/f", "@@ -1,2 +1,2 @@", " keep", "-gone", "\\ No newline at end of file", "+tail"].join("\n"),
    );
    const lines = p.files[0]!.hunks[0]!.lines;
    expect(lines[1]!.k).toBe("del");
    expect(lines[1]!.noEol).toBe(true);
    expect(lines[2]!.noEol).toBeUndefined();
    expect(p.complete).toBe(true);
  });

  it('treats a deleted line starting with "--" as content, never as a "--- a/file" header (rule 4)', () => {
    const p = parseUnifiedPatch(
      ["diff --git a/f b/f", "@@ -1,3 +1,3 @@", " ctx", "---rf", "+++opts", " more"].join("\n"),
    );
    expect(p.malformed).toBe(false);
    expect(p.files).toHaveLength(1);
    const lines = p.files[0]!.hunks[0]!.lines;
    expect(lines[1]).toStrictEqual({ k: "del", o: 2, n: null, text: "--rf" });
    expect(lines[2]).toStrictEqual({ k: "add", o: null, n: 2, text: "++opts" });
    expect(p.del).toBe(1);
    expect(p.add).toBe(1);
  });

  it("treats a literal '--- a/other' line inside open counts as a deletion (rule 4 headline)", () => {
    const p = parseUnifiedPatch(
      ["diff --git a/patch.txt b/patch.txt", "@@ -1,2 +1,2 @@", " header", "--- a/other/file", "+ body"].join("\n"),
    );
    const lines = p.files[0]!.hunks[0]!.lines;
    expect(lines[1]!.k).toBe("del");
    expect(lines[1]!.text).toBe("-- a/other/file");
    expect(p.files).toHaveLength(1);
  });

  it('accepts blank context lines in both spellings ("" and " ")', () => {
    const p = parseUnifiedPatch(["diff --git a/f b/f", "@@ -1,2 +1,3 @@", "", " ", "+x"].join("\n"));
    const lines = p.files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => [l.k, l.text])).toEqual([
      ["ctx", ""],
      ["ctx", ""],
      ["add", "x"],
    ]);
    expect(p.complete).toBe(true);
  });

  it("keeps \\r inside line text (split is \\n-only)", () => {
    const p = parseUnifiedPatch(["diff --git a/f b/f", "@@ -1 +1 @@", "-old\r", "+new\r"].join("\n"));
    const lines = p.files[0]!.hunks[0]!.lines;
    expect(lines[0]!.text).toBe("old\r");
    expect(lines[1]!.text).toBe("new\r");
  });

  it("reports truncated input as complete:false without malformed (cut mid-hunk)", () => {
    const p = parseUnifiedPatch(["diff --git a/f b/f", "@@ -1,5 +1,5 @@", " a", "-b", "+c"].join("\n"));
    expect(p.malformed).toBe(false);
    expect(p.complete).toBe(false);
    expect(p.files[0]!.hunks[0]!.lines).toHaveLength(3);
    expect(p.add).toBe(1);
    expect(p.del).toBe(1);
  });

  it("marks malformed on a syntactically invalid body line and discards the rest", () => {
    const p = parseUnifiedPatch(
      ["diff --git a/f b/f", "@@ -1,3 +1,3 @@", " a", "xNOT A PATCH LINE", "-b", "+c"].join("\n"),
    );
    expect(p.malformed).toBe(true);
    expect(p.complete).toBe(false); // counts were still open when the error hit
    const lines = p.files[0]!.hunks[0]!.lines;
    expect(lines).toHaveLength(1); // " a" survived; everything after the bad line is gone
    expect(p.add).toBe(0);
    expect(p.del).toBe(0);
  });

  it("marks malformed on a `diff --git` lookalike inside open counts", () => {
    const p = parseUnifiedPatch(["diff --git a/f b/f", "@@ -1,2 +1,2 @@", " a", "diff --git a/x b/x"].join("\n"));
    expect(p.malformed).toBe(true);
    expect(p.files).toHaveLength(1);
  });

  it.each([
    ["non-numeric start", "@@ -a +1 @@"],
    ["non-numeric count", "@@ -1,x +1 @@"],
    ["missing trailing @@", "@@ -1 +1 @"],
    ["missing plus side", "@@ -1,2 @@"],
    ["garbage before counts", "@@ junk @@"],
    ["count beyond safe integers", `@@ -1,${"9".repeat(17)} +1 @@`],
  ])("marks malformed on an illegal hunk header: %s", (_name, header) => {
    const p = parseUnifiedPatch(["diff --git a/f b/f", header, " a", "-b", "+c"].join("\n"));
    expect(p.malformed).toBe(true);
    expect(p.files[0]!.hunks).toHaveLength(0);
  });

  it("defaults a missing hunk count to 1 on both sides", () => {
    const p = parseUnifiedPatch(["diff --git a/f b/f", "@@ -3 +5 @@", " x"].join("\n"));
    const h = p.files[0]!.hunks[0]!;
    expect(h.oldLines).toBe(1);
    expect(h.newLines).toBe(1);
    expect(h.lines[0]).toStrictEqual({ k: "ctx", o: 3, n: 5, text: "x" });
    expect(p.complete).toBe(true);
  });

  it("parses multiple file blocks (multi-file patch)", () => {
    const p = parseUnifiedPatch(
      [
        "diff --git a/one b/one",
        "--- a/one",
        "+++ b/one",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/two b/two",
        "deleted file mode 100644",
        "--- a/two",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-z",
      ].join("\n"),
    );
    expect(p.files).toHaveLength(2);
    expect(p.files[1]!.meta.deleted).toBe(true);
    expect(p.files[0]!.hunks).toHaveLength(1);
    expect(p.files[1]!.hunks).toHaveLength(1);
    expect(p.add).toBe(1);
    expect(p.del).toBe(2);
    expect(p.complete).toBe(true);
  });

  it("ignores stray text before the first `diff --git` and tolerates an empty input", () => {
    const stray = parseUnifiedPatch("not a patch at all\nstill not\n");
    expect(stray.files).toHaveLength(0);
    expect(stray.malformed).toBe(false);
    expect(stray.complete).toBe(true);
    expect(parseUnifiedPatch("").files).toHaveLength(0);
    expect(parseUnifiedPatch("\n").files).toHaveLength(0);
  });

  it("flags a context line that overdraws a closed side as malformed (count mismatch)", () => {
    // header promises 1 old / 2 new, but the second line is context — old side exhausted
    const p = parseUnifiedPatch(["diff --git a/f b/f", "@@ -1,1 +1,2 @@", " a", " b"].join("\n"));
    expect(p.malformed).toBe(true);
    expect(p.complete).toBe(false);
  });

  it("hunk cap boundary: 10 000 hunks ⇒ hunkCap false; 10 001 ⇒ true (#8)", () => {
    const build = (hunks: number): string => {
      const parts: string[] = ["diff --git a/f b/f"];
      for (let i = 0; i < hunks; i++) {
        parts.push(`@@ -${i + 1} +${i + 1} @@`);
        parts.push(" x");
      }
      return parts.join("\n");
    };
    const at = parseUnifiedPatch(build(WTDIFF_PARSE_HUNKS_MAX));
    expect(at.hunkCap).toBe(false);
    expect(at.lineCap).toBe(false); // 2×10k + 1 lines ≤ 50k
    expect(at.files[0]!.hunks).toHaveLength(WTDIFF_PARSE_HUNKS_MAX);
    expect(at.complete).toBe(true);
    const over = parseUnifiedPatch(build(WTDIFF_PARSE_HUNKS_MAX + 1));
    expect(over.hunkCap).toBe(true);
    expect(over.malformed).toBe(false);
    expect(over.files[0]!.hunks).toHaveLength(WTDIFF_PARSE_HUNKS_MAX); // cap hunk never opens
  });

  it("line cap boundary: 50 000 lines ⇒ lineCap false; 50 001 ⇒ true", () => {
    const build = (totalLines: number): string => {
      const body = totalLines - 2; // file header + hunk header
      const parts: string[] = ["diff --git a/f b/f", `@@ -1,${body} +1,${body} @@`];
      for (let i = 0; i < body; i++) parts.push(` line ${i}`);
      return parts.join("\n");
    };
    const at = parseUnifiedPatch(build(WTDIFF_PARSE_LINES_MAX));
    expect(at.lineCap).toBe(false);
    expect(at.complete).toBe(true);
    expect(at.files[0]!.hunks[0]!.lines).toHaveLength(WTDIFF_PARSE_LINES_MAX - 2);
    const over = parseUnifiedPatch(build(WTDIFF_PARSE_LINES_MAX + 1));
    expect(over.lineCap).toBe(true);
    expect(over.hunkCap).toBe(false);
    expect(over.malformed).toBe(false);
    // the unprocessed 50 001st line never parsed; the 50 000 processed ones are intact
    expect(over.files[0]!.hunks[0]!.lines).toHaveLength(WTDIFF_PARSE_LINES_MAX - 2);
  });

  it("both caps judged independently — a hunk-dense patch hits hunkCap long before lineCap", () => {
    const parts: string[] = ["diff --git a/f b/f"];
    for (let i = 0; i < WTDIFF_PARSE_HUNKS_MAX + 5; i++) {
      parts.push(`@@ -${i + 1} +${i + 1} @@`);
      parts.push(" x"); // single-line hunks: ~20k lines total, far under the 50k line cap
    }
    const p = parseUnifiedPatch(parts.join("\n"));
    expect(p.hunkCap).toBe(true);
    expect(p.lineCap).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseUnifiedPatch — property tests (fixed seed, 2000 cases) + linearity
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — the fixed seed is part of the frozen test contract. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GenLine {
  k: "ctx" | "del" | "add";
  o: number | null;
  n: number | null;
  text: string;
  noEol?: true;
}

/** Generates a random WELL-FORMED multi-file patch plus its expected parse. */
function genCase(rand: () => number): { text: string; expectedFiles: GenLine[][]; add: number; del: number } {
  const TEXTS = ["", "x", "--rf", "++z", "a\rb", " lead", "tab\there", "ends ", "üñí", "a/b"];
  const pickText = (): string => TEXTS[Math.floor(rand() * TEXTS.length)] ?? "x";
  const lines: string[] = [];
  const expectedFiles: GenLine[][] = [];
  let add = 0;
  let del = 0;
  const fileCount = 1 + Math.floor(rand() * 2);
  for (let f = 0; f < fileCount; f++) {
    lines.push(`diff --git a/f${f} b/f${f}`);
    if (rand() < 0.25) lines.push("index 1111111..2222222 100644");
    if (rand() < 0.2) lines.push("new file mode 100644");
    if (rand() < 0.2) {
      lines.push("--- a/old");
      lines.push("+++ b/new");
    }
    if (rand() < 0.15) {
      lines.push("Binary files a/x and b/x differ");
      expectedFiles.push([]);
      continue;
    }
    const hunks: GenLine[] = [];
    const hunkCount = Math.floor(rand() * 4); // 0..3
    for (let h = 0; h < hunkCount; h++) {
      const body: Array<{ k: GenLine["k"]; text: string; noEol: boolean }> = [];
      const groups = 1 + Math.floor(rand() * 3);
      for (let g = 0; g < groups; g++) {
        const nc = Math.floor(rand() * 3);
        const nd = Math.floor(rand() * 3);
        const na = Math.floor(rand() * 3);
        for (let i = 0; i < nc; i++) body.push({ k: "ctx", text: pickText(), noEol: false });
        for (let i = 0; i < nd; i++) body.push({ k: "del", text: pickText(), noEol: false });
        for (let i = 0; i < na; i++) body.push({ k: "add", text: pickText(), noEol: false });
      }
      if (body.length === 0) body.push({ k: "ctx", text: "anchor", noEol: false });
      const ctxN = body.filter((b) => b.k === "ctx").length;
      const delN = body.filter((b) => b.k === "del").length;
      const addN = body.filter((b) => b.k === "add").length;
      const oldStart = 1 + Math.floor(rand() * 50);
      const newStart = 1 + Math.floor(rand() * 50);
      lines.push(`@@ -${oldStart},${ctxN + delN} +${newStart},${ctxN + addN} @@${rand() < 0.5 ? " sec" : ""}`);
      let o = oldStart;
      let n = newStart;
      for (const b of body) {
        const noEol = (b.k === "del" || b.k === "add") && rand() < 0.15;
        if (b.k === "ctx") {
          // blank context may appear as " " + text, or — for empty text — as a bare ""
          lines.push(b.text === "" && rand() < 0.3 ? "" : ` ${b.text}`);
          hunks.push({ k: "ctx", o: o++, n: n++, text: b.text });
        } else if (b.k === "del") {
          lines.push(`-${b.text}`);
          hunks.push({ k: "del", o: o++, n: null, text: b.text });
          del++;
        } else {
          lines.push(`+${b.text}`);
          hunks.push({ k: "add", o: null, n: n++, text: b.text });
          add++;
        }
        if (noEol) {
          lines.push("\\ No newline at end of file");
          hunks[hunks.length - 1]!.noEol = true;
        }
      }
    }
    expectedFiles.push(hunks);
  }
  // git output newline-terminates EVERY line (incl. a final blank ctx line) — without the
  // trailing "\n" a final blank line would be swallowed by the parser's split artifact rule.
  return { text: lines.join("\n") + "\n", expectedFiles, add, del };
}

describe("parseUnifiedPatch — property tests (§5 D0, fixed seed, 2000 cases)", () => {
  it("counter consistency, monotone line numbers, exact totals — never throws", () => {
    const rand = mulberry32(0x5eed_2026);
    for (let i = 0; i < 2_000; i++) {
      const gen = genCase(rand);
      const p = parseUnifiedPatch(gen.text);
      expect(p.malformed, `case ${i} must not be malformed`).toBe(false);
      expect(p.complete, `case ${i} must be complete`).toBe(true);
      expect(p.lineCap).toBe(false);
      expect(p.hunkCap).toBe(false);
      expect(p.add, `case ${i} add total`).toBe(gen.add);
      expect(p.del, `case ${i} del total`).toBe(gen.del);
      expect(p.files).toHaveLength(gen.expectedFiles.length);
      for (let f = 0; f < gen.expectedFiles.length; f++) {
        const expLines = gen.expectedFiles[f]!;
        const gotFile = p.files[f]!;
        expect(
          gotFile.hunks.reduce((s, h) => s + h.lines.length, 0),
          `case ${i} file ${f} line count`,
        ).toBe(expLines.length);
        const all = gotFile.hunks.flatMap((h) => h.lines);
        for (let li = 0; li < expLines.length; li++) {
          expect(all[li]).toStrictEqual(expLines[li]);
        }
        for (const h of gotFile.hunks) {
          // per-hunk count consistency: ctx+del === oldLines, ctx+add === newLines
          const ctx = h.lines.filter((l) => l.k === "ctx").length;
          const delN = h.lines.filter((l) => l.k === "del").length;
          const addN = h.lines.filter((l) => l.k === "add").length;
          expect(ctx + delN).toBe(h.oldLines);
          expect(ctx + addN).toBe(h.newLines);
          // monotone per-side numbering starting at the header's starts
          let lastO = h.oldStart - 1;
          let lastN = h.newStart - 1;
          for (const l of h.lines) {
            if (l.o !== null) {
              expect(l.o).toBeGreaterThan(lastO);
              lastO = l.o;
            }
            if (l.n !== null) {
              expect(l.n).toBeGreaterThan(lastN);
              lastN = l.n;
            }
          }
          expect(lastO).toBe(h.oldStart + h.oldLines - 1);
          expect(lastN).toBe(h.newStart + h.newLines - 1);
        }
      }
    }
  });
});

describe("parseUnifiedPatch — linear operation count (比值法)", () => {
  const buildPatch = (totalLines: number): string => {
    const body = totalLines - 2;
    const parts: string[] = ["diff --git a/big b/big", `@@ -1,${body} +1,${body} @@`];
    for (let i = 0; i < body; i++) parts.push(` line ${i} with some payload ${i % 97}`);
    return parts.join("\n");
  };

  const bestOf = (text: string, runs: number): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      parseUnifiedPatch(text);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    return best;
  };

  it("4k → 20k lines (5×) stays ≈ linear: t(20k) ≤ max(10 × t(4k), 1ms)", () => {
    const small = buildPatch(4_000);
    const large = buildPatch(20_000);
    parseUnifiedPatch(small); // warmup (JIT)
    parseUnifiedPatch(large);
    const tSmall = bestOf(small, 5);
    const tLarge = bestOf(large, 5);
    // linear ⇒ ratio ≈ 5; quadratic ⇒ ≈ 25 — the 10× bound (with a 1ms floor for timer
    // granularity on very fast machines) separates them with margin on both sides
    expect(tLarge).toBeLessThanOrEqual(Math.max(10 * tSmall, 1.0));
  });

  it("hunk-count scaling is linear too (10k vs 2k hunks)", () => {
    const build = (hunks: number): string => {
      const parts: string[] = ["diff --git a/h b/h"];
      for (let i = 0; i < hunks; i++) {
        parts.push(`@@ -${i + 1} +${i + 1} @@ s${i}`);
        parts.push(` x${i}`);
      }
      return parts.join("\n");
    };
    const small = build(2_000);
    const large = build(10_000);
    parseUnifiedPatch(small);
    parseUnifiedPatch(large);
    const tSmall = bestOf(small, 5);
    const tLarge = bestOf(large, 5);
    expect(tLarge).toBeLessThanOrEqual(Math.max(10 * tSmall, 1.0));
  });
});
