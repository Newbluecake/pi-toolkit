// scheduled-reports A3 (plan r3 §5.3): `sessionScoped` prompt sections. A scoped section's persisted
// snapshot records the owning session id; read-back into a different (or unknown) session — a
// fork / copy of the branch — starts from the initial state, so a child session never inherits
// the parent's task list. Every other section's serialized bytes stay exactly as before.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPromptSectionHub, type SectionRegistration } from "../../src/sysprompt/hub.js";
import { initialSectionState, type SectionState } from "../../src/prompt-sections/stable-section.js";
import {
  PROMPT_SECTIONS_ENTRY_TYPE,
  readBackSectionStates,
  sanitizePromptSectionsEntry,
  serializeSectionStates,
} from "../../src/prompt-sections/store.js";

const NAMES = ["pi_project_memory", "pi_subagent_types", "pi_subagent_models", "pi_schedules"] as const;
const snap = (text: string): SectionState => ({
  snapshot: text,
  announced: text,
  stale: false,
  sentCount: 0,
  sentBytes: 0,
});

describe("store: scoped sections carry a sid", () => {
  test("serialize adds sid ONLY to scoped sections; unscoped bytes are unchanged", () => {
    const states = new Map<(typeof NAMES)[number], SectionState>([
      ["pi_subagent_types", snap("T")],
      ["pi_schedules", snap("S")],
    ]);
    const plain = serializeSectionStates(states);
    expect(JSON.stringify(plain)).not.toContain("sid");
    const scoped = serializeSectionStates(states, { names: new Set(["pi_schedules"]), sessionId: "sess-A" });
    expect(scoped.sections.pi_subagent_types).toEqual(plain.sections.pi_subagent_types);
    expect(scoped.sections.pi_schedules).toEqual({ ...plain.sections.pi_schedules, sid: "sess-A" });
  });

  test("sanitize keeps a string sid and drops a malformed one", () => {
    const ok = sanitizePromptSectionsEntry({
      v: 1,
      sections: { pi_schedules: { snapshot: "S", sid: "x", sentCount: 0, sentBytes: 0 } },
    });
    expect(ok?.sections.pi_schedules?.sid).toBe("x");
    const bad = sanitizePromptSectionsEntry({
      v: 1,
      sections: { pi_schedules: { snapshot: "S", sid: 5, sentCount: 0, sentBytes: 0 } },
    });
    expect(bad?.sections.pi_schedules).toBeUndefined();
  });

  test("read-back: same sid restores, other sid / missing sid ⇒ initial state, others unaffected", () => {
    const scope = (sid: string | undefined) => ({ names: new Set(["pi_schedules" as const]), sessionId: sid });
    const data = serializeSectionStates(
      new Map([
        ["pi_subagent_types", snap("T")],
        ["pi_schedules", snap("S")],
      ]),
      scope("sess-A"),
    );
    const branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data }];
    const same = readBackSectionStates(branch, "resume", NAMES, scope("sess-A"));
    expect(same?.states.get("pi_schedules")?.snapshot).toBe("S");
    const other = readBackSectionStates(branch, "fork", NAMES, scope("sess-B"));
    expect(other?.states.get("pi_schedules")).toEqual(initialSectionState());
    expect(other?.states.get("pi_subagent_types")?.snapshot).toBe("T");
    const unknownSid = readBackSectionStates(branch, "fork", NAMES, scope(undefined));
    expect(unknownSid?.states.get("pi_schedules")).toEqual(initialSectionState());
    // a legacy entry (scoped section persisted WITHOUT sid) is never trusted
    const legacy = serializeSectionStates(new Map([["pi_schedules", snap("S")]]));
    const l = readBackSectionStates(
      [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: legacy }],
      "resume",
      NAMES,
      scope("sess-A"),
    );
    expect(l?.states.get("pi_schedules")).toEqual(initialSectionState());
  });

  test("no scope argument ⇒ byte-identical legacy read-back", () => {
    const data = serializeSectionStates(new Map([["pi_schedules", snap("S")]]));
    const r = readBackSectionStates(
      [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data }],
      "resume",
      NAMES,
    );
    expect(r?.states.get("pi_schedules")?.snapshot).toBe("S");
  });
});

