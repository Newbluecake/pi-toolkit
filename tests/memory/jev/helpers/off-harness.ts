/**
 * J0 off-golden harness（jev-plan §4 J0 第 4 条；arch §9.2「off 的证明」）。
 *
 * 在**未接线 jev 的当前 dev** 上，把 `wireMemory` 的全部可观察面（注册序列、注入渲染、
 * 工具脚本、/mem 命令与补全、doctor、启动提醒）录成一份 `OffRecord`。
 * J0 用它在 dev 上生成 A′ golden `tests/fixtures/memory/jev-off-golden.json`；J6/J7 合入后
 * 用同一份 harness 重放五种 off 配置，前四种必须与 golden 逐字节相等，`pi-api` 走
 * 逐字段比对 + `PI_API_ALLOWED_DIFF`（off-golden.test.ts 导出，J0 为空）。
 *
 * 设计约束（照 legacy-golden.test.ts 的确定性协议，§10.1）：
 *  1. 每次录制一个全新的 mkdtemp 根（fixtures 经 tests/memory/helpers/fixture-dir.ts
 *     物化，mtime 固定）；HOME / ARMORY_MEMORY_ROOT 防御性 stub 到 tmp。
 *  2. `vi.useFakeTimers({toFake:["Date"]})` 钉死到 FIXED_NOW —— `updated:` 戳、doctor
 *     的 staleDays 比较、view 页脚的 doctor 摘要全部确定。录制结束后恢复真实时钟。
 *  3. 一切落盘字符串先经 `mask`（tmp 根 → `${MEMROOT}`、`updated:` ISO → `<DATE>`、
 *     trash id → `<TRASHID>`），golden 不含机器相关路径。
 *  4. 进程级 `pi-subagent:memory-doctor-reminders` 表在录制 reminder 前清空 —— 它按
 *     cwd 去重，五个配置共用 FIXTURE_CWD，不清空会互相吞掉通知（这是 harness 唯一
 *     触碰的进程级状态；与 wireMemory 自身的闭包状态无关）。
 *
 * fake pi（`recordingPi()`）镜像 pi loader 的注册语义（`on()` 追加、所有 handler 保留），
 * 并把每次注册按调用顺序写进 `log`；未实现属性的被读取也会记一条 `{kind:"pi-access"}`
 * （J6 之后 jev 若调用了 fake 没实现的面，golden 立刻显形，堵「漏录某个注册面」的洞）。
 * `fakeHub()` 同理记录 `sections.register` 的名字，并保留 registration 供 render 重放。
 *
 * 该文件只被测试使用；不得 import 任何生产模块的可变单例。
 */

import { readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SKIP } from "../../../../src/prompt-sections/stable-section.js";
import { parseMemorySettings } from "../../../../src/memory/settings.js";
import { wireMemory } from "../../../../src/memory/index.js";
import type { SectionRegistration } from "../../../../src/sysprompt/hub.js";
import { canonicalJson } from "../../../../src/memory/tool-surface.js";
import { collectDoctorFindings } from "../../../../src/memory/doctor-command.js";
import { formatDoctorReport, type DoctorFinding } from "../../../../src/memory/doctor.js";
import {
  materializeEmptyFixture,
  materializeFixture,
  FIXTURE_CWD,
  type MaterializedFixture,
} from "../../helpers/fixture-dir.js";

/** 五种 off 配置（jev-plan J0 第 4 条）。 */
export type OffConfigName = "disabled" | "legacy-layout" | "legacy-tool" | "secure-sim" | "pi-api";

export const OFF_CONFIG_NAMES: readonly OffConfigName[] = [
  "disabled",
  "legacy-layout",
  "legacy-tool",
  "secure-sim",
  "pi-api",
];

/** 录制用的固定时钟（doctor staleDays、`updated:` 户口的基准）。 */
export const FIXED_NOW_ISO = "2026-10-30T08:00:00.000Z";

// ───────────────────────────── recording fake pi ─────────────────────────────

