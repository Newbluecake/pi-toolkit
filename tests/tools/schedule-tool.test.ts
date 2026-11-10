import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { getJsonSchemaToolParameters } from "@earendil-works/pi-ai/api/constrained-sampling";
import { manualClaim } from "../../src/schedule/core/claim.js";
import { finishRun } from "../../src/schedule/core/writer.js";
import { addTask, approve, makeTask, readOk } from "../schedule/core/fixtures.js";
import { afterEach, describe, expect, it } from "vitest";
import { createScheduleTool, SCHEDULE_TOOL_DESCRIPTION } from "../../src/tools/schedule-tool.js";
import { createScheduleAgent } from "../../src/schedule/agent/wire.js";
import { a3Env, stripApproval, type A3Env } from "../schedule/agent/a3-helpers.js";

let env: A3Env;
afterEach(() => env?.cleanup());

function tool(e: A3Env) {
  return createScheduleTool({ agent: () => e.agent, ports: () => e.ports, now: () => e.fake.now() });
}
async function call(e: A3Env, params: Record<string, unknown>, ctx: unknown = {}) {
  const r = await tool(e).execute("id", params as never, undefined, undefined, ctx as never);
  const text = (r.content[0] as { text: string }).text;
  return { text, details: r.details as Record<string, unknown> };
}
const DAILY = { name: "daily", cron: "0 8 * * *", tz: "Asia/Shanghai", prompt: "do the thing" };

