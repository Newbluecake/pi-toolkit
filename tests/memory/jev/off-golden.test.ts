/**
 * J0 off-golden suite（jev-plan §4 J0；arch §9.2「off 的证明」）。
 *
 * `UPDATE_JEV_OFF_GOLDEN=1` 且 golden 不存在时，本文件在**未改动的 dev** 上录制五种
 * off 配置（helpers/off-harness.ts `recordMemoryOff`）并写出 A′ golden
 * `tests/fixtures/memory/jev-off-golden.json` —— 此后**永不重生**（与 memory-legacy
 * golden 同一条 generate-once 规则；legacy-golden.test.ts:55-66 的先例）。
 *
 * 日常模式断言：
 *  - 四个「设置期 off」配置（disabled / legacy-layout / legacy-tool / secure-sim）：
 *    录制 = golden，**逐字节**（canonical 序列化后字符串相等）。
 *  - `pi-api`（设置开 + 运行时无 modelRegistry）：逐字段比对 + `PI_API_ALLOWED_DIFF`
 *    允许差异清单。dev 上它与 disabled 完全相同（wireMemory 尚不读 modelRegistry），
 *    清单为空 ⇒ 五个字段全部严格相等。J6/J7 合入后只允许往清单**追加** token：
 *
 *      registration:<entry-token>        jev 多注册的面（如 on:tool_call、
 *                                       renderer:subagent:memory-inject、
 *                                       section-register:<name>）
 *      tool-description:<tool>           memory 工具描述换成 MEMORY_TOOL_V2_TEXT_JEV
 *      pi-access:<prop>                  fake pi 上新增的属性读取
 *      command-line:<text>               /mem、/mem list 输出末尾多出的一行（如
 *                                       `jev: off (pi-api)`）
 *      completion:<value>                /mem 补全新增的条目（jev/tags/review/expired）
 *      tool-line:<text>                  工具输出/文件字节中新增的行（如
 *                                       `jev: not tagged (off: pi-api)`）
 *      reminder-line:<text>              启动提醒追加行
 *
 *    清单之外任何差异都让测试失败；每次追加必须在 commit message 写明理由（方案 §1.1）。
 *  - `render` / `doctor` / `tidyPrompt` 三个字段对 pi-api 同样逐字节（fixture 无行内
 *    注释、primary 已触发 D02，D17–D19 不会出现——jev-plan J0 第 4 条）。
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  OFF_CONFIG_NAMES,
  recordMemoryOff,
  type OffConfigName,
  type OffRecord,
  type RegistrationEntry,
  type ToolStepRecord,
} from "./helpers/off-harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, "..", "..", "fixtures", "memory", "jev-off-golden.json");
const UPDATE = process.env.UPDATE_JEV_OFF_GOLDEN === "1";
const GOLDEN_EXISTS = existsSync(GOLDEN_PATH);

/** 生成闸：UPDATE 且文件已存在 ⇒ 直接失败（generate-once，永不覆盖）。 */
export function assertGenerateOnceGate(update: boolean, goldenExists: boolean): void {
  if (update && goldenExists) {
    throw new Error(
      "UPDATE_JEV_OFF_GOLDEN=1 but tests/fixtures/memory/jev-off-golden.json already exists. " +
        "The jev off golden is generate-once, never overwrite (jev-plan §1.3: A′ 永不重生) — " +
        "regenerating would be a plan revision and needs root sign-off, not an env var.",
    );
  }
}

assertGenerateOnceGate(UPDATE, GOLDEN_EXISTS);

// ───────────────────────────── allowlist (pi-api) ─────────────────────────────

