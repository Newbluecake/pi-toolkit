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
  SPAWN_MODEL_MAX_BYTES,
  SPAWN_NONTERMINAL_MAX,
  SPAWN_PREFS_BODY_MAX,
  SPAWN_STARTING_MAX,
  SPAWN_TERMINAL_KEEP,
  SpawnPrefsRequestSchema,
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
  SpawnRequestSchemaWithSession,
  SessionRefSchema,
  parseSpawnModelRef,
  parseSpawnPrefsRequest,
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
    // `model` became a REAL field in the default-model plan (§2) — the unknown-field probe
    // uses `force` instead. A KNOWN-key probe with an invalid VALUE is covered below
    // ("non-\"\" invalid value ⇒ model-invalid").
    expect(Value.Check(SpawnRequestSchema, { ...body(), force: true })).toBe(false);
    expect(Value.Check(SpawnRequestSchema, { ...body(), modelz: "anthropic/claude" })).toBe(false);
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

// ---------------------------------------------------------------------------
// default-model plan §2/§6 (H1): parseSpawnModelRef, the `model` tri-state, the prefs surface.
// ---------------------------------------------------------------------------

describe("parseSpawnModelRef 正反例 (default-model plan §2/§6)", () => {
  it.each([
    ["anthropic/claude-opus-4-5", "anthropic", "claude-opus-4-5"],
    ["openrouter/openai/gpt-4o:extended", "openrouter", "openai/gpt-4o:extended"],
    ["vertex/claude@2024", "vertex", "claude@2024"],
    ["p1/typo-xyz", "p1", "typo-xyz"],
    // provider charset: `.`, `_`, `-` INSIDE the provider are fine (alnum start)
    ["prov._-2/m", "prov._-2", "m"],
  ])("accepts %s", (ref, provider, id) => {
    expect(parseSpawnModelRef(ref)).toEqual({ provider, id });
    // split is at the FIRST `/` and carries no normalization — reassembly is identity
    const parsed = parseSpawnModelRef(ref);
    expect(parsed && `${parsed.provider}/${parsed.id}`).toBe(ref);
  });

  it.each([
    ["empty provider", "/claude-opus-4-5"],
    ["empty id", "anthropic/"],
    ["no slash", "anthropic"],
    ["leading dash provider (flag confusion)", "-x/y"],
    ["provider starting with dot", ".a/x"],
    ["provider with colon", "a:b/c"],
    ["non-ASCII provider", "中/x"],
    ["plain space", "anthropic /claude"],
    ["tab in id", "anthropic/\tclaude"],
    ["newline", "anthropic/claude\n"],
    ["zero-width space U+200B", "anthropic/claude\u200b"],
    ["provider over 128 bytes", `${"p".repeat(129)}/${"m".repeat(128)}`],
    ["id over 128 bytes", `p/${"m".repeat(129)}`],
    ["empty string", ""],
  ])("rejects %s: %j", (_name, ref) => {
    expect(parseSpawnModelRef(ref)).toBeNull();
  });

  it("each half at exactly 128 bytes ⇒ whole ref exactly SPAWN_MODEL_MAX_BYTES (257) parses", () => {
    const ref = `${"p".repeat(128)}/${"m".repeat(128)}`;
    expect(new TextEncoder().encode(ref).length).toBe(SPAWN_MODEL_MAX_BYTES);
    expect(parseSpawnModelRef(ref)).toEqual({ provider: "p".repeat(128), id: "m".repeat(128) });
  });
});