describe("schedule tool — definition", () => {
  it("has a frozen, model-facing description without internal references", () => {
    env = a3Env();
    const t = tool(env);
    expect(t.description).toBe(SCHEDULE_TOOL_DESCRIPTION);
    for (const s of [t.description, t.promptSnippet ?? "", ...(t.promptGuidelines ?? [])])
      expect(s).not.toMatch(/[§]|architecture|r3 plan/);
    expect(t.description).toContain("tasks you create or change take effect immediately");
    expect(t.description).toContain("Only create or change a scheduled task when the user asked for it");
    for (const s of [t.description, t.promptSnippet ?? "", ...(t.promptGuidelines ?? [])])
      expect(s).not.toMatch(/approv|pending|\/schedule approve/i);
    expect(t.promptSnippet).toContain("takes effect immediately");
    expect((t.promptGuidelines ?? []).join("\n")).toContain("tell the user the task id and its next run");
    // two instances describe identically (the registered schema never depends on runtime state)
    expect(JSON.stringify(tool(a3Env()).parameters)).toBe(JSON.stringify(t.parameters));
    expect(JSON.stringify(t.parameters)).not.toContain("approval");
    expect((t.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
});

describe("schedule tool — create / approval semantics", () => {
  it("create ⇒ active immediately; result names the id, next run and the two facts the model must know; no approval is written", async () => {
    env = a3Env();
    const r = await call(env, { action: "create", ...DAILY });
    expect(r.details).toEqual({ ok: true, id: r.details.id });
    expect(r.text).toMatch(/active immediately\./);
    expect(r.text).toMatch(/Next run: 2026-01-02 08:00 Asia\/Shanghai\./);
    expect(r.text).not.toMatch(/PENDING|approv|\/schedule/i);
    expect(r.text).toMatch(/only runs while this session is open/);
    expect(r.text).toMatch(/result appears as a message in this session/);
    const st = env.agent.readState();
    if (st.kind !== "ok") throw new Error("state");
    expect(st.state.tasks[0]).not.toHaveProperty("approval");
  });

  it("create/update notify the TUI with the next run; no UI or a throwing UI is silent", async () => {
    env = a3Env();
    const msgs: Array<[string, unknown]> = [];
    const ctx = { ui: { notify: (m: string, k: unknown) => void msgs.push([m, k]) } };
    const c = await call(env, { action: "create", ...DAILY }, ctx);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]![0]).toContain(c.details.id as string);
    expect(msgs[0]![0]).toMatch(/已创建并启用，next run /);
    expect(msgs[0]![1]).toBe("info");
    await call(env, { action: "update", id: c.details.id, prompt: "changed" }, ctx);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]![0]).toMatch(/已更新并启用/);
    const boom = {
      ui: {
        notify: () => {
          throw new Error("x");
        },
      },
    };
    expect((await call(env, { action: "update", id: c.details.id, prompt: "again" }, boom)).details.ok).toBe(true);
    expect((await call(env, { action: "update", id: c.details.id, prompt: "again2" }, {})).details.ok).toBe(true);
    // failures never notify
    msgs.length = 0;
    await call(env, { action: "update", id: "s_zzzzzzzz", prompt: "x" }, ctx);
    expect(msgs).toHaveLength(0);
  });

  it("an old-ledger task with no approval: list shows no pending flag, run_now runs, resume/update never mention approval", async () => {
    env = a3Env();
    const seen: string[] = [];
    env.agent.setExecutor("background", { dispatch: (run) => void seen.push(run.runKey) });
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    await stripApproval(env, id);
    expect((await call(env, { action: "list" })).text).not.toMatch(/pending/);
    expect((await call(env, { action: "run_now", id })).details.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect((await call(env, { action: "resume", id })).text).toBe(`Resumed task ${id}. Task is scheduled.`);
    const u = await call(env, { action: "update", id, prompt: "touched" });
    expect(u.details).toEqual({ ok: true, id });
    expect(u.text).not.toMatch(/approv|pending/i);
  });

  it("run_now on a freshly created task starts a run at once (no user approval step)", async () => {
    env = a3Env();
    const seen: string[] = [];
    env.agent.setExecutor("background", { dispatch: (run) => void seen.push(run.runKey) });
    const c = await call(env, { action: "create", ...DAILY });
    const r = await call(env, { action: "run_now", id: c.details.id });
    expect(r.details.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("update of an execution field stays active; pause/resume work", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const u = await call(env, { action: "update", id, prompt: "changed" });
    expect(u.details).toEqual({ ok: true, id });
    expect(u.text).toMatch(/active immediately/);
    const p = await call(env, { action: "pause", id });
    expect(p.text).toMatch(/Paused task/);
    expect((await call(env, { action: "resume", id })).text).toMatch(/Task is scheduled\./);
  });

  it.each(["approval", "createdBy", "createdVia", "createdAt", "ownerCwd"])(
    "rejects the forbidden field %s even if the host did not enforce the schema",
    async (field) => {
      env = a3Env();
      const r = await call(env, { action: "create", ...DAILY, [field]: "x" });
      expect(r.details).toMatchObject({ ok: false, code: "E_INVALID" });
      expect(env.agent.readState().kind).toBe("absent");
    },
  );

  it("an id on create is refused; update needs a valid id and at least one field", async () => {
    env = a3Env();
    expect((await call(env, { action: "create", ...DAILY, id: "s_aaaaaaaa" })).details.code).toBe("E_INVALID");
    expect((await call(env, { action: "update", name: "x" })).details.code).toBe("E_INVALID");
    const c = await call(env, { action: "create", ...DAILY });
    expect((await call(env, { action: "update", id: c.details.id })).details.code).toBe("E_INVALID");
    expect(
      (await call(env, { action: "create", ...DAILY, cron: undefined, at: "2026-03-01T00:00", tz: undefined })).details
        .ok,
    ).toBe(true);
    expect((await call(env, { action: "create", ...DAILY, at: "2026-03-01T00:00" })).details.code).toBe("E_INVALID");
    expect((await call(env, { action: "create", name: "x", prompt: "p", tz: "UTC" })).details.code).toBe("E_INVALID");
  });

  it.each(["", null])("schema-bypassed create id=%j is unassigned, without mutating the input", async (id) => {
    env = a3Env();
    const params = { action: "create", ...DAILY, id };
    const r = await call(env, params);
    expect(params.id).toBe(id);
    expect(r.details).toEqual({ ok: true, id: expect.stringMatching(/^s_[a-z2-7]{8}$/) });
    expect(readOk(env.agent.store()!).tasks[0]!.id).toBe(r.details.id);
  });

  it("empty/null create id is the only forbidden-field exception; other reserved fields remain rejected", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    expect(c.details.ok).toBe(true);
    const before = ledgerBytes(env);
    for (const field of [
      "approval",
      "createdBy",
      "createdVia",
      "createdAt",
      "ownerCwd",
      "everyMs",
      "intervalMs",
      "anchorAt",
    ]) {
      for (const value of ["", null]) {
        const r = await call(env, { action: "create", ...DAILY, id: "", [field]: value });
        expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
        expect(r.text).toContain(`\`${field}\` cannot be set through this tool`);
        expect(ledgerBytes(env)).toEqual(before);
      }
    }
  });

  it("delete removes; list/get/history read the ledger", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const l = await call(env, { action: "list" });
    expect(l.text).toContain(id);
    expect(l.text).not.toContain("pending");
    const g = await call(env, { action: "get", id });
    expect(g.text).toContain("defHash:");
    expect(g.text).toContain("prompt:");
    expect((await call(env, { action: "history" })).text).toBe("No runs recorded.");
    expect((await call(env, { action: "delete", id })).details.ok).toBe(true);
    expect((await call(env, { action: "list" })).text).toBe("No scheduled tasks in this session.");
    expect((await call(env, { action: "get", id })).details.code).toBe("E_INVALID");
  });
});

describe("schedule tool — mode matrix (§3.3)", () => {
  it("print: reads allowed, every write E_MODE", async () => {
    env = a3Env({}, "print");
    expect((await call(env, { action: "list" })).details.ok).toBe(true);
    for (const action of ["create", "update", "pause", "resume", "delete", "run_now"])
      expect((await call(env, { action, id: "s_aaaaaaaa", ...DAILY })).details).toMatchObject({
        ok: false,
        code: "E_MODE",
      });
  });
  it("--no-session: create E_EPHEMERAL, the rest sees an empty session", async () => {
    env = a3Env({}, "ephemeral");
    expect((await call(env, { action: "create", ...DAILY })).details.code).toBe("E_EPHEMERAL");
    expect((await call(env, { action: "list" })).text).toBe("No scheduled tasks in this session.");
  });
  it.each([
    ["secure", "E_SECURE"],
    ["child", "E_CHILD"],
  ] as const)("%s mode refuses every action with %s", async (kind, code) => {
    env = a3Env();
    const agent = createScheduleAgent({
      ctx: { sessionManager: { getSessionId: () => "x" } } as never,
      mode: { kind, arm: false },
      sessionId: "x",
      self: undefined,
      dir: "/nonexistent",
      plain: false,
      inVault: () => false,
      clock: env.fake,
      warn: () => undefined,
      router: undefined,
    });
    const t = createScheduleTool({ agent: () => agent, ports: () => env.ports });
    for (const action of ["list", "create", "run_now"]) {
      const r = await t.execute(
        "i",
        { action, ...DAILY, id: "s_aaaaaaaa" } as never,
        undefined,
        undefined,
        {} as never,
      );
      expect(r.details).toMatchObject({ ok: false, code });
    }
  });
  it("no current session agent ⇒ E_NOT_OWNER", async () => {
    env = a3Env();
    const t = createScheduleTool({ agent: () => undefined, ports: () => env.ports });
    const r = await t.execute("i", { action: "list" } as never, undefined, undefined, {} as never);
    expect(r.details).toMatchObject({ ok: false, code: "E_NOT_OWNER" });
  });
});

describe("schedule report path rendering", () => {
  it.each(["short", "legacy"])(
    "get/history display an absolute %s report path without changing the ledger",
    async (format) => {
      env = a3Env();
      const store = env.agent.ensureStore();
      const task = approve(makeTask());
      await addTask(store, task, env.fake.now());
      const claim = await manualClaim(store, {
        taskId: task.id,
        reqId: "tool_path_request",
        holder: env.agent.holder!,
      });
      if (claim.kind !== "started") throw new Error("claim failed");
      const reportFile = format === "short" ? `reports/${task.id}-20260101-0800-2.md` : `reports/${"a".repeat(64)}.md`;
      await store.transact((d, ctx) => ({
        value: finishRun(d, claim.runKey, { state: "completed", reportFile }, ctx.now),
        write: true,
      }));
      const path = join(store.root.real, store.dirName, reportFile);
      for (const action of ["get", "history"]) {
        const result = await call(env, { action, id: task.id });
        expect(result.details.ok).toBe(true);
        expect(result.text).toContain(`report ${path}`);
        expect(result.text).not.toContain(`report ${reportFile}`);
      }
      expect(readOk(store).runs[0]!.reportFile).toBe(reportFile);
    },
  );
});

/** Read actual bytes, not a reserialized state: rejected calls must not even bump the ledger revision. */
function ledgerBytes(e: A3Env): Buffer {
  const store = e.agent.store();
  if (store === undefined) throw new Error("expected a temporary store");
  return readFileSync(join(store.root.real, store.dirName, "state.json"));
}

function promptExample(text: string): Record<string, unknown> {
  const match = text.match(/\{"action":"update","id":"[^"]+","prompt":"[^"]+"\}/);
  if (match === null) throw new Error("missing copyable prompt-only update example");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function sdkArguments(e: A3Env, args: Record<string, unknown>): Record<string, unknown> {
  return validateToolArguments(tool(e) as never, {
    type: "toolCall",
    id: "sdk-schedule-call",
    name: "schedule",
    arguments: args as never,
  }) as Record<string, unknown>;
}

describe("schedule tool — actionable errors at the execute boundary (#83)", () => {
  it.each([
    [
      { cron: "", at: "" },
      ["cron: string(empty, length=0, value hidden)", "at: string(empty, length=0, value hidden)"],
      "give exactly one of cron, at, every",
    ],
    [{ cron: "" }, ["cron: string(empty, length=0, value hidden)"], "when.expr must be a 5-field cron expression"],
    [{ at: "" }, ["at: string(empty, length=0, value hidden)"], 'when.at: expected "YYYY-MM-DDTHH:mm"'],
    [{ every: "" }, ["every: string(empty, length=0, value hidden)"], "every unit must be s/m/h/d"],
    [{ cron: "  " }, ["cron: string(length=2, value hidden)"], "when.expr must be a 5-field cron expression"],
    [{ tz: "UTC" }, ["tz: string(length=3, value hidden)"], "tz must accompany cron or at"],
    [
      { cron: "0 8 * * *", at: "2026-12-01T00:00" },
      ["cron: string(length=9, value hidden)", "at: string(length=16, value hidden)"],
      "give exactly one of cron, at, every",
    ],
    [
      { cron: "0 8 * * *", every: "90m" },
      ["cron: string(length=9, value hidden)", "every: string(length=3, value hidden)"],
      "give exactly one of cron, at, every",
    ],
    [
      { at: "2026-12-01T00:00", every: "90m" },
      ["at: string(length=16, value hidden)", "every: string(length=3, value hidden)"],
      "give exactly one of cron, at, every",
    ],
    [
      { cron: "0 8 * * *", at: "2026-12-01T00:00", every: "90m" },
      [
        "cron: string(length=9, value hidden)",
        "at: string(length=16, value hidden)",
        "every: string(length=3, value hidden)",
      ],
      "give exactly one of cron, at, every",
    ],
    [
      { every: "90m", tz: "UTC" },
      ["every: string(length=3, value hidden)", "tz: string(length=3, value hidden)"],
      "every uses elapsed UTC time; remove tz",
    ],
  ] as const)("explains %j without changing any ledger byte", async (fields, visibleFields, reason) => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const bytes = ledgerBytes(env);
    const changed = env.changed.n;
    const r = await call(env, { action: "update", id, prompt: "new full prompt", ...fields });
    expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(r.text).toContain(`E_INVALID: ${reason}`);
    for (const field of visibleFields) expect(r.text).toContain(field);
    expect(r.text).toContain("Empty strings are supplied values, not omission");
    expect(r.text).toContain("exactly one nonempty cron");
    expect(r.text).toContain("tz must accompany cron or at, never every");
    expect(r.text).toContain("omit unchanged cron/at/every/tz and all other unchanged fields");
    expect(r.text).toContain("Do not use empty strings, false or 0 as placeholders");
    expect(promptExample(r.text)).toEqual({ action: "update", id: "<当前id>", prompt: "<新完整提示>" });
    expect(r.text).not.toContain(id);
    expect(ledgerBytes(env)).toEqual(bytes);
    expect(env.changed.n).toBe(changed);
  });

  it.each(["cron", "at", "every"])("create with empty %s retains E_INVALID and gives a create example", async (key) => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const bytes = ledgerBytes(env);
    const r = await call(env, { action: "create", name: "invalid", prompt: "p", [key]: "" });
    expect(c.details.ok).toBe(true);
    expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(r.text).toContain(`${key}: string(empty, length=0, value hidden)`);
    expect(r.text).toContain("Empty strings are supplied values, not omission");
    expect(r.text).toContain('{"action":"create","name":"daily","cron":"0 8 * * *","prompt":"<完整提示>"}');
    expect(ledgerBytes(env)).toEqual(bytes);
  });

  it.each([
    [{ action: "update", prompt: "p" }, "`id` (s_xxxxxxxx) is required for update"],
    [{ action: "update", id: "" }, "`id` (s_xxxxxxxx) is required for update"],
    [{ op: "update", prompt: "p" }, "`action` is required"],
    [{ prompt: "p" }, "`action` is required"],
    [{ action: "edit", prompt: "p" }, "`action` is required"],
  ])("missing/invalid id or action: %j gets a concrete repair, not undefined", async (params, reason) => {
    env = a3Env();
    await call(env, { action: "create", ...DAILY });
    const bytes = ledgerBytes(env);
    const r = await call(env, params);
    expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(r.text).toContain(reason);
    expect(r.text).toContain('{"action":"list"}');
    expect(promptExample(r.text)).toEqual({ action: "update", id: "<当前id>", prompt: "<新完整提示>" });
    if ("op" in params || params.action !== "update") expect(r.text).toContain("use action, not op");
    expect(ledgerBytes(env)).toEqual(bytes);
  });

  it("nothing to update explains patch semantics and gives an executable minimal example", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const bytes = ledgerBytes(env);
    const r = await call(env, { action: "update", id });
    expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(r.text).toContain("nothing to update");
    expect(ledgerBytes(env)).toEqual(bytes);
    const example = promptExample(r.text);
    expect(example).toEqual({ action: "update", id: "<当前id>", prompt: "<新完整提示>" });
    const fixed = await call(env, { ...example, id });
    expect(fixed.details).toEqual({ ok: true, id });
    expect(readOk(env.agent.store()!).tasks[0]!.prompt).toBe("<新完整提示>");
  });

  it.each([
    { cron: "0 8 * * *", tz: "Asia/Shanghai" },
    { at: "2026-03-01T00:00", tz: "Asia/Shanghai" },
  ])("prompt-only update preserves when and all unspecified task fields: %j", async (when) => {
    env = a3Env();
    const c = await call(env, {
      action: "create",
      name: "keep name",
      prompt: "old full prompt",
      ...when,
      feishu: false,
      agentType: "reviewer",
      model: "provider/model",
      thinking: "high",
      timeoutS: 600,
      handoff: true,
      isolation: "worktree",
    });
    expect(c.details.ok).toBe(true);
    const id = c.details.id as string;
    expect((await call(env, { action: "pause", id })).details.ok).toBe(true);
    const before = structuredClone(readOk(env.agent.store()!).tasks[0]!);
    env.fake.advance(1000);
    const r = await call(env, { action: "update", id, prompt: "new complete prompt" });
    expect(r.details).toEqual({ ok: true, id });
    const after = readOk(env.agent.store()!).tasks[0]!;
    expect(after).toEqual({ ...before, prompt: "new complete prompt" });
    expect(after.when).toEqual(before.when);
    expect(after.enabled).toBe(false);
  });
});

