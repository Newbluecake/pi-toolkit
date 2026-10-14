import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { ExternalRunMeta, RunId, RunSnapshot } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { SpawnService } from "../../src/service/spawn-service.js";
import { wireConsult } from "../../src/consult/index.js";
import type { ConsultForkStore } from "../../src/consult/tool.js";
import { msgExpertIsExternal } from "../../src/external-agent/messages.js";

let tmp: string;
let consultDir: string;
let piFile: string;
let extFile: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "consult-ext-"));
  consultDir = join(tmp, "cache", "consult-sessions");
  mkdirSync(join(tmp, "external-agent", "droid", "sessions"), { recursive: true });
  piFile = join(tmp, "pi.jsonl");
  extFile = join(tmp, "external-agent", "droid", "sessions", "abcdefgh1.jsonl");
  writeFileSync(piFile, "{}\n");
  writeFileSync(extFile, "{}\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function snap(o: {
  runId: RunId;
  label: string;
  sessionFile: string;
  model?: { provider: string; id: string };
  external?: ExternalRunMeta;
}): RunSnapshot {
  return {
    runId: o.runId,
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      label: o.label,
      agentType: "worker",
      sessionFile: o.sessionFile,
      ...(o.model ? { model: o.model } : {}),
      ...(o.external ? { external: o.external } : {}),
    },
    updatedAt: 1,
  };
}
function wiring(live: RunSnapshot[], isExternalProvider?: (p: string) => boolean, entries?: unknown[]) {
  const query = {
    get: (id: string) => live.find((s) => s.runId === id),
    list: () => [...live],
  } as unknown as QueryService;
  const forkStore = { removeForkFile: () => undefined } as unknown as ConsultForkStore;
  return wireConsult({
    settings: () => ({ ...DEFAULT_SETTINGS.consult }),
    query,
    spawnService: {} as Pick<SpawnService, "spawn" | "waitOutcome" | "abort">,
    priceOf: () => undefined,
    forkStore,
    consultDir,
    ...(entries ? { prefetchedEntries: entries } : {}),
    ...(isExternalProvider ? { isExternalProvider } : {}),
  });
}

describe("resolveExperts: external runs are never consultable", () => {
  it("diag.external ⇒ rejected with msgExpertIsExternal (even with a pi-looking session file)", () => {
    const w = wiring([snap({ runId: "r_EXT00001", label: "e", sessionFile: piFile, external: { provider: "droid" } })]);
    expect(() => w.resolveExperts(["e"])).toThrow(msgExpertIsExternal("r_EXT00001"));
  });
  it("session file under <agentDir>/external-agent ⇒ rejected (live and index paths)", () => {
    const live = wiring([snap({ runId: "r_EXT00002", label: "e2", sessionFile: extFile })]);
    expect(() => live.resolveExperts(["r_EXT00002"])).toThrow(msgExpertIsExternal("r_EXT00002"));
    const entry = {
      type: "custom",
      customType: "subagent:run",
      data: snap({ runId: "r_EXT00003", label: "e3", sessionFile: extFile }),
    };
    const idx = wiring([], undefined, [entry]);
    expect(() => idx.resolveExperts(["r_EXT00003"])).toThrow(msgExpertIsExternal("r_EXT00003"));
  });
  it("isExternalProvider claims the model provider ⇒ rejected", () => {
    const w = wiring(
      [snap({ runId: "r_EXT00004", label: "e4", sessionFile: piFile, model: { provider: "droid", id: "m" } })],
      (p) => p === "droid",
    );
    expect(() => w.resolveExperts(["e4"])).toThrow(msgExpertIsExternal("r_EXT00004"));
  });
  it("isExternalProvider absent: a pi run whose provider is literally 'droid' is NOT rejected", () => {
    const w = wiring([
      snap({ runId: "r_PI000001", label: "p", sessionFile: piFile, model: { provider: "droid", id: "m" } }),
    ]);
    const res = w.resolveExperts(["p"]);
    expect(res.refs[0]?.runId).toBe("r_PI000001");
  });
  it("isExternalProvider present but not claiming: ordinary pi run still resolves", () => {
    const w = wiring(
      [snap({ runId: "r_PI000002", label: "p2", sessionFile: piFile, model: { provider: "anthropic", id: "m" } })],
      (p) => p === "droid",
    );
    expect(w.resolveExperts(["p2"]).refs).toHaveLength(1);
  });
});