describe("SpawnRequestBody.model 三态 + model-invalid (default-model plan D2)", () => {
  it("absent ⇒ hub preference: parses OK, body.model stays undefined", () => {
    const res = parseSpawnRequestBody(body());
    expect(res).toEqual({ ok: true, body: body() });
    if (res.ok) expect(res.body.model).toBeUndefined();
  });

  it('"" ⇒ explicit pi default: schema and parse accept, kept verbatim', () => {
    const b = body({ model: "" });
    expect(Value.Check(SpawnRequestSchema, b)).toBe(true);
    expect(parseSpawnRequestBody(b)).toEqual({ ok: true, body: b });
  });

  it('"provider/id" ⇒ accepted verbatim (id may carry / : . @)', () => {
    const b = body({ model: "openrouter/openai/gpt-4o:extended" });
    expect(Value.Check(SpawnRequestSchema, b)).toBe(true);
    expect(parseSpawnRequestBody(b)).toEqual({ ok: true, body: b });
  });

  it.each([
    ["empty provider", "/x"],
    ["leading dash", "-x/y"],
    ["whitespace", "a b/c"],
    ["newline", "a/b\n"],
    ["zero-width space", "a/b\u200b"],
    ["no slash", "ab"],
  ])('non-"" invalid value ⇒ model-invalid: %s', (_name, model) => {
    expect(parseSpawnRequestBody(body({ model }))).toEqual({ ok: false, error: "model-invalid" });
  });

  it("UTF-16 prefilter escape: ≤257 units but >257 UTF-8 bytes ⇒ model-invalid (not schema)", () => {
    // 87 chars (≤257 units) so the schema prefilter lets it by; 43×3 + 1 + 43×3 = 259 bytes,
    // and each half is 129 bytes > the 128-byte per-part cap — parseSpawnModelRef must reject.
    const ref = `${"中".repeat(43)}/${"中".repeat(43)}`;
    expect(Value.Check(SpawnRequestSchema, body({ model: ref }))).toBe(true);
    expect(parseSpawnRequestBody(body({ model: ref }))).toEqual({ ok: false, error: "model-invalid" });
  });

  it(">257 UTF-16 units ⇒ schema prefilter rejects (schema, not model-invalid)", () => {
    expect(parseSpawnRequestBody(body({ model: "a".repeat(SPAWN_MODEL_MAX_BYTES + 1) }))).toEqual({
      ok: false,
      error: "schema",
    });
  });
});