/** 允许差异清单（jev-plan J0 第 4 条：J0 写成空清单；只许追加，见文件头 token 语法）。 */
export const PI_API_ALLOWED_DIFF: readonly string[] = [
  // J6 (jev-plan §4 J6): memory jev hooks — registered once the settings say
  // on; under off(pi-api) every handler returns on its first line.
  "registration:on:before_agent_start",
  "registration:on:tool_call",
  "registration:on:tool_result",
  "registration:on:message_start",
  "registration:on:session_start",
  "registration:on:session_compact",
  "registration:on:turn_end",
  "registration:on:session_shutdown",
  "registration:registerMessageRenderer:subagent:memory-inject",
  // J4 command port in place ⇒ `/mem` description gains ` · /mem jev · /mem tags`.
  "registration:registerCommand:mem",
  // `/mem` / `/mem list` trailer status line under off(pi-api).
  "command-line:jev: off (pi-api)",
  // J4 completions that appear once the command port is passed in.
  "completion:jev",
  "completion:tags",
  // J8 completions (same port gate: only listed when the jev port is passed).
  "completion:review",
  "completion:expired",
  // J7 (jev-plan §4 J7): production wiring passes the J5 write port ⇒ the
  // memory tool description swaps to MEMORY_TOOL_V2_TEXT_JEV (schema
  // unchanged, arch §9.3).
  "tool-description:memory",
  // J5 write echo under off(pi-api) (registry absent ⇒ no tagging call).
  "tool-line:jev: not tagged (off: pi-api)",
];

function hasToken(prefix: string, value?: string): boolean {
  const token = value === undefined ? prefix : `${prefix}:${value}`;
  return PI_API_ALLOWED_DIFF.includes(token);
}

// ───────────────────────────── golden load/save ─────────────────────────────

interface GoldenFile {
  baseline: string;
  cases: Record<OffConfigName, OffRecord>;
}

function gitHead(): string {
  return execSync("git rev-parse HEAD", { cwd: HERE, encoding: "utf8" }).trim();
}

const loadedGolden: GoldenFile | undefined = UPDATE
  ? undefined
  : (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile);
const cases: Record<string, OffRecord> = UPDATE ? {} : (loadedGolden?.cases ?? {});

/** canonical（递归键排序）+ JSON round-trip，掩掉 undefined 键（同 legacy-golden）。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function serialized(value: unknown): string {
  return JSON.stringify(canonical(JSON.parse(JSON.stringify(value))));
}

function goldenCase(name: OffConfigName): OffRecord {
  const rec = cases[name];
  if (rec === undefined) throw new Error(`golden case missing: ${name}`);
  return rec;
}

afterAll(() => {
  if (!UPDATE) return;
  if (execSync("git status --porcelain -- src package.json", { cwd: HERE, encoding: "utf8" }).trim() !== "") {
    throw new Error(
      "UPDATE_JEV_OFF_GOLDEN=1 requires an untouched src/ and package.json (golden must be generated on unmodified dev).",
    );
  }
  const output: GoldenFile = { baseline: gitHead(), cases: cases as Record<OffConfigName, OffRecord> };
  const text = JSON.stringify(output, null, 2) + "\n";
  if (text.includes("<!-- mem")) throw new Error("golden must not contain inline `<!-- mem` comments");
  writeFileSync(GOLDEN_PATH, text);
});

// ───────────────────────────── comparators (pi-api) ─────────────────────────────

function entryToken(e: RegistrationEntry): string | undefined {
  switch (e.kind) {
    case "on":
      return `on:${e.event}`;
    case "registerTool":
      return `registerTool:${e.name}`;
    case "registerCommand":
      return `registerCommand:${e.name}`;
    case "registerMessageRenderer":
      return `registerMessageRenderer:${e.customType}`;
    case "registerEntryRenderer":
      return `registerEntryRenderer:${e.customType}`;
    case "registerMarkdownTransformer":
      return "registerMarkdownTransformer";
    case "registerShortcut":
      return `registerShortcut:${e.key}`;
    case "registerFlag":
      return `registerFlag:${e.name}`;
    case "section-register":
      return `section-register:${e.name}`;
    case "pi-access":
      return `pi-access:${e.prop}`;
  }
}

/** golden 必须是 actual 的子序列；actual 多出的项只能来自清单声明的 jev 注册。 */
function compareRegistrations(actualRaw: unknown, goldenRaw: unknown): void {
  const actual = actualRaw as RegistrationEntry[];
  const golden = goldenRaw as RegistrationEntry[];
  const problems: string[] = [];
  let ai = 0;
  const checkExtra = (a: RegistrationEntry): void => {
    const at = entryToken(a);
    if (!hasToken("registration", at)) problems.push(`unexpected extra registration: ${String(at)}`);
  };
  for (const g of golden) {
    const gt = entryToken(g)!;
    while (ai < actual.length && entryToken(actual[ai]!) !== gt) {
      checkExtra(actual[ai]!);
      ai += 1;
    }
    const a = actual[ai];
    if (a === undefined) {
      problems.push(`golden registration missing from actual: ${gt}`);
      continue;
    }
    ai += 1;
    if (a.kind === "registerTool" && g.kind === "registerTool") {
      // 同名工具：只允许清单声明的描述变体（MEMORY_TOOL_V2_TEXT_JEV）；其余字段逐字节。
      const restEqual = serialized({ ...a, description: g.description }) === serialized(g);
      if (!restEqual || (a.description !== g.description && !hasToken("tool-description", a.name))) {
        problems.push(`tool ${a.name} differs beyond the allowlist`);
      }
      continue;
    }
    if (serialized(a) !== serialized(g) && !hasToken("registration", gt)) {
      problems.push(`registration entry changed: ${gt}`);
    }
  }
  for (const a of actual.slice(ai)) checkExtra(a);
  expect(problems, problems.join("\n")).toEqual([]);
}

