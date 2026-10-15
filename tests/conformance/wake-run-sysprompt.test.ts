/**
 * Conformance pin for the wake-run system-prompt lineage (docs/dev/pi-1.2-compat/plan.md §5,
 * decision D1=A; converted from the plan-phase experiment `zz-wake-debug.test.ts`).
 *
 * Flow per case: real AgentSession + real `createPromptSectionHub` (stable mode) carrying one
 * frozen section, then user turn → notification wake run (`pi.sendMessage(triggerTurn:true)`) →
 * user turn, asserting on the three resulting model requests.
 *
 * Version split (the pi version is read in the TEST only — I14 forbids version gates in `src/`):
 * - wakeReplay:true is asserted on EVERY supported pi version: on pi ≤1.1 this is exactly what
 *   the replay layer exists for (wake runs never fire `before_agent_start` there, so without the
 *   replay their request head forks from the user runs' lineage — field-2026-09-24: 44% vs 10%).
 * - The `messageType === "custom"` bas observation and the wakeReplay:false case run ONLY on
 *   pi ≥1.2 (`it.runIf(piMinor >= 2)`): pi 1.2 fires `before_agent_start` for wake runs too and
 *   its own forced-prompt projection runs last, superseding the replay layer's output — which is
 *   precisely why the layer is dormant (not removed) there, kept for the 1.0/1.1 peer floor.
 */
import { describe, expect, it } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { readBeforeAgentStartTrigger } from "../../src/adapters/pi-compat.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { createProbeHarness, sleep, textTurn } from "./topic-switch-runtime-harness.js";

const piMinor = Number(VERSION.split(".")[1] ?? 0);

const SECTION_TEXT = "## MEMSECTION\nhello-from-wake-pin";

/** Poll until `pred()` is true or `timeoutMs` elapses (bounded waits only — zero-hang invariant). */
async function waitUntil(pred: () => boolean, timeoutMs = 5000, stepMs = 5): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(stepMs);
  }
}

function systemMessages(messages: unknown[]): unknown[] {
  return messages.filter((m) => (m as { role?: unknown }).role === "system");
}

/** Runs the user → wake → user flow against a real hub and returns the raw requests + bas kinds. */
async function runWakeFlow(wakeReplay: boolean): Promise<{ requests: unknown[][]; basKinds: string[] }> {
  const harness = await createProbeHarness({ scripted: [textTurn("ack")] });
  try {
    const pi = harness.currentPi();
    const hub = createPromptSectionHub(pi, {
      mode: () => "stable",
      wakeReplay,
      adoptForeignForcedPrompt: false,
      log: () => {}, // diagnostics silenced; regressions surface as assertion failures below
    });
    hub.register("pi_project_memory", { provider: () => SECTION_TEXT, title: "Memory" });
    const basKinds: string[] = [];
    pi.on("before_agent_start", (ev: unknown) => {
      basKinds.push(readBeforeAgentStartTrigger(ev).kind);
    });

    await harness.session().prompt("USER-1"); // request 0: user run
    pi.sendMessage({ customType: "wake", content: "WAKE-1", display: true }, { triggerTurn: true });
    await waitUntil(() => harness.modelRuntime.callCount() >= 2 && !harness.session().isStreaming); // request 1: wake run
    await harness.session().prompt("USER-2"); // request 2: user run

    return {
      requests: harness.modelRuntime.requestMessages.map((messages) => [...messages]),
      basKinds,
    };
  } finally {
    await harness.dispose();
  }
}

function expectOneByteLineage(requests: unknown[][]): void {
  expect(requests).toHaveLength(3);
  const heads = requests.map((messages) => systemMessages(messages)[0]);
  // Every request has a system head carrying the folded section (also on the wake run).
  for (const [i, head] of heads.entries()) {
    expect(head, `request ${i} has a system head`).toBeDefined();
    expect(JSON.stringify(heads[i]), `request ${i} head carries the section`).toContain("MEMSECTION");
  }
  // The wake run's head is byte-identical to BOTH surrounding user runs' heads.
  expect(heads[1]).toEqual(heads[0]);
  expect(heads[1]).toEqual(heads[2]);
}

describe("wake-run system-prompt lineage (pi-1.2-compat plan §5, D1=A)", () => {
  it("wakeReplay:true — wake-run request head equals the surrounding user runs' and carries the section (on pi ≤1.1 this equality IS the replay layer working)", async () => {
    const { requests } = await runWakeFlow(true);
    expectOneByteLineage(requests);
  });

  it.runIf(piMinor >= 2)(
    "pi ≥1.2: wake runs fire before_agent_start with messageType 'custom' (read via readBeforeAgentStartTrigger)",
    async () => {
      // pi ≤1.1: wake runs NEVER fire before_agent_start (its only 1.1 caller is prompt()) — that
      // missing signal is the root cause the replay layer exists to patch, which is why this case
      // cannot run there at all. pi 1.2 fires it for sendMessage(triggerTurn) wake runs.
      const { basKinds } = await runWakeFlow(true);
      expect(basKinds).toEqual(["user", "custom", "user"]);
    },
  );

  it.runIf(piMinor >= 2)(
    "pi ≥1.2, wakeReplay:false — heads still equal + section present: pi's own forced-prompt projection supersedes the replay layer (dormant, not removed)",
    async () => {
      // This is the pin that proves the replay layer is redundant on pi ≥1.2 (plan §5.1 evidence:
      // replay on/off produce byte-identical requests there). If it ever FAILS after a pi upgrade
      // (pi regresses to rendering wake heads from the base prompt), the replay layer is still
      // necessary — do NOT delete it. Conversely, once the peer floor rises to ≥1.2, this pin is
      // the basis for removing the layer entirely.
      const { requests } = await runWakeFlow(false);
      expectOneByteLineage(requests);
    },
  );
});
