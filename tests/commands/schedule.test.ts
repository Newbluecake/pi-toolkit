/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScheduleCommand, parseFlags, splitPrompt, tokenizeScheduleArgs } from "../../src/commands/schedule.js";
import { scheduleEditArgs } from "../../src/web-hub/ui/src/logic/schedule.js";
import { createTask } from "../../src/schedule/agent/ops.js";
import { manualClaim } from "../../src/schedule/core/claim.js";
import { finishRun, openSessionStore } from "../../src/schedule/core/writer.js";
import { sessionDirName } from "../../src/schedule/core/paths.js";
import { defHash, isExecutable } from "../../src/schedule/core/spec.js";
import { a3Env, basicRaw, CRON, stripApproval, type A3Env } from "../schedule/agent/a3-helpers.js";
import { addTask, approve, makeTask, readOk, SID, self } from "../schedule/core/fixtures.js";

let env: A3Env;
afterEach(() => env?.cleanup());
const AI = { by: "agent", via: "tool" } as const;

const OTHER_SID = "019a1111-bbbb-7ccc-8ddd-eeeeeeeeeeee";

interface Harness {
  run(args: string, over?: Record<string, unknown>): Promise<string>;
  confirms: Array<{ title: string; message: string }>;
  setConfirm(fn: (title: string, message: string) => boolean | Promise<boolean>): void;
  setInputs(values: string[]): void;
  enabled: { value: boolean };
}

function harness(e: A3Env): Harness {
  const confirms: Harness["confirms"] = [];
  let confirmFn: (t: string, m: string) => boolean | Promise<boolean> = () => true;
  let inputs: string[] = [];
  const enabled = { value: true };
  const cmd = createScheduleCommand({
    enabled: () => enabled.value,
    agent: () => e.agent,
    ports: () => e.ports,
    inVault: () => false,
    now: () => e.fake.now(),
  });
  return {
    confirms,
    enabled,
    setConfirm: (fn) => (confirmFn = fn),
    setInputs: (v) => (inputs = [...v]),
    async run(args, over = {}) {
      const out: string[] = [];
      const ctx = {
        ui: {
          notify: (m: string) => out.push(m),
          confirm: async (title: string, message: string) => {
            confirms.push({ title, message });
            return confirmFn(title, message);
          },
          input: async () => inputs.shift(),
        },
        ...over,
      };
      await cmd.handler(args, ctx as never);
      return out.join("\n");
    },
  };
}

const ADD = `add daily --cron "0 8 * * *" --tz Asia/Shanghai -- summarize the repo`;

