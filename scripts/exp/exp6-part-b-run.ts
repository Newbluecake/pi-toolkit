#!/usr/bin/env node
/**
 * Experiment 6 Part B — one consult run (README §3). FULL vs TRIM(T1) on a
 * forked copy of a real expert session, read-only tools, extensions off.
 *
 *   npx tsx scripts/exp/exp6-part-b-run.ts <expert> <arm> <rep>
 *     expert: edoc1|edoc2|edoc3|ec1|ec2   arm: FULL|TRIM   rep: 1..3
 *   npx tsx scripts/exp/exp6-part-b-run.ts --setup     # rebuild /tmp/exp5-repo + /tmp/.p5x, verify
 *   npx tsx scripts/exp/exp6-part-b-run.ts --spent     # print cumulative spend
 *
 * Result JSON → /tmp/exp6-runs/<expert>-<arm>-r<rep>.json. The fork copy lives
 * in /tmp/exp6-forks and is deleted after the run; the source session's
 * sha256 is checked before/after.
 */
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { buildConsultPrompt } from "../../src/consult/prompt.js";
import { OPUS, calibrate, loadContext, planTrim, applyToJsonl, type AnyMsg } from "./exp6-lib.js";

const REPO = "/home/bluecake/ai/pi-toolkit";
const RUNS = "/tmp/exp6-runs";
const FORKS = "/tmp/exp6-forks";
const BUDGET_USD = 25;
const SAFETY_TURNS = 8;
const SAFETY_MS = 600_000;
const PROD_MS = 150_000;
const PROD_TURNS = 3;
const READONLY = ["read", "grep", "find", "ls"];
const TRIM_NOTE =
  "Note: some earlier large tool outputs in your history were elided to placeholders; before citing their exact content, re-read the file with the read tool.";
const S = join(homedir(), ".pi/agent/sessions");

function typeBody(path: string): string {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (m ? m[1]! : raw).trim();
}

function sectionBetween(file: string, start: string, end: string): string {
  const s = readFileSync(file, "utf8");
  const a = s.indexOf(start);
  const b = s.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`section not found in ${file}`);
  return s.slice(a + start.length, b).trim();
}

const EC_Q: Record<string, string> = {
  ec1: [
    "请按编号逐条回答（每条都要答）：",
    "1. mutator 包的 `Placement` 类型定义了哪几个取值？",
    "2. runner 给每个请求加的追踪 header 叫什么？值由哪个函数、怎么生成？",
    "3. 按 `docs/design.md`：L2 Sink 探针把命中上报到 ApiStrike 的哪个 API 端点？L3 OOB 的 DNS 监听端口是多少？",
    "4. 你列的 P0-1 是什么问题？定位在哪个文件哪一行？",
    "5. `SchemaMutator` 在生产链路里有没有被用到？依据是什么？",
  ].join("\n"),
  ec2: [
    "请按编号逐条回答（每条都要答）：",
    "1. 审计报告（docs/dev/scan-effectiveness-audit.md）里 P1-1 是什么问题？证据定位在哪些文件:行号？",
    "2. 你跑 `go test -count=1 -run 'Baseline' ./internal/detect/ ./internal/runner/ -v` 时，`internal/runner` 包通过了几个测试？该包耗时多少？",
    "3. `BaselineFeeder.FeedBaseline` 的方法签名是什么？单个基线请求 HTTP 失败时 `ensureBaseline` 怎么处理？",
    "4. 你的总体验收结论？有无 Blocker / Major？Minor 是什么？",
    "5. 真实 runner 集成测试里各检测器产出的 finding 数分别是多少？",
  ].join("\n"),
};

interface Expert {
  source: string;
  cutBeforeSecondUser: boolean;
  cwd: string;
  rewrite?: [string, string];
  model: [string, string];
  systemPrompt: () => string;
  question: () => string;
}

const EDOC_Q = () =>
  sectionBetween(join(REPO, "docs/dev/fabric-v2/exp5/consult-qa.md"), "## e1-r1 — Q", "## e1-r1 — A");
