/**
 * S0 probe extension `ask_probe` (ask-user-async plan §2.1): a stand-in for the FUTURE `ask_user`
 * background-interrupt wiring. It must NOT import P1/P2 implementation (none exists); it mirrors,
 * in miniature, exactly the mechanism the plan specifies:
 *
 *  - `execute()` awaits `ctx.ui.custom(...)` with a recording component (render/handleInput/dispose
 *    call counts + every keystroke) — the recording is what C2/C3/C5 assert against.
 *  - a synchronous first-claim-wins race between "tui" (component submit/escape) and "background"
 *    (out-of-stack completion), same semantics as src/ask-user/remote.ts's createDialogRace (the
 *    claimant union there gains "background" only in P1, plan §5.1).
 *  - `fire()` = §5.2's interrupt trigger in miniature: FIRST `pi.sendMessage(..., { triggerTurn:
 *    true })` (the §1.3 send point, customType `bash-job:notification`), THEN `race.claim(
 *    "background")` + `component.cancel()` — the §1.2 "stack-external interrupt" recipe.
 *  - T1: background wins BEFORE `ui.custom` (execute gates on fire) → factory observes the winner
 *    and `queueMicrotask(cancel)` (index.ts:87 pattern).
 *  - T2: fire is queued as a microtask BEFORE `ui.custom()` is invoked, so the claim+cancel lands
 *    in the factory-returned → `.then`-mount microtask gap of showExtensionCustom
 *    (interactive-mode.js `Promise.resolve(factory(...)).then(...)`): close() runs before mount.
 *  - T3a/b/c: fire after mount, racing keystrokes in the same tick.
 *  - "plain": no scheduling at all — the test drives send()/answer()/fire() by hand (Suite B,
 *    delivery-semantics criteria C6–C11).
 */
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

export const PROBE_CUSTOM_TYPE = "bash-job:notification";

export type ProbeTiming = "T1" | "T2" | "T3a" | "T3b" | "T3c" | "plain";

const ProbeParams = Type.Object({
  timing: Type.Union([
    Type.Literal("T1"),
    Type.Literal("T2"),
    Type.Literal("T3a"),
    Type.Literal("T3b"),
    Type.Literal("T3c"),
    Type.Literal("plain"),
  ]),
});

/** Synchronous first-claim-wins arbitration (createDialogRace semantics, "background" claimant). */
function createFirstClaimWins(): {
  claim(by: "tui" | "background"): boolean;
  winner: "tui" | "background" | undefined;
} {
  let winner: "tui" | "background" | undefined;
  return {
    claim(by) {
      if (winner !== undefined) return false;
      winner = by;
      return true;
    },
    get winner() {
      return winner;
    },
  };
}

export interface ProbeOutcome {
  kind: "answered" | "interrupted" | "cancelled";
  answer?: number;
}

export interface ProbeEventLogEntry {
  type: string;
  seq: number;
  role?: string | undefined;
}

export interface ProbeAttempt {
  index: number;
  timing: ProbeTiming;
  renders: number;
  inputs: string[];
  disposed: number;
  focusEvents: number;
  /** Set synchronously when execute() returns; undefined while the dialog hangs. */
  outcome: ProbeOutcome | undefined;
  whenEntered: Promise<void>;
  whenFactoryReturned: Promise<void>;
  /** Resolved on first focus (showExtensionCustom's `.then` mount ran setFocus). */
  whenMounted: Promise<void>;
  whenSettled: Promise<ProbeOutcome>;
}

export interface AskProbe {
  attempts: ProbeAttempt[];
  events: ProbeEventLogEntry[];
  /** role-"custom" message_start payloads seen by THIS extension (C7). */
  customMessages: Array<{ customType: string; content: unknown }>;
  /** §1.3 send point verbatim: triggerTurn custom message, no claim, no cancel. */
  send(content: string): void;
  /** send() + claim("background") + cancelLocal() — the interrupt trigger. */
  fire(): void;
  /** TUI-side programmatic submit: claim("tui") + submit — what handleInput("\r") does. */
  answer(n: number): void;
}

