/**
 * web-hub-spawn plan v2.1 §SP1: `protocol/spawn.ts` — schema 正反例, constant pins.
 *
 * The type-level pins (enum unions, port shapes) live in
 * `tests/web-hub/contract/types.test-d.ts` because ONLY that file is covered by
 * `npm run typecheck`'s second tsc pass; this file pins RUNTIME behavior.
 *
 * `SPAWN_ID_RE`/`PROMPT_TEXT_MAX_BYTES` must stay equal to `hub/http.ts`'s private
 * `CMD_ID_RE`/`PROMPT_TEXT_MAX_BYTES`, but http.ts is SP9's hot file (§2.3) and outside SP1's
 * file domain — so the pins read http.ts's SOURCE instead of importing it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ASK_USER_MARKER } from "../../../src/ask-user/channel-handler.js";
import {
  FIRST_PROMPT_BACKOFF_MS,
  FIRST_PROMPT_GRACE_MS,
  ORPHAN_BOUND_MS,
  PROMPT_TEXT_MAX_BYTES,
  RPC_ASK_USER_TITLE,
  SPAWN_BACKOFF_MS,
  SPAWN_BODY_MAX,
  SPAWN_BREAKER_OPEN_MS,
  SPAWN_CWD_MAX_BYTES,
  SPAWN_FAIL_WINDOW_MS,
  SPAWN_ID_RE,
  SPAWN_NONTERMINAL_MAX,
  SPAWN_STARTING_MAX,
  SPAWN_TERMINAL_KEEP,
  STDERR_FILE_MAX,
  STDERR_FILES_MAX,
  STDERR_QUEUE_BYTES,
  STDERR_RING_BYTES,
  STDERR_TAIL_BYTES,
  STOP_KILL_MS,
  STOP_TERM_MS,
  STDOUT_LINE_MAX,
  SUPPORTED_PI_RANGE,
  UI_REQ_HEAD_BYTES,
  MARKER_HOLD_GRACE_MS,
  EXIT_GUARD_MS,
  REAPER_GRACE_MS,
  SPAWN_EVENT_MS,
  SpawnRequestSchema,
  parseSpawnRequestBody,
  type SpawnRequestBody,
} from "../../../src/web-hub/protocol/spawn.js";

const ID_16 = "a".repeat(16);
const ID_64 = "b".repeat(64);

function body(over: Partial<SpawnRequestBody> = {}): SpawnRequestBody {
  return { id: ID_16, cwd: "/home/u/proj", ...over };
}

describe("SpawnRequestSchema 正反例 (plan §SP1)", () => {
  it("accepts the minimal and the full body", () => {
    const minimal = body();
    const full = body({
      id: ID_64,
      confirm: true,
      expectCwd: "/home/u/proj",
      firstPrompt: { text: "first!", deliver: "followUp" },
    });
    expect(Value.Check(SpawnRequestSchema, minimal)).toBe(true);
    expect(Value.Check(SpawnRequestSchema, full)).toBe(true);
    expect(parseSpawnRequestBody(minimal)).toEqual({ ok: true, body: minimal });
    expect(parseSpawnRequestBody(full)).toEqual({ ok: true, body: full });
  });

  it("rejects extra fields at BOTH levels (additionalProperties:false)", () => {
    expect(Value.Check(SpawnRequestSchema, { ...body(), model: "anthropic/claude" })).toBe(false);
    expect(Value.Check(SpawnRequestSchema, body({ firstPrompt: { text: "x", ttl: 5 } }))).toBe(false);
    expect(parseSpawnRequestBody({ ...body(), force: true })).toEqual({ ok: false, error: "schema" });
  });

  it.each([
    ["15 chars", "c".repeat(15)],
    ["65 chars", "d".repeat(65)],
    ["bad char", "e".repeat(15) + "$"],
  ])("rejects id: %s", (_name, id) => {
    expect(Value.Check(SpawnRequestSchema, body({ id }))).toBe(false);
    expect(parseSpawnRequestBody(body({ id }))).toEqual({ ok: false, error: "schema" });
  });

  it("rejects a non-string / missing cwd and confirm !== true", () => {
    expect(Value.Check(SpawnRequestSchema, { id: ID_16 })).toBe(false);
    expect(Value.Check(SpawnRequestSchema, { ...body(), cwd: 42 })).toBe(false);
    expect(Value.Check(SpawnRequestSchema, body({ confirm: "yes" as unknown as true }))).toBe(false);
  });

  it("rejects deliver outside {steer, followUp}", () => {
    expect(Value.Check(SpawnRequestSchema, body({ firstPrompt: { text: "x", deliver: "email" } }))).toBe(false);
    expect(Value.Check(SpawnRequestSchema, body({ firstPrompt: { text: "x", deliver: "steer" } }))).toBe(true);
  });

  it("rejects non-objects without throwing", () => {
    for (const raw of [undefined, null, "x", 42, [], [body()]]) {
      expect(parseSpawnRequestBody(raw)).toEqual({ ok: false, error: "not-an-object" });
    }
  });
});

describe("UTF-8 byte caps (schema prefilter + exact byte check)", () => {
  it("cwd 4097 ASCII chars are rejected (schema prefilter)", () => {
    expect(parseSpawnRequestBody(body({ cwd: "/".repeat(4097) }))).toEqual({ ok: false, error: "schema" });
  });

  it("cwd passing the UTF-16 prefilter but exceeding 4096 UTF-8 bytes is rejected by bytes", () => {
    // 2048 chars × 3 bytes = 6144 bytes; UTF-16 length 2048 ≤ 4096 so the schema alone lets it by.
    const wide = "中".repeat(2048);
    expect(Value.Check(SpawnRequestSchema, body({ cwd: wide }))).toBe(true);
    expect(parseSpawnRequestBody(body({ cwd: wide }))).toEqual({ ok: false, error: "cwd-too-long" });
  });

  it("cwd at exactly 4096 UTF-8 bytes is accepted", () => {
    expect(parseSpawnRequestBody(body({ cwd: "/".repeat(4096) }))).toMatchObject({ ok: true });
    expect(parseSpawnRequestBody(body({ cwd: "中".repeat(1365) + "a" }))).toMatchObject({ ok: true }); // 4096 bytes
  });

  it("firstPrompt.text 48 KiB + 1 ASCII chars are rejected (schema prefilter)", () => {
    const text = "a".repeat(PROMPT_TEXT_MAX_BYTES + 1);
    expect(parseSpawnRequestBody(body({ firstPrompt: { text } }))).toEqual({ ok: false, error: "schema" });
  });

  it("firstPrompt.text passing the prefilter but exceeding 48 KiB UTF-8 bytes is rejected by bytes", () => {
    const wide = "中".repeat(20_000); // 60 000 bytes, UTF-16 length 20 000 ≤ 49 152
    expect(Value.Check(SpawnRequestSchema, body({ firstPrompt: { text: wide } }))).toBe(true);
    expect(parseSpawnRequestBody(body({ firstPrompt: { text: wide } }))).toEqual({
      ok: false,
      error: "first-prompt-too-long",
    });
  });

  it("firstPrompt.text at exactly 48 KiB UTF-8 bytes is accepted (ASCII and multibyte)", () => {
    expect(parseSpawnRequestBody(body({ firstPrompt: { text: "a".repeat(48 * 1024) } }))).toMatchObject({ ok: true });
    expect(parseSpawnRequestBody(body({ firstPrompt: { text: "中".repeat(16 * 1024) } }))).toMatchObject({ ok: true });
  });

  it("SP9 / SP1 leftover P3①: expectCwd passing the UTF-16 prefilter but exceeding 4096 UTF-8 bytes is rejected by bytes", () => {
    // 2048 chars × 3 bytes = 6144 bytes; UTF-16 length 2048 ≤ 4096 so the schema alone lets it by —
    // the exact byte re-check in parseSpawnRequestBody (same path as cwd) must catch it.
    const wide = "中".repeat(2048);
    expect(Value.Check(SpawnRequestSchema, body({ expectCwd: wide }))).toBe(true);
    expect(parseSpawnRequestBody(body({ expectCwd: wide }))).toEqual({ ok: false, error: "cwd-too-long" });
    // boundary: exactly 4096 bytes still passes
    expect(parseSpawnRequestBody(body({ expectCwd: "中".repeat(1365) + "a" }))).toMatchObject({ ok: true });
  });
});

describe("同源常量 pins (plan §SP1 验收)", () => {
  const httpSrc = readFileSync(new URL("../../../src/web-hub/hub/http.ts", import.meta.url), "utf8");

  it("SPAWN_ID_RE.source === http.ts's CMD_ID_RE.source", () => {
    expect(SPAWN_ID_RE.source).toBe("^[A-Za-z0-9_-]{16,64}$");
    // http.ts's CMD_ID_RE is module-private and outside SP1's file domain — pin via source text.
    expect(httpSrc).toContain(`const CMD_ID_RE = /${SPAWN_ID_RE.source}/;`);
  });

  it("PROMPT_TEXT_MAX_BYTES === http.ts's PROMPT_TEXT_MAX_BYTES (48 KiB)", () => {
    expect(PROMPT_TEXT_MAX_BYTES).toBe(48 * 1024);
    expect(httpSrc).toContain("const PROMPT_TEXT_MAX_BYTES = 48 * 1024;");
  });

  it("RPC_ASK_USER_TITLE === ask-user's ASK_USER_MARKER", () => {
    expect(RPC_ASK_USER_TITLE).toBe(ASK_USER_MARKER);
    expect(RPC_ASK_USER_TITLE).toBe("\0XYZ_ASK_USER");
  });

  it("SUPPORTED_PI_RANGE mirrors the package-root peerDependencies range", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    const range = pkg.peerDependencies["@earendil-works/pi-coding-agent"];
    expect(range).toBe(`>=${SUPPORTED_PI_RANGE.min} <${SUPPORTED_PI_RANGE.maxExclusive}`);
    expect(SUPPORTED_PI_RANGE).toEqual({ min: "1.0.0", maxExclusive: "1.1.0" });
  });
});

describe("常量表 (arch §7 lifecycle/limit constants)", () => {
  it("stop escalation / reaper / orphan bounds", () => {
    expect(SPAWN_EVENT_MS).toBe(5_000);
    expect(STOP_TERM_MS).toBe(5_000);
    expect(STOP_KILL_MS).toBe(3_000);
    expect(EXIT_GUARD_MS).toBe(5_000);
    expect(REAPER_GRACE_MS).toBe(5_000);
    expect(ORPHAN_BOUND_MS).toBe(12_000);
    expect(MARKER_HOLD_GRACE_MS).toBe(5_000);
    expect(UI_REQ_HEAD_BYTES).toBe(512);
    expect(STDOUT_LINE_MAX).toBe(64 * 1024);
  });

  it("stderr sink budgets", () => {
    expect(STDERR_RING_BYTES).toBe(64 * 1024);
    expect(STDERR_QUEUE_BYTES).toBe(64 * 1024);
    expect(STDERR_FILE_MAX).toBe(256 * 1024);
    expect(STDERR_FILES_MAX).toBe(20);
    expect(STDERR_TAIL_BYTES).toBe(4_096);
  });

  it("first-prompt + breaker + retention", () => {
    expect(FIRST_PROMPT_GRACE_MS).toBe(120_000);
    expect(FIRST_PROMPT_BACKOFF_MS).toEqual([1_000, 3_000, 9_000]);
    expect(SPAWN_BACKOFF_MS).toEqual([0, 5_000, 30_000]);
    expect(SPAWN_FAIL_WINDOW_MS).toBe(600_000);
    expect(SPAWN_BREAKER_OPEN_MS).toBe(600_000);
    expect(SPAWN_TERMINAL_KEEP).toBe(20);
    expect(SPAWN_NONTERMINAL_MAX).toBe(16);
    expect(SPAWN_STARTING_MAX).toBe(2);
    expect(SPAWN_BODY_MAX).toBe(52 * 1024);
    expect(SPAWN_CWD_MAX_BYTES).toBe(4_096);
  });
});

// ---------------------------------------------------------------------------
// 未启用响应矩阵的类型层钉住 (arch §8.2 唯一矩阵; SP9 的 headless-matrix.test.ts 按格断言
// 字节，这里钉住矩阵的词汇表本身——SSE 事件名 / 错误码 / hub cap 都必须已进冻结数组)。
// ---------------------------------------------------------------------------

describe("响应矩阵词汇表 (arch §8.2, SP9 之前先钉在类型层)", () => {
  it('SSE_EVENTS carries "spawns"; the four spawn error codes sit at API_ERRORS\' tail (after upload)', async () => {
    const { SSE_EVENTS, API_ERRORS } = await import("../../../src/web-hub/protocol/http-contract.js");
    expect(SSE_EVENTS).toContain("spawns");
    expect(SSE_EVENTS.at(-1)).toBe("spawns"); // 尾部追加，不打乱既有顺序
    expect(API_ERRORS.slice(-4)).toEqual(["E_SPAWN_DENIED", "E_DIR", "E_LIMIT", "E_LAUNCHER"]);
  });

  it('SPAWN_HUB_CAP is "spawn.v1" (advertised only when config.spawn exists — SP10 wires it)', async () => {
    const { SPAWN_HUB_CAP } = await import("../../../src/web-hub/protocol/version.js");
    expect(SPAWN_HUB_CAP).toBe("spawn.v1");
  });
});
