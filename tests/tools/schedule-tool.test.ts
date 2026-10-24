import { afterEach, describe, expect, it } from "vitest";
import { createScheduleTool, SCHEDULE_TOOL_DESCRIPTION } from "../../src/tools/schedule-tool.js";
import { createScheduleAgent } from "../../src/schedule/agent/wire.js";
import { defHash, isApproved } from "../../src/schedule/core/spec.js";
import { a3Env, type A3Env } from "../schedule/agent/a3-helpers.js";

let env: A3Env;
afterEach(() => env?.cleanup());

function tool(e: A3Env) {
  return createScheduleTool({ agent: () => e.agent, ports: () => e.ports, now: () => e.fake.now() });
}
async function call(e: A3Env, params: Record<string, unknown>) {
  const r = await tool(e).execute("id", params as never, undefined, undefined, {} as never);
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
    expect(t.description).toContain("approved by the USER");
    // two instances describe identically (the registered schema never depends on runtime state)
    expect(JSON.stringify(tool(a3Env()).parameters)).toBe(JSON.stringify(t.parameters));
    expect(JSON.stringify(t.parameters)).not.toContain("approval");
    expect((t.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
});

describe("schedule tool — create / approval semantics", () => {
  it("create ⇒ pending, and the result says the three things the model must know", async () => {
    env = a3Env();
    const r = await call(env, { action: "create", ...DAILY });
    expect(r.details).toMatchObject({ ok: true, pending: true });
    expect(r.text).toMatch(/PENDING USER APPROVAL/);
    expect(r.text).toContain("/schedule approve");
    expect(r.text).toMatch(/only runs while this session is open/);
    expect(r.text).toMatch(/result appears as a message in this session/);
    const st = env.agent.readState();
    if (st.kind !== "ok") throw new Error("state");
    expect(isApproved(st.state.tasks[0]!)).toBe(false);
  });

  it("run_now on a pending task ⇒ E_UNAPPROVED with a hint; nothing is claimed", async () => {
    env = a3Env();
    env.agent.setExecutor("background", { dispatch: () => undefined });
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const r = await call(env, { action: "run_now", id });
    expect(r.details).toMatchObject({ ok: false, code: "E_UNAPPROVED" });
    expect(r.text).toContain("pending the user's approval");
  });

  it("run_now on an approved task starts a run through the executor", async () => {
    env = a3Env();
    const seen: string[] = [];
    env.agent.setExecutor("background", { dispatch: (run) => void seen.push(run.runKey) });
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    // the USER approves (the tool has no such action)
    const store = env.agent.ensureStore();
    const { approveTask } = await import("../../src/schedule/core/claim.js");
    const snap = store.read();
    if (snap.kind !== "ok") throw new Error("state");
    await approveTask(store, id, defHash(snap.state.tasks[0]!), "tui");
    const r = await call(env, { action: "run_now", id });
    expect(r.details.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("update of an execution field returns the pending note; pause/resume never approve", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const u = await call(env, { action: "update", id, prompt: "changed" });
    expect(u.details).toMatchObject({ ok: true, pending: true });
    const r = await call(env, { action: "resume", id });
    expect(r.text).toMatch(/PENDING USER APPROVAL/);
    const p = await call(env, { action: "pause", id });
    expect(p.text).toMatch(/Paused task/);
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

  it("delete removes; list/get/history read the ledger", async () => {
    env = a3Env();
    const c = await call(env, { action: "create", ...DAILY });
    const id = c.details.id as string;
    const l = await call(env, { action: "list" });
    expect(l.text).toContain(id);
    expect(l.text).toContain("pending");
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