/** 有序注册日志的一条。工具只记 name/label/描述/promptSnippet/promptGuidelines +
 *  `canonicalJson(parameters)`（schema 键序敏感，见 tool-surface.ts）。 */
export type RegistrationEntry =
  | { kind: "on"; event: string }
  | {
      kind: "registerTool";
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: string;
    }
  | { kind: "registerCommand"; name: string; description: string }
  | { kind: "registerMessageRenderer"; customType: string }
  | { kind: "registerEntryRenderer"; customType: string }
  | { kind: "registerMarkdownTransformer" }
  | { kind: "registerShortcut"; key: string }
  | { kind: "registerFlag"; name: string }
  | { kind: "section-register"; name: string }
  | { kind: "pi-access"; prop: string };

export interface RecordingLog {
  entries: RegistrationEntry[];
}

type Handler = (event: never, ctx: never) => unknown;

/** 镜像 pi loader 注册语义的 fake `ExtensionAPI`。
 *
 * `opts.omitModelRegistry` 目前恒为真：fake 从不暴露 `modelRegistry`（dev 上没有任何
 * 代码读它；`pi-api` 配置正是「fake pi 与 fake ctx 都没有 modelRegistry」）。 */
export function recordingPi(log: RecordingLog): ExtensionAPI {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<
    string,
    { execute: (id: string, params: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<unknown> }
  >();
  const commands = new Map<
    string,
    {
      description: string;
      getArgumentCompletions?: (p: string) => unknown;
      handler: (args: string, ctx: unknown) => Promise<void>;
    }
  >();

  const base: Record<string, unknown> = {
    on: (event: string, handler: Handler) => {
      log.entries.push({ kind: "on", event });
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    registerTool: (def: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute: (id: string, params: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<unknown>;
    }) => {
      log.entries.push({
        kind: "registerTool",
        name: def.name,
        label: def.label,
        description: def.description,
        ...(def.promptSnippet === undefined ? {} : { promptSnippet: def.promptSnippet }),
        ...(def.promptGuidelines === undefined ? {} : { promptGuidelines: def.promptGuidelines }),
        parameters: canonicalJson(def.parameters),
      });
      tools.set(def.name, def);
    },
    registerCommand: (
      name: string,
      options: {
        description: string;
        getArgumentCompletions?: (p: string) => unknown;
        handler: (args: string, ctx: unknown) => Promise<void>;
      },
    ) => {
      log.entries.push({ kind: "registerCommand", name, description: options.description });
      commands.set(name, options);
    },
    registerMessageRenderer: (customType: string) => {
      log.entries.push({ kind: "registerMessageRenderer", customType });
    },
    registerEntryRenderer: (customType: string) => {
      log.entries.push({ kind: "registerEntryRenderer", customType });
    },
    registerMarkdownTransformer: () => {
      log.entries.push({ kind: "registerMarkdownTransformer" });
    },
    registerShortcut: (key: string) => {
      log.entries.push({ kind: "registerShortcut", key });
    },
    registerFlag: (name: string) => {
      log.entries.push({ kind: "registerFlag", name });
    },
    sendMessage: () => {
      /* memory off 路径从不 sendMessage；出现即由 pi-access/行为差异暴露 */
    },
    appendEntry: () => {
      /* 同上 */
    },
    getActiveTools: () => ["read", "bash", "edit", "write", "memory"],
    setActiveTools: () => {},
  };
  // Proxy 只记录「fake 未实现」的属性读取（含 typeof 探测），防漏录注册面。
  const pi = new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      log.entries.push({ kind: "pi-access", prop });
      return undefined;
    },
  });
  // 把内部容器挂到 base 上（测试/harness 取工具与命令用；不进注册日志）。
  Object.assign(base, {
    __handlers: handlers,
    __tools: tools,
    __commands: commands,
  });
  return pi as unknown as ExtensionAPI;
}