/** Recording component: counts render/handleInput/dispose, resolves `whenMounted` on first focus. */
class ProbeComponent implements Component {
  selected = 1;
  private doneLatch = false;
  private _focused = false;

  constructor(
    private readonly tuiSubmit: (selected: number) => void,
    private readonly tuiCancel: () => void,
    private readonly record: { renders: number; inputs: string[]; disposed: number; focusEvents: number },
    private readonly onFirstFocus: () => void,
  ) {}

  /** Focusable: TuiBase.setFocus sets this — first `true` marks the component as MOUNTED. */
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (value) {
      this.record.focusEvents += 1;
      this.onFirstFocus();
    }
  }

  render(_width: number): string[] {
    this.record.renders += 1;
    return [
      "┌─ ask_probe ───────────┐",
      "│ Background finished?  │",
      "│ [1] yes   [2] no      │",
      "└─ 1..2 · Enter · Esc ──┘",
    ];
  }

  handleInput(data: string): void {
    this.record.inputs.push(data);
    if (data >= "1" && data <= "9") {
      this.selected = Number(data);
    } else if (data === "\r") {
      this.claimTuiAndSubmit();
    } else if (data === "\x1b") {
      if (this.claimTui()) this.cancel();
    }
  }

  // claim() lives on the enclosing attempt's race, injected after construction.
  claimTui: () => boolean = () => false;
  claimTuiAndSubmit: () => void = () => {};

  /** TUI submit — mirrors AskUserComponent.submit's `_resolved`-style single-shot guard. */
  submit(selected: number): void {
    if (this.doneLatch) return;
    this.doneLatch = true;
    this.tuiSubmit(selected);
  }
  /** External cancel (background) — no race claim here, mirroring index.ts's web path. */
  cancel(): void {
    if (this.doneLatch) return;
    this.doneLatch = true;
    this.tuiCancel();
  }
  dispose(): void {
    this.record.disposed += 1;
  }
  invalidate(): void {}
}

