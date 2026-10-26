/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScheduleCommand, parseFlags, splitPrompt, tokenizeScheduleArgs } from "../../src/commands/schedule.js";
import { createTask, updateTask } from "../../src/schedule/agent/ops.js";
import { manualClaim } from "../../src/schedule/core/claim.js";
import { finishRun, openSessionStore } from "../../src/schedule/core/writer.js";
import { sessionDirName } from "../../src/schedule/core/paths.js";
import { defHash, isApproved } from "../../src/schedule/core/spec.js";
import { a3Env, basicRaw, CRON, type A3Env } from "../schedule/agent/a3-helpers.js";
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
    for (const a of [ADD, "approve s_aaaaaaaa", "rm s_aaaaaaaa", "list --all"])
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
  it("add by flags creates an APPROVED task; list shows it with next time; show prints full definition + hash", async () => {
    env = a3Env();
    const h = harness(env);
    expect(await h.run(ADD)).toMatch(/已创建并批准 s_/);
    const t = readOk(env.agent.store()!).tasks[0]!;
    expect(isApproved(t)).toBe(true);
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

  it("add with missing pieces asks interactively; still incomplete ⇒ nothing created", async () => {
    env = a3Env();
    const h = harness(env);
    h.setInputs(["nightly", "0 3 * * *", "do it"]);
    expect(await h.run("add")).toMatch(/已创建并批准/);
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
    expect(await h.run(`add x --cron "0 8 * * *" --at 2026-02-01T09:00 -- p`)).toMatch(/只能给一个/);
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
    expect(await h.run(`add x --cron "0 8 * * *" --no-consult -- p`)).toMatch(/已创建并批准/);
    expect(await h.run(`add y --cron "0 8 * * *" -- p`)).toMatch(/已创建并批准/);
    const [withFlag, without] = readOk(env.agent.store()!).tasks;
    expect(withFlag!.bg?.consultMain).toBe(without!.bg?.consultMain); // the flag changed nothing
  });

  it("edit of an approved task keeps it approved; edit of a pending (AI) task keeps it pending and says so", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    const mine = readOk(env.agent.store()!).tasks[0]!;
    expect(await h.run(`edit ${mine.id} -- new prompt`)).toMatch(/已重新批准/);
    expect(isApproved(readOk(env.agent.store()!).tasks[0]!)).toBe(true);
    const ai = await createTask(env.ports, basicRaw({ name: "ai" }), AI);
    if (!ai.ok) throw new Error(ai.detail);
    expect(await h.run(`edit ${ai.value.id} --no-feishu`)).toMatch(/仍待确认/);
    expect(isApproved(readOk(env.agent.store()!).tasks[1]!)).toBe(false);
    expect(await h.run(`edit ${ai.value.id}`)).toMatch(/没有要修改/);
  });
});

describe("approve — review + hash CAS", () => {
  it("bare approve shows the FULL definition and hash in the confirm, then approves exactly that hash", async () => {
    env = a3Env();
    const h = harness(env);
    const ai = await createTask(env.ports, basicRaw({ prompt: "secret plan: do X then Y" }), AI);
    if (!ai.ok) throw new Error(ai.detail);
    const out = await h.run(`approve ${ai.value.id}`);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]!.message).toContain("secret plan: do X then Y");
    expect(h.confirms[0]!.message).toContain(defHash(ai.value));
    expect(out).toMatch(/已批准/);
    const t = readOk(env.agent.store()!).tasks[0]!;
    expect(t.approval).toMatchObject({ hash: defHash(t), by: "user", via: "tui" });
    expect(await h.run(`approve ${ai.value.id}`)).toMatch(/已是批准状态/);
  });

  it("the definition changing while the confirm dialog is open ⇒ E_REV, NOT approved (hash sampled before confirm)", async () => {
    env = a3Env();
    const h = harness(env);
    const ai = await createTask(env.ports, basicRaw(), AI);
    if (!ai.ok) throw new Error(ai.detail);
    h.setConfirm(async () => {
      await updateTask(env.ports, ai.value.id, { prompt: "swapped under the reviewer" }, AI);
      return true;
    });
    const out = await h.run(`approve ${ai.value.id}`);
    expect(out).toMatch(/E_REV/);
    const t = readOk(env.agent.store()!).tasks[0]!;
    expect(t.prompt).toBe("swapped under the reviewer");
    expect(isApproved(t)).toBe(false);
  });

  it("declining the confirm leaves it pending; a typed/web hash skips the confirm and CASes; wrong hash ⇒ E_REV; web via", async () => {
    env = a3Env();
    const h = harness(env);
    const ai = await createTask(env.ports, basicRaw(), AI);
    if (!ai.ok) throw new Error(ai.detail);
    h.setConfirm(() => false);
    expect(await h.run(`approve ${ai.value.id}`)).toMatch(/已取消/);
    expect(isApproved(readOk(env.agent.store()!).tasks[0]!)).toBe(false);
    expect(await h.run(`approve ${ai.value.id} ${"a".repeat(64)}`)).toMatch(/E_REV/);
    expect(h.confirms).toHaveLength(1); // the hashed forms never opened a dialog
    expect(await h.run(`approve ${ai.value.id} nothex`)).toMatch(/64 位十六进制/);
    expect(await h.run(`approve ${ai.value.id} ${defHash(ai.value)}`, { webInvocation: true })).toMatch(/已批准/);
    expect(readOk(env.agent.store()!).tasks[0]!.approval?.via).toBe("web");
  });
});