describe("schedule tool — pinned SDK optional/null vs empty-string contract", () => {
  it("source schema requires only action; real SDK strict conversion makes optionals required-but-nullable", () => {
    env = a3Env();
    const t = tool(env);
    const original = JSON.stringify(t.parameters);
    expect(t.parameters.required).toEqual(["action"]);
    expect(t.parameters.properties.action.description).toContain('"action":"update","id":"<当前id>"');
    for (const key of ["cron", "at", "every"] as const) {
      expect(t.parameters.properties[key].description).toContain("Update: omit all three to keep the schedule");
      expect(t.parameters.properties[key].description).toContain("Empty string is not omission");
    }
    const strict = getJsonSchemaToolParameters(t as never, true);
    expect(strict.required).toEqual(Object.keys(t.parameters.properties));
    const properties = strict.properties as Record<string, { anyOf?: unknown[] }>;
    for (const key of Object.keys(t.parameters.properties).filter((k) => k !== "action")) {
      expect(properties[key]!.anyOf).toEqual(expect.arrayContaining([{ type: "null" }]));
    }
    expect(JSON.stringify(t.parameters)).toBe(original);
  });

  it("real SDK validation strips optional nulls BEFORE execute; the prompt-only update retains cron/tz", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const before = structuredClone(readOk(env.agent.store()!).tasks[0]!);
    // Simulate the required-but-nullable strict response, then pass it through the actual SDK validator.
    const input = {
      ...Object.fromEntries(Object.keys(tool(env).parameters.properties).map((key) => [key, null])),
      action: "update",
      id,
      prompt: "SDK new complete prompt",
    };
    const validated = sdkArguments(env, input);
    expect(input.cron).toBe(null); // SDK does not mutate transcript arguments.
    expect(validated).toEqual({ action: "update", id, prompt: "SDK new complete prompt" });
    expect(Object.hasOwn(validated, "cron")).toBe(false);
    const r = await call(env, validated); // Never execute(null) and call it SDK evidence.
    expect(r.details).toEqual({ ok: true, id });
    expect(readOk(env.agent.store()!).tasks[0]!).toEqual({ ...before, prompt: "SDK new complete prompt" });
  });

  it("real SDK validation preserves empty strings, so execute rejects cron+at without touching ledger bytes", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const input = { action: "update", id, prompt: "new", cron: "", at: "" };
    const validated = sdkArguments(env, input);
    expect(validated).toEqual(input);
    expect(Object.hasOwn(validated, "cron")).toBe(true);
    const bytes = ledgerBytes(env);
    const r = await call(env, validated);
    expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(r.text).toContain("cron: string(empty, length=0, value hidden), at: string(empty, length=0, value hidden)");
    expect(r.text).toContain("give exactly one of cron, at, every");
    expect(promptExample(r.text)).toEqual({ action: "update", id: "<当前id>", prompt: "<新完整提示>" });
    expect(r.text).not.toContain(id);
    expect(ledgerBytes(env)).toEqual(bytes);
  });

  it("SDK rejects a missing action before execute (op is not a schema parameter)", () => {
    env = a3Env();
    expect(() => sdkArguments(env, { op: "update", id: "s_aaaaaaaa", prompt: "p" })).toThrow(/action/);
  });
});