/** 从 recordingPi 取回内部容器（仅 harness/测试用）。 */
export function recordingPiInternals(pi: ExtensionAPI): {
  handlers: Map<string, Handler[]>;
  tools: Map<
    string,
    { name: string; execute: (id: string, params: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<unknown> }
  >;
  commands: Map<
    string,
    {
      description: string;
      getArgumentCompletions?: (p: string) => unknown;
      handler: (args: string, ctx: unknown) => Promise<void>;
    }
  >;
} {
  const inner = pi as unknown as {
    __handlers: Map<string, Handler[]>;
    __tools: Map<
      string,
      { name: string; execute: (id: string, params: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<unknown> }
    >;
    __commands: Map<
      string,
      {
        description: string;
        getArgumentCompletions?: (p: string) => unknown;
        handler: (args: string, ctx: unknown) => Promise<void>;
      }
    >;
  };
  return { handlers: inner.__handlers, tools: inner.__tools, commands: inner.__commands };
}

/** 记录 `sections.register` 的最小 hub。名字重复即抛（与真 hub 一致，抓重复注册 bug）。 */
export function fakeHub(log: RecordingLog): {
  register: (name: string, registration: SectionRegistration) => void;
  registrations: Map<string, SectionRegistration>;
  _state: () => undefined;
  _captured: () => undefined;
} {
  const registrations = new Map<string, SectionRegistration>();
  return {
    register: (name, registration) => {
      if (registrations.has(name)) throw new Error(`duplicate prompt section registration: ${name}`);
      log.entries.push({ kind: "section-register", name });
      registrations.set(name, registration);
    },
    registrations,
    _state: () => undefined,
    _captured: () => undefined,
  };
}

// ───────────────────────────── masking ─────────────────────────────

const TRASH_ID_RE = /\d{8}T\d{6}(?:\d{3})?Z-\d+-[a-z0-9]{4,12}/g;
const UPDATED_ISO_RE = /updated: \d{4}-\d{2}-\d{2}T[0-9:.]+Z/g;

/** 掩码：tmp 根 → `${MEMROOT}`；`updated:` ISO → `<DATE>`；trash id → `<TRASHID>`。 */
export function maskText(text: string, roots: readonly string[]): string {
  let out = text;
  for (const r of roots) out = out.split(r).join("${MEMROOT}");
  out = out.replace(UPDATED_ISO_RE, "updated: <DATE>");
  out = out.replace(TRASH_ID_RE, "<TRASHID>");
  return out;
}

export function maskDeep(value: unknown, roots: readonly string[]): unknown {
  if (typeof value === "string") return maskText(value, roots);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, roots));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, roots);
    return out;
  }
  return value;
}

// ───────────────────────────── OffRecord ─────────────────────────────

export interface ToolStepRecord {
  step: string;
  /** 工具输出文本（content[0].text）；抛错时 undefined 且 error 有值。 */
  output?: string;
  error?: string;
  /** 该步之后记忆目录全部 *.md 的字节（已掩码）+ .trash 文件名（已掩码）。 */
  files: Record<string, string>;
  trash: readonly string[];
}

export interface CommandNotificationRecord {
  sub: string;
  level: string;
  message: string;
}

/** 一份 off 配置的可观察面快照（jev-plan J0 第 4 条的七类字段）。 */
export interface OffRecord {
  registrations: readonly RegistrationEntry[];
  render: {
    current5: { main: string; child: string };
    syntheticCore: { main: string; child: string };
  };
  tool: { surface: "v2" | "legacy"; steps: readonly ToolStepRecord[] };
  command: {
    notifications: readonly CommandNotificationRecord[];
    completions: Record<string, unknown>;
  };
  doctor: {
    findings: readonly { id: string; severity: string; file?: string; line?: number; message: string; fix?: string }[];
    report: string;
  };
  reminder: { notifications: readonly string[] };
}

// ───────────────────────────── fixtures / ctx ─────────────────────────────

function fakeCtx(cwd: string, extra: Record<string, unknown> = {}): ExtensionContext {
  return { cwd, mode: "rpc", hasUI: false, ...extra } as unknown as ExtensionContext;
}

function uiCtx(cwd: string, sessionId: string): { ctx: ExtensionContext; notifications: CommandNotificationRecord[] } {
  const notifications: CommandNotificationRecord[] = [];
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level: level ?? "info" }),
    },
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