function fakePi() {
  const handlers = new Map<string, (e: any, c: any) => any>();
  const appended: Array<{ type: string; data: any }> = [];
  const pi = {
    on: (event: string, h: any) => void handlers.set(event, h),
    appendEntry: (type: string, data: unknown) => void appended.push({ type, data }),
  } as unknown as ExtensionAPI;
  return { pi, handlers, appended };
}
const mkHub = (host: ReturnType<typeof fakePi>) =>
  createPromptSectionHub(host.pi, { mode: () => "stable", wakeReplay: false, adoptForeignForcedPrompt: false });
const ctxOf = (sid: string, branch: unknown[] = []) =>
  ({ sessionManager: { getSessionId: () => sid, getBranch: () => branch } }) as any;
const section = (live: () => string, scoped: boolean): SectionRegistration => ({
  provider: live,
  title: "## S",
  ...(scoped ? { sessionScoped: true as const } : {}),
});
const bas = (host: ReturnType<typeof fakePi>, ctx: any) =>
  host.handlers.get("before_agent_start")!(
    { type: "before_agent_start", prompt: "p", systemPrompt: "BASE", systemPromptOptions: {} },
    ctx,
  );

describe("hub: a forked session does not inherit the parent's scoped section", () => {
  test("parent has tasks; the fork's wire prefix has none while unscoped sections persist", () => {
    // parent session A
    const host = fakePi();
    const hub = mkHub(host);
    hub.register(
      "pi_subagent_types",
      section(() => "TYPES", false),
    );
    hub.register(
      "pi_schedules",
      section(() => "TASKS-A", true),
    );
    const ctxA = ctxOf("sess-A");
    host.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    expect(bas(host, ctxA).systemPrompt).toBe("BASE\n\nTYPES\n\nTASKS-A");
    const entry = host.appended.at(-1)!;
    expect(entry.data.sections.pi_schedules.sid).toBe("sess-A");
    expect(entry.data.sections.pi_subagent_types.sid).toBeUndefined();

    // fork B: branch copied from A, but a new session id and (for the fork) no schedules of its own
    const host2 = fakePi();
    const hub2 = mkHub(host2);
    hub2.register(
      "pi_subagent_types",
      section(() => "TYPES", false),
    );
    hub2.register(
      "pi_schedules",
      section(() => "", true),
    ); // provider reads B's (empty) ledger
    const branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: entry.data }];
    const ctxB = ctxOf("sess-B", branch);
    host2.handlers.get("session_start")!({ type: "session_start", reason: "fork" }, ctxB);
    expect(bas(host2, ctxB)).toEqual({ systemPrompt: "BASE\n\nTYPES" });
    const next = host2.appended.at(-1)!;
    expect(next.data.sections.pi_schedules?.snapshot ?? "").toBe("");
  });

  test("resume of the SAME session restores the scoped snapshot byte-for-byte", () => {
    const host = fakePi();
    const hub = mkHub(host);
    hub.register(
      "pi_schedules",
      section(() => "TASKS-A", true),
    );
    const ctxA = ctxOf("sess-A");
    host.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    bas(host, ctxA);
    const entry = host.appended.at(-1)!;
    const host2 = fakePi();
    const hub2 = mkHub(host2);
    hub2.register(
      "pi_schedules",
      section(() => "TASKS-A-LATER", true),
    );
    const ctx2 = ctxOf("sess-A", [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: entry.data }]);
    host2.handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx2);
    // frozen head stays TASKS-A; the new live value surfaces as a tail update message
    const r = bas(host2, ctx2);
    expect(r.systemPrompt).toBe("BASE\n\nTASKS-A");
    expect(r.message).toBeDefined();
  });
});