describe("parsing helpers", () => {
  it("tokenizes quotes and splits the raw prompt at the first standalone --", () => {
    expect(tokenizeScheduleArgs(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f\\", "g"]);
    expect(splitPrompt(`add x --cron "0 8 * * *" --  keep   spacing -- here `)).toEqual({
      head: `add x --cron "0 8 * * *"`,
      prompt: "keep   spacing -- here",
    });
    expect(splitPrompt("add x --cron y").prompt).toBeUndefined();
    const p = parseFlags(["x", "--cron", "0 8 * * *", "--no-feishu", "--all"]);
    expect(p.positional).toEqual(["x"]);
    expect(p.flags.get("cron")).toBe("0 8 * * *");
    expect(p.flags.has("no-feishu") && p.flags.has("all")).toBe(true);
    expect(parseFlags(["--bogus"]).error).toMatch(/未知参数/);
    expect(parseFlags(["--cron"]).error).toMatch(/需要一个值/);
  });
});

describe("gates", () => {
  it("disabled ⇒ only E_DISABLED, nothing touched; Feishu mutations are hard-refused first", async () => {
    env = a3Env();
    const h = harness(env);
    h.enabled.value = false;
    expect(await h.run("list")).toMatch(/E_DISABLED/);
    expect(await h.run(ADD)).toMatch(/E_DISABLED/);
    h.enabled.value = true;
    for (const a of [ADD, "rm s_aaaaaaaa", "list --all"])
      expect(await h.run(a, { feishuInvocation: true, webInvocation: true })).toMatch(/飞书入口不能修改/);
    expect(await h.run("list", { feishuInvocation: true, webInvocation: true })).toMatch(/没有定时任务/);
    expect(env.agent.readState().kind).toBe("absent");
  });

  it("print mode refuses writes with E_MODE; unknown subcommand prints usage", async () => {
    env = a3Env({}, "print");
    const h = harness(env);
    expect(await h.run(ADD)).toMatch(/E_MODE/);
    expect(await h.run("list")).toMatch(/没有定时任务/);
    env.cleanup();
    env = a3Env();
    expect(await harness(env).run("frobnicate")).toMatch(/未知子命令/);
  });
});

describe("add / edit / list / show / log", () => {
  it("add by flags creates a task that is enabled at once and carries no approval; list shows it with next time; show prints full definition + hash", async () => {
    env = a3Env();
    const h = harness(env);
    expect(await h.run(ADD)).toMatch(/已创建并启用 s_/);
    const t = readOk(env.agent.store()!).tasks[0]!;
    expect(isExecutable(t)).toBe(true);
    expect(t).not.toHaveProperty("approval");
    expect(t.createdBy).toBe("user");
    expect(t.prompt).toBe("summarize the repo");
    const list = await h.run("");
    expect(list).toContain(t.id);
    expect(list).toMatch(/next 2026-01-02 08:00 Asia\/Shanghai/);
    const show = await h.run(`show ${t.id}`);
    expect(show).toContain(`defHash: ${defHash(t)}`);
    expect(show).toContain("summarize the repo");
    expect(await h.run(`log ${t.id}`)).toBe("没有运行记录。");
    expect(await h.run("show s_zzzzzzzz")).toMatch(/E_INVALID/);
  });

  it("show prints no approval line for new tasks AND for legacy ones; list rows never say pending", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    const mine = readOk(env.agent.store()!).tasks[0]!;
    const ai = await createTask(env.ports, basicRaw({ name: "ai" }), AI);
    if (!ai.ok) throw new Error(ai.detail);
    await env.agent.ensureStore().transact((d) => {
      d.tasks[0] = approve(d.tasks[0]!); // legacy ledger: a matching old approval is simply ignored
      return { value: undefined, write: true };
    });
    for (const id of [mine.id, ai.value.id]) {
      const show = await h.run(`show ${id}`);
      expect(show).not.toMatch(/approv|PENDING|待确认/i);
      expect(show).toContain("defHash:");
    }
    const list = await h.run("");
    expect(list).not.toMatch(/pending|auto/);
    expect(list).toContain(ai.value.id);
  });

  it("add with missing pieces asks interactively; still incomplete ⇒ nothing created", async () => {
    env = a3Env();
    const h = harness(env);
    h.setInputs(["nightly", "0 3 * * *", "do it"]);
    expect(await h.run("add")).toMatch(/已创建并启用/);
    const t = readOk(env.agent.store()!).tasks[0]!;
    expect([t.name, t.when.kind, t.prompt]).toEqual(["nightly", "cron", "do it"]);
    h.setInputs([]);
    expect(await h.run("add lonely")).toMatch(/信息不完整/);
    expect(readOk(env.agent.store()!).tasks).toHaveLength(1);
    h.setInputs(["x", "2026-02-01T09:00", "p"]);
    await h.run("add");
    expect(readOk(env.agent.store()!).tasks[1]!.when).toMatchObject({ kind: "once", at: "2026-02-01T09:00" });
  });

  it("flag errors and invalid definitions are reported, not thrown", async () => {
    env = a3Env();
    const h = harness(env);
    expect(await h.run(`add x --cron "0 8 * * *" --at 2026-02-01T09:00 -- p`)).toMatch(
      /give exactly one of cron, at, every/,
    );
    expect(await h.run(`add x --cron "99 * * * *" -- p`)).toMatch(/E_INVALID/);
    expect(await h.run(`add x --cron "0 8 * * *" --timeout abc -- p`)).toMatch(/整数秒/);
    expect(await h.run(`add x --tz UTC -- p`)).toMatch(/--tz 需要/);
    expect(env.agent.readState().kind).toBe("absent");
  });

  it("#40: --consult is rejected (nothing created); --no-consult is silently accepted and not persisted", async () => {
    env = a3Env();
    const h = harness(env);
    expect(parseFlags(["--consult"]).error).toMatch(/--consult 已移除/);
    expect(await h.run(`add x --cron "0 8 * * *" --consult -- p`)).toMatch(/--consult 已移除/);
    expect(env.agent.readState().kind).toBe("absent");
    expect(parseFlags(["--no-consult"]).error).toBeUndefined();
    expect(await h.run(`add x --cron "0 8 * * *" --no-consult -- p`)).toMatch(/已创建并启用/);
    expect(await h.run(`add y --cron "0 8 * * *" -- p`)).toMatch(/已创建并启用/);
    const [withFlag, without] = readOk(env.agent.store()!).tasks;
    expect(withFlag!.bg?.consultMain).toBe(without!.bg?.consultMain); // the flag changed nothing
  });

  it("edit takes effect at once, says so, writes no approval; an old-ledger task without approval edits the same way", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    const mine = readOk(env.agent.store()!).tasks[0]!;
    const out = await h.run(`edit ${mine.id} -- new prompt`);
    expect(out).toMatch(/已修改 s_\w+（hash [0-9a-f]{8}），立即生效。/);
    expect(out).not.toMatch(/批准|待确认/);
    expect(readOk(env.agent.store()!).tasks[0]).not.toHaveProperty("approval");
    const ai = await createTask(env.ports, basicRaw({ name: "ai" }), AI);
    if (!ai.ok) throw new Error(ai.detail);
    await stripApproval(env, ai.value.id);
    expect(await h.run(`edit ${ai.value.id} --no-feishu`)).toMatch(/立即生效/);
    expect(isExecutable(readOk(env.agent.store()!).tasks[1]!)).toBe(true);
    expect(await h.run(`edit ${ai.value.id}`)).toMatch(/没有要修改/);
  });
});