describe("pause / resume / rm / run / repair", () => {
  it("pause→resume; resume of a pending task warns it is NOT approved; rm deletes", async () => {
    env = a3Env();
    const h = harness(env);
    await h.run(ADD);
    const id = readOk(env.agent.store()!).tasks[0]!.id;
    expect(await h.run(`pause ${id}`)).toMatch(/已暂停/);
    expect(readOk(env.agent.store()!).tasks[0]!.enabled).toBe(false);
    expect(await h.run(`resume ${id}`)).toMatch(/已恢复/);
    const ai = await createTask(env.ports, basicRaw({ name: "ai" }), AI);
    if (!ai.ok) throw new Error(ai.detail);
    expect(await h.run(`resume ${ai.value.id}`)).toMatch(/恢复不等于批准/);
    expect(await h.run(`rm ${id}`)).toMatch(/已删除/);
    expect(readOk(env.agent.store()!).tasks.map((t) => t.id)).toEqual([ai.value.id]);
    expect(await h.run("rm")).toMatch(/用法/);
    expect(await h.run("rm s_zzzzzzzz")).toMatch(/E_INVALID/);
  });

  it("run: pending ⇒ E_UNAPPROVED hint; approved ⇒ started through the executor", async () => {
    env = a3Env();
    const seen: string[] = [];
    env.agent.setExecutor("background", { dispatch: (r) => void seen.push(r.runKey) });
    const h = harness(env);
    const ai = await createTask(env.ports, basicRaw(), AI);
    if (!ai.ok) throw new Error(ai.detail);
    expect(await h.run(`run ${ai.value.id}`)).toMatch(/E_UNAPPROVED.*approve/);
    await h.run(`approve ${ai.value.id} ${defHash(ai.value)}`);
    expect(await h.run(`run ${ai.value.id}`)).toMatch(/已开始运行/);
    expect(seen).toHaveLength(1);
    expect(await h.run(`run ${ai.value.id}`)).toMatch(/E_OVERLAP/);
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
    await addTask(other, t, env.fake.now()); // pending (no approval)
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

  it("approve --all reviews + CASes under the foreign lock; pause/resume/rm --all work; resume never approves", async () => {
    const { h, other, foreign } = await twoSessions();
    const out = await h.run(`approve ${foreign.id} --all`);
    expect(out).toMatch(/已批准/);
    expect(h.confirms[0]!.message).toContain(defHash(foreign));
    expect(isApproved(readOk(other).tasks[0]!)).toBe(true);
    expect(await h.run(`pause ${foreign.id} --all`)).toMatch(/已暂停/);
    expect(readOk(other).tasks[0]!.enabled).toBe(false);
    expect(await h.run(`resume ${foreign.id} --all`)).toMatch(/已恢复/);
    expect(await h.run(`rm ${foreign.id} --all`)).toMatch(/已删除/);
    expect(readOk(other).tasks).toHaveLength(0);
    // an id found nowhere
    expect(await h.run(`rm s_zzzzzzzz --all`)).toMatch(/都没有任务/);
  });

  it("resume --all of a never-approved foreign task leaves it pending", async () => {
    const { h, other, foreign } = await twoSessions();
    await h.run(`pause ${foreign.id} --all`);
    expect(await h.run(`resume ${foreign.id} --all`)).toMatch(/恢复不等于批准/);
    expect(isApproved(readOk(other).tasks[0]!)).toBe(false);
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

describe("__put — frozen web review contract", () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ name: "web", when: CRON, prompt: "from the web form", feishu: true, ...over });
  const ZERO = "0".repeat(64);

  it("preview (all-zero hash) returns the hash to bind and writes nothing; a matching hash creates an APPROVED web task", async () => {
    env = a3Env();
    const h = harness(env);
    const prev = await h.run(`__put ${body()} ${ZERO}`, { webInvocation: true });
    const hash = /^PREVIEW defHash=([0-9a-f]{64})/.exec(prev)?.[1];
    expect(hash).toBeDefined();
    expect(env.agent.readState().kind).toBe("absent");
    const ok = await h.run(`__put ${body()} ${hash}`, { webInvocation: true });
    const id = /^OK (s_[a-z2-7]{8}) defHash=([0-9a-f]{64})$/.exec(ok);
    expect(id?.[2]).toBe(hash);
    const t = readOk(env.agent.store()!).tasks[0]!;
    expect(t.approval).toMatchObject({ hash, via: "web" });
    expect(t.createdVia).toBe("web");
  });

  it("a non-matching hash is E_REV and nothing is written (content differs from what was reviewed)", async () => {
    env = a3Env();
    const h = harness(env);
    const prev = await h.run(`__put ${body()} ${ZERO}`);
    const hash = /defHash=([0-9a-f]{64})/.exec(prev)![1]!;
    const out = await h.run(`__put ${body({ prompt: "tampered" })} ${hash}`);
    expect(out).toMatch(/E_REV/);
    expect(env.agent.readState().kind).toBe("absent");
  });

  it("edit needs baseHash; a stale baseHash is E_REV; a reviewed edit approves a previously pending task", async () => {
    env = a3Env();
    const h = harness(env);
    const ai = await createTask(env.ports, basicRaw(), AI);
    if (!ai.ok) throw new Error(ai.detail);
    const base = defHash(ai.value);
    const edit = { id: ai.value.id, baseHash: base, name: "daily", when: CRON, prompt: "reviewed edit" };
    expect(await h.run(`__put ${JSON.stringify({ ...edit, baseHash: undefined })} ${ZERO}`)).toMatch(/必须带 baseHash/);
    const prev = await h.run(`__put ${JSON.stringify(edit)} ${ZERO}`);
    const hash = /defHash=([0-9a-f]{64})/.exec(prev)![1]!;
    expect(isApproved(readOk(env.agent.store()!).tasks[0]!)).toBe(false); // preview wrote nothing
    expect(await h.run(`__put ${JSON.stringify({ ...edit, baseHash: "f".repeat(64) })} ${hash}`)).toMatch(/E_REV/);
    expect(await h.run(`__put ${JSON.stringify(edit)} ${hash}`)).toMatch(/^OK /);
    const t = readOk(env.agent.store()!).tasks[0]!;
    expect(t.prompt).toBe("reviewed edit");
    expect(t.approval?.hash).toBe(hash);
    expect(t.createdBy).toBe("agent"); // provenance is kept
  });

  it("malformed input: no hash, bad json, unknown field, baseHash on create, bad id", async () => {
    env = a3Env();
    const h = harness(env);
    expect(await h.run(`__put ${body()}`)).toMatch(/用法/);
    expect(await h.run(`__put {nope ${ZERO}`)).toMatch(/json 无法解析/);
    expect(await h.run(`__put ${body({ approval: {} })} ${ZERO}`)).toMatch(/未知字段 approval/);
    expect(await h.run(`__put ${body({ baseHash: "a".repeat(64) })} ${ZERO}`)).toMatch(/创建不能带 baseHash/);
    expect(await h.run(`__put ${body({ id: "bad", baseHash: "a".repeat(64) })} ${ZERO}`)).toMatch(/id 无效/);
    expect(env.agent.readState().kind).toBe("absent");
  });
});