describe("hub: a fork whose history carries the parent's scoped update retracts it (D2)", () => {
  /** Parent A: frozen head without tasks, then a task appears ⇒ an announced `update` + persisted entry. */
  function parentWithAnnouncedUpdate(): { branch: unknown[]; updateText: string } {
    const host = fakePi();
    const hub = mkHub(host);
    let live = "";
    hub.register(
      "pi_schedules",
      section(() => live, true),
    );
    const ctxA = ctxOf("sess-A");
    host.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    expect(bas(host, ctxA)).toBeUndefined(); // frozen head: no section, nothing to announce
    live = "TASKS-A";
    const r = bas(host, ctxA);
    expect(r.systemPrompt).toBeUndefined(); // stable: the system prompt does not move
    expect(r.message.content).toContain("TASKS-A");
    const entry = host.appended.at(-1)!;
    expect(entry.data.sections.pi_schedules).toMatchObject({ sid: "sess-A", announced: "TASKS-A" });
    return {
      branch: [
        { type: "custom_message", customType: r.message.customType, content: r.message.content },
        { type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: entry.data },
      ],
      updateText: r.message.content,
    };
  }

  test("fork with no tasks of its own: exactly one `removed` update, system prompt bytes unchanged, then silence", () => {
    const { branch } = parentWithAnnouncedUpdate();
    const host = fakePi();
    const hub = mkHub(host);
    hub.register(
      "pi_subagent_types",
      section(() => "TYPES", false),
    );
    hub.register(
      "pi_schedules",
      section(() => "", true),
    );
    const ctxB = ctxOf("sess-B", branch);
    host.handlers.get("session_start")!({ type: "session_start", reason: "fork" }, ctxB);
    const first = bas(host, ctxB);
    expect(first.systemPrompt).toBe("BASE\n\nTYPES"); // same bytes as a fork without the fix
    expect(first.message.content).toContain("no longer applies; ignore that update");
    expect(first.message.content).toContain('"## S"');
    expect(first.message.details.updates).toEqual([{ section: "pi_schedules", kind: "removed" }]);
    expect(first.message.content).not.toContain("TASKS-A");
    // later turns: the retraction is not repeated and the prompt is stable
    expect(bas(host, ctxB)).toEqual({ systemPrompt: "BASE\n\nTYPES" });
    expect(host.appended.at(-1)!.data.sections.pi_schedules?.sid).toBe("sess-B");
  });

  test("fork with its OWN tasks: the first turn replaces the parent's block with the fork's block", () => {
    const { branch } = parentWithAnnouncedUpdate();
    const host = fakePi();
    const hub = mkHub(host);
    hub.register(
      "pi_schedules",
      section(() => "TASKS-B", true),
    );
    const ctxB = ctxOf("sess-B", branch);
    host.handlers.get("session_start")!({ type: "session_start", reason: "fork" }, ctxB);
    const first = bas(host, ctxB);
    expect(first.systemPrompt).toBe("BASE\n\nTASKS-B");
    expect(first.message.content).toContain("<pi_section_update");
    expect(first.message.content).toContain("TASKS-B");
    expect(first.message.content).not.toContain("TASKS-A");
    expect(bas(host, ctxB)).toEqual({ systemPrompt: "BASE\n\nTASKS-B" });
  });

  test("a parent whose last announcement was a removal, or whose head was never updated, needs no retraction", () => {
    const host = fakePi();
    const hub = mkHub(host);
    hub.register(
      "pi_schedules",
      section(() => "TASKS-A", true),
    );
    const ctxA = ctxOf("sess-A");
    host.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    bas(host, ctxA); // head only, announced === snapshot
    const entry = host.appended.at(-1)!;
    const host2 = fakePi();
    const hub2 = mkHub(host2);
    hub2.register(
      "pi_schedules",
      section(() => "", true),
    );
    const ctxB = ctxOf("sess-B", [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: entry.data }]);
    host2.handlers.get("session_start")!({ type: "session_start", reason: "fork" }, ctxB);
    expect(bas(host2, ctxB)).toBeUndefined();
  });

  test("the SAME session resumed is not a fork: no retraction", () => {
    const { branch } = parentWithAnnouncedUpdate();
    const host = fakePi();
    const hub = mkHub(host);
    hub.register(
      "pi_schedules",
      section(() => "TASKS-A", true),
    );
    const ctxA = ctxOf("sess-A", branch);
    host.handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctxA);
    const r = bas(host, ctxA);
    expect(JSON.stringify(r ?? {})).not.toContain("no longer applies");
  });

  test("readBackSectionStates reports foreignAnnounced only for scoped sections from another sid", () => {
    const scope = (sid: string) => ({ names: new Set(["pi_schedules" as const]), sessionId: sid });
    const data = serializeSectionStates(
      new Map<(typeof NAMES)[number], SectionState>([
        ["pi_subagent_types", { ...snap("T"), announced: "T2" }],
        ["pi_schedules", { ...snap("S"), announced: "S2" }],
      ]),
      scope("sess-A"),
    );
    const branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data }];
    expect(readBackSectionStates(branch, "fork", NAMES, scope("sess-B"))?.foreignAnnounced).toEqual(["pi_schedules"]);
    expect(readBackSectionStates(branch, "resume", NAMES, scope("sess-A"))?.foreignAnnounced).toEqual([]);
  });
});