describe("spawn prefs wire (default-model plan §2: SpawnPrefsWire/schema/parse/max)", () => {
  it('SpawnPrefsRequestSchema is strict: "" and valid refs pass, extra fields / non-strings fail', () => {
    expect(Value.Check(SpawnPrefsRequestSchema, { defaultModel: "" })).toBe(true);
    expect(Value.Check(SpawnPrefsRequestSchema, { defaultModel: "anthropic/claude-opus-4-5" })).toBe(true);
    expect(Value.Check(SpawnPrefsRequestSchema, { defaultModel: "x", extra: 1 })).toBe(false);
    expect(Value.Check(SpawnPrefsRequestSchema, {})).toBe(false);
    expect(Value.Check(SpawnPrefsRequestSchema, { defaultModel: 5 })).toBe(false);
    expect(Value.Check(SpawnPrefsRequestSchema, { defaultModel: null })).toBe(false);
  });

  it("parseSpawnPrefsRequest: not-an-object / schema / model-invalid / ok", () => {
    for (const raw of [undefined, null, "x", 42, [], [{ defaultModel: "" }]]) {
      expect(parseSpawnPrefsRequest(raw)).toEqual({ ok: false, error: "not-an-object" });
    }
    expect(parseSpawnPrefsRequest({ defaultModel: "x", extra: 1 })).toEqual({ ok: false, error: "schema" });
    expect(parseSpawnPrefsRequest({ defaultModel: 5 })).toEqual({ ok: false, error: "schema" });
    // non-empty values ride parseSpawnModelRef — same rejection vocabulary as the POST body
    expect(parseSpawnPrefsRequest({ defaultModel: "-x/y" })).toEqual({ ok: false, error: "model-invalid" });
    expect(parseSpawnPrefsRequest({ defaultModel: "anthropic/" })).toEqual({ ok: false, error: "model-invalid" });
    expect(parseSpawnPrefsRequest({ defaultModel: "a".repeat(600) })).toEqual({ ok: false, error: "model-invalid" });
    // "" = the explicit 「清空」 request — parses OK, the route maps it to null
    expect(parseSpawnPrefsRequest({ defaultModel: "" })).toEqual({ ok: true, body: { defaultModel: "" } });
    expect(parseSpawnPrefsRequest({ defaultModel: "vertex/claude@2024" })).toEqual({
      ok: true,
      body: { defaultModel: "vertex/claude@2024" },
    });
  });

  it("caps: SPAWN_MODEL_MAX_BYTES / SPAWN_PREFS_BODY_MAX", () => {
    expect(SPAWN_MODEL_MAX_BYTES).toBe(257); // 128 (provider) + 1 (/) + 128 (id)
    expect(SPAWN_PREFS_BODY_MAX).toBe(1024);
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
  it('SSE_EVENTS carries "spawns"; the four spawn error codes sit contiguously after upload\'s (tail order)', async () => {
    const { SSE_EVENTS, API_ERRORS } = await import("../../../src/web-hub/protocol/http-contract.js");
    expect(SSE_EVENTS).toContain("spawns");
    expect(SSE_EVENTS.at(-1)).toBe("spawns"); // 尾部追加，不打乱既有顺序
    // web-hub-preview PV1 又在 spawn 后面尾部追加了四个 E_PREVIEW_*，所以 spawn 的四个不再是
    // 数组末尾，但必须仍连续、仍按原顺序跟在 upload 六码之后（§2.3 只许尾部追加）
    const launcher = API_ERRORS.indexOf("E_LAUNCHER");
    expect(launcher).toBeGreaterThan(-1);
    expect(API_ERRORS.slice(launcher - 3, launcher + 1)).toEqual(["E_SPAWN_DENIED", "E_DIR", "E_LIMIT", "E_LAUNCHER"]);
  });

  it('SPAWN_HUB_CAP is "spawn.v1" (advertised only when config.spawn exists — SP10 wires it)', async () => {
    const { SPAWN_HUB_CAP } = await import("../../../src/web-hub/protocol/version.js");
    expect(SPAWN_HUB_CAP).toBe("spawn.v1");
  });
});

describe("web-hub-spawn-restore plan §10.1: restore constants + session coordinate validators", async () => {
  const m = await import("../../../src/web-hub/protocol/spawn.js");
  it("constants carry the plan's values (§14.2 ③: not settings)", () => {
    expect(m.RESTORE_MAX_ATTEMPTS).toBe(3);
    expect(m.RESTORE_STABLE_MS).toBe(120_000);
    expect(m.RESTORE_MIN_LIFETIME_MS).toBe(300_000);
    expect(m.RESTORE_TERM_WAIT_MS).toBe(3_000);
    expect(m.RESTORE_KILL_WAIT_MS).toBe(2_000);
    expect(m.RESTORE_POLL_MS).toBe(100);
    expect(m.RESTORE_CONCURRENCY).toBe(m.SPAWN_STARTING_MAX);
    expect(m.RESTORE_REGISTER_MAX_MS).toBe(240_000);
    expect(m.RESTORE_SESSION_FILE_MAX_BYTES).toBe(1024);
  });
  it("RESTORE_SESSION_ID_RE: alnum start, [A-Za-z0-9_-], ≤128 chars", () => {
    const re = m.RESTORE_SESSION_ID_RE;
    expect(re.test("019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(re.test("sess-fake-abc")).toBe(true);
    expect(re.test("a".repeat(128))).toBe(true);
    expect(re.test("a".repeat(129))).toBe(false);
    expect(re.test("-x")).toBe(false);
    expect(re.test("_x")).toBe(false);
    expect(re.test("")).toBe(false);
    expect(re.test("a/b")).toBe(false);
    expect(re.test("a.b")).toBe(false);
    expect(re.test("a b")).toBe(false);
  });
  it("isValidRestoreSessionFile: absolute, .jsonl, no NUL/newline, ≤1024 UTF-8 bytes", () => {
    const ok = m.isValidRestoreSessionFile;
    expect(ok("/home/u/.pi/agent/sessions/--p--/x.jsonl")).toBe(true);
    expect(ok("relative/x.jsonl")).toBe(false);
    expect(ok("/x.json")).toBe(false);
    expect(ok("/a\nb.jsonl")).toBe(false);
    expect(ok("/a\0b.jsonl")).toBe(false);
    expect(ok(`/${"a".repeat(1017)}.jsonl`)).toBe(true); // exactly 1024
    expect(ok(`/${"a".repeat(1018)}.jsonl`)).toBe(false); // 1025
    expect(ok(`/${"é".repeat(508)}.jsonl`)).toBe(true); // UTF-8 bytes: 1 + 1016 + 6 = 1023
    expect(ok(`/${"é".repeat(509)}.jsonl`)).toBe(false); // 1 + 1018 + 6 = 1025
  });
});

// ---------------------------------------------------------------------------
// web-hub session-history plan §3.3/§4.2: the `session` ref on POST /api/headless
// ---------------------------------------------------------------------------

describe("session-history plan §3.3: `session` ref on the POST body (parseSpawnRequestBody opts)", () => {
  const SID = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b"; // matches RESTORE_SESSION_ID_RE
  const session = { key: "d1/019a2b3c.jsonl", id: SID };

  it("no opts ⇒ EXACT pre-feature path: a `session` key is a schema violation, never parsed", () => {
    const raw = { ...body(), session };
    expect(Value.Check(SpawnRequestSchema, raw)).toBe(false);
    expect(Value.Check(SpawnRequestSchemaWithSession, raw)).toBe(true); // the new schema admits it
    expect(parseSpawnRequestBody(raw)).toEqual({ ok: false, error: "schema" });
    // opts.session !== true behaves the same as absent
    expect(parseSpawnRequestBody(raw, {})).toEqual({ ok: false, error: "schema" });
    expect(parseSpawnRequestBody(raw, { session: false })).toEqual({ ok: false, error: "schema" });
  });

  it("opts.session === true + valid ref ⇒ ok, decoded verbatim (mode optional, round-trips)", () => {
    const withMode = { ...body(), session: { ...session, mode: "resume" as const } };
    expect(parseSpawnRequestBody(withMode, { session: true })).toEqual({ ok: true, body: withMode });
    expect(parseSpawnRequestBody({ ...body(), session }, { session: true })).toEqual({
      ok: true,
      body: { ...body(), session },
    });
  });

  it("opts.session === true + NO session ⇒ ok and body.session stays undefined; model tri-state intact", () => {
    const r = parseSpawnRequestBody(body(), { session: true });
    expect(r.ok && r.body.session).toBeUndefined();
    // "" is still the explicit pi default (no session ⇒ no model-with-session conflict)
    expect(parseSpawnRequestBody(body({ model: "" }), { session: true })).toMatchObject({ ok: true });
    // a garbage model is still model-invalid (existing checks run before the session checks)
    expect(parseSpawnRequestBody(body({ model: "garbage" }), { session: true })).toEqual({
      ok: false,
      error: "model-invalid",
    });
  });

  it("session-ref: schema-valid key that fails isValidSessionKey", () => {
    for (const key of ["d1/bad", "a/b/c.jsonl", ".jsonl", "d1/.jsonl", "../x.jsonl", `${"d".repeat(256)}/x.jsonl`]) {
      expect(parseSpawnRequestBody({ ...body(), session: { ...session, key } }, { session: true })).toEqual({
        ok: false,
        error: "session-ref",
      });
    }
  });

  it('model-with-session: ANY model value incl. "" conflicts with a session (PD13)', () => {
    expect(parseSpawnRequestBody({ ...body(), session, model: "" }, { session: true })).toEqual({
      ok: false,
      error: "model-with-session",
    });
    expect(
      parseSpawnRequestBody({ ...body(), session, model: "anthropic/claude-sonnet-4" }, { session: true }),
    ).toEqual({ ok: false, error: "model-with-session" });
  });

  it("priority: session-ref outranks model-with-session (checked first)", () => {
    expect(
      parseSpawnRequestBody({ ...body(), session: { ...session, key: "d1/bad" }, model: "" }, { session: true }),
    ).toEqual({ ok: false, error: "session-ref" });
  });

  it("SessionRefSchema is strict: extra fields / bad id / bad mode / too-short key ⇒ schema", () => {
    const extra = { ...session, extra: 1 };
    expect(parseSpawnRequestBody({ ...body(), session: extra }, { session: true })).toEqual({
      ok: false,
      error: "schema",
    });
    expect(parseSpawnRequestBody({ ...body(), session: { ...session, id: "bad id!" } }, { session: true })).toEqual({
      ok: false,
      error: "schema",
    });
    expect(parseSpawnRequestBody({ ...body(), session: { ...session, mode: "clone" } }, { session: true })).toEqual({
      ok: false,
      error: "schema",
    });
    // minLength 3 prefilter (the exact shape is isValidSessionKey's job, reached as session-ref)
    expect(parseSpawnRequestBody({ ...body(), session: { ...session, key: "ab" } }, { session: true })).toEqual({
      ok: false,
      error: "schema",
    });
    expect(Value.Check(SessionRefSchema, session)).toBe(true);
  });

  it("SpawnRequestSchemaWithSession accepts every pre-feature body shape (superset, byte-identical otherwise)", () => {
    const minimal = body();
    const full = body({
      id: ID_64,
      confirm: true,
      expectCwd: "/home/u/proj",
      model: "",
      firstPrompt: { text: "first!", deliver: "followUp" },
    });
    expect(Value.Check(SpawnRequestSchemaWithSession, minimal)).toBe(true);
    expect(Value.Check(SpawnRequestSchemaWithSession, full)).toBe(true);
    expect(parseSpawnRequestBody(full, { session: true })).toEqual({ ok: true, body: full });
    // unknown fields still rejected at both levels
    expect(Value.Check(SpawnRequestSchemaWithSession, { ...full, force: true })).toBe(false);
  });

  it('SPAWN_HISTORY_HUB_CAP is "spawn.history.v1" (session-history plan PD1 — advertised only when config.spawn?.history === true)', async () => {
    const { SPAWN_HISTORY_HUB_CAP } = await import("../../../src/web-hub/protocol/version.js");
    expect(SPAWN_HISTORY_HUB_CAP).toBe("spawn.history.v1");
  });
});
