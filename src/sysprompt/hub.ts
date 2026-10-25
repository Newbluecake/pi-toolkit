import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  POINTED,
  SKIP,
  forgetAnnounced,
  initialSectionState,
  markStale,
  resolveAtSeed,
  resolveAtTurn,
  type Live,
  type SectionName,
  type SectionState,
  type SectionUpdate,
} from "../prompt-sections/stable-section.js";
import { foldSections } from "../prompt-sections/fold.js";
import {
  PROMPT_SECTIONS_ENTRY_TYPE,
  readBackSectionStates,
  serializeSectionStates,
  type ReadBack,
  type ReadBackReason,
  type SectionScope,
} from "../prompt-sections/store.js";
import { renderSectionUpdateMessage } from "../prompt-sections/update-message.js";
import { createWakeReplay, type MessageLike } from "./wake-replay.js";
import {
  getTranscriptHelpers,
  onContextWithSystem as registerContextWithSystem,
  readForceSystemPrompt,
  tryGetSystemPrompt,
} from "./compat.js";

export type SystemPromptMode = "stable" | "live" | "legacy";

export interface SectionProviderInput {
  ctx: ExtensionContext;
  promptText: string;
  optionsCwd?: string;
}

export type SectionProvider = (input: SectionProviderInput) => Live;

export interface SectionRegistration {
  provider: SectionProvider;
  title: string | ((input: SectionProviderInput) => string);
  /**
   * todo #22 optimize-plan §2.6: a function is evaluated ONCE, only when the
   * resolved update's `kind === "pointer"`, with the SAME `input` the
   * provider just received. Never called for `update`/`removed` entries. A
   * throw / non-string / thenable return omits the hint (never fails the
   * update, never re-enters the section's snapshot/announced state) and
   * WARNs once per section per `activate()`. A plain string behaves exactly
   * as before (byte-identical) — it's passed through unconditionally.
   */
  pointerHint?: string | ((input: SectionProviderInput) => string);
  skipIf?: (input: SectionProviderInput) => boolean;
  /**
   * scheduled-reports A3 (plan r3 §5.3): the section's content belongs to ONE session. Its persisted
   * snapshot records the owning session id and read-back into any other session (fork / copy of the
   * branch) starts from the initial state instead of inheriting it. Absent ⇒ every byte of the
   * section's persistence is as before.
   */
  sessionScoped?: true;
}

export interface PromptSectionHubOpts {
  mode: () => SystemPromptMode;
  wakeReplay: boolean;
  adoptForeignForcedPrompt: boolean;
  log?: (msg: string) => void;
}

export interface PromptSectionHub {
  register(name: SectionName, registration: SectionRegistration): void;
  _state(name: SectionName): SectionState | undefined;
  _captured(): string | undefined;
}

type RenderUpdate = {
  section: SectionName;
  title: string;
  pointerHint?: string;
  absentFromHead?: boolean;
} & SectionUpdate;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