const FAKE_SECRET_83 = "FAKE_ACCEPTANCE_SECRET_83";

function assertBoundedPrivateError(r: Awaited<ReturnType<typeof call>>, hidden: readonly string[]): void {
  expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
  for (const value of hidden) expect(JSON.stringify(r)).not.toContain(value);
  expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(r.text.split("\n")[0]!)).toBeLessThanOrEqual(512 + "E_INVALID: ".length);
  expect(r.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(r.text).not.toContain("\\u001b");
  expect(r.text).not.toContain("\\nFORGED");
  expect(r.text.split("\n").length).toBeLessThanOrEqual(5);
  const summaries = r.text.match(/(?:cron|at|every|tz|action|id): [^\n)]*\)/g) ?? [];
  for (const summary of summaries) expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(80);
}

describe("schedule tool — bounded, value-free error presentation (#83 blocker)", () => {
  it.each(["cron", "at", "every", "tz"])(
    "SDK-valid million-character %s never expands execute.content",
    async (field) => {
      env = a3Env();
      const c = await call(env, { action: "create", ...DAILY });
      const id = c.details.id as string;
      const huge = FAKE_SECRET_83 + "X".repeat(1_000_000 - FAKE_SECRET_83.length);
      // These are legal SDK string arguments, not a direct-execute schema-bypass reproduction.
      const input = { action: "update", id, cron: "", at: "", [field]: huge };
      const validated = sdkArguments(env, input);
      expect(validated).toEqual(input);
      const bytes = ledgerBytes(env);
      const changed = env.changed.n;
      const r = await call(env, validated);
      assertBoundedPrivateError(r, [FAKE_SECRET_83, id]);
      expect(r.text).toContain("give exactly one of cron, at, every");
      expect(r.text).toContain(`${field}: string(length=1000000, value hidden)`);
      expect(promptExample(r.text)).toEqual({ action: "update", id: "<当前id>", prompt: "<新完整提示>" });
      expect(ledgerBytes(env)).toEqual(bytes);
      expect(env.changed.n).toBe(changed);
    },
  );

  it("all four huge fields stay individually and collectively bounded, including multibyte input", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const huge = `${FAKE_SECRET_83}\nFORGED\u001b[31m` + "界".repeat(1_000_000);
    const validated = sdkArguments(env, { action: "update", id, cron: huge, at: huge, every: huge, tz: huge });
    const bytes = ledgerBytes(env);
    const r = await call(env, validated);
    assertBoundedPrivateError(r, [FAKE_SECRET_83, "FORGED", "界", id]);
    expect(r.text).toContain("give exactly one of cron, at, every");
    for (const key of ["cron", "at", "every", "tz"]) {
      expect(r.text).toContain(`${key}: string(length=${huge.length}, value hidden)`);
    }
    expect(ledgerBytes(env)).toEqual(bytes);
  });

  it.each([
    [
      "short Bearer in conflicting cron",
      { cron: `Bearer ${FAKE_SECRET_83}`, at: "" },
      "give exactly one of cron, at, every",
    ],
    [
      "raw cron token in original detail",
      { cron: `${FAKE_SECRET_83} * * * *` },
      "cron: minute: bad value (value hidden)",
    ],
    [
      "raw cron step in original detail",
      { cron: `*/${FAKE_SECRET_83} * * * *` },
      "cron: minute: bad step in (value hidden)",
    ],
    [
      "raw timezone in original detail",
      { cron: "0 8 * * *", tz: `Bearer ${FAKE_SECRET_83}` },
      "when.tz: unsupported time zone (value hidden)",
    ],
    ["short at", { at: FAKE_SECRET_83 }, 'when.at: expected "YYYY-MM-DDTHH:mm"'],
    ["short every", { every: FAKE_SECRET_83 }, "every unit must be s/m/h/d"],
    [
      "newline and ESC in timezone detail",
      { cron: "0 8 * * *", tz: `${FAKE_SECRET_83}\nFORGED\u001b[31m` },
      "when.tz: unsupported time zone (value hidden)",
    ],
    [
      "newline and ESC in cron detail",
      { cron: `${FAKE_SECRET_83}\u001b[31m * * * *` },
      "cron: minute: bad value (value hidden)",
    ],
    [
      "invalid id with controls",
      { id: `${FAKE_SECRET_83}\nFORGED\u001b[31m`, prompt: "p" },
      "`id` (s_xxxxxxxx) is required for update",
    ],
    ["syntactically valid nonexistent id", { id: "s_secretsa", prompt: "p" }, "no such task (id hidden)"],
    [
      "agent registry detail",
      { agentType: `${FAKE_SECRET_83}\nFORGED\u001b[31m` },
      "unknown agent type (value hidden)",
    ],
    ["model detail", { model: `provider/${FAKE_SECRET_83}` }, "unknown model (value hidden)"],
    [
      "create with supplied id",
      { action: "create", id: FAKE_SECRET_83, ...DAILY },
      "`id` cannot be set through this tool",
    ],
  ] as const)("SDK-valid %s hides values without changing the ledger", async (_label, fields, reason) => {
    env = a3Env();
    env.ports.knownModel = () => false;
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const input = { action: "update", id, ...fields };
    const validated = sdkArguments(env, input);
    expect(validated).toEqual(input);
    const bytes = ledgerBytes(env);
    const changed = env.changed.n;
    const r = await call(env, validated);
    assertBoundedPrivateError(r, [FAKE_SECRET_83, "FORGED", "s_secretsa", id]);
    expect(r.text).toContain(reason);
    expect(ledgerBytes(env)).toEqual(bytes);
    expect(env.changed.n).toBe(changed);
  });

  it("single huge timezone is hidden from the original operation detail, not just the field summary", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const tz = FAKE_SECRET_83 + "X".repeat(1_000_000);
    const validated = sdkArguments(env, { action: "update", id, cron: "0 8 * * *", tz });
    const bytes = ledgerBytes(env);
    const r = await call(env, validated);
    assertBoundedPrivateError(r, [FAKE_SECRET_83, id]);
    expect(r.text).toContain("when.tz: unsupported time zone (value hidden)");
    expect(r.text).toContain(`tz: string(length=${tz.length}, value hidden)`);
    expect(ledgerBytes(env)).toEqual(bytes);
  });

  it.each([FAKE_SECRET_83, `${FAKE_SECRET_83}\nFORGED\u001b[31m`, FAKE_SECRET_83 + "X".repeat(1_000_000)])(
    "schema-bypassed action is summarized, never interpolated (case %#)",
    async (action) => {
      env = a3Env();
      const c = await call(env, { action: "create", ...DAILY });
      const id = c.details.id as string;
      const bytes = ledgerBytes(env);
      // Invalid enum values cannot pass the SDK; exercise the tool's defensive boundary separately.
      const r = await call(env, { action, id, prompt: "p" });
      assertBoundedPrivateError(r, [FAKE_SECRET_83, "FORGED", id]);
      expect(r.text).toContain("`action` is required");
      expect(r.text).toContain(`action: string(length=${action.length}, value hidden)`);
      expect(promptExample(r.text)).toEqual({ action: "update", id: "<当前id>", prompt: "<新完整提示>" });
      expect(ledgerBytes(env)).toEqual(bytes);
    },
  );

  it("a noncredential-looking private value is hidden too; no credential-pattern heuristic", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const privateValue = "innocuousPrivateWord";
    const id = c.details.id as string;
    const bytes = ledgerBytes(env);
    const r = await call(env, sdkArguments(env, { action: "update", id, cron: `${privateValue} * * * *` }));
    assertBoundedPrivateError(r, [privateValue, id]);
    expect(r.text).toContain("cron: minute: bad value (value hidden)");
    expect(ledgerBytes(env)).toEqual(bytes);
  });
});