describe("the approval commands are gone (schedule-auto-approve r2)", () => {
  const HASH = "a".repeat(64);
  const PUT = `__put ${JSON.stringify({ name: "web", when: CRON, prompt: "x" })} ${HASH}`;

  it.each([
    ["approve", `approve s_aaaaaaaa`],
    ["approve <hash>", `approve s_aaaaaaaa ${HASH}`],
    ["approve --all", `approve s_aaaaaaaa --all`],
    ["reject", `reject s_aaaaaaaa`],
    ["reject <hash>", `reject s_aaaaaaaa ${HASH}`],
    ["__put", PUT],
    ["__put preview", `__put {} ${"0".repeat(64)}`],
  ])("%s ⇒ unknown subcommand; the ledger is untouched and no dialog opens", async (_n, cmd) => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    const file = join(env.dir, sessionDirName(SID), "state.json");
    const before = readFileSync(file, "utf8");
    const out = await h.run(cmd, { webInvocation: true });
    expect(out).toMatch(/未知子命令/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(h.confirms).toHaveLength(0);
  });

  it("the usage text and the completions mention none of approve / reject / __put", async () => {
    env = a3Env();
    const h = harness(env);
    const usage = await h.run("frobnicate");
    expect(usage).not.toMatch(/approve|reject|__put|批准|确认/);
    const cmd = createScheduleCommand({
      enabled: () => true,
      agent: () => env.agent,
      ports: () => env.ports,
      inVault: () => false,
    });
    const items = (cmd.getArgumentCompletions!("") as Array<{ value: string }>).map((i) => i.value);
    expect(items).not.toContain("approve");
    expect(items).not.toContain("reject");
    expect(items).not.toContain("__put");
  });

  it("an unapproved task on an OLD ledger is listed, shown, run and edited like any other (no `pending` anywhere)", async () => {
    env = a3Env();
    const seen: string[] = [];
    env.agent.setExecutor("background", { dispatch: (r) => void seen.push(r.runKey) });
    const h = harness(env);
    const c = await createTask(env.ports, basicRaw(), AI);
    if (!c.ok) throw new Error(c.detail);
    await stripApproval(env, c.value.id);
    expect(await h.run("")).not.toMatch(/pending/);
    expect(await h.run(`run ${c.value.id}`)).toMatch(/已开始运行/);
    expect(seen).toHaveLength(1);
  });
});