/** 文本 = golden，或 golden + 允许的追加行（command / reminder）。 */
function compareTextWithExtraLines(actual: string, golden: string, kind: "command-line" | "reminder-line"): void {
  if (actual === golden) return;
  const goldenLines = golden.split("\n");
  const actualLines = actual.split("\n");
  const prefix = actualLines.slice(0, goldenLines.length);
  if (serialized(prefix) !== serialized(goldenLines)) {
    expect(actual).toBe(golden);
    return;
  }
  for (const extra of actualLines.slice(goldenLines.length)) {
    if (!hasToken(kind, extra)) {
      expect(actual).toBe(golden);
      return;
    }
  }
}

/** 删掉清单允许的新增行后必须与 golden 相等（tool 输出与文件字节）。 */
function stripAllowedLines(text: string, kind: "tool-line"): string {
  return text
    .split("\n")
    .filter((line) => !PI_API_ALLOWED_DIFF.includes(`${kind}:${line}`))
    .join("\n");
}

function compareToolStep(actual: ToolStepRecord, golden: ToolStepRecord): void {
  expect(actual.step).toBe(golden.step);
  const aOut = actual.output === undefined ? undefined : stripAllowedLines(actual.output, "tool-line");
  const gOut = golden.output === undefined ? undefined : golden.output;
  expect(aOut, `tool step ${actual.step} output`).toBe(gOut);
  expect(actual.error, `tool step ${actual.step} error`).toBe(golden.error);
  expect(serialized(actual.trash), `tool step ${actual.step} trash`).toBe(serialized(golden.trash));
  const fileNames = [...new Set([...Object.keys(actual.files), ...Object.keys(golden.files)])].sort();
  for (const name of fileNames) {
    expect(
      actual.files[name] === undefined ? undefined : stripAllowedLines(actual.files[name]!, "tool-line"),
      `tool step ${actual.step} file ${name}`,
    ).toBe(golden.files[name]);
  }
}

// ───────────────────────────── cases ─────────────────────────────

const SETTINGS_OFF_CONFIGS: readonly OffConfigName[] = ["disabled", "legacy-layout", "legacy-tool", "secure-sim"];

async function record(name: OffConfigName): Promise<OffRecord> {
  const rec = await recordMemoryOff(name);
  if (UPDATE) cases[name] = JSON.parse(JSON.stringify(rec)) as OffRecord;
  return rec;
}

