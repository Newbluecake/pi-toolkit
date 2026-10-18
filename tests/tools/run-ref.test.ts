import { describe, expect, it, vi } from "vitest";
import type { Text } from "@earendil-works/pi-tui";
import type { RunSnapshot } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import { createAbortTool } from "../../src/tools/abort-tool.js";
import { createExtendTimeoutTool } from "../../src/tools/extend-timeout-tool.js";
import { createSetModelTool } from "../../src/tools/set-model-tool.js";
import { cleanLabel, runRefText, runRefTitle, titleForHandle } from "../../src/tools/run-ref.js";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const ctx = { lastComponent: undefined, state: {} } as never;
const RID = "r_CWZSH5BE";
const LABEL = "dev-consult-C-follow-ups";
const snap = (label?: string, status = "running") =>
  ({
    runId: RID,
    generation: 1,
    status,
    phase: "run",
    deadlines: {},
    diag: label ? { label } : {},
    updatedAt: 0,
  }) as RunSnapshot;
const resolveRun = (h: string) => ({ ok: true as const, runId: h === LABEL || h === "r_CWZ" ? RID : h });
const render = (c: unknown) => (c as Text).render(200).join("\n");

describe("run-ref helpers", () => {
  it("formats with and without label; blank label ⇒ bare fallback (no undefined / empty parens)", () => {
    expect(runRefText(RID, LABEL)).toBe(`${LABEL} (run_id: ${RID})`);
    expect(runRefText(RID, undefined)).toBe(`run ${RID}`);
    expect(runRefText(RID, "  \n ")).toBe(`run ${RID}`);
    expect(runRefTitle(RID, LABEL)).toBe(`${LABEL} (${RID})`);
    expect(runRefTitle(RID, undefined)).toBe(RID);
    expect(cleanLabel("x".repeat(100))!.length).toBe(48);
    expect(cleanLabel("a\nb\tc")).toBe("a b c");
  });
  it("titleForHandle resolves a label/prefix; misses and throws fall back to the raw handle", () => {
    const get = () => snap(LABEL);
    expect(titleForHandle(LABEL, { resolveRun, get })).toBe(`${LABEL} (${RID})`);
    expect(titleForHandle("r_CWZ", { resolveRun, get })).toBe(`${LABEL} (${RID})`);
    expect(titleForHandle("zzz", { resolveRun: () => ({ ok: false, error: "x" }) as never, get })).toBe("zzz");
    expect(
      titleForHandle("zzz", {
        resolveRun: () => {
          throw new Error("boom");
        },
        get,
      }),
    ).toBe("zzz");
    expect(titleForHandle(RID, { resolveRun, get: () => snap() })).toBe(RID);
    expect(titleForHandle(undefined, {})).toBe("…");
  });
});

describe("steer_subagent label display", () => {
  const mk = (label?: string) =>
    createSteerTool({
      query: { get: () => snap(label), steer: async () => ({ ok: true }) } as unknown as QueryService,
      resolveRun,
    });
  it("renderCall title + result text + details carry the label", async () => {
    const t = mk(LABEL);
    expect(render(t.renderCall!({ run_id: RID, text: "go" } as never, theme, ctx))).toContain(
      `Steer Subagent: ${LABEL} (${RID})`,
    );
    const out = await t.execute("t", { run_id: LABEL, text: "go" } as never);
    expect((out.content[0] as { text: string }).text).toBe(`Sent follow-up instruction to ${LABEL} (run_id: ${RID}).`);
    expect(out.details).toEqual({ ok: true, runId: RID, label: LABEL });
  });
  it("no label ⇒ exactly the legacy text and details", async () => {
    const t = mk(undefined);
    expect(render(t.renderCall!({ run_id: RID, text: "go" } as never, theme, ctx))).toContain(`Steer Subagent: ${RID}`);
    const out = await t.execute("t", { run_id: RID, text: "go" } as never);
    expect((out.content[0] as { text: string }).text).toBe(`Sent follow-up instruction to run ${RID}.`);
    expect(out.details).toEqual({ ok: true, runId: RID });
  });
  it("errors for a resolved labeled run name it", async () => {
    const t = createSteerTool({
      query: {
        get: () => snap(LABEL, "completed"),
        steer: async () => ({ ok: false, reason: "not_running" }),
      } as unknown as QueryService,
      resolveRun,
    });
    await expect(t.execute("t", { run_id: LABEL, text: "go" } as never)).rejects.toThrow(
      `${LABEL} (run_id: ${RID}) is not currently running`,
    );
  });
});

