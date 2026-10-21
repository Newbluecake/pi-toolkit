import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FakeClock } from "../../src/core/clock.js";
import { RootWakeController, type RootWakeDeps } from "../../src/fabric/root-wake.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";

describe("RootWakeController random event invariants", () => {
  it("single owner, occupied states supervised, at-most-once abort, zero abort after handover", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ op: fc.integer({ min: 0, max: 11 }), ms: fc.integer({ min: 0, max: 15000 }) }), {
          minLength: 30,
          maxLength: 150,
        }),
        (events) => {
          const clock = new FakeClock(),
            ledger = new XsWakeLedger(),
            capability = new XsHostCapability();
          capability.observe({ messageType: "user", prompt: "seed human" });
          let idle = true,
            deferred = false,
            nextToken = 0,
            abortingToken: string | undefined;
          const aborts = new Map<string, number>(),
            handed = new Set<string>();
          const deps: RootWakeDeps = {
            sessionId: "session",
            rootRunMaxS: 5,
            wakeEnabled: true,
            receive: () => "wake",
            clock,
            ledger,
            capability,
            newToken: () => `token-${++nextToken}`,
            warn: () => {},
            host: {
              isIdle: () => idle,
              hasPendingMessages: () => false,
              sendMessage: () => {
                idle = deferred;
              },
              abort: () => {
                const token = abortingToken ?? controllers.find((c) => c.busy)?.activeToken;
                if (token !== undefined) {
                  expect(handed.has(token)).toBe(false);
                  aborts.set(token, (aborts.get(token) ?? 0) + 1);
                }
              },
            },
          };
          let controllers = [new RootWakeController(deps)];
          const main = () => controllers.find((c) => c.busy) ?? controllers[0]!;
          for (const event of events) {
            const c = main();
            switch (event.op) {
              case 0:
              case 1:
                deferred = event.op === 1;
                c.dispatch({ xid: `x-${nextToken}`, from: "sender", content: "fenced", expiresAt: clock.now() + 5000 });
                break;
              case 2:
                clock.advance(event.ms);
                break;
              case 3:
                idle = true;
                break;
              case 4:
                idle = false;
                break;
              case 5: {
                const record =
                  ledger.entries().find((r) => r.token === c.activeToken) ??
                  ledger.entries().find((r) => r.state === "tombstone");
                if (record !== undefined) {
                  idle = false;
                  abortingToken = record.token;
                  c.beforeAgentStart({
                    messageType: "custom",
                    message: { customType: "subagent:xs", details: { xsWake: true, wakeToken: record.token } },
                  });
                  abortingToken = undefined;
                }
                break;
              }
              case 6:
                c.input({ source: "rpc", text: "human" });
                if (c.state === "handedOver") handed.add(c.activeToken!);
                break;
              case 7:
                c.settled();
                break;
              case 8:
                c.beforeAgentStart({ messageType: "user", prompt: "other run" });
                break;
              case 9:
                for (const old of controllers) old.dispose();
                controllers = [new RootWakeController(deps)];
                controllers[0]!.recover();
                break;
              case 10:
                if (controllers.length < 3) controllers.push(new RootWakeController(deps));
                controllers.at(-1)!.recover();
                break;
              case 11:
                c.input({ source: "extension", text: "/goal continuation" });
                break;
            }
            const owners = controllers.filter((controller) => controller.busy);
            expect(owners.length).toBeLessThanOrEqual(1);
            for (const owner of owners) {
              const record = ledger.get(owner.activeToken!);
              expect(record).toBeDefined();
              // Every occupying state has a deadline/grace timer OR the two-idle observer.
              expect(clock.pendingTimers).toBeGreaterThan(0);
              if (owner.state === "handedOver") {
                expect(record?.handed).toBe(true);
                expect(record?.started).toBe(true);
              }
              if (owner.state === "deferred") expect(record?.handed).toBe(false);
            }
            expect([...aborts.values()].every((n) => n <= 1)).toBe(true);
            expect(ledger.size).toBeLessThanOrEqual(ledger.capacity);
          }
          for (const c of controllers) c.dispose();
          expect(clock.pendingTimers).toBe(0);
        },
      ),
      { seed: 20261021, numRuns: 250 },
    );
  });
});