describe("jev off golden (A′, jev-plan J0)", () => {
  for (const name of SETTINGS_OFF_CONFIGS) {
    it(`${name}: recording is byte-identical to the golden`, async () => {
      const rec = await record(name);
      expect(serialized(rec)).toBe(serialized(goldenCase(name)));
    });
  }

  it("golden covers exactly the five off configs and carries a dev baseline", () => {
    if (!UPDATE) {
      expect([...OFF_CONFIG_NAMES].sort()).toEqual(Object.keys(cases).sort());
      expect(loadedGolden?.baseline).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("golden contains no inline `<!-- mem` comments and no machine paths", () => {
    // 掩码后的 golden 不应出现 tmp 根（/tmp/…）或原始 updated ISO 戳。
    const text = UPDATE ? JSON.stringify(cases) : readFileSync(GOLDEN_PATH, "utf8");
    expect(text.includes("<!-- mem")).toBe(false);
    expect(text).not.toMatch(/updated: \d{4}-\d{2}-\d{2}T[0-9:.]+Z/);
  });

  it("pi-api: field-by-field comparison against the golden (PI_API_ALLOWED_DIFF is empty on dev)", async () => {
    const actual = await record("pi-api");
    const golden = goldenCase("pi-api");
    // render / doctor / tidyPrompt：逐字节（方案 J0 第 4 条）。
    expect(serialized(actual.render)).toBe(serialized(golden.render));
    expect(serialized(actual.doctor)).toBe(serialized(golden.doctor));
    expect(actual.tidyPrompt).toBe(golden.tidyPrompt);
    // registrations：子序列 + 允许差异清单。
    compareRegistrations(actual.registrations, golden.registrations);
    // command：notify 文本只允许声明过的追加行；补全只允许声明过的新条目。
    expect(actual.command.notifications.length).toBe(golden.command.notifications.length);
    for (let i = 0; i < golden.command.notifications.length; i++) {
      const a = actual.command.notifications[i]!;
      const g = golden.command.notifications[i]!;
      expect(a.sub).toBe(g.sub);
      expect(a.level).toBe(g.level);
      compareTextWithExtraLines(a.message, g.message, "command-line");
    }
    const gCompletions = golden.command.completions as Record<string, unknown>;
    const aCompletions = actual.command.completions as Record<string, unknown>;
    for (const key of Object.keys(gCompletions)) {
      const gList = Array.isArray(gCompletions[key]) ? (gCompletions[key] as unknown[]) : gCompletions[key];
      const aList = Array.isArray(aCompletions[key]) ? (aCompletions[key] as unknown[]) : aCompletions[key];
      if (!Array.isArray(gList) || !Array.isArray(aList)) {
        expect(serialized(aList)).toBe(serialized(gList));
        continue;
      }
      // golden 条目按序保留于 actual；多出的条目必须在清单里声明。
      let gi = 0;
      for (const item of aList) {
        if (gi < gList.length && serialized(item) === serialized(gList[gi])) {
          gi += 1;
          continue;
        }
        const value = (item as { value?: string }).value;
        if (!hasToken("completion", typeof value === "string" ? value : serialized(item))) {
          expect(serialized(aList), `completion extra for "${key}"`).toBe(serialized(gList));
        }
      }
      if (gi !== gList.length) expect(serialized(aList), `completion lost items for "${key}"`).toBe(serialized(gList));
    }
    // tool / reminder：只允许确定性部件的声明差异。
    expect(actual.tool.surface).toBe(golden.tool.surface);
    expect(actual.tool.steps.length).toBe(golden.tool.steps.length);
    for (let i = 0; i < golden.tool.steps.length; i++) {
      compareToolStep(actual.tool.steps[i]!, golden.tool.steps[i]!);
    }
    expect(actual.reminder.notifications.length).toBeLessThanOrEqual(golden.reminder.notifications.length + 5);
    // reminder 的每条 golden 通知必须在 actual 中出现（顺序保持），新行需声明。
    let ri = 0;
    for (const note of actual.reminder.notifications) {
      if (ri < golden.reminder.notifications.length && note === golden.reminder.notifications[ri]) {
        ri += 1;
        continue;
      }
      if (!hasToken("reminder-line", note)) {
        expect(serialized(actual.reminder.notifications)).toBe(serialized(golden.reminder.notifications));
      }
    }
    expect(ri).toBe(golden.reminder.notifications.length);
    // dev 断言：pi-api 与 disabled 逐字段相同（wireMemory 尚不读 modelRegistry）。
    // J6 起由 PI_API_ALLOWED_DIFF 白名单比对取代（上面逐 token 校验，未登记的差异即失败）。
    const disabled = cases["disabled"] ?? (await recordMemoryOff("disabled"));
    if (PI_API_ALLOWED_DIFF.length === 0) expect(serialized(actual)).toBe(serialized(disabled));
  });

  it("generation gate refuses to overwrite an existing golden", () => {
    expect(() => assertGenerateOnceGate(true, true)).toThrow(/never overwrite/);
    expect(() => assertGenerateOnceGate(true, false)).not.toThrow();
    expect(() => assertGenerateOnceGate(false, true)).not.toThrow();
  });
});