describe("abort_subagent label display", () => {
  const mk = (label: string | undefined, res: unknown) =>
    createAbortTool({
      query: { get: () => snap(label), stop: vi.fn(async () => res) } as unknown as QueryService,
      resolveRun,
    });
  it("labeled: title, text, details", async () => {
    const t = mk(LABEL, { ok: true, escalatedTo: "L2" });
    expect(render(t.renderCall!({ run_id: LABEL } as never, theme, ctx))).toContain(
      `Abort Subagent: ${LABEL} (${RID})`,
    );
    const out = await t.execute("t", { run_id: LABEL } as never, undefined, undefined, {} as never);
    expect((out.content[0] as { text: string }).text).toContain(
      `Abort requested for ${LABEL} (run_id: ${RID}) (escalation: L2)`,
    );
    expect(out.details).toMatchObject({ runId: RID, label: LABEL });
  });
  it("unlabeled: legacy text; terminal case labeled", async () => {
    const out = await mk(undefined, { ok: true, escalatedTo: "L2" }).execute(
      "t",
      { run_id: RID } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect((out.content[0] as { text: string }).text).toContain(`Abort requested for run ${RID} (escalation`);
    expect(out.details).not.toHaveProperty("label");
    const done = await mk(LABEL, { ok: false, reason: "already_terminal", status: "completed" }).execute(
      "t",
      { run_id: RID } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect((done.content[0] as { text: string }).text).toContain(`${LABEL} (run_id: ${RID}) has already reached`);
  });
});

describe("extend_subagent_timeout label display", () => {
  const ok = {
    ok: true,
    runId: RID,
    previousDeadlineAt: 1,
    deadlineAt: 610_000,
    requestedMs: 600_000,
    grantedMs: 600_000,
    clamped: false,
    extensionsUsed: 1,
    extensionsRemaining: 2,
    hardDeadlineAt: 1_210_000,
    rescuedFromGrace: false,
  };
  const mk = (label?: string, res: unknown = ok) =>
    createExtendTimeoutTool({
      query: { get: () => snap(label), extendTimeout: () => res } as unknown as QueryService,
      resolveRun,
      now: () => 10_000,
    });
  it("labeled: title/text/details; unlabeled: legacy", async () => {
    const t = mk(LABEL);
    expect(render(t.renderCall!({ run_id: LABEL, extend_s: 600 } as never, theme, ctx))).toContain(`${LABEL} (${RID})`);
    const out = await t.execute("t", { run_id: LABEL, extend_s: 600 } as never);
    expect((out.content[0] as { text: string }).text).toContain(`Extended ${LABEL} (run_id: ${RID.slice(0, 8)}) by`);
    expect(out.details).toMatchObject({ runId: RID, label: LABEL });
    const bare = await mk(undefined).execute("t", { run_id: RID, extend_s: 600 } as never);
    expect((bare.content[0] as { text: string }).text).toContain(`Extended run ${RID.slice(0, 8)} by`);
    expect(bare.details).toBe(ok);
  });
  it("rejection names the labeled run", async () => {
    const t = mk(LABEL, { ok: false, reason: "already_terminal" });
    await expect(t.execute("t", { run_id: LABEL, extend_s: 600 } as never)).rejects.toThrow(
      `${LABEL} (run_id: ${RID.slice(0, 8)}) already finished`,
    );
  });
});

describe("set_model run_id label display", () => {
  const mk = (label?: string, outcome: unknown = { ok: true, model: { provider: "a", id: "b" } }) =>
    createSetModelTool({
      host: {
        setModel: async () => true,
        getThinkingLevel: () => undefined,
        setThinkingLevel: () => undefined,
        findModel: () => ({}),
      },
      runs: { setModel: async () => outcome as never },
      resolveHint: () => ({ provider: "a", id: "b" }),
      resolveRun,
      labelOf: () => label,
    });
  it("labeled success/err + renderCall target; unlabeled keeps the raw handle", async () => {
    const t = mk(LABEL);
    expect(render(t.renderCall!({ model: "b", run_id: LABEL } as never, theme, ctx))).toContain(
      `target: ${LABEL} (${RID})`,
    );
    const out = await t.execute("t", { model: "b", run_id: LABEL } as never, undefined, undefined, {} as never);
    expect((out.content[0] as { text: string }).text).toContain(`Model for ${LABEL} (run_id: ${RID}) set to a/b`);
    expect(out.details).toMatchObject({ target: RID, runId: RID, label: LABEL });
    await expect(
      mk(LABEL, { ok: false, reason: "not_running" }).execute(
        "t",
        { model: "b", run_id: LABEL } as never,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(`${LABEL} (run_id: ${RID}) is not currently running`);
    const bare = await mk(undefined).execute(
      "t",
      { model: "b", run_id: RID } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect((bare.content[0] as { text: string }).text).toContain(`Model for ${RID} set to a/b`);
    expect(bare.details).not.toHaveProperty("label");
  });
});