const EDOC_SP = () => typeBody(join(REPO, "docs/dev/fabric-v2/exp5/upstream-analyst.md"));
const EXPERTS: Record<string, Expert> = {
  edoc1: {
    source: `${S}/--tmp-exp5-repo--/2026-09-24T03-27-04-794Z_01a0d173-d65a-744a-9e71-0ce131b412c0.jsonl`,
    cutBeforeSecondUser: true,
    cwd: "/tmp/exp5-repo",
    model: ["zai", "glm-5.3"],
    systemPrompt: EDOC_SP,
    question: EDOC_Q,
  },
  edoc2: {
    source: `${S}/--tmp-exp5-repo--/2026-09-24T03-27-10-800Z_01a0d173-edd0-7421-b08d-8303ef7efe59.jsonl`,
    cutBeforeSecondUser: true,
    cwd: "/tmp/exp5-repo",
    model: ["zai", "glm-5.3"],
    systemPrompt: EDOC_SP,
    question: EDOC_Q,
  },
  edoc3: {
    source: `${S}/--tmp-exp5-repo--/2026-09-24T03-48-14-477Z_01a0d187-360c-71bb-a167-9a34ae818248.jsonl`,
    cutBeforeSecondUser: true,
    cwd: "/tmp/exp5-repo",
    model: ["zai", "glm-5.3"],
    systemPrompt: EDOC_SP,
    question: EDOC_Q,
  },
  ec1: {
    source: `${S}/--home-bluecake-ai-apistrike--/2026-09-21T07-38-13-933Z_01a0c2e6-b22d-77c3-bc8e-4b2d1bb9ce87.jsonl`,
    cutBeforeSecondUser: false,
    cwd: "/tmp/exp6-snap-apistrike-70dbf25",
    rewrite: ["/home/bluecake/ai/apistrike", "/tmp/exp6-snap-apistrike-70dbf25"],
    model: ["cr-anthropic", "claude-sonnet-5"],
    systemPrompt: () => typeBody(join(homedir(), ".pi/agent/agents/Explore.md")),
    question: () => EC_Q.ec1!,
  },
  ec2: {
    source: `${S}/--home-bluecake-ai-apistrike--/2026-09-21T08-37-21-619Z_01a0c31c-d452-77c3-bc8e-4b384ad5e7e3.jsonl`,
    cutBeforeSecondUser: false,
    cwd: "/tmp/exp6-snap-apistrike-55e1bfe",
    rewrite: ["/home/bluecake/ai/apistrike", "/tmp/exp6-snap-apistrike-55e1bfe"],
    model: ["cr-anthropic", "claude-sonnet-5"],
    systemPrompt: () => typeBody(join(homedir(), ".pi/agent/agents/verifier.md")),
    question: () => EC_Q.ec2!,
  },
};

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

export function spent(): number {
  if (!existsSync(RUNS)) return 0;
  let t = 0;
  for (const f of readdirSync(RUNS)) {
    if (!f.endsWith(".json")) continue;
    try {
      t += JSON.parse(readFileSync(join(RUNS, f), "utf8")).costUsd ?? 0;
    } catch {
      /* partial */
    }
  }
  const judge = "/tmp/exp6-judge";
  if (existsSync(judge))
    for (const f of readdirSync(judge)) {
      if (!f.endsWith(".json")) continue;
      try {
        t += JSON.parse(readFileSync(join(judge, f), "utf8")).costUsd ?? 0;
      } catch {
        /* partial */
      }
    }
  return t;
}

function setup(): void {
  if (!existsSync("/tmp/exp5-repo/src")) {
    rmSync("/tmp/exp5-repo", { recursive: true, force: true });
    mkdirSync("/tmp/exp5-repo", { recursive: true });
    execSync(`git -C ${REPO} archive 14e28c0 | tar -x -C /tmp/exp5-repo`);
  }
  if (existsSync("/tmp/exp5-repo/docs/dev/fabric-v2")) throw new Error("LEAK: fabric-v2 in exp5 snapshot");
  mkdirSync("/tmp/.p5x", { recursive: true });
  writeFileSync("/tmp/.p5x/plan.md", readFileSync(join(REPO, "docs/dev/fabric-v2/plan.md")));
  // brief-A.md: restore byte-exactly from what the experts actually read (the archived copy differs in whitespace)
  {
    const { messages } = loadContext(EXPERTS.edoc1!.source);
    const briefCall = messages
      .flatMap((m) => (m.role === "assistant" ? (m.content ?? []) : []))
      .find((b: any) => b.type === "toolCall" && b.name === "read" && b.arguments?.path === "/tmp/.p5x/brief-A.md");
    const res = messages.find((m) => m.role === "toolResult" && m.toolCallId === briefCall?.id);
    writeFileSync("/tmp/.p5x/brief-A.md", (res?.content ?? []).map((b: any) => b.text ?? "").join(""));
  }
  // verify every read of /tmp/.p5x/* and /tmp/exp5-repo/* in the three experts matches the restored files
  for (const key of ["edoc1", "edoc2", "edoc3"]) {
    const { messages } = loadContext(EXPERTS[key]!.source);
    const calls = new Map<string, any>();
    for (const m of messages)
      if (m.role === "assistant") for (const b of m.content ?? []) if (b.type === "toolCall") calls.set(b.id, b);
    let ok = 0;
    const bad: string[] = [];
    for (const m of messages) {
      if (m.role !== "toolResult") continue;
      const c = calls.get(m.toolCallId);
      if (c?.name !== "read") continue;
      const p: string = c.arguments.path;
      const text = (m.content ?? [])
        .map((b: any) => b.text ?? "")
        .join("")
        .replace(/\n\n\[[^\n]*\]\s*$/, "");
      const lines = readFileSync(p, "utf8").split("\n");
      const off = Math.max(1, Number(c.arguments.offset ?? 1));
      const res = text.split("\n");
      const i = res.findIndex((l: string, k: number) => l !== (lines[off - 1 + k] ?? ""));
      if (i >= 0) bad.push(`${p}@${off} line ${off + i}`);
      else ok++;
    }
    console.log(key, "reads matched", ok, "mismatches", bad);
  }
}

