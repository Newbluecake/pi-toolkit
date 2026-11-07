import { describe, expect, it } from "vitest";
import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPromptSectionHub, type SystemPromptMode } from "../../src/sysprompt/hub.js";
import { initialSectionState, SKIP, type Live, type SectionName } from "../../src/prompt-sections/stable-section.js";
import { PROMPT_SECTIONS_ENTRY_TYPE } from "../../src/prompt-sections/store.js";
import { createSessionMemorySection } from "../../src/memory/scopes/session-section.js";
import type { SessionMemoryView } from "../../src/memory/scopes/types.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function harness(mode: SystemPromptMode = "stable") {
  const handlers = new Map<string, Handler>();
  const logs: string[] = [];
  const appended: unknown[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    appendEntry: (type: string, data: unknown) => {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  const hub = createPromptSectionHub(pi, {
    mode: () => mode,
    wakeReplay: true,
    adoptForeignForcedPrompt: false,
    log: (s) => logs.push(s),
  });
  let branch: unknown[] = [];
  const ctx = {
    getSystemPrompt: () => "BASE",
    sessionManager: { getSessionId: () => "own", getBranch: () => branch },
  } as unknown as ExtensionContext;
  const invoke = (name: string, event: unknown = {}) => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`missing handler ${name}`);
    return handler(event, ctx);
  };
  return {
    hub,
    logs,
    appended,
    invoke,
    start: () =>
      invoke("before_agent_start", { type: "before_agent_start", prompt: "go", systemPrompt: "BASE" }) as
        BeforeAgentStartEventResult | undefined,
    seed: async () =>
      (await invoke("context_with_system", { messages: [{ role: "system", content: "BASE", timestamp: 1 }] })) as
        { messages: { content: string }[] } | undefined,
    restore: (sections: Record<string, unknown>) => {
      branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: { v: 1, sections } }];
      invoke("session_start", { reason: "reload" });
    },
  };
}
const persisted = (snapshot: string, extra: Record<string, unknown> = {}) => ({
  snapshot,
  sentCount: 0,
  sentBytes: 0,
  ...extra,
});
const scopedNames = ["pi_session_memory", "pi_hub_memory"] as const;

