import { describe, expect, it } from "vitest";
import type { SetModelOutcome } from "../../src/core/types.js";
import { createSetModelTool, type SetModelToolDeps } from "../../src/tools/set-model-tool.js";
import { MSG_SET_MODEL_ON_EXTERNAL, MSG_SET_MODEL_TO_EXTERNAL } from "../../src/external-agent/messages.js";

const pi = [{ provider: "anthropic", id: "claude-haiku-4" }];
function deps(over: Partial<SetModelToolDeps> = {}, outcome?: SetModelOutcome): SetModelToolDeps {
  return {
    host: {
      setModel: async () => true,
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => undefined,
      findModel: (p, id) => pi.find((c) => c.provider === p && c.id === id),
    },
    runs: { setModel: async (_r, model) => outcome ?? { ok: true, model } },
    available: () => pi,
    resolveRun: (h) => ({ ok: true, runId: `resolved:${h}` }),
    ...over,
  };
}
const run = (d: SetModelToolDeps, params: Record<string, unknown>) =>
  createSetModelTool(d).execute("tc", params as never, undefined, undefined, {} as never);
const owns = (p: string) => p === "droid";

describe("set_model with the external port", () => {
  it("switching TO droid/* is rejected (host self, host foreign, run form)", async () => {
    await expect(run(deps({ externalOwns: owns }), { model: "droid/gpt-6-luna" })).rejects.toThrow(
      MSG_SET_MODEL_TO_EXTERNAL,
    );
    await expect(run(deps({ externalOwns: owns }), { model: "droid/x", run_id: "r9" })).rejects.toThrow(
      MSG_SET_MODEL_TO_EXTERNAL,
    );
    await expect(run(deps({ externalOwns: owns, selfRunId: "r1" }), { model: "droid/x" })).rejects.toThrow(
      MSG_SET_MODEL_TO_EXTERNAL,
    );
  });
  it("pi targets still work with the port present", async () => {
    const r = await run(deps({ externalOwns: owns }), { model: "anthropic/claude-haiku-4" });
    expect(r.details).toMatchObject({ ok: true });
  });
  it("externalOwns absent: droid/x follows the original unknown-model path", async () => {
    await expect(run(deps(), { model: "droid/x" })).rejects.toThrow(
      "unknown model: droid/x (not available in this installation — check the provider auth)",
    );
  });
  it("unsupported on a foreign run: reworded only when the port is present", async () => {
    const unsupported: SetModelOutcome = { ok: false, reason: "unsupported" };
    await expect(
      run(deps({ externalOwns: owns }, unsupported), { model: "anthropic/claude-haiku-4", run_id: "r9" }),
    ).rejects.toThrow(MSG_SET_MODEL_ON_EXTERNAL);
    await expect(run(deps({}, unsupported), { model: "anthropic/claude-haiku-4", run_id: "r9" })).rejects.toThrow(
      "this session cannot switch models mid-run",
    );
  });
});