describe("pause / resume / rm / run / repair", () => {
  it("pause→resume (plain receipts, no approval talk); rm deletes", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    const id = readOk(env.agent.store()!).tasks[0]!.id;
    expect(await h.run(`pause ${id}`)).toBe(`已暂停 ${id}。`);
    expect(readOk(env.agent.store()!).tasks[0]!.enabled).toBe(false);
    expect(await h.run(`resume ${id}`)).toBe(`已恢复 ${id}。`);
    const ai = await createTask(env.ports, basicRaw({ name: "ai" }), AI);
    if (!ai.ok) throw new Error(ai.detail);
    await stripApproval(env, ai.value.id);
    expect(await h.run(`resume ${ai.value.id}`)).toBe(`已恢复 ${ai.value.id}。`);
    expect(await h.run(`rm ${id}`)).toMatch(/已删除/);
    expect(readOk(env.agent.store()!).tasks.map((t) => t.id)).toEqual([ai.value.id]);
    expect(await h.run("rm")).toMatch(/用法/);
    expect(await h.run("rm s_zzzzzzzz")).toMatch(/E_INVALID/);
  });

  it("run: a freshly created task starts through the executor at once; a second run overlaps", async () => {
    env = a3Env();
    const seen: string[] = [];
    env.agent.setExecutor("background", { dispatch: (r) => void seen.push(r.runKey) });
    const h = harness(env);
    const ai = await createTask(env.ports, basicRaw(), AI);
    if (!ai.ok) throw new Error(ai.detail);
    expect(await h.run(`run ${ai.value.id}`)).toMatch(/已开始运行/);
    expect(seen).toHaveLength(1);
    expect(await h.run(`run ${ai.value.id}`)).toMatch(/E_OVERLAP.*已有运行在进行/);
  });

  it("repair quarantines a corrupt ledger; a healthy one needs nothing", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    expect(await h.run("repair")).toMatch(/无需修复/);
    writeFileSync(join(env.dir, sessionDirName(SID), "state.json"), "{broken");
    expect(await h.run("list")).toMatch(/E_DEGRADED.*repair/);
    expect(await h.run("repair")).toMatch(/state\.json\.bak/);
    expect(await h.run("list")).toMatch(/没有定时任务/);
  });
});

describe("--all matrix (§5.2)", () => {
  async function twoSessions() {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD); // own task
    const root = env.agent.store()!.root;
    const other = openSessionStore({
      root,
      sessionId: OTHER_SID,
      self: self(),
      epoch: "x",
      now: () => env.fake.now(),
      lockTimeoutMs: 300,
    });
    const t = makeTask({ name: "foreign", ownerCwd: env.ports.ownerCwd() });
    await addTask(other, t, env.fake.now()); // no approval (runs like any other)
    return { h, other, foreign: t };
  }

  it("list/show/log --all span sessions; edit and run --all are refused", async () => {
    const { h, foreign } = await twoSessions();
    const list = await h.run("list --all");
    expect(list).toContain("（本会话）");
    expect(list).toContain(foreign.id);
    expect(list).toContain(OTHER_SID.slice(0, 8));
    expect(await h.run(`show ${foreign.id} --all`)).toContain(`defHash: ${defHash(foreign)}`);
    expect(await h.run(`log ${foreign.id} --all`)).toBe("没有运行记录。");
    expect(await h.run(`show ${foreign.id}`)).toMatch(/本会话没有任务/); // without --all it is not visible
    expect(await h.run(`edit ${foreign.id} --all --no-feishu`)).toMatch(/不支持 --all/);
    expect(await h.run(`run ${foreign.id} --all`)).toMatch(/执行只发生在归属会话内/);
  });

  it.each([false, true])("show/log use the owning session's absolute report paths (all=%s)", async (all) => {
    const { h, other, foreign } = await twoSessions();
    const store = all ? other : env.agent.store()!;
    const task = all ? foreign : readOk(store).tasks[0]!;
    await store.transact((d) => {
      d.tasks[0] = approve(d.tasks[0]!);
      return { value: undefined, write: true };
    });
    const claim = await manualClaim(store, { taskId: task.id, reqId: "cmd_path_request", holder: env.agent.holder! });
    if (claim.kind !== "started") throw new Error("claim failed");
    const reportFile = `reports/${task.id}-20260101-0800.md`;
    await store.transact((d, ctx) => ({
      value: finishRun(d, claim.runKey, { state: "completed", reportFile }, ctx.now),
      write: true,
    }));
    for (const sub of ["show", "log"]) {
      const output = await h.run(`${sub} ${task.id}${all ? " --all" : ""}`);
      expect(output).toContain(`report ${join(store.root.real, store.dirName, reportFile)}`);
      expect(output).not.toContain(`report ${reportFile}`);
    }
    expect(readOk(store).runs[0]!.reportFile).toBe(reportFile);
  });

  it("pause/resume/rm --all work under the foreign lock and never touch an approval", async () => {
    const { h, other, foreign } = await twoSessions();
    expect(await h.run(`pause ${foreign.id} --all`)).toMatch(/已暂停/);
    expect(readOk(other).tasks[0]!.enabled).toBe(false);
    expect(await h.run(`resume ${foreign.id} --all`)).toBe(`已恢复 ${foreign.id}。`);
    expect(readOk(other).tasks[0]!.enabled).toBe(true);
    expect(readOk(other).tasks[0]).not.toHaveProperty("approval");
    expect(h.confirms).toHaveLength(0);
    expect(await h.run(`rm ${foreign.id} --all`)).toMatch(/已删除/);
    expect(readOk(other).tasks).toHaveLength(0);
    // an id found nowhere
    expect(await h.run(`rm s_zzzzzzzz --all`)).toMatch(/都没有任务/);
  });

  it("an id present in two sessions is ambiguous and nothing is written", async () => {
    const { h, other, foreign } = await twoSessions();
    const third = openSessionStore({
      root: env.agent.store()!.root,
      sessionId: "019a2222-cccc-7ddd-8eee-ffffffffffff",
      self: self(),
      epoch: "y",
      now: () => env.fake.now(),
      lockTimeoutMs: 300,
    });
    await addTask(third, { ...foreign }, env.fake.now());
    expect(await h.run(`pause ${foreign.id} --all`)).toMatch(/多个会话中出现/);
    expect(readOk(other).tasks[0]!.enabled).toBe(true);
  });
});

