/**
 * fabric-xs-activation plan §3 P1: `/fabric status`'s requests line — rendered from the
 * optional `deps.progress` port (English tokens only). Absent port / empty rows ⇒ NO line
 * (byte-identical status output); a hub without `xs.state.v1` renders `unavailable`, never a
 * fabricated zero; phase counts + `wake↓` reasons come from the rows verbatim.
 */
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import { XsMembership } from "../../src/fabric/xs/membership.js";
import {
  createFabricXsCommand,
  type FabricXsCommandDeps,
  type FabricXsProgressView,
} from "../../src/commands/fabric-xs.js";

const SESSION = "sess-cmd-0123456789abcd";

function harness(progress?: () => FabricXsProgressView | undefined) {
  const clock = new FakeClock(1_000);
  const membership = new XsMembership({ sessionId: SESSION, clock, persist: () => undefined });
  membership.attach();
  const deps: FabricXsCommandDeps = {
    enabled: () => true,
    sessionId: () => SESSION,
    membership: () => membership,
    fence: () => createSessionFence({ clock }),
    statusView: () => ({ capability: "verified", lines: [] }),
    now: () => clock.now(),
    ...(progress === undefined ? {} : { progress }),
  };
  const command = createFabricXsCommand(deps);
  return {
    async status(): Promise<string> {
      const notes: { message: string; level: string }[] = [];
      await command.handler("status", {
        mode: "tui",
        ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
      } as never);
      return notes[0]?.message ?? "";
    },
  };
}

describe("/fabric status requests line (fabric-xs-activation P1)", () => {
  it("no port / empty rows ⇒ no requests line at all", async () => {
    expect(await harness().status()).not.toContain("requests");
    expect(await harness(() => ({ rows: [] })).status()).not.toContain("requests q");
  });

  it("counts phases (English tokens) and lists wake↓ reasons", async () => {
    const out = await harness(() => ({
      rows: [
        { phase: "queued" },
        { phase: "delivered" },
        { phase: "delivered", wakeReason: "pair_wake_rate" },
        { phase: "started" },
        { phase: "replied" },
        { wakeReason: "pair_wake_rate" },
      ],
    })).status();
    expect(out).toContain("requests q1 d2 s1 r1 u1 · wake↓ pair_wake_rate×2");
  });

  it("hubStateCap false ⇒ unavailable (legacy hub), never fabricated zeros", async () => {
    const out = await harness(() => ({ rows: [{ phase: "delivered" }], hubStateCap: false })).status();
    expect(out).toContain("requests unavailable (hub-cap off)");
    expect(out).not.toContain("requests q");
  });

  it("hubStateCap undefined (n/a) still renders the local counts", async () => {
    const out = await harness(() => ({ rows: [{ phase: "delivered" }] })).status();
    expect(out).toContain("requests q0 d1 s0 r0");
  });
});