function makeFork(key: string, arm: "FULL" | "TRIM", tag: string): { path: string; elided: number; plan?: string[] } {
  const ex = EXPERTS[key]!;
  mkdirSync(FORKS, { recursive: true });
  let lines = readFileSync(ex.source, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  if (ex.cutBeforeSecondUser) {
    let users = 0;
    const cut = lines.findIndex((l) => {
      const e = JSON.parse(l);
      if (e.type === "message" && e.message?.role === "user") users++;
      return users === 2;
    });
    if (cut > 0) lines = lines.slice(0, cut);
  }
  let raw = lines.join("\n") + "\n";
  if (ex.rewrite) raw = raw.split(ex.rewrite[0]).join(ex.rewrite[1]);
  // fresh session id in the header so the fork is its own session
  const hdr = JSON.parse(raw.slice(0, raw.indexOf("\n")));
  hdr.id = `exp6-${tag}`;
  hdr.parentSession = ex.source;
  hdr.cwd = ex.cwd;
  raw = JSON.stringify(hdr) + raw.slice(raw.indexOf("\n"));
  const path = join(FORKS, `${tag}.jsonl`);
  writeFileSync(path, raw);
  if (arm === "FULL") return { path, elided: 0 };
  const { messages } = loadContext(path);
  const cal = calibrate(messages);
  if (!cal.ok) throw new Error(`calibration failed for ${key}: ${cal.reason}`);
  const plan = planTrim(messages, "T1", cal.r);
  const out = applyToJsonl(raw, plan);
  if (out.rewritten !== plan.elide.size) throw new Error(`trim rewrote ${out.rewritten} != planned ${plan.elide.size}`);
  writeFileSync(path, out.text);
  return { path, elided: out.rewritten, plan: [...plan.elide.values()].slice(0, 40) };
}

function opusCost(u: AnyMsg): number {
  return (
    ((u.input ?? 0) * OPUS.input +
      (u.output ?? 0) * OPUS.output +
      (u.cacheRead ?? 0) * OPUS.cacheRead +
      (u.cacheWrite ?? 0) * OPUS.cacheWrite) /
    1e6
  );
}

async function run(key: string, arm: "FULL" | "TRIM", rep: number): Promise<void> {
  const ex = EXPERTS[key];
  if (!ex) throw new Error(`unknown expert ${key}`);
  mkdirSync(RUNS, { recursive: true });
  const id = `${key}-${arm}-r${rep}`;
  const outFile = join(RUNS, `${id}.json`);
  if (existsSync(outFile)) {
    console.log(`skip ${id} (exists)`);
    return;
  }
  const already = spent();
  if (already >= BUDGET_USD - 0.5) throw new Error(`budget exhausted: spent $${already.toFixed(2)}`);
  const nonce = randomBytes(4).toString("hex");
  const before = sha(ex.source);
  const fork = makeFork(key, arm, `${id}-${nonce}`);
  const runtime = await ModelRuntime.create({
    authPath: join(getAgentDir(), "auth.json"),
    modelsPath: join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = runtime.getModels(ex.model[0]).find((m: any) => m.id === ex.model[1]);
  if (!model) throw new Error(`model ${ex.model.join("/")} not found`);
  const srcEntries = readFileSync(ex.source, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const thinkingLevel = srcEntries.find((e) => e.type === "thinking_level_change")?.thinkingLevel;
  // run nonce at the top of the system prompt: prevents cross-run prompt-cache hits between reps/arms
  const systemPrompt = `[exp6 run ${nonce}]\n${ex.systemPrompt()}`;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ex.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: ex.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.open(fork.path, FORKS, ex.cwd);
  const { session } = await createAgentSession({
    cwd: ex.cwd,
    agentDir,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: READONLY,
    resourceLoader,
    settingsManager,
    sessionManager,
  } as any);
  const active = session.getActiveToolNames();
  if (active.some((n: string) => !READONLY.includes(n))) throw new Error(`non-readonly tools active: ${active}`);
  const startCount = session.state.messages.length;
  let prompt = buildConsultPrompt({ question: ex.question(), maxAnswerChars: 2000, budgetNote: false });
  if (arm === "TRIM") prompt += `\n${TRIM_NOTE}`;
  const t0 = Date.now();
  let turns = 0;
  let safetyStop: string | undefined;
  const firstTurnAt: number[] = [];
  session.subscribe((ev: any) => {
    if (ev?.type === "message_end" && ev.message?.role === "assistant") {
      turns++;
      firstTurnAt.push(Date.now() - t0);
      if (turns >= SAFETY_TURNS && !safetyStop) {
        safetyStop = "turns";
        void session.abort();
      }
    }
  });
  const timer = setTimeout(() => {
    safetyStop = "time";
    void session.abort();
  }, SAFETY_MS);
  timer.unref();
  let error: string | undefined;
  try {
    await session.prompt(prompt);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  clearTimeout(timer);
  const wallMs = Date.now() - t0;
  const newMsgs = session.state.messages.slice(startCount) as AnyMsg[];
  const assistants = newMsgs.filter((m) => m.role === "assistant");
  const usage = assistants.map((m) => m.usage ?? {});
  const costUsd = usage.reduce((a, u) => a + (u.cost?.total ?? 0), 0);
  const opusEq = usage.reduce((a, u) => a + opusCost(u), 0);
  const toolCalls = assistants.flatMap((m) =>
    (m.content ?? [])
      .filter((b: AnyMsg) => b.type === "toolCall")
      .map((b: AnyMsg) => ({ name: b.name, args: b.arguments })),
  );
  const answer = [...assistants]
    .reverse()
    .find((m) => (m.content ?? []).some((b: AnyMsg) => b.type === "text" && b.text?.trim()));
  const answerText = answer
    ? (answer.content ?? [])
        .filter((b: AnyMsg) => b.type === "text")
        .map((b: AnyMsg) => b.text)
        .join("\n")
    : "";
  const leak = toolCalls.filter((c) => {
    const s = JSON.stringify(c.args);
    return /\.pi\/agent|\/tmp\/w[0-9a-f]|\/tmp\/exp(?!5-repo|6-snap)/.test(s);
  });
  const first = usage[0] ?? {};
  const result = {
    id,
    expert: key,
    arm,
    rep,
    nonce,
    model: ex.model.join("/"),
    thinkingLevel,
    cwd: ex.cwd,
    elidedToolResults: fork.elided,
    placeholders: fork.plan,
    firstRequest: {
      input: first.input ?? 0,
      cacheWrite: first.cacheWrite ?? 0,
      cacheRead: first.cacheRead ?? 0,
      total: (first.input ?? 0) + (first.cacheWrite ?? 0) + (first.cacheRead ?? 0),
      costUsd: first.cost?.total ?? 0,
      opusEq: opusCost(first),
    },
    perTurn: usage.map((u, i) => ({
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      costUsd: u.cost?.total,
      atMs: firstTurnAt[i],
    })),
    turns: assistants.length,
    toolCalls,
    wallMs,
    costUsd,
    opusEq,
    overProdTime: wallMs > PROD_MS,
    overProdTurns: assistants.length > PROD_TURNS,
    safetyStop,
    error,
    stopReason: assistants.at(-1)?.stopReason,
    errorMessage: assistants.at(-1)?.errorMessage,
    leakCalls: leak,
    answerChars: answerText.length,
    wouldTruncate: answerText.length > 2000,
    answer: answerText,
  };
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  rmSync(fork.path, { force: true });
  const after = sha(ex.source);
  if (before !== after) throw new Error(`SOURCE MODIFIED: ${ex.source}`);
  console.log(
    `${id}: turns=${result.turns} tools=${toolCalls.length} wall=${(wallMs / 1000).toFixed(0)}s first=${result.firstRequest.total}tok cost=$${costUsd.toFixed(3)} opusEq=$${opusEq.toFixed(3)} chars=${answerText.length} ${error ?? ""} ${result.errorMessage ?? ""} spent=$${(already + costUsd).toFixed(2)}`,
  );
}

const args = process.argv.slice(2);
if (args[0] === "--setup") setup();
else if (args[0] === "--spent") console.log(spent().toFixed(3));
else if (args[0] === "--fork-only") {
  // dry check: build fork + trim, print sizes, delete
  const f = makeFork(args[1]!, args[2] as "FULL" | "TRIM", `dry-${args[1]}-${args[2]}`);
  const { messages } = loadContext(f.path);
  const cal = calibrate(messages);
  console.log(
    JSON.stringify(
      {
        path: f.path,
        elided: f.elided,
        messages: messages.length,
        users: messages.filter((m) => m.role === "user").length,
        lastRole: messages.at(-1)?.role,
        r: cal.r,
        sample: f.plan?.slice(0, 3),
      },
      null,
      2,
    ),
  );
  rmSync(f.path, { force: true });
} else
  run(args[0]!, args[1] as "FULL" | "TRIM", Number(args[2] ?? 1)).then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
