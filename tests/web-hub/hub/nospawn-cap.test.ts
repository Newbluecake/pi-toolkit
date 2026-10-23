/**
 * private-plan §4.1-5 (Q2, 拍板 2026-10-23) — hub side: an agent advertising `agent.nospawn.v1`
 * (a private-mount-ns session) NEVER enters the version-replacement observer, exactly like a
 * managed agent; the same agent WITHOUT the cap behaves exactly as before (freeze F6).
 *
 * Real `startHub` over a fake frontend (hub.test.ts's minimal pattern) + two real agent sockets.
 * Deliberately NOT added to `hub-spawn.test.ts`: that suite is replayed and COUNTED by
 * `spawn/golden.test.ts`'s immutable baseline, so its test set must not grow.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { AGENT_NOSPAWN_CAP } from "../../../src/web-hub/protocol/nospawn.js";
import { config, connectClient, hello, tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

function fakeFrontend(): FrontendFactory {
  return (deps: FrontendDeps): HttpFrontend => {
    void deps;
    return {
      listen: async () => ({ port: 43210 }),
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

describe("hub onVersion gate — agent.nospawn.v1 (private-plan §4.1-5 / Q2)", () => {
  it("a caps-carrying agent never reaches supersede.observe; without the cap the same version does", async () => {
    const home = tmp.make("wh-nospawn-");
    const hub = await startHub(config({ home }), fakeFrontend(), { uid: process.getuid?.() ?? 0 });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);

    const nsAgent = await connectClient(hub.paths.socketPath);
    nsAgent.send(
      hello({
        pluginVersion: "9.9.9",
        agentId: { pid: 4712, nonce: "nonceDDDDDDDDDDDDDDD" },
        caps: ["ev.v1", AGENT_NOSPAWN_CAP],
      }),
    );
    await nsAgent.waitFrame((f) => f["t"] === "hello_ack");
    await settle();
    await settle(); // register → caps recorded → onVersion — all synchronous; settle for good measure
    expect(hub.info.supersedePending).toBeFalsy(); // the cap held: observe() never ran

    const plain = await connectClient(hub.paths.socketPath);
    plain.send(hello({ pluginVersion: "9.8.8", agentId: { pid: 4713, nonce: "nonceEEEEEEEEEEEEEEE" } }));
    await plain.waitFrame((f) => f["t"] === "hello_ack");
    await settle();
    await settle();
    expect(hub.info.supersedePending).toBe(true);
    expect(hub.info.nextVersion).toBe("9.8.8");
    nsAgent.sock.destroy();
    plain.sock.destroy();
  });

  it("the cap alone is inert for a SAME-version agent (no supersede either way — F6 baseline)", async () => {
    const home = tmp.make("wh-nospawn-same-");
    const hub = await startHub(config({ home }), fakeFrontend(), { uid: process.getuid?.() ?? 0 });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
    const agent = await connectClient(hub.paths.socketPath);
    agent.send(
      hello({
        pluginVersion: "1.2.3", // same as the hub ⇒ never a supersede, cap or not
        agentId: { pid: 4714, nonce: "nonceFFFFFFFFFFFFFF" },
        caps: ["ev.v1", AGENT_NOSPAWN_CAP],
      }),
    );
    await agent.waitFrame((f) => f["t"] === "hello_ack");
    await settle();
    expect(hub.info.supersedePending).toBeFalsy();
    agent.sock.destroy();
  });
});
