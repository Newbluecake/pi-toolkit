/**
 * web-hub-version plan §3.7/§3.8 — hub assembly: the `version.v1` cap on both surfaces,
 * `FrontendDeps.version`, and `onUiServed` ⇒ `HubInfo.ui` + exactly one `hub` broadcast per real
 * change. Real `startHub` over a fake frontend (hub-preview.test.ts's pattern).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendDeps, FrontendFactory, HttpFrontend, HubEvent } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { HubUiBuildWire } from "../../../src/web-hub/protocol/version-info.js";
import { config, connectClient, hello, tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

function fakeFrontend(): FrontendFactory & { deps: FrontendDeps[] } {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return {
      listen: async () => ({ port: 43210 }),
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        probe: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  }) as FrontendFactory & { deps: FrontendDeps[] };
  f.deps = [];
  return f;
}

async function start(): Promise<{ hub: RunningHub; deps: FrontendDeps; frames: HubEvent[] }> {
  const fe = fakeFrontend();
  const hub = await startHub(config({ home: tmp.make("wh-hubversion-"), port: 0 }), fe, {
    uid: process.getuid?.() ?? 0,
  });
  if ("exists" in hub) throw new Error("unexpected exists");
  hubs.push(hub);
  const deps = fe.deps[0]!;
  const frames: HubEvent[] = [];
  deps.bus.subscribe((e) => {
    if (e.type === "hub") frames.push(e);
  });
  return { hub, deps, frames };
}

const UI_A: HubUiBuildWire = {
  source: "package",
  version: "1.0.0",
  commit: "abcdefabcdef",
  builtAt: "2026-01-01T00:00:00.000Z",
  assets: ["/assets/index-aaaaaaaa.js"],
};

describe("hub assembly × version (plan §3.7)", () => {
  it("version.v1 is on BOTH cap surfaces and FrontendDeps.version is wired", async () => {
    const { hub, deps } = await start();
    expect(deps.version).toBeDefined();
    expect(typeof deps.onUiServed).toBe("function");
    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(hub.info.caps).toContain(VERSION_HUB_CAP);
    expect(ack["caps"] as string[]).toContain(VERSION_HUB_CAP);
    expect([...(ack["caps"] as string[])]).toEqual([...hub.info.caps]);
    c.sock.destroy();
  });

  it("HubInfo carries no ui/bootHead until observed (byte-identical shape otherwise)", async () => {
    const { hub } = await start();
    expect("ui" in hub.info).toBe(false);
  });

  it("bootHead is observed once after start (package root is a git toplevel here) and announced by a hub frame", async () => {
    const { hub, frames } = await start();
    const deadline = Date.now() + 5000;
    while (hub.info.bootHead === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    if (hub.info.bootHead === undefined) return; // not a git checkout (e.g. a tarball): the capture is silent by contract
    expect(hub.info.bootHead.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });

  it("onUiServed sets info.ui with one hub frame per REAL change; same value ⇒ none; undefined deletes", async () => {
    const { hub, deps, frames } = await start();
    const base = frames.length;
    deps.onUiServed!(UI_A);
    expect(hub.info.ui).toEqual(UI_A);
    expect(frames.length - base).toBe(1);
    deps.onUiServed!({ ...UI_A, assets: [...UI_A.assets] }); // structurally equal
    expect(frames.length - base).toBe(1);
    // assets-only change (commit/builtAt identical) ⇒ exactly one more
    deps.onUiServed!({ ...UI_A, assets: ["/assets/index-bbbbbbbb.js"] });
    expect(frames.length - base).toBe(2);
    expect(hub.info.ui!.assets).toEqual(["/assets/index-bbbbbbbb.js"]);
    deps.onUiServed!(undefined);
    expect("ui" in hub.info).toBe(false);
    expect(frames.length - base).toBe(3);
    deps.onUiServed!(undefined);
    expect(frames.length - base).toBe(3);
  });

  it("after close() a late onUiServed updates nothing and broadcasts nothing", async () => {
    const { hub, deps, frames } = await start();
    await hub.close("test");
    const n = frames.length;
    deps.onUiServed!(UI_A);
    expect(frames.length).toBe(n);
  });
});
