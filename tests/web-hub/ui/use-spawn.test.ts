// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSpawn } from "../../../src/web-hub/ui/src/composables/useSpawn.js";
import type {
  HubTransport,
  SpawnListOutcome,
  SpawnPrefsOutcome,
  SpawnTransport,
} from "../../../src/web-hub/ui/src/transport/types.js";

/**
 * default-model plan F1: `createSpawn`'s prefs surface — the `prefs` ref fed by `list()`'s
 * `prefs` slot and by `setDefaultModel()`'s 200 echo, plus the absent-capability degradation
 * (a transport without `spawn`/`setPrefs` yields `E_UNSUPPORTED`, never a TypeError).
 */

function fakeTransport(spawn?: Partial<SpawnTransport>): HubTransport {
  return {
    mode: "token",
    start: async () => {},
    close: () => {},
    subscribe: async () => ({ ok: true }),
    unsubscribe: async () => {},
    page: async () => ({ ok: false, error: "E_UNSUPPORTED" }),
    command: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
    dialog: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
    ...(spawn === undefined ? {} : { spawn: spawn as SpawnTransport }),
  };
}

const POLICY = {
  allowed: true,
  confirm: "unknown-dir",
  scope: "known",
  max: 4,
  maxPerPrincipal: 2,
  active: 0,
  activeMine: 0,
  registerTimeoutS: 30,
  maxLifetimeMinutes: 720,
} as const;

const LIST_WITH_PREFS: SpawnListOutcome = {
  ok: true,
  policy: POLICY,
  items: [],
  prefs: { defaultModel: "anthropic/claude-opus-4-5" },
};

describe("createSpawn prefs surface (default-model plan F1)", () => {
  it("prefs starts null; a list() carrying prefs folds it in; one without leaves the mirror untouched", async () => {
    let outcome = LIST_WITH_PREFS;
    const s = createSpawn(fakeTransport({ list: async () => outcome }));
    expect(s.prefs.value).toBeNull();
    await s.list();
    expect(s.prefs.value).toEqual({ defaultModel: "anthropic/claude-opus-4-5" });
    // A pre-feature hub (no prefs slot) must NOT read as "cleared" — the mirror stays.
    outcome = { ok: true, policy: POLICY, items: [] };
    await s.refreshPrefs();
    expect(s.prefs.value).toEqual({ defaultModel: "anthropic/claude-opus-4-5" });
    // A failed list leaves it alone too.
    outcome = { ok: false, error: "E_NETWORK", status: 0 };
    await s.list();
    expect(s.prefs.value).toEqual({ defaultModel: "anthropic/claude-opus-4-5" });
  });

  it("setDefaultModel() posts through the transport; the 200 echo becomes the mirror (incl. the cleared null)", async () => {
    const sent: string[] = [];
    let reply: SpawnPrefsOutcome = { ok: true, prefs: { defaultModel: "openai/gpt-5" } };
    const s = createSpawn(
      fakeTransport({
        setPrefs: async (v) => {
          sent.push(v);
          return reply;
        },
      }),
    );
    expect(await s.setDefaultModel("openai/gpt-5")).toEqual({ ok: true, prefs: { defaultModel: "openai/gpt-5" } });
    expect(sent).toEqual(["openai/gpt-5"]);
    expect(s.prefs.value).toEqual({ defaultModel: "openai/gpt-5" });
    reply = { ok: true, prefs: { defaultModel: null } };
    await s.setDefaultModel("");
    expect(sent).toEqual(["openai/gpt-5", ""]);
    expect(s.prefs.value).toEqual({ defaultModel: null });
  });

  it("a failed setDefaultModel() leaves the mirror untouched", async () => {
    let reply: SpawnPrefsOutcome = { ok: true, prefs: { defaultModel: "p/m" } };
    const s = createSpawn(fakeTransport({ setPrefs: async () => reply }));
    await s.setDefaultModel("p/m");
    reply = { ok: false, error: "E_LAUNCHER", reason: "persist", retryable: true };
    expect(await s.setDefaultModel("p/other")).toMatchObject({ ok: false, error: "E_LAUNCHER" });
    expect(s.prefs.value).toEqual({ defaultModel: "p/m" });
  });

  it("a transport WITHOUT spawn degrades every method (incl. prefs) to E_UNSUPPORTED", async () => {
    const s = createSpawn(fakeTransport(undefined));
    expect(s.prefs.value).toBeNull();
    expect(await s.list()).toEqual({ ok: false, error: "E_UNSUPPORTED", status: 0 });
    expect(await s.refreshPrefs()).toEqual({ ok: false, error: "E_UNSUPPORTED", status: 0 });
    expect(await s.setDefaultModel("p/m")).toEqual({ ok: false, error: "E_UNSUPPORTED", retryable: false });
    expect(s.prefs.value).toBeNull();
  });

  it("a spawn transport WITHOUT setPrefs (old fake) degrades only the write", async () => {
    const s = createSpawn(fakeTransport({ list: async () => LIST_WITH_PREFS }));
    expect(await s.setDefaultModel("p/m")).toEqual({ ok: false, error: "E_UNSUPPORTED", retryable: false });
    await s.list();
    expect(s.prefs.value).toEqual({ defaultModel: "anthropic/claude-opus-4-5" });
  });
});
