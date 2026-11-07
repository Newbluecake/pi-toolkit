import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { FakeClock } from "../../src/core/clock.js";
import {
  ROOT_WAKE_ABORT_GRACE_MS,
  guardRootWakeContext,
  observeRootWakeTrigger,
  RootWakeController,
  RootWakeOrphanWatch,
  type RootWakeDeps,
} from "../../src/fabric/root-wake.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";

describe("RootWakeController random event invariants", () => {
  it("single owner, occupied states supervised, at-most-once abort, zero abort after handover", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ op: fc.integer({ min: 0, max: 12 }), ms: fc.integer({ min: 0, max: 15000 }) }), {
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
            const c = controllers.length > 0 ? main() : undefined;
            switch (event.op) {
              case 0:
              case 1:
                deferred = event.op === 1;
                c.dispatch({ xid: `x-${nextToken}`, from: "sender", content: "fenced", expiresAt: clock.now() + 5000 });
                break;
              case 12:
                c.dispatch({
                  xid: `reply-${nextToken}`,
                  from: "sender",
                  content: "reply",
                  expiresAt: clock.now() + 5000,
                  solicited: true,
                  returnLevel: event.ms % 5,
                });
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

/**
 * wake-unknown-optimistic (plan §5.4, review #7): four-state capability, controller vs bare
 * guard + activation watch, repeated `context` sights, BAS/context interleaving, handover and
 * never-settling aborts. Reload/lease composition stays in the deterministic unit tests.
 */
describe("wake-unknown-optimistic random event invariants", () => {
  it("optimistic first-run: per-token ≤1 abort/audit, dead optimistic tokens never hop, capability monotone", () => {
    fc.assert(
      fc.property(
        fc.record({
          initialCap: fc.constantFrom("unknown", "observed", "verified", "absent"),
          neverSettle: fc.boolean(),
          events: fc.array(
            fc.record({
              op: fc.integer({ min: 0, max: 13 }),
              ms: fc.integer({ min: 0, max: 15000 }),
              pick: fc.integer({ min: 0, max: 9 }),
            }),
            { minLength: 40, maxLength: 160 },
          ),
        }),
        ({ initialCap, neverSettle, events }) => {
          const SESSION = "session";
          const clock = new FakeClock();
          const ledger = new XsWakeLedger();
          const capability = new XsHostCapability();
          if (initialCap === "observed" || initialCap === "verified")
            capability.observe({ messageType: "user", prompt: "seed" });
          if (initialCap === "verified") capability.verify();
          if (initialCap === "absent") capability.observe({ prompt: "old peer" });
          let prevCap = capability.state;
          const capOrder = (s: string) => ["unknown", "observed", "verified"].indexOf(s);
          const realLevel = createCausalLevel({
            maxLevel: 4,
            runLevel: () => undefined,
            raiseRun: () => {},
            initialRoot: 0,
            persistRoot: () => {},
          });
          // raise attribution: (token, value) pairs, plus the model the implementation must match
          const raises: Array<{ token: string; v: number }> = [];
          const expectRaises: Array<{ token: string; v: number }> = [];
          let raiseCtx: string | undefined;
          const level = {
            raise: (kind: "root", v: number) => {
              if (raiseCtx !== undefined) raises.push({ token: raiseCtx, v });
              realLevel.raise(kind, v);
            },
            hopAllowed: (l: number) => realLevel.hopAllowed(l),
          };
          const hostState = { idle: true };
          let deferredMode = false;
          const aborts = new Map<string, number>();
          const abortedOnce = new Set<string>();
          const abort = vi.fn(() => {
            if (neverSettle) return; // a never-settling host abort
            hostState.idle = true;
            const candidates = ledger
              .entries()
              .filter((r) => r.abortIssuedAt !== undefined && !abortedOnce.has(r.token));
            if (candidates.length > 1) throw new Error(`ambiguous abort attribution: ${candidates.length}`);
            const token = candidates[0]?.token;
            if (token !== undefined) {
              abortedOnce.add(token);
              aborts.set(token, (aborts.get(token) ?? 0) + 1);
            }
          });
          const auditLog: Array<[string, string | undefined]> = [];
          const audit = (event: string, token?: string) => auditLog.push([event, token]);
          const warn = vi.fn();
          const watch = new RootWakeOrphanWatch({ clock, audit, warn });
          const watchPort = { abort, isIdle: () => hostState.idle };
          let controllers = [new RootWakeController(depsFor())];
          function depsFor(): RootWakeDeps {
            return {
              sessionId: SESSION,
              rootRunMaxS: 5,
              wakeEnabled: true,
              receive: () => "wake",
              clock,
              ledger,
              capability,
              level,
              warn,
              abortOrphan: (t) => watch.issue(watchPort, t),
              newToken: () => `token-${++nextToken}`,
              host: {
                isIdle: () => hostState.idle,
                hasPendingMessages: () => false,
                sendMessage: () => {
                  hostState.idle = deferredMode;
                },
                abort,
              },
            };
          }
          let nextToken = 0;
          const main = () => controllers.find((c) => c.busy) ?? controllers[0]!;
          let attached = true;
          let windowOrphanNotes = 0;
          // token model: level + committed bit mirroring every write site
          const tokenModel = new Map<string, { lvl: number | undefined; optimistic: boolean; committed: boolean }>();
          const authorizedEver = new Set<string>();
          const tokenXid = new Map<string, string>();
          const seenTokens: string[] = [];
          const basEvent = (token: string | undefined, kind: "ours" | "orphan" | "notoken" | "shape") =>
            kind === "shape"
              ? { messageType: "custom" }
              : {
                  messageType: "custom",
                  message: {
                    customType: "subagent:xs",
                    details: {
                      xsWake: true,
                      ...(token === undefined ? {} : { wakeToken: token }),
                    },
                  },
                };
          const ctxEvent = (token: string | undefined, xid: string | undefined, marker: boolean) => ({
            type: "context",
            messages: marker
              ? [
                  { role: "user", content: "u" },
                  {
                    role: "custom",
                    customType: "subagent:xs",
                    details: {
                      xsWake: true,
                      ...(token === undefined ? {} : { wakeToken: token }),
                      ...(xid === undefined ? {} : { xid }),
                    },
                  },
                ]
              : [{ role: "assistant", content: "a" }],
          });
          const barePort = {
            abort: (() => {
              void watch.issue(watchPort, undefined);
            }) as () => void,
            isIdle: () => hostState.idle,
          };
          for (const event of events) {
            const c = controllers.length > 0 ? main() : undefined;
            const busyToken = controllers.find((x) => x.busy)?.activeToken;
            const oldToken = seenTokens.length > 0 ? seenTokens[event.pick % seenTokens.length] : undefined;
            switch (event.op) {
              case 0:
              case 1: {
                deferredMode = event.pick % 2 === 0;
                const lvl = event.op === 1 || event.pick % 4 === 3 ? undefined : event.pick % 3;
                const token = `token-${nextToken + 1}`;
                raiseCtx = token;
                if (controllers.length === 0) break; // no stack: no dispatch (production window)
                const optimistic = capability.optimistic;
                const result = c.dispatch({
                  xid: `x${nextToken + 1}`,
                  from: "sender",
                  content: "fenced",
                  expiresAt: clock.now() + 5000,
                  ...(lvl === undefined ? {} : { level: lvl }),
                });
                raiseCtx = undefined;
                if (result.dispatched) {
                  seenTokens.push(result.token);
                  tokenXid.set(result.token, `x${result.token.slice(6)}`);
                  const appliedCarryOrHop = result.effect === "applied" && !optimistic && lvl !== undefined;
                  tokenModel.set(result.token, { lvl, optimistic, committed: appliedCarryOrHop });
                  if (lvl !== undefined)
                    expectRaises.push({ token: result.token, v: appliedCarryOrHop ? lvl + 1 : lvl });
                  if (capability.state === "absent") throw new Error("absent host dispatched a wake");
                  if (optimistic && capability.state !== "unknown")
                    throw new Error("optimistic flag disagreed with capability");
                } else if (capability.state === "absent" && result.wakeDowngraded !== "host_unsupported")
                  throw new Error("absent host downgraded with a different token");
                break;
              }
              case 2: {
                watch.runStarted();
                windowOrphanNotes = 0;
                const kind =
                  event.pick <= 3 ? "ours" : event.pick <= 5 ? "orphan" : event.pick <= 6 ? "notoken" : "shape";
                const token =
                  kind === "ours" ? (busyToken ?? oldToken) : kind === "orphan" ? "orphan-token" : undefined;
                raiseCtx = token;
                const shapeTarget = busyToken;
                if (kind === "shape" && shapeTarget !== undefined) raiseCtx = shapeTarget;
                const ev = basEvent(token, kind);
                let result: { kind: string; token?: string };
                if (attached && controllers.length > 0) result = c.beforeAgentStart(ev);
                else {
                  for (const r of ledger.entries())
                    if (r.sessionId === SESSION && r.state === "live") ledger.tombstone(r.token);
                  result = observeRootWakeTrigger(ev, {
                    sessionId: SESSION,
                    abort: barePort.abort,
                    orphan: (t) => watch.issue(watchPort, t),
                    ledger,
                    capability,
                    clock,
                    level,
                    audit,
                    warn,
                  });
                }
                raiseCtx = undefined;
                if (result.kind === "authorized" && result.token !== undefined) {
                  authorizedEver.add(result.token);
                  const m = tokenModel.get(result.token);
                  if (m !== undefined && !m.committed) {
                    m.committed = true;
                    if (m.lvl !== undefined) expectRaises.push({ token: result.token, v: m.lvl + 1 });
                  }
                }
                if (kind === "shape" && shapeTarget !== undefined) {
                  const m = tokenModel.get(shapeTarget);
                  const rec = ledger.get(shapeTarget);
                  if (m?.optimistic && rec?.abortIssuedAt !== undefined) m.committed = true;
                }
                break;
              }
              case 3:
              case 4: {
                watch.runStarted();
                windowOrphanNotes = 0;
                const ev = event.op === 3 ? { messageType: "user", prompt: "human" } : { prompt: "legacy human" };
                if (attached && controllers.length > 0) c.beforeAgentStart(ev);
                else
                  observeRootWakeTrigger(ev, {
                    sessionId: SESSION,
                    abort: barePort.abort,
                    orphan: (t) => watch.issue(watchPort, t),
                    ledger,
                    capability,
                    clock,
                    audit,
                    warn,
                  });
                break;
              }
              case 5: {
                const marker = event.pick <= 5;
                const token =
                  event.pick <= 3
                    ? (busyToken ?? oldToken)
                    : event.pick === 4
                      ? oldToken
                      : event.pick === 5
                        ? "orphan-token"
                        : busyToken;
                const known = token !== undefined && ledger.get(token) !== undefined;
                const xid = event.pick === 6 ? "WRONG" : token !== undefined ? tokenXid.get(token) : undefined;
                const ev = ctxEvent(token, xid, marker);
                const before = new Map(ledger.entries().map((r) => [r.token, r.levelCommitted] as const));
                let result: { kind: string; token?: string };
                if (attached && controllers.length > 0) result = c.context(ev);
                else
                  result = guardRootWakeContext(ev, {
                    sessionId: SESSION,
                    abort: barePort.abort,
                    orphan: (t) => watch.issue(watchPort, t),
                    ledger,
                    capability,
                    clock,
                    audit,
                    warn,
                  });
                if (result.kind === "aborted" && result.token !== undefined && ledger.get(result.token) !== undefined) {
                  const m = tokenModel.get(result.token);
                  if (m && !m.committed) m.committed = true; // the guard writes levelCommitted:true
                }
                if (result.kind === "other" && marker && known && token !== undefined) {
                  const rec = ledger.get(token);
                  if (rec?.handed === true && before.get(token) === false) {
                    const m = tokenModel.get(token);
                    if (m && !m.committed) m.committed = true;
                  }
                }
                break;
              }
              case 6:
                if (controllers.length === 0) break;
                c.input({ source: "rpc", text: "human" });
                if (c.state === "handedOver" && c.activeToken !== undefined) {
                  const m = tokenModel.get(c.activeToken);
                  if (m?.optimistic && !m.committed) m.committed = true;
                }
                break;
              case 7:
                for (const x of controllers) x.settled();
                watch.settled();
                windowOrphanNotes = 0;
                break;
              case 8:
                clock.advance(event.ms);
                break;
              case 9:
                hostState.idle = true;
                break;
              case 10:
                hostState.idle = false;
                break;
              case 11: {
                for (const old of controllers) old.dispose();
                controllers = [new RootWakeController(depsFor())];
                raiseCtx = ledger.entries().find((r) => r.sessionId === SESSION && r.state === "live")?.token;
                controllers[0]!.recover();
                const claimed = controllers[0]!.activeToken;
                if (claimed !== undefined) {
                  const rec = ledger.get(claimed);
                  const m = tokenModel.get(claimed);
                  if (
                    rec?.started === true &&
                    rec.abortIssuedAt === undefined &&
                    (!rec.optimistic || rec.authorizedAt !== undefined) &&
                    m !== undefined &&
                    !m.committed
                  ) {
                    m.committed = true;
                    if (m.lvl !== undefined) expectRaises.push({ token: claimed, v: m.lvl + 1 });
                  }
                }
                raiseCtx = undefined;
                break;
              }
              case 12:
                attached = !attached;
                if (attached) {
                  for (const old of controllers) old.dispose(); // never leak the previous stack's timers
                  controllers = [new RootWakeController(depsFor())];
                  raiseCtx = ledger.entries().find((r) => r.sessionId === SESSION && r.state === "live")?.token;
                  controllers[0]!.recover();
                  const claimed0 = controllers[0]!.activeToken;
                  if (claimed0 !== undefined) {
                    const rec0 = ledger.get(claimed0);
                    const m0 = tokenModel.get(claimed0);
                    if (
                      rec0?.started === true &&
                      rec0.abortIssuedAt === undefined &&
                      (!rec0.optimistic || rec0.authorizedAt !== undefined) &&
                      m0 !== undefined &&
                      !m0.committed
                    ) {
                      m0.committed = true;
                      if (m0.lvl !== undefined) expectRaises.push({ token: claimed0, v: m0.lvl + 1 });
                    }
                  }
                  raiseCtx = undefined;
                } else {
                  for (const old of controllers) old.dispose();
                  controllers = []; // the bare window has no live stack
                }
                break;
              case 13:
                watch.runStarted();
                windowOrphanNotes = 0;
                break;
            }
            // ---- invariants after every event ----
            const nowCap = capability.state;
            if (nowCap !== prevCap) {
              if (nowCap === "absent") {
                if (prevCap === "absent") throw new Error("absent left absent");
              } else if (capOrder(nowCap) <= capOrder(prevCap))
                throw new Error(`capability regressed ${prevCap}→${nowCap}`);
              prevCap = nowCap;
            }
            for (const [tokenStr, n] of aborts) expect(n, `abort count for ${tokenStr}`).toBeLessThanOrEqual(1);
            for (const rec of ledger.entries()) {
              if (!tokenModel.has(rec.token)) continue;
              const auditCount = auditLog.filter(
                ([e, t]) => t === rec.token && (e === "wake_shape_absent_aborted" || e === "wake_late_aborted"),
              ).length;
              expect(auditCount, `abort audit for ${rec.token}`).toBeLessThanOrEqual(1);
              const handedNotes = auditLog.filter(
                ([e, t]) => t === rec.token && e === "wake_shape_absent_handed",
              ).length;
              expect(handedNotes, `handed audit for ${rec.token}`).toBeLessThanOrEqual(1);
              if (rec.handed) expect(aborts.get(rec.token) ?? 0, `abort after handover ${rec.token}`).toBe(0);
            }
            expect(windowOrphanNotes).toBeLessThanOrEqual(1);
            const busy = controllers.filter((x) => x.busy);
            expect(busy.length).toBeLessThanOrEqual(1);
            if (busy.length === 1) expect(clock.pendingTimers, "occupied controller has timers").toBeGreaterThan(0);
            if (watch.pending) expect(clock.pendingTimers, "pending watch has timers").toBeGreaterThan(0);
            const owner = busy[0];
            if (owner?.state === "aborting") {
              const rec = owner.activeToken !== undefined ? ledger.get(owner.activeToken) : undefined;
              if (rec?.abortIssuedAt !== undefined && clock.now() >= rec.abortIssuedAt + ROOT_WAKE_ABORT_GRACE_MS)
                expect(owner.state, "grace passed while aborting").toBe("stuck");
            }
          }
          // dead optimistic tokens never hop: their attributed raises are all carries
          for (const [tokenStr, m] of tokenModel) {
            if (!m.optimistic || m.lvl === undefined) continue;
            const myRaises = raises.filter((r) => r.token === tokenStr).map((r) => r.v);
            if (!authorizedEver.has(tokenStr))
              for (const v of myRaises) expect(v, `dead optimistic ${tokenStr} raised a hop`).toBe(m.lvl);
          }
          // the raise stream the implementation produced equals the model
          expect(raises).toEqual(expectRaises);
          for (const x of controllers) x.dispose();
          watch.dispose();
          expect(clock.pendingTimers).toBe(0);
        },
      ),
      { seed: 20261102, numRuns: 150 },
    );
  });
});