/** provider 输出序列化：SKIP sentinel → "<SKIP>"（golden 只存 JSON 值）。 */
function providerOut(v: unknown): string {
  if (v === SKIP) return "<SKIP>";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Files the tool script writes get the REAL mtime (fake timers only fake
 *  `Date`), and the legacy `list` prints each file's mtime date — pin any file
 *  newer than FIXED_NOW back to FIXED_NOW after every step so the recording
 *  does not depend on the wall-clock day. Fixture files (2026-09) are older
 *  and stay untouched. */
function pinWrittenMtimes(fx: MaterializedFixture): void {
  const fixed = new Date(FIXED_NOW_ISO).getTime();
  try {
    for (const name of readdirSync(fx.memDir)) {
      if (!name.endsWith(".md")) continue;
      const path = join(fx.memDir, name);
      try {
        if (statSync(path).mtimeMs > fixed) utimesSync(path, fixed / 1000, fixed / 1000);
      } catch {
        /* raced */
      }
    }
  } catch {
    /* no dir yet */
  }
}

function snapshotDir(fx: MaterializedFixture): { files: Record<string, string>; trash: readonly string[] } {
  const files: Record<string, string> = {};
  const trash: string[] = [];
  const root = fx.paths.memoryRoot;
  const slugDir = fx.memDir;
  try {
    for (const name of readdirSync(slugDir).sort()) {
      if (name === ".trash") {
        try {
          for (const t of readdirSync(join(slugDir, ".trash")).sort()) trash.push(maskText(t, [root]));
        } catch {
          /* raced */
        }
        continue;
      }
      if (!name.endsWith(".md")) continue;
      try {
        files[name] = maskText(readFileSync(join(slugDir, name), "utf8"), [root]);
      } catch {
        files[name] = "<unreadable>";
      }
    }
  } catch {
    /* dir gone */
  }
  return { files, trash };
}

// ───────────────────────────── tool scripts ─────────────────────────────

const V2_STEPS: readonly { step: string; params: Record<string, unknown> }[] = [
  { step: "view-dir", params: { command: "view" } },
  {
    step: "create-core",
    params: {
      command: "create",
      path: "core.md",
      file_text: "# Core\n\nIntro line.\n\n## Rules\n\n- long commands need timeout\n- never git add -A\n",
    },
  },
  { step: "view-core", params: { command: "view", path: "core.md" } },
  { step: "view-core-section", params: { command: "view", path: "core.md", section: "Rules" } },
  {
    step: "str-replace",
    params: { command: "str_replace", path: "core.md", old_str: "Intro line.", new_str: "Intro (edited)." },
  },
  {
    step: "insert-section",
    params: { command: "insert", path: "core.md", section: "Rules", insert_text: "- commit only exact paths" },
  },
  { step: "append-alias", params: { action: "append", name: "core.md", content: "Tail line via legacy append." } },
  { step: "write-alias", params: { action: "write", name: "notes.md", content: "# Notes\n\n- note one\n" } },
  { step: "search", params: { command: "search", query: "timeout" } },
  { step: "rename", params: { command: "rename", old_path: "notes.md", new_path: "decisions.md" } },
  { step: "delete", params: { command: "delete", path: "decisions.md" } },
  { step: "view-dir-final", params: { command: "view" } },
];

const LEGACY_STEPS: readonly { step: string; params: Record<string, unknown> }[] = [
  { step: "list", params: { action: "list" } },
  { step: "write-core", params: { action: "write", name: "core.md", content: "# Core\n\n- rule one\n" } },
  { step: "list-after-write", params: { action: "list" } },
  { step: "append", params: { action: "append", name: "core.md", content: "tail line" } },
  { step: "list-final", params: { action: "list" } },
];

async function runToolScript(
  pi: ExtensionAPI,
  fx: MaterializedFixture,
  surface: "v2" | "legacy",
): Promise<readonly ToolStepRecord[]> {
  const { tools } = recordingPiInternals(pi);
  const tool = tools.get("memory");
  if (!tool) throw new Error("memory tool not registered");
  const steps = surface === "v2" ? V2_STEPS : LEGACY_STEPS;
  const out: ToolStepRecord[] = [];
  let call = 0;
  for (const step of steps) {
    call += 1;
    let output: string | undefined;
    let error: string | undefined;
    try {
      const result = (await tool.execute(`t${String(call)}`, step.params, undefined, undefined, fakeCtx(fx.cwd))) as {
        content: { type: string; text: string }[];
      };
      output = result.content.map((c) => c.text).join("\n");
    } catch (err) {
      error = (err as Error).message;
    }
    pinWrittenMtimes(fx);
    out.push({
      step: step.step,
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      ...snapshotDir(fx),
    });
  }
  return out;
}

// ───────────────────────────── main entry ─────────────────────────────

function settingsFor(config: OffConfigName) {
  switch (config) {
    case "disabled":
      // jev 键在 dev 上是未知键（被 parseMemorySettings 丢弃）—— 正是要钉住的行为。
      // #36 D-3（plan §3 jev-off-golden 行，评审 M13）：默认布局将改为 blocks，
      // 四个依赖默认布局的配置显式钉 layout:"tiered"，golden 字节因此不随默认值
      // 翻转而变；legacy-layout 配置保持 layout:"legacy" 原值。今天默认仍是
      // tiered，显式钉不改变录制结果（golden 未重生）。
      return parseMemorySettings({ layout: "tiered", jev: { enabled: false } });
    case "legacy-layout":
      return parseMemorySettings({ layout: "legacy", jev: { enabled: true } });
    case "legacy-tool":
      return parseMemorySettings({ layout: "tiered", toolSurface: "legacy", jev: { enabled: true } });
    case "secure-sim":
    case "pi-api":
      return parseMemorySettings({ layout: "tiered", jev: { enabled: true } });
  }
}

/** 录制一种 off 配置的完整 OffRecord。自含时钟/环境隔离（见文件头）。 */
export async function recordMemoryOff(config: OffConfigName): Promise<OffRecord> {
  const envTmp = mkdtempSync(join(tmpdir(), "jev-off-env-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_NOW_ISO));
  // reminder 的进程级去重表按 cwd 键控，五个配置共用 FIXTURE_CWD —— 清空保证互不干扰。
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:memory-doctor-reminders")] = new Map();
  const fixtures: MaterializedFixture[] = [];
  // wireMemory 不传 paths（与生产一致），一切目录解析走 defaultPaths() —— 它
  // 在**调用时**读 ARMORY_MEMORY_ROOT（paths.ts，无 memoization），所以在每个
  // 片段前把 stub 指到对应 fixture 的 root，即得逐 fixture 隔离的目录。
  const useFixtureRoot = (fx: MaterializedFixture): void => vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
  try {
    const settings = settingsFor(config);
    const wireOpts = (sections: ReturnType<typeof fakeHub>, isChildSession: boolean) =>
      ({
        settings,
        isChildSession,
        sections,
        // secure-sim：dev 上多传的键被忽略；J6 之后生效（jev-plan J0 第 4 条）。
        ...(config === "secure-sim" ? { secureDomainKind: "secure" } : {}),
      }) as Parameters<typeof wireMemory>[1];

    // ── registrations（主会话接线）──
    const log: RecordingLog = { entries: [] };
    const pi = recordingPi(log);
    const hub = fakeHub(log);
    wireMemory(pi, wireOpts(hub, false));

    // ── render（current-5 + synthetic core，主/子会话）──
    // 主会话 provider 直接取自上面 hub 里的 registration；子会话需要独立接线
    // （isChildSession 在 wire 时烘焙进 memorySection），不记录其注册。
    const current5 = materializeFixture("current-5");
    const synthetic = materializeFixture("synthetic/extra-pinned");
    fixtures.push(current5, synthetic);
    const childLog: RecordingLog = { entries: [] };
    const childPi = recordingPi(childLog);
    const childHub = fakeHub(childLog);
    wireMemory(childPi, wireOpts(childHub, true));
    const mainSection = hub.registrations.get("pi_project_memory");
    const childSection = childHub.registrations.get("pi_project_memory");
    if (!mainSection || !childSection) throw new Error("pi_project_memory section not registered");
    const renderOne = (section: SectionRegistration, fx: MaterializedFixture): string => {
      useFixtureRoot(fx);
      return providerOut(
        section.provider({
          ctx: fakeCtx(fx.cwd, { sessionManager: { getSessionId: () => "golden-session" } }),
          promptText: "",
          optionsCwd: fx.cwd,
        }),
      );
    };
    const render = {
      current5: { main: renderOne(mainSection, current5), child: renderOne(childSection, current5) },
      syntheticCore: { main: renderOne(mainSection, synthetic), child: renderOne(childSection, synthetic) },
    };

    // ── tool（固定脚本；legacy surface 用 legacy 脚本）──
    const toolFx = materializeEmptyFixture();
    fixtures.push(toolFx);
    const surface: "v2" | "legacy" = settings.toolSurface === "legacy" ? "legacy" : "v2";
    useFixtureRoot(toolFx);
    const toolSteps = await runToolScript(pi, toolFx, surface);

    // ── command（/mem 系列 + 补全）──
    const cmdFx = materializeFixture("current-5");
    fixtures.push(cmdFx);
    useFixtureRoot(cmdFx);
    const { commands } = recordingPiInternals(pi);
    const mem = commands.get("mem");
    if (!mem) throw new Error("/mem command not registered");
    const notifications: CommandNotificationRecord[] = [];
    for (const sub of ["", "list", "doctor", "path"]) {
      const { ctx, notifications: notes } = uiCtx(cmdFx.cwd, "golden-session");
      await mem.handler(sub, ctx);
      for (const n of notes)
        notifications.push({ sub: sub === "" ? "(default)" : sub, level: n.level, message: n.message });
    }
    const completions: Record<string, unknown> = {};
    for (const prefix of ["", "t", "restore ", "j", "r"]) {
      completions[prefix === "" ? "(empty)" : prefix] = mem.getArgumentCompletions?.(prefix) ?? null;
    }

    // ── doctor（collectDoctorFindings + formatDoctorReport）──
    useFixtureRoot(cmdFx);
    const findings = collectDoctorFindings(cmdFx.cwd, cmdFx.paths, settings);
    const serializeFinding = (f: DoctorFinding) => ({
      id: f.id,
      severity: f.severity,
      ...(f.file === undefined ? {} : { file: f.file }),
      ...(f.line === undefined ? {} : { line: f.line }),
      message: f.message,
      ...(f.fix === undefined ? {} : { fix: f.fix }),
    });

    // ── reminder（session_start，主会话 + hasUI）──
    const reminderLog: RecordingLog = { entries: [] };
    const reminderPi = recordingPi(reminderLog);
    const reminderHub = fakeHub(reminderLog);
    wireMemory(reminderPi, wireOpts(reminderHub, false));
    useFixtureRoot(cmdFx);
    const reminderCtx = uiCtx(cmdFx.cwd, "golden-session-reminder");
    const reminderNotes: string[] = [];
    const handlerLists = recordingPiInternals(reminderPi).handlers.get("session_start") ?? [];
    for (const h of handlerLists) {
      await h(
        { type: "session_start", reason: "new" } as never,
        {
          ...reminderCtx.ctx,
          ui: { notify: (m: string) => reminderNotes.push(m) },
        } as never,
      );
    }

    const roots = [envTmp, ...new Set(fixtures.map((f) => f.paths.memoryRoot))];
    const masked = maskDeep(
      {
        registrations: log.entries,
        render,
        tool: { surface, steps: toolSteps },
        command: { notifications, completions },
        doctor: { findings: findings.map(serializeFinding), report: formatDoctorReport(findings) },
        reminder: { notifications: reminderNotes },
      },
      roots,
    ) as OffRecord;
    return masked;
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const f of fixtures) f.cleanup();
    rmSync(envTmp, { recursive: true, force: true });
  }
}
