import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock } from "../../src/core/clock.js";
import { classifiedInfo } from "../../src/core/errors.js";
import { createInitialState } from "../../src/core/state-machine.js";
import type { AgentTypeConfig, RunSnapshot, SpawnRequest } from "../../src/core/types.js";
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS } from "../../src/config/settings.js";
import { formatAvailableModelsForPrompt } from "../../src/config/available-models.js";
import { createExternalAgentsPort } from "../../src/external-agent/port.js";
import type { ExternalSessionHandle } from "../../src/external-agent/types.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { availableModelsSection } from "../../src/sysprompt/core-sections.js";
import { makeSpec } from "./droid/fakes.js";

const roots: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

/** Real managed child + RPC + provider + port. Only the CLI is an offline fixture. */
function harness(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "droid-availability-"));
  roots.push(root);
  const modeFile = join(root, "mode");
  const cli = join(root, "cli.mjs");
  const binary = join(root, "droid");
  const script = join(root, "turn.jsonl");
  const trace = join(root, "trace.log");
  writeFileSync(trace, "");
  const fixture = new URL("./fixtures/fake-droid.mjs", import.meta.url).href;
  writeFileSync(modeFile, mode);
  writeFileSync(
    script,
    [
      { notify: { type: "droid_working_state_changed", newState: "thinking" } },
      { notify: { type: "error", message: "No access token SECRET-FACTORY-KEY" } },
      { notify: { type: "agent_turn_completed", turnId: "auth", reason: "completed", tokenUsage: {} } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  writeFileSync(
    cli,
    `import { readFileSync } from "node:fs";
process.env.DROID_TRACE_FILE = ${JSON.stringify(trace)};
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8");
if (mode === "auth-setup") { console.error("No access token SECRET-FACTORY-KEY"); process.exit(1); }
process.argv = [process.argv[0], ${JSON.stringify(fileURLToPath(fixture))}, "--mode", mode,
  ...(mode === "auth-turn" ? ["--script", ${JSON.stringify(script)}] : [])];
await import(${JSON.stringify(fixture)});
`,
  );
  writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
  chmodSync(binary, 0o755);
  const assembled = createExternalAgentsPort({
    settings: {
      droid: {
        ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid,
        enabled: true,
        binary,
        models: ["gpt-6-luna"],
        killGraceMs: 200,
      },
    },
    clock: systemClock,
    agentDir: root,
    registry: () => [],
    piProviders: () => [],
    warnOnce: () => {},
  })!;
  cleanup.push(() => assembled.port.dispose());
  const provider = assembled.providers.get("droid")!;
  const create = async () => {
    const handle = await provider.create(makeSpec({ cwd: root, persist: true }));
    cleanup.push(() => {
      handle.dispose();
    });
    handle.attach(() => {});
    return handle;
  };
  const registration = availableModelsSection({
    stackAvailable: () => [{ provider: "pi", id: "native" }],
    externalModels: () => [{ provider: "droid", models: assembled.port.advertised(), total: 1 }],
  });
  const prompt = () =>
    registration.provider({ ctx: { scopedModels: [] } as unknown as ExtensionContext, promptText: "" });
  const probeCatalog = async () => {
    writeFileSync(trace, "");
    provider.catalog.refreshInBackground("stale");
    // close_session is sent only after the probe has consumed a successful init response/catalog.
    await vi.waitFor(() => expect(readFileSync(trace, "utf8")).toContain("droid.close_session"));
    expect(provider.catalog.snapshot()?.models.length).toBeGreaterThan(0);
  };
  return {
    root,
    port: assembled.port,
    provider,
    create,
    prompt,
    probeCatalog,
    setMode: (m: string) => writeFileSync(modeFile, m),
  };
}

function admission(port: ReturnType<typeof harness>["port"], root: string, handle: ExternalSessionHandle) {
  const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
  const initial = createInitialState("r_PREVIOUS1", 1, 0);
  const previous: RunSnapshot = {
    ...initial,
    status: "completed",
    phase: "settled",
    updatedAt: 1,
    diag: { ...initial.diag, model: { provider: "droid", id: "gpt-6-luna" }, sessionFile: handle.sessionFile! },
  };
  const run = vi.fn(async (): Promise<never> => {
    throw new Error("unavailable admission must never reach H2/runner");
  });
  const label = vi.fn();
  const acquire = vi.fn(async () => ({ ok: true as const, ticket: { runId: "unused", release() {} } }));
  const service = createSpawnService({
    external: port,
    agentDir: root,
    now: Date.now,
    types: {
      get: () => type,
      list: () => [type],
      configHashOf: () => undefined,
      reload: async () => ({ types: [type], errors: [] }),
    },
    runner: { run },
    pool: { acquire },
    onLabel: label,
    durableRecords: () => [previous],
  });
  cleanup.push(() => service.dispose?.());
  return { service, run, label, acquire };
}

describe("droid availability: real offline run → prompt → admission", () => {
  it.each(["auth-turn", "http-402"])(
    "%s hides the models, rejects all dispatch shapes and resume, then a successful run recovers",
    async (mode) => {
      vi.stubEnv("FACTORY_API_KEY", "SECRET-FACTORY-KEY");
      const h = harness(mode);
      expect(h.prompt()).toContain("### External agent models (droid)");
      const handle = await h.create();
      await handle.prompt("hello");
      expect(handle.getTurnErrorInfo?.()).toMatchObject({ kind: "auth", retryable: false });
      const reason = h.port.unavailableReason("droid")!;
      expect(reason).toContain(mode === "http-402" ? "付款或订阅计划" : "未登录或凭据失效");
      expect(reason).toContain("/reload");
      expect(reason).not.toContain("SECRET-FACTORY-KEY");
      expect(handle.getTurnErrorInfo?.()?.message).not.toContain("SECRET-FACTORY-KEY");
      expect(h.prompt()).toBe(formatAvailableModelsForPrompt([{ provider: "pi", id: "native" }]));
      // The valid quota key and a metadata-only probe do NOT prove that CLI OAuth/model access works.
      h.port.observeAvailability!("droid", { source: "quota", ok: true });
      expect(h.port.unavailableReason("droid")).toBe(reason);
      await h.probeCatalog(); // same failing CLI mode: init succeeds, only the first turn fails auth
      expect(h.port.unavailableReason("droid")).toBe(reason);
      expect(h.prompt()).not.toContain("### External agent models (droid)");
      const a = admission(h.port, h.root, handle);
      const before = a.service.snapshots();
      const base: SpawnRequest = {
        type: "worker",
        prompt: "must not run",
        modelOverride: { provider: "droid", id: "gpt-6-luna" },
      };
      for (const request of [
        { ...base, isolation: "worktree" as const }, // top-level Agent / H2
        { ...base, parentRunId: "r_PARENT001" }, // nested Agent
        { ...base, suppressDelivery: true }, // workflow ChildSpawner
        { type: "worker", prompt: "resume", resumeFrom: "r_PREVIOUS1" },
      ]) {
        expect(await a.service.spawn(request)).toEqual({
          error: { kind: "config", retryable: false, message: reason },
        });
      }
      expect(a.run).not.toHaveBeenCalled();
      expect(a.label).not.toHaveBeenCalled();
      expect(a.acquire).not.toHaveBeenCalled();
      expect(a.service.runningIds()).toEqual([]);
      expect(a.service.snapshots()).toEqual(before);
      h.port.observeAvailability!("droid", { source: "quota", authError: "HTTP 401" });
      const beforeRecovery = h.port.unavailableReason("droid");
      h.setMode("default");
      const recovered = await h.create(); // an already-admitted/concurrent run can supply recovery evidence
      expect(h.port.unavailableReason("droid")).toBe(beforeRecovery); // init alone is not a successful run
      await recovered.prompt("recovered");
      expect(recovered.getTurnErrorInfo?.()).toBeUndefined();
      expect(recovered.getLastAssistantText?.()).toBe("DONE");
      expect(h.port.unavailableReason("droid")).toBeUndefined();
      expect(h.prompt()).toContain("### External agent models (droid)");
    },
  );

  it("a failed catalog login probe also suppresses configured models (no auth state is persisted)", async () => {
    const h = harness("auth-setup");
    h.provider.catalog.refreshInBackground("stack_build");
    await vi.waitFor(() => expect(h.port.unavailableReason("droid")).toContain("No access token"));
    expect(h.port.advertised()).toEqual([]);
    expect(h.provider.catalog.snapshot()).toBeUndefined();
    h.setMode("default");
    await h.probeCatalog();
    expect(h.port.unavailableReason("droid")).toBeUndefined(); // catalog success clears only its own failure
    expect(h.prompt()).toContain("### External agent models (droid)");
  });

  it("early CLI auth failure persists across a successful catalog probe, then a successful turn recovers", async () => {
    vi.stubEnv("FACTORY_API_KEY", "SECRET-FACTORY-KEY");
    const h = harness("auth-setup");
    let error: unknown;
    try {
      await h.create();
    } catch (e) {
      error = e;
    }
    expect(classifiedInfo(error)).toMatchObject({ kind: "auth", retryable: false });
    expect(classifiedInfo(error)?.message).not.toContain("SECRET-FACTORY-KEY");
    expect(h.port.unavailableReason("droid")).toContain("No access token");
    expect(h.port.advertised()).toEqual([]);
    h.setMode("default");
    await h.probeCatalog();
    expect(h.port.unavailableReason("droid")).toContain("No access token");
    expect(h.prompt()).not.toContain("### External agent models (droid)");
    const recovered = await h.create();
    await recovered.prompt("recovered");
    expect(h.port.unavailableReason("droid")).toBeUndefined();
    expect(h.prompt()).toContain("### External agent models (droid)");
  });
});