export function createPromptSectionHub(pi: ExtensionAPI, opts: PromptSectionHubOpts): PromptSectionHub {
  const registrations = new Map<SectionName, SectionRegistration>();
  const states = new Map<SectionName, SectionState>();
  const helpers = getTranscriptHelpers();
  const replay = createWakeReplay({ getCurrentSystemMessage: helpers?.getCurrentSystemMessage });
  const log = opts.log ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  let userTurnSeen = false;
  let prefixFresh = false;
  let firstRequestPending = true;
  let lastPersisted: string | undefined;
  let warnedPersist = false;
  let currentSid: string | undefined;
  const warnedPointerHint = new Set<SectionName>();
  /**
   * D2: scoped sections whose parent-session update messages ride in this (forked/copied) branch's
   * history. Once the section has a snapshot of its own, one tail update retracts/replaces them.
   */
  const retractForeign = new Set<SectionName>();

  const names = (): SectionName[] => [...registrations.keys()];
  const freshStates = (): Map<SectionName, SectionState> =>
    new Map(names().map((name) => [name, initialSectionState()]));

  function callProvider(registration: SectionRegistration, input: SectionProviderInput): Live {
    try {
      const value = registration.provider(input);
      if (isThenable(value)) {
        log("prompt section provider returned a thenable; treating it as SKIP");
        return SKIP;
      }
      return typeof value === "string" ? value : SKIP;
    } catch {
      return SKIP;
    }
  }

  function titleOf(registration: SectionRegistration, input: SectionProviderInput): string {
    return typeof registration.title === "function" ? registration.title(input) : registration.title;
  }

  /**
   * §2.6: a function `pointerHint` is called ONLY here (from a pointer-kind
   * update), in its OWN try/catch — a throw here must never make the
   * section fall into `sectionTexts`'s outer catch (which would drop this
   * turn's whole update and roll the section back to its last snapshot).
   */
  function resolveFunctionPointerHint(
    name: SectionName,
    fn: (input: SectionProviderInput) => string,
    input: SectionProviderInput,
  ): string | undefined {
    let value: unknown;
    try {
      value = fn(input);
    } catch {
      if (!warnedPointerHint.has(name)) {
        warnedPointerHint.add(name);
        log(`prompt section "${name}" pointerHint function threw; omitting the hint`);
      }
      return undefined;
    }
    if (typeof value !== "string" || value === "" || isThenable(value)) {
      if (!warnedPointerHint.has(name)) {
        warnedPointerHint.add(name);
        log(`prompt section "${name}" pointerHint function returned a non-usable value; omitting the hint`);
      }
      return undefined;
    }
    return value;
  }

  const scopedNames = (): ReadonlySet<SectionName> =>
    new Set([...registrations].filter(([, r]) => r.sessionScoped === true).map(([name]) => name));
  function scope(): SectionScope | undefined {
    const names = scopedNames();
    return names.size === 0 ? undefined : { names, sessionId: currentSid };
  }
  function noteSession(ctx: ExtensionContext | undefined): void {
    // Only session-scoped sections need the sid: without one registered the ctx is never touched here
    // (a minimal host without a session manager must keep working byte-for-byte as before).
    if (![...registrations.values()].some((r) => r.sessionScoped === true)) return;
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      currentSid = typeof id === "string" && id !== "" ? id : undefined;
    } catch {
      currentSid = undefined; // stale ctx ⇒ unknown ⇒ scoped sections are not trusted
    }
  }

  function persist(): void {
    const data = serializeSectionStates(states, scope());
    const serialized = JSON.stringify(data);
    if (serialized === lastPersisted) return;
    try {
      pi.appendEntry(PROMPT_SECTIONS_ENTRY_TYPE, data);
      lastPersisted = serialized;
    } catch (error) {
      if (!warnedPersist) {
        warnedPersist = true;
        log(`prompt section persist failed (in-memory state kept): ${String(error)}`);
      }
    }
  }

  /** Both session_start and session_tree read the branch this way (never throws); each hook applies its own not-found policy below (§4.9). */
  function readBranch(ctx: ExtensionContext, reason: ReadBackReason): ReadBack | undefined {
    try {
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      return readBackSectionStates(branch, reason, names(), scope());
    } catch {
      return undefined;
    }
  }

  function resetToFresh(): void {
    states.clear();
    for (const [name, state] of freshStates()) states.set(name, state);
  }

  function onSessionStart(ctx: ExtensionContext, reason: ReadBackReason): void {
    noteSession(ctx);
    const restored = readBranch(ctx, reason);
    retractForeign.clear();
    for (const name of restored?.foreignAnnounced ?? []) retractForeign.add(name);
    if (!restored) {
      // §4.8: entry not found / invalid / reason "new" -> fresh snapshot (one refresh ahead).
      resetToFresh();
      lastPersisted = undefined;
    } else {
      states.clear();
      for (const [name, state] of restored.states)
        states.set(name, reason === "reload" && restored.exact ? state : forgetAnnounced(state));
      lastPersisted = restored.serialized;
    }
    replay.reset();
    userTurnSeen = false;
    prefixFresh = false;
    firstRequestPending = true;
  }

  function onSessionTree(ctx: ExtensionContext): void {
    noteSession(ctx);
    const restored = readBranch(ctx, "tree");
    if (restored) {
      retractForeign.clear();
      for (const name of restored.foreignAnnounced) retractForeign.add(name);
      states.clear();
      for (const [name, state] of restored.states) states.set(name, forgetAnnounced(state));
      lastPersisted = restored.serialized;
      return;
    }
    // §4.9: no entry on the new branch (or a read error) -> keep the in-memory
    // states as they are (do NOT reset to fresh -- that is session_start's
    // policy, not session_tree's), just forgetAnnounced them.
    for (const name of names()) states.set(name, forgetAnnounced(states.get(name) ?? initialSectionState()));
    lastPersisted = undefined;
  }

  function sectionTexts(
    input: SectionProviderInput,
    mode: SystemPromptMode,
    collectUpdates: boolean,
  ): { texts: string[]; updates: RenderUpdate[] } {
    const texts: string[] = [];
    const updates: RenderUpdate[] = [];
    for (const [name, registration] of registrations) {
      try {
        if (registration.skipIf?.(input)) continue;
        const live = callProvider(registration, input);
        if (mode === "legacy") {
          texts.push(live === SKIP ? "" : live);
          continue;
        }
        let state = states.get(name) ?? initialSectionState();
        if (mode === "live") state = markStale(state);
        const resolved = resolveAtTurn(state, live);
        states.set(name, resolved.state);
        texts.push(resolved.text);
        let update = resolved.update;
        if (
          collectUpdates &&
          retractForeign.has(name) &&
          resolved.state.snapshot !== undefined &&
          !resolved.state.stale
        ) {
          // D2: the branch history still carries ANOTHER session's update of this scoped section.
          // Say what is true for THIS session: nothing (removed) or its own current block.
          retractForeign.delete(name);
          update ??=
            resolved.state.snapshot === "" ? { kind: "removed" } : { kind: "update", content: resolved.state.snapshot };
        }
        if (collectUpdates && update) {
          const pointerHint =
            typeof registration.pointerHint === "string"
              ? registration.pointerHint
              : registration.pointerHint !== undefined && update.kind === "pointer"
                ? resolveFunctionPointerHint(name, registration.pointerHint, input)
                : undefined;
          updates.push({
            section: name,
            title: titleOf(registration, input),
            ...(pointerHint === undefined ? {} : { pointerHint }),
            // The frozen head never carried this section (empty snapshot) ⇒ the update adds it.
            ...(resolved.state.snapshot === "" ? { absentFromHead: true } : {}),
            ...update,
          });
        }
      } catch {
        const state = states.get(name);
        texts.push(mode === "legacy" ? "" : (state?.snapshot ?? ""));
      }
    }
    return { texts, updates };
  }

  function seedSections(ctx: ExtensionContext, promptText: string, mode: SystemPromptMode): string {
    const input: SectionProviderInput = { ctx, promptText };
    const texts: string[] = [];
    for (const [name, registration] of registrations) {
      try {
        if (registration.skipIf?.(input)) continue;
        if (mode === "legacy") {
          const live = callProvider(registration, input);
          texts.push(live === SKIP ? "" : live);
          continue;
        }
        const state = states.get(name) ?? initialSectionState();
        const resolved = resolveAtSeed(state, () => callProvider(registration, input));
        states.set(name, resolved.state);
        texts.push(resolved.text);
      } catch {
        texts.push(mode === "legacy" ? "" : (states.get(name)?.snapshot ?? ""));
      }
    }
    return foldSections(promptText, texts);
  }

  function onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): BeforeAgentStartEventResult | undefined {
    userTurnSeen = true;
    noteSession(ctx);
    const mode = opts.mode();
    if (prefixFresh) {
      prefixFresh = false;
      for (const name of names()) states.set(name, markStale(states.get(name) ?? initialSectionState()));
    }
    const input: SectionProviderInput = {
      ctx,
      promptText: event.systemPrompt,
      ...(event.systemPromptOptions?.cwd === undefined ? {} : { optionsCwd: event.systemPromptOptions.cwd }),
    };
    const { texts, updates } = sectionTexts(input, mode, mode === "stable");
    const systemPrompt = foldSections(event.systemPrompt, texts);

    if (opts.wakeReplay) {
      replay.capture(
        systemPrompt !== event.systemPrompt
          ? systemPrompt
          : opts.adoptForeignForcedPrompt
            ? readForceSystemPrompt(event)
            : undefined,
      );
    }
    if (mode === "stable") persist();

    let message: BeforeAgentStartEventResult["message"];
    if (updates.length > 0) {
      try {
        message = renderSectionUpdateMessage(updates);
      } catch {
        message = undefined;
      }
    }
    if (systemPrompt === event.systemPrompt && message === undefined) return undefined;
    return {
      ...(systemPrompt === event.systemPrompt ? {} : { systemPrompt }),
      ...(message === undefined ? {} : { message }),
    };
  }

  function handleContextWithSystem(
    event: { messages: MessageLike[] },
    ctx: ExtensionContext,
  ): { messages: MessageLike[] } | undefined {
    const first = firstRequestPending;
    firstRequestPending = false;
    const captured = replay.captured();
    if (captured !== undefined) {
      if (first) {
        const current = tryGetSystemPrompt(ctx);
        if (current !== undefined && current !== captured && current.startsWith(captured)) {
          log(
            `R5a: a later extension appended forced system-prompt text; ${opts.adoptForeignForcedPrompt ? "adopting" : "keeping only"} our captured bytes`,
          );
          if (opts.adoptForeignForcedPrompt) replay.capture(current);
        }
      }
      const messages = replay.apply(event.messages);
      return messages === undefined ? undefined : { messages };
    }
    if (!first || userTurnSeen || registrations.size === 0) return undefined;
    const current = tryGetSystemPrompt(ctx);
    if (current === undefined || current === "") return undefined;
    const seeded = seedSections(ctx, current, opts.mode());
    if (seeded === current) return undefined;
    replay.capture(seeded);
    const messages = replay.apply(event.messages);
    return messages === undefined ? undefined : { messages };
  }

  pi.on("before_agent_start", onBeforeAgentStart);
  if (opts.wakeReplay) registerContextWithSystem(pi, handleContextWithSystem);
  pi.on("session_start", (event, ctx) => onSessionStart(ctx, event.reason));
  pi.on("session_compact", () => {
    // §4.5: forgetAnnounced ONLY here -- markStale is gated by prefixFresh
    // inside onBeforeAgentStart so a compaction that is NOT immediately
    // followed by a fresh user turn (mid-run compaction, F12②③) does not
    // silently rewrite the frozen snapshot on a later, non-free turn.
    for (const name of names()) states.set(name, forgetAnnounced(states.get(name) ?? initialSectionState()));
    prefixFresh = true;
  });
  pi.on("model_select", () => {
    prefixFresh = true;
  });
  pi.on("session_tree", (_event, ctx) => onSessionTree(ctx));
  pi.on("turn_start", () => {
    prefixFresh = false;
  });
  pi.on("agent_settled", () => {
    firstRequestPending = true;
  });

  return {
    register(name, registration) {
      if (registrations.has(name)) throw new Error(`duplicate prompt section registration: ${name}`);
      registrations.set(name, registration);
      states.set(name, initialSectionState());
    },
    _state(name) {
      const state = states.get(name);
      return state === undefined ? undefined : { ...state };
    },
    _captured() {
      return replay.captured();
    },
  };
}