describe("scoped section stable invalidation seam (manual registration only)", () => {
  it.each(scopedNames)("%s resets only itself, skips provider/output, and samples anew on recovery", (name) => {
    const h = harness();
    let blocked = false;
    let calls = 0;
    let live: Live = "SAFE";
    h.hub.register(name, {
      title: "Scoped",
      invalidateIf: () => blocked,
      provider: () => {
        calls++;
        return live;
      },
    });
    h.hub.register("pi_subagent_models", { title: "Models", provider: () => "MODELS" });
    expect(h.start()?.systemPrompt).toBe("BASE\n\nSAFE\n\nMODELS");
    blocked = true;
    live = SKIP;
    expect(h.start()?.systemPrompt).toBe("BASE\n\nMODELS");
    expect(calls).toBe(1);
    expect(h.hub._state(name)).toEqual(initialSectionState());
    expect(h.hub._state("pi_subagent_models")?.snapshot).toBe("MODELS");
    expect(h.hub._captured()).toBe("BASE\n\nMODELS"); // normal capture, not replay clear
    blocked = false;
    live = "RECOVERED";
    expect(h.start()?.systemPrompt).toBe("BASE\n\nRECOVERED\n\nMODELS");
    expect(calls).toBe(2);
    expect(h.hub._state(name)?.snapshot).toBe("RECOVERED");
  });

  it("throwing predicates fail closed OUTSIDE fallback and log once without exception/body", () => {
    const h = harness();
    let bad = false;
    let calls = 0;
    h.hub.register("pi_hub_memory", {
      title: "Hub",
      provider: () => {
        calls++;
        return "SECRET BODY";
      },
      invalidateIf: () => {
        if (bad) throw new Error("SECRET BODY".repeat(1000));
        return false;
      },
    });
    h.start();
    bad = true;
    expect(h.start()).toBeUndefined();
    expect(h.start()).toBeUndefined();
    expect(h.hub._state("pi_hub_memory")).toEqual(initialSectionState());
    expect(calls).toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).not.toContain("SECRET");
    expect(h.logs[0]!.length).toBeLessThan(150);
  });

  it.each([false, true])(
    "fresh frozen seed is gated without provider even when predicate throws=%s",
    async (throws) => {
      const h = harness();
      let calls = 0;
      h.hub.register("pi_session_memory", {
        title: "Session",
        provider: () => {
          calls++;
          return "NEW";
        },
        invalidateIf: () => {
          if (throws) throw new Error("private error");
          return true;
        },
      });
      h.restore({ pi_session_memory: persisted("PERSISTED SECRET") });
      expect(h.hub._state("pi_session_memory")?.stale).toBe(false);
      expect(await h.seed()).toBeUndefined();
      expect(calls).toBe(0);
      expect(h.hub._state("pi_session_memory")).toEqual(initialSectionState());
    },
  );

  it("provider read failures keep existing snapshot rather than announcing normal deletion", () => {
    const h = harness();
    let failed = false;
    h.hub.register("pi_session_memory", {
      title: "Session",
      invalidateIf: () => false,
      provider: () => {
        if (failed) throw new Error("read fault");
        return "SAFE";
      },
    });
    expect(h.start()?.systemPrompt).toBe("BASE\n\nSAFE");
    failed = true;
    const result = h.start();
    expect(result?.systemPrompt).toBe("BASE\n\nSAFE");
    expect(result?.message).toBeUndefined();
    expect(h.hub._state("pi_session_memory")?.announced).toBe("SAFE");
  });

  it("seed invalidation recovery samples again, even after a fresh restored snapshot", async () => {
    const h = harness();
    let blocked = true;
    let calls = 0;
    h.hub.register("pi_hub_memory", {
      title: "Hub",
      invalidateIf: () => blocked,
      provider: () => {
        calls++;
        return "RECOVERED";
      },
    });
    h.restore({ pi_hub_memory: persisted("OLD") });
    expect(await h.seed()).toBeUndefined();
    expect(calls).toBe(0);
    blocked = false;
    h.invoke("agent_settled");
    expect((await h.seed())?.messages[0]?.content).toBe("BASE\n\nRECOVERED");
    expect(calls).toBe(1);
  });

  it("restored seed without invalidation preserves old provider call count and bytes", async () => {
    const h = harness();
    let calls = 0;
    h.hub.register("pi_project_memory", {
      title: "Project",
      provider: () => {
        calls++;
        return "NEW";
      },
    });
    h.restore({ pi_project_memory: persisted("OLD") });
    expect((await h.seed())?.messages[0]?.content).toBe("BASE\n\nOLD");
    expect(calls).toBe(0);
    expect(h.start()?.systemPrompt).toBe("BASE\n\nOLD");
    expect(calls).toBe(1);
    expect(h.hub._state("pi_project_memory")?.announced).toBe("NEW");
  });

  it.each(["live", "legacy"] as const)("%s never invokes invalidateIf; fresh provider retains its own gate", (mode) => {
    const h = harness(mode);
    let calls = 0;
    let blocked = false;
    h.hub.register("pi_hub_memory", {
      title: "Hub",
      invalidateIf: () => {
        throw new Error("not consulted");
      },
      skipIf: () => blocked,
      provider: () => {
        calls++;
        return "LIVE";
      },
    });
    expect(h.start()?.systemPrompt).toBe("BASE\n\nLIVE");
    blocked = true;
    // P4c owns this fresh skipIf gate; provider SKIP alone cannot retract live snapshots.
    expect(h.start()).toBeUndefined();
    expect(calls).toBe(1);
    expect(h.logs).toEqual([]);
  });

  it("successful delete is removed tail, not historical erasure, then stale refresh becomes empty", () => {
    const h = harness();
    let current: SessionMemoryView = {
      items: [
        {
          item: {
            id: "n1",
            authority: "agent",
            text: "raw",
            created: "2026-11-07T00:00:00.000Z",
            updated: "2026-11-07T00:00:00.000Z",
          },
          rev: "12345678",
        },
      ],
      nextN: 2,
      opsSinceSnap: 0,
      dropped: [],
      persistence: "appended",
      poisoned: false,
    };
    const provider = createSessionMemorySection({ isLocked: () => false, view: () => current });
    h.hub.register("pi_session_memory", { title: "Session memory", provider });
    const head = h.start()?.systemPrompt;
    expect(head).toContain("raw");
    current = { ...current, items: [] };
    const removed = h.start();
    expect(removed?.systemPrompt).toBe(head);
    expect(removed?.message?.content).toContain("no longer applies");
    expect(h.hub._state("pi_session_memory")?.announced).toBe("");
    h.invoke("model_select");
    expect(h.start()).toBeUndefined();
    expect(h.hub._state("pi_session_memory")?.snapshot).toBe("");
  });

  it("unknown cross-layer availability is not own invalidation; same-view capture avoids double reads", () => {
    const h = harness();
    let reads = 0;
    let locked = false;
    let captured: { state: "ok" | "inert" } | undefined;
    h.hub.register("pi_hub_memory", {
      title: "Hub",
      invalidateIf: () => {
        if (locked) return true;
        captured = { state: "ok" };
        reads++;
        return captured.state !== "ok";
      },
      provider: () => {
        expect(captured?.state).toBe("ok");
        return "HUB (project unknown)";
      },
    });
    expect(h.start()?.systemPrompt).toContain("HUB");
    expect(reads).toBe(1);
    locked = true;
    expect(h.start()).toBeUndefined();
    expect(reads).toBe(1);
  });

  it("retains retractForeign until a safe own snapshot exists", () => {
    const h = harness();
    let blocked = true;
    h.hub.register("pi_session_memory", {
      title: "Session",
      sessionScoped: true,
      invalidateIf: () => blocked,
      provider: () => "OWN",
    });
    h.restore({ pi_session_memory: persisted("FOREIGN", { sid: "parent", announced: "FOREIGN UPDATE" }) });
    expect(h.start()).toBeUndefined();
    blocked = false;
    const safe = h.start();
    expect(safe?.systemPrompt).toBe("BASE\n\nOWN");
    expect(safe?.message?.content).toContain("OWN");
    expect(h.start()?.message).toBeUndefined();
  });

  it("invalidating one new section never resets old sections or calls their providers extra times", () => {
    const h = harness();
    const oldNames: SectionName[] = ["pi_project_memory", "pi_subagent_types", "pi_subagent_models", "pi_schedules"];
    let calls = 0;
    for (const name of oldNames)
      h.hub.register(name, {
        title: name,
        provider: () => {
          calls++;
          return name;
        },
      });
    h.hub.register("pi_hub_memory", {
      title: "Hub",
      provider: () => {
        throw new Error("must skip");
      },
      invalidateIf: () => true,
    });
    const expected = ["BASE", ...oldNames].join("\n\n");
    expect(h.start()?.systemPrompt).toBe(expected);
    expect(h.start()?.systemPrompt).toBe(expected);
    expect(calls).toBe(8);
    for (const name of oldNames) expect(h.hub._state(name)?.snapshot).toBe(name);
  });
});
