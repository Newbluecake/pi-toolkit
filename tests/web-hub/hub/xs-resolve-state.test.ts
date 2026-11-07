import { afterEach, describe, expect, it } from "vitest";
import { rig } from "./xs-fixtures.js";
import type { XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";

/** P2b: target.xsState is authoritative hello-cap evidence, three-end gated. */
const OLD = ["ev.v1", "xs.v1", "xs.reply.v1"];
const NEW = [...OLD, "xs.state.v1"];
const rigs: ReturnType<typeof rig>[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.relay.dispose();
  }
});

function resolve(hub: boolean, source: boolean, target: boolean) {
  const r = rig(60, undefined, hub ? true : undefined);
  rigs.push(r);
  const a = r.agent({ pid: 1, sessionId: "sess-A", caps: source ? NEW : OLD });
  const b = r.agent({ pid: 2, sessionId: "sess-B", caps: target ? NEW : OLD });
  const out: XsResFrame[] = [];
  const frame: XsReqFrame = {
    t: "xs_req",
    rid: "resolve-proof",
    op: "resolve",
    query: "sess-B",
    origin: { sessionId: "sess-A", epoch: 1 },
  };
  r.relay.router.handle(a.key, frame, (result) => out.push(result));
  expect(out).toHaveLength(1);
  return { r, a, b, frame, result: out[0]! };
}

describe("P2b resolve target state-cap negotiation", () => {
  for (const hub of [false, true])
    for (const source of [false, true])
      for (const target of [false, true]) {
        it(`hub=${hub} source=${source} target=${target}`, () => {
          const { result } = resolve(hub, source, target);
          expect(result).toMatchObject({ ok: true, target: { ref: "sess-B", sessionId: "sess-B" } });
          if (hub && source && target) expect(result.target).toHaveProperty("xsState", true);
          else expect(result.target).not.toHaveProperty("xsState");
        });
      }
  it("legacy/off combinations are byte-identical to the pre-feature resolve response", () => {
    const old = JSON.stringify(resolve(false, false, false).result);
    for (const [hub, source, target] of [
      [false, true, true],
      [true, false, true],
      [true, true, false],
    ] as const)
      expect(JSON.stringify(resolve(hub, source, target).result)).toBe(old);
  });
  it("changed target hello removes the proof; caller/status cannot manufacture it", () => {
    const { r, a, b, frame } = resolve(true, true, true);
    r.registry.onFrame(b.key, { t: "status", xsState: true } as never);
    // Re-register the actual target with a legacy hello on a new socket.
    r.registry.remove(b.key, { allowConnected: true });
    r.agent({ pid: 3, sessionId: "sess-B", caps: OLD });
    const out: XsResFrame[] = [];
    r.relay.router.handle(a.key, { ...frame, rid: "again" }, (result) => out.push(result));
    expect(out[0]?.target).not.toHaveProperty("xsState");
  });
});