describe("interval P2 CLI", () => {
  it("executes the UI-generated edit command with quoted name and verbatim prompt", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run("add interval --every 90m -- initial prompt");
    const task = readOk(env.agent.store()!).tasks[0]!;
    const args = scheduleEditArgs(task, {
      name: 'a "quoted" \\name',
      kind: "every",
      value: "45s",
      tz: "ignored",
      prompt: "report -- once\nnext line",
    });
    expect(args).toBeTypeOf("string");
    expect(await h.run(args!)).toContain("已修改");
    const updated = readOk(env.agent.store()!).tasks[0]!;
    expect(updated.name).toBe('a "quoted" \\name');
    expect(updated.prompt).toBe("report -- once\nnext line");
    expect(updated.when).toEqual({ kind: "every", everyMs: 45_000, anchorAt: env.fake.now() });
    expect(
      scheduleEditArgs(task, { name: "a -- b", kind: "every", value: "45s", tz: "UTC", prompt: "report" }),
    ).toBeUndefined();
  });
  it("--every create/edit normalizes, returns id/anchor/next/policy and writes v2", async () => {
    env = a3Env();
    const h = harness(env);
    const result = await h.run("add interval --every 90m -- report once");
    const s = readOk(env.agent.store()!),
      task = s.tasks[0]!;
    expect(s.v).toBe(2);
    expect(task.when).toEqual({ kind: "every", everyMs: 5_400_000, anchorAt: env.fake.now() });
    expect(result).toContain(task.id);
    expect(result).toContain("5400s");
    expect(result).toContain("anchor");
    expect(result).toContain("next 2026-01-01 01:30:30 UTC");
    expect(result).toContain("catch-up: aggregate once");
    const hash = defHash(task);
    env.fake.advance(1000);
    expect(await h.run(`edit ${task.id} --every 1.5h`)).toContain("5400s");
    expect(defHash(readOk(env.agent.store()!).tasks[0]!)).toBe(hash);
    await h.run(`edit ${task.id} --every 45s`);
    expect(readOk(env.agent.store()!).tasks[0]!.when).toEqual({
      kind: "every",
      everyMs: 45_000,
      anchorAt: env.fake.now(),
    });
  });

  it.each([
    ["--every 90m --cron '0 * * * *'", "give exactly one of cron, at, every"],
    ["--every 90m --at 2026-12-01T00:00", "give exactly one of cron, at, every"],
    ["--every 90m --tz UTC", "remove tz"],
    ["--every 90min", "every unit must be s/m/h/d"],
    ["--cron '*/90 * * * *'", "--every 90m"],
  ])("rejects %s before creating the store", async (flags, error) => {
    env = a3Env();
    expect(await harness(env).run(`add interval ${flags} -- report once`)).toContain(error);
    expect(env.agent.store()).toBeUndefined();
  });

  it("invalid interval edit leaves bytes/rev unchanged", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    const task = readOk(env.agent.store()!).tasks[0]!;
    const before = JSON.stringify(readOk(env.agent.store()!));
    env.fake.advance(3 * 3_600_000);
    expect(await h.run(`edit ${task.id} --every 90m --tz UTC`)).toContain("remove tz");
    expect(JSON.stringify(readOk(env.agent.store()!))).toBe(before);
  });
});