export function createAskProbeExtension(): { factory: ExtensionFactory; probe: AskProbe } {
  const attempts: ProbeAttempt[] = [];
  const events: ProbeEventLogEntry[] = [];
  const customMessages: AskProbe["customMessages"] = [];
  let eventSeq = 0;
  let piSendMessage: ((content: string) => void) | undefined;

  // The currently-hanging attempt's control surface (one at a time in every S0 scenario).
  let live:
    | {
        attempt: ProbeAttempt;
        race: ReturnType<typeof createFirstClaimWins>;
        component: ProbeComponent | undefined;
        releaseGate: () => void;
      }
    | undefined;

  const sendNow = (content: string) => piSendMessage?.(content);

  const fireNow = (target: NonNullable<typeof live>) => {
    sendNow(`bg-done-${target.attempt.index}`);
    if (target.race.claim("background")) target.component?.cancel();
  };

  const factory: ExtensionFactory = (pi) => {
    piSendMessage = (content) =>
      pi.sendMessage({ customType: PROBE_CUSTOM_TYPE, content, display: true }, { triggerTurn: true });
    pi.on("ui_prompt_start", () => {
      events.push({ type: "ui_prompt_start", seq: eventSeq++ });
    });
    pi.on("ui_prompt_end", () => {
      events.push({ type: "ui_prompt_end", seq: eventSeq++ });
    });
    pi.on("agent_start", () => {
      events.push({ type: "agent_start", seq: eventSeq++ });
    });
    pi.on("agent_end", () => {
      events.push({ type: "agent_end", seq: eventSeq++ });
    });
    pi.on("message_start", (e) => {
      const message = e.message as { role?: string; customType?: string; content?: unknown };
      events.push({ type: "message_start", seq: eventSeq++, role: message?.role });
      if (message?.role === "custom")
        customMessages.push({ customType: message.customType ?? "?", content: message.content });
    });

    pi.registerTool({
      name: "ask_probe",
      label: "Ask Probe",
      description: "S0 conformance probe: hangs on ctx.ui.custom like ask_user; interrupted via probe.fire().",
      parameters: ProbeParams,
      async execute(
        _toolCallId: string,
        params: Static<typeof ProbeParams>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<ProbeOutcome> | undefined,
        ctx: ExtensionContext,
      ): Promise<AgentToolResult<ProbeOutcome>> {
        const timing = params.timing as ProbeTiming;
        const race = createFirstClaimWins();
        let resolveEntered!: () => void;
        let resolveFactory!: () => void;
        let resolveMounted!: () => void;
        let resolveSettled!: (o: ProbeOutcome) => void;
        const attempt = {
          index: attempts.length,
          timing,
          renders: 0,
          inputs: [] as string[],
          disposed: 0,
          focusEvents: 0,
          outcome: undefined,
          whenEntered: new Promise<void>((r) => (resolveEntered = r)),
          whenFactoryReturned: new Promise<void>((r) => (resolveFactory = r)),
          whenMounted: new Promise<void>((r) => (resolveMounted = r)),
          whenSettled: new Promise<ProbeOutcome>((r) => (resolveSettled = r)),
        } as ProbeAttempt & { renders: number; inputs: string[]; disposed: number; focusEvents: number };
        attempts.push(attempt);

        const target = { attempt, race, component: undefined as ProbeComponent | undefined, releaseGate: () => {} };
        live = target;
        resolveEntered();

        // T1: the background completion won BEFORE ui.custom — execute gates until fire()
        // releases it (fire() = send + claim + cancelLocal; component doesn't exist yet).
        if (timing === "T1") await new Promise<void>((r) => (target.releaseGate = r));

        // T2: queue the fire microtask BEFORE calling ui.custom — it lands in the
        // factory-returned → `.then`-mount microtask gap (close() runs before mount).
        if (timing === "T2") void Promise.resolve().then(() => fireNow(target));

        const localResult = await ctx.ui.custom<ProbeOutcome | null>((tui, _theme, _keybindings, done) => {
          const record = attempt as ProbeAttempt & {
            renders: number;
            inputs: string[];
            disposed: number;
            focusEvents: number;
          };
          const comp = new ProbeComponent(
            (selected) => done({ kind: "answered", answer: selected }),
            () => done(null),
            record,
            () => resolveMounted(),
          );
          comp.claimTui = () => race.claim("tui");
          comp.claimTuiAndSubmit = () => {
            if (race.claim("tui")) comp.submit(comp.selected);
          };
          target.component = comp;
          if (race.winner === "background") queueMicrotask(() => comp.cancel()); // index.ts:87 pattern
          resolveFactory();
          return comp;
        });

        const outcome: ProbeOutcome =
          race.winner === "background"
            ? { kind: "interrupted" }
            : localResult?.kind === "answered"
              ? { kind: "answered", answer: localResult.answer ?? 0 }
              : { kind: "cancelled" };
        attempt.outcome = outcome;
        resolveSettled(outcome);
        return { content: [{ type: "text", text: `probe:${outcome.kind}${outcome.answer ?? ""}` }], details: outcome };
      },
    });
  };

  const probe: AskProbe = {
    attempts,
    events,
    customMessages,
    send: sendNow,
    fire: () => {
      const target = live && live.attempt.outcome === undefined ? live : undefined;
      if (!target) return;
      target.releaseGate(); // no-op unless T1 still gated
      fireNow(target);
    },
    answer: (n: number) => {
      const target = live && live.attempt.outcome === undefined ? live : undefined;
      if (!target?.component) return;
      target.component.selected = n;
      target.component.claimTuiAndSubmit();
    },
  };
  return { factory, probe };
}
