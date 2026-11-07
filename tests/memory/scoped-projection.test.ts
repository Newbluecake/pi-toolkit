import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createScopedProjection, predictScopedVisibility } from "../../src/memory/scoped-projection.js";
import { ProjectCapture } from "../../src/memory/scoped-project-view.js";
import {
  initialSectionState,
  POINTED,
  SKIP,
  resolveAtTurn,
  type SectionName,
  type SectionState,
} from "../../src/prompt-sections/stable-section.js";
import type { SectionProviderInput, SystemPromptMode } from "../../src/sysprompt/hub.js";
import type { MemoryOwner, SessionMemoryView, HubMemoryView, MemoryAuthority } from "../../src/memory/scopes/types.js";

const date = "2026-11-07T00:00:00.000Z";
function session(text = "- same", authority: MemoryAuthority = "user"): SessionMemoryView {
  return {
    items: [{ item: { id: "n1", text, authority, created: date, updated: date }, rev: "12345678" }],
    dropped: [],
    nextN: 2,
    opsSinceSnap: 0,
    persistence: "memory-only",
    poisoned: false,
  };
}
function hubView(text = "- same"): HubMemoryView {
  return {
    state: "ok",
    items: [
      {
        id: "general.001",
        text,
        authority: "user",
        topic: "general",
        created: date,
        updated: date,
        src: { project: "0123456789ab", label: "own", sid8: "12345678" },
        grant: { via: "command", by: "user", turn: "12345678", cap: "12345678" },
      },
    ],
  };
}
function source(body = "- same") {
  const c = new ProjectCapture();
  const unit = c.file("core.md", body, body);
  c.track(body, unit);
  return c.finish(`## Memory (own)\n${body}`);
}
function fixture(mode: SystemPromptMode = "stable") {
  let owner: MemoryOwner | undefined = { incarnation: {}, sid: "own", sessionEpoch: 1, branchGen: 1 };
  let view = session();
  let hub = hubView();
  let enabled = true;
  let available = true;
  let sessionReads = 0;
  let hubReads = 0;
  const states = new Map<SectionName, SectionState>();
  const coordinator = createScopedProjection({
    enabled: () => enabled,
    owner: () => owner,
    mode: () => mode,
    state: { _state: (n) => states.get(n) },
    session: {
      available: () => available,
      view: () => {
        sessionReads++;
        return view;
      },
    },
    hub: {
      available: () => available,
      view: () => {
        hubReads++;
        return hub;
      },
    },
  });
  const ctx = {} as ExtensionContext;
  const input = (phase: "turn" | "seed" = "turn"): SectionProviderInput => ({ ctx, promptText: "BASE", phase });
  return {
    coordinator,
    states,
    input,
    reads: () => [sessionReads, hubReads],
    setView: (v: SessionMemoryView) => {
      view = v;
    },
    setHub: (v: HubMemoryView) => {
      hub = v;
    },
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    setAvailable: (v: boolean) => {
      available = v;
    },
    changeOwner: () => {
      owner = { incarnation: {}, sid: "other", sessionEpoch: 2, branchGen: 2 };
    },
    clearOwner: () => {
      owner = undefined;
    },
  };
}
describe("same-input projection coordinator (factory, not P4c assembly)", () => {
  it("marks the actual project loser and reuses the exact input capture across all providers", () => {
    const f = fixture();
    const input = f.input();
    const text = f.coordinator.project(input, source());
    expect(text).toContain("- same (dup of session n1)");
    expect(f.coordinator.sessionSection!.provider(input)).toContain("- n1 user: - same");
    expect(f.coordinator.hubSection!.provider(input)).toContain("(dup of session n1)");
    expect(f.reads()).toEqual([1, 1]);
    expect(f.coordinator.project(input, source())).toBe(text);
    expect(f.reads()).toEqual([1, 1]);
  });
  it("captures immutable DTOs, not a live mutable view reference", () => {
    const f = fixture();
    const original = session();
    f.setView(original);
    const input = f.input();
    f.coordinator.begin(input);
    (original as unknown as { items: { item: { text: string } }[] }).items[0]!.item.text = "changed outside capture";
    expect(f.coordinator.project(input, source())).toContain("dup of session n1");
    const live = f.coordinator.sessionSection!.provider(input);
    expect(live).toContain("- same");
    expect(live).not.toContain("changed outside capture");
    expect(f.reads()).toEqual([1, 1]);
  });
  it("new input identity, even reused ctx/text, captures new real views", () => {
    const f = fixture();
    expect(f.coordinator.project(f.input(), source())).toContain("dup of session n1");
    f.setView(session("unrelated"));
    expect(f.coordinator.project(f.input(), source())).toContain("dup of hub general.001");
    expect(f.reads()).toEqual([2, 2]);
  });
  it("snapshot/full-announced are eligible, POINTED latest live is not", () => {
    const f = fixture();
    f.setHub({ state: "absent", items: [] });
    const turn = () => {
      const input = f.input();
      f.coordinator.project(input, source());
      const live = f.coordinator.sessionSection!.provider(input);
      if (typeof live !== "string") throw new Error("expected full");
      const state = f.states.get("pi_session_memory") ?? initialSectionState();
      f.states.set("pi_session_memory", resolveAtTurn(state, live).state);
    };
    turn();
    for (let i = 0; i < 4; i++) {
      f.setView(session(`- change${i}`));
      turn();
    }
    expect(f.states.get("pi_session_memory")?.announced).toBe(POINTED);
    f.setView(session("- new"));
    expect(f.coordinator.project(f.input(), source("- new"))).not.toContain("dup of session");
    expect(f.coordinator.project(f.input(), source("- same"))).toContain("dup of session n1");
  });
  it("a full tail's real authority is usable; arbitrary recovered strings have no manifest", () => {
    const f = fixture();
    f.setHub({ state: "absent", items: [] });
    f.states.set("pi_session_memory", {
      ...initialSectionState(),
      snapshot: "unknown old",
      announced: "unknown old",
      stale: false,
    });
    const input = f.input();
    expect(f.coordinator.project(input, source())).toContain("dup of session n1"); // real new full tail
    const live = f.coordinator.sessionSection!.provider(input);
    if (typeof live !== "string") throw new Error("expected full tail");
    f.states.set("pi_session_memory", {
      snapshot: "unknown old",
      announced: live,
      stale: false,
      sentCount: 1,
      sentBytes: Buffer.byteLength(live),
    });
    f.setView(session("- other"));
    expect(f.coordinator.project(f.input("seed"), source())).toContain("dup of session n1");
    const fresh = fixture();
    fresh.setHub({ state: "absent", items: [] });
    fresh.states.set("pi_session_memory", {
      snapshot: live,
      announced: POINTED,
      stale: false,
      sentCount: 3,
      sentBytes: 0,
    });
    expect(fresh.coordinator.project(fresh.input(), source())).not.toContain("dup of session");
  });
  it("seed is lazy: fresh snapshot does not announce the latest view, unlike BAS", () => {
    const f = fixture();
    f.setHub({ state: "absent", items: [] });
    f.states.set("pi_session_memory", { snapshot: "old", announced: "old", stale: false, sentCount: 0, sentBytes: 0 });
    expect(f.coordinator.project(f.input("seed"), source())).not.toContain("dup of");
    expect(f.coordinator.project(f.input("turn"), source())).toContain("dup of session n1");
  });
  it("missing phase and malformed future anchors never become winners", () => {
    const f = fixture();
    const input = f.input();
    delete input.phase;
    expect(f.coordinator.project(input, source())).not.toContain("dup of");
    const v = session();
    const malformed = { ...v, items: v.items.map((e) => ({ ...e, item: { ...e.item, id: "x".repeat(500) } })) };
    f.setView(malformed);
    f.setHub({ state: "absent", items: [] });
    expect(f.coordinator.project(f.input(), source())).not.toContain("dup of");
  });
  it("owner before/after source or view capture changes invalidate only this invocation", () => {
    const f = fixture();
    const input = f.input();
    f.coordinator.begin(input);
    f.changeOwner();
    expect(f.coordinator.project(input, source())).not.toContain("dup of");
    expect(f.coordinator.sessionSection!.invalidateIf!(input)).toBe(true);
    expect(f.coordinator.sessionSection!.provider(input)).toBe(SKIP);
    expect(f.reads()).toEqual([1, 1]);
    expect(f.coordinator.project(f.input(), source())).toContain("dup of session n1");
  });
  it("off/locked/unknown owner do not read either view", () => {
    for (const gate of ["off", "unavailable", "owner"] as const) {
      const f = fixture();
      if (gate === "off") f.setEnabled(false);
      if (gate === "unavailable") f.setAvailable(false);
      if (gate === "owner") f.clearOwner();
      f.coordinator.project(f.input(), source());
      expect(f.reads()).toEqual([0, 0]);
    }
  });
  it("read failure is unavailable, not deletion and not a reason to clear the other layer", () => {
    const owner: MemoryOwner = { incarnation: {}, sid: "own", sessionEpoch: 1, branchGen: 1 };
    const c = createScopedProjection({
      enabled: () => true,
      owner: () => owner,
      mode: () => "stable",
      state: { _state: () => undefined },
      session: {
        available: () => true,
        view: () => {
          throw new Error("read fault");
        },
      },
      hub: { available: () => true, view: () => hubView() },
    });
    const input: SectionProviderInput = { ctx: {} as ExtensionContext, promptText: "BASE", phase: "turn" };
    expect(c.project(input, source())).toContain("dup of hub general.001");
    expect(c.sessionSection!.provider(input)).toBe(SKIP);
    expect(c.hubSection!.invalidateIf!(input)).toBe(false);
  });
  it("actual pointer output cannot be promoted because its short stub fits the bound", () => {
    const owner: MemoryOwner = { incarnation: {}, sid: "own", sessionEpoch: 1, branchGen: 1 };
    const body = "x".repeat(5000);
    const c = createScopedProjection({
      enabled: () => true,
      owner: () => owner,
      mode: () => "stable",
      state: { _state: () => undefined },
      session: { available: () => true, view: () => session(body), renderBudgetBytes: 500 },
    });
    const input: SectionProviderInput = { ctx: {} as ExtensionContext, promptText: "BASE", phase: "turn" };
    expect(c.project(input, source(body))).not.toContain("dup of");
    expect(c.sessionSection!.provider(input)).toContain("over budget");
  });
  it("project POINTED latest source cannot win a scoped collision", () => {
    const f = fixture();
    f.setView(session("- same", "agent"));
    f.setHub({ state: "absent", items: [] });
    f.states.set("pi_project_memory", {
      snapshot: "unknown old",
      announced: POINTED,
      stale: false,
      sentCount: 3,
      sentBytes: 0,
    });
    const input = f.input();
    f.coordinator.project(input, source("- same <!-- mem user -->"));
    expect(f.coordinator.sessionSection!.provider(input)).not.toContain("dup of project");
  });
  it.each(["live", "legacy"] as const)("%s predicts actual fresh output instead of a stable pointer", (mode) => {
    const f = fixture(mode);
    f.states.set("pi_session_memory", {
      snapshot: "old",
      announced: POINTED,
      stale: false,
      sentCount: 3,
      sentBytes: 0,
    });
    expect(f.coordinator.project(f.input(), source())).toContain("dup of session n1");
  });
  it("prediction mismatch is fail-safe: no unobserved project winner or fixed-point rerender", () => {
    const owner: MemoryOwner = { incarnation: {}, sid: "own", sessionEpoch: 1, branchGen: 1 };
    let projectStates = 0;
    let reads = 0;
    const c = createScopedProjection({
      enabled: () => true,
      owner: () => owner,
      mode: () => "stable",
      state: {
        _state: (name) =>
          name !== "pi_project_memory"
            ? initialSectionState()
            : ++projectStates === 1
              ? initialSectionState()
              : { snapshot: "unknown", announced: POINTED, stale: false, sentCount: 3, sentBytes: 0 },
      },
      session: {
        available: () => true,
        view: () => {
          reads++;
          return session("- same", "agent");
        },
      },
    });
    const input: SectionProviderInput = { ctx: {} as ExtensionContext, promptText: "BASE", phase: "turn" };
    const actual = c.project(input, source("- same <!-- mem user -->"));
    expect(actual).not.toContain("dup of");
    expect(c.sessionSection!.provider(input)).not.toContain("dup of project");
    expect(reads).toBe(1);
    expect(projectStates).toBe(2); // two phases, not a fixed point
  });
  it("owner changing inside a read fails the before/after capture closed", () => {
    let owner: MemoryOwner = { incarnation: {}, sid: "own", sessionEpoch: 1, branchGen: 1 };
    const c = createScopedProjection({
      enabled: () => true,
      owner: () => owner,
      mode: () => "stable",
      state: { _state: () => undefined },
      session: {
        available: () => true,
        view: () => {
          owner = { ...owner, branchGen: 2 };
          return session();
        },
      },
    });
    const input: SectionProviderInput = { ctx: {} as ExtensionContext, promptText: "BASE", phase: "turn" };
    expect(c.project(input, source())).not.toContain("dup of");
    expect(c.sessionSection!.provider(input)).toBe(SKIP);
  });
  it("pure prediction matches accepted state machine at byte/count edges", () => {
    const state = { snapshot: "head", announced: "old", stale: false, sentCount: 2, sentBytes: 32767 };
    expect(predictScopedVisibility(state, "a", "stable", "turn")).toContain("a");
    expect(predictScopedVisibility(state, "ab", "stable", "turn")).not.toContain("ab");
    expect(resolveAtTurn(state, "ab").state.announced).toBe(POINTED);
    expect(predictScopedVisibility(state, "a", "stable", "seed")).toEqual(["head", "old"]);
  });
});
