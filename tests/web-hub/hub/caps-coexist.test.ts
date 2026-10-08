import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import {
  DIALOG_BG_HUB_CAPS,
  HOLD_HUB_CAPS,
  P2_HUB_CAPS,
  PREVIEW_ABS_HUB_CAP,
  PREVIEW_HUB_CAP,
  RUNTX_HUB_CAPS,
  SPAWN_HUB_CAP,
  SPAWN_MODEL_HUB_CAP,
  UPLOAD_HUB_CAPS,
  WTDIFF_HUB_CAP,
  PREVIEW_HUB_CAP,
  PREVIEW_LAN_HUB_CAP,
} from "../../../src/web-hub/protocol/version.js";
import type { HubSpawnConfig } from "../../../src/web-hub/protocol/spawn.js";
import { config, connectClient, hello, tmpDirs, waitFor } from "./helpers.js";
import { fakeConn, recordBus } from "./helpers.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { memLog } from "./helpers.js";

/**
 * fleet-drawer plan §8.4 (#5): the THREE-WAY capability coexistence test — upload, spawn and
 * runtx all touch the same two hub cap surfaces (`hub.ts`'s browser-facing `HubInfo.caps` /
 * `agent-server.ts`'s agent-facing `hello_ack.caps`), so this pins:
 *   1. the two surfaces are SET-EQUAL for every feature combination (a drift would make an
 *      agent or a browser silently mis-detect a feature);
 *   2. both carry P2_HUB_CAPS ∪ UPLOAD_HUB_CAPS ∪ RUNTX_HUB_CAPS (plus DIALOG_BG, and
 *      spawn.v1/preview.v1 exactly when their config keys exist);
 *   3. registry `card()`'s four derived booleans (upload/uploadLan/runTranscript/
 *      runTranscriptLan) are mutually independent and consistent across the snapshot paths
 *      (`get()`/`list()` feed the initial `agents` frame, `agent_up` the live push, reclaim
 *      the reconnect).
 *
 * The 18-combination AGENT-side caps matrix is F2's (`tests/web-hub/agent/wiring-control`),
 * out of this package's file domain; the SSE-level three-path card delivery (`toCard`) is F4's.
 */

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

function fakeFrontend(): { factory: FrontendFactory; deps: FrontendDeps[] } {
  const holder: { deps: FrontendDeps[] } = { deps: [] };
  const factory: FrontendFactory = (deps): HttpFrontend => {
    holder.deps.push(deps);
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
  return { factory, deps: holder.deps };
}

async function start(fe: FrontendFactory, home: string, spawn?: HubSpawnConfig): Promise<RunningHub> {
  const r = await startHub(
    config({ home, ...(spawn === undefined ? {} : { spawn }) }),
    fe,
    // Fail-closed platform probe: supervisor init() no-ops (no reaper child, no spawns.json —
    // §7.1) while caps STILL carry spawn.v1, which is exactly the surface this file pins.
    spawn === undefined
      ? { uid: process.getuid?.() ?? 0 }
      : { uid: process.getuid?.() ?? 0, spawnSeams: { probe: { platform: "darwin" } } },
  );
  if ("exists" in r) throw new Error("unexpected exists");
  hubs.push(r);
  return r;
}

/** Real tmp launcher tree satisfying the spawn init check (same fixture as hub-spawn.test.ts). */
function launcherFixture(root: string): void {
  const pkgDir = `${root}/node_modules/@earendil-works/pi-coding-agent`;
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    `${pkgDir}/package.json`,
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }),
  );
  writeFileSync(`${pkgDir}/cli.js`, "// test launcher entry\n");
}

describe("§8.4 caps coexistence — hub cap surfaces (upload ∪ spawn ∪ runtx)", () => {
  it("default config: HubInfo.caps ≡ hello_ack.caps (set-equal), both ⊇ P2 ∪ UPLOAD ∪ RUNTX ∪ DIALOG_BG ∪ HOLD, no spawn/preview", async () => {
    const home = tmp.make("wh-coexist-");
    const fe = fakeFrontend();
    const hub = await start(fe.factory, home);
    const browserCaps = [...hub.info.caps].sort();

    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = [...(ack["caps"] as string[])].sort();
    c.sock.destroy();

    expect(browserCaps).toEqual(agentCaps); // the two surfaces never drift (§3.1 invariant)
    for (const cap of [
      ...P2_HUB_CAPS,
      ...UPLOAD_HUB_CAPS,
      ...RUNTX_HUB_CAPS,
      ...DIALOG_BG_HUB_CAPS,
      ...HOLD_HUB_CAPS,
    ]) {
      expect(browserCaps).toContain(cap);
    }
    expect(browserCaps).not.toContain(SPAWN_HUB_CAP);
    expect(browserCaps).not.toContain(SPAWN_MODEL_HUB_CAP);
    expect(browserCaps).not.toContain(PREVIEW_HUB_CAP);
    expect(browserCaps).not.toContain(PREVIEW_ABS_HUB_CAP); // dir-plan P1a: same gate, also absent
  });

  it("config.spawn: spawn.v1 joins BOTH surfaces (fail-closed probe) and they stay set-equal", async () => {
    const home = tmp.make("wh-coexist-spawn-");
    launcherFixture(home);
    const fe = fakeFrontend();
    const hub = await start(fe.factory, home, {
      roots: [],
      maxProcesses: 4,
      maxPerPrincipal: 2,
      ratePerMinute: 3,
      maxLifetimeMinutes: 720,
      registerTimeoutS: 30,
      lan: "off",
    });
    const browserCaps = [...hub.info.caps]; // UNSORTED — the tail order is part of the pin

    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = [...(ack["caps"] as string[])]; // UNSORTED — order is part of the pin
    c.sock.destroy();

    expect(browserCaps).toEqual(agentCaps);
    expect(browserCaps).toContain(SPAWN_HUB_CAP);
    expect(browserCaps).toContain(SPAWN_MODEL_HUB_CAP); // default-model D4: same conditional tail
    // the two caps ride ADJACENT in the same order on both surfaces (spawn.v1 then spawn.model.v1)
    expect(browserCaps.indexOf(SPAWN_MODEL_HUB_CAP)).toBe(browserCaps.indexOf(SPAWN_HUB_CAP) + 1);
    expect(agentCaps.indexOf(SPAWN_MODEL_HUB_CAP)).toBe(agentCaps.indexOf(SPAWN_HUB_CAP) + 1);
    // the runtx group still rides along (the whole point of coexistence)
    for (const cap of RUNTX_HUB_CAPS) expect(browserCaps).toContain(cap);
  });

  it("FrontendDeps.runTx is wired (F3b assembly) alongside uploads/spawn-absent defaults", async () => {
    const home = tmp.make("wh-coexist-runtx-");
    const fe = fakeFrontend();
    await start(fe.factory, home);
    const deps = fe.deps[0]!;
    expect(deps.runTx).toBeDefined();
    for (const m of ["snapshot", "page", "watch", "unwatch", "onFrame", "setSink", "dispose"] as const) {
      expect(typeof deps.runTx![m]).toBe("function");
    }
    expect(deps.uploads).toBeDefined(); // upload (U3) coexists on the same deps object
  });
});

describe("§8.4 registry card — upload/uploadLan/runTranscript/runTranscriptLan independence", () => {
  it("the four booleans derive independently from their caps; consistent across get()/list()/agent_up", () => {
    const clock = { t: 1_000_000 };
    const reg = createRegistry({ now: () => clock.t, log: memLog(), pidAlive: () => true });
    const events: HubEvent[] = recordBus(reg);

    const combos: Array<{ caps: string[]; want: [boolean, boolean, boolean, boolean] }> = [
      { caps: ["ev.v1"], want: [false, false, false, false] }, // plain old agent
      { caps: ["ev.v1", "upload.v1"], want: [true, false, false, false] }, // upload loopback-only
      { caps: ["ev.v1", "upload.v1", "upload.lan.v1"], want: [true, true, false, false] },
      { caps: ["ev.v1", "runtx.v1"], want: [false, false, true, false] }, // runtx loopback-only
      { caps: ["ev.v1", "runtx.v1", "runtx.lan.v1"], want: [false, false, true, true] },
      { caps: ["ev.v1", "upload.v1", "upload.lan.v1", "runtx.v1", "runtx.lan.v1"], want: [true, true, true, true] },
    ];
    for (const { caps, want } of combos) {
      const { agentKey } = reg.register(
        hello({ caps, agentId: { pid: 4242, nonce: `n${want.join("")}AAAAAAAAAAA` } }),
        fakeConn(),
      );
      const view = reg.get(agentKey)!;
      expect([view.upload, view.uploadLan, view.runTranscript, view.runTranscriptLan]).toEqual(want);
      expect(reg.list().find((v) => v.agentKey === agentKey)).toMatchObject({
        upload: want[0],
        uploadLan: want[1],
        runTranscript: want[2],
        runTranscriptLan: want[3],
      });
      const up = events.findLast((e) => e.type === "agent_up");
      expect(up?.type === "agent_up" && up.agent).toMatchObject({
        upload: want[0],
        uploadLan: want[1],
        runTranscript: want[2],
        runTranscriptLan: want[3],
      });
    }
  });

  it("reconnect path: a re-hello with changed caps updates the card (the reconnect snapshot path)", async () => {
    const clock = { t: 1_000_000 };
    const reg = createRegistry({ now: () => clock.t, log: memLog(), pidAlive: () => true });
    const conn = fakeConn();
    const { agentKey } = reg.register(hello({ caps: ["ev.v1", "runtx.v1", "runtx.lan.v1"] }), conn);
    expect(reg.get(agentKey)).toMatchObject({ runTranscript: true, runTranscriptLan: true });

    // /reload with subagentTranscript=loopback: caps drop runtx.lan.v1 (upload caps unaffected)
    reg.register(hello({ caps: ["ev.v1", "runtx.v1", "upload.v1"] }), conn);
    expect(reg.get(agentKey)).toMatchObject({
      runTranscript: true,
      runTranscriptLan: false,
      upload: true,
      uploadLan: false,
    });
    await waitFor(() => true); // no async work; just exercising the sync path under async test
  });

  // web-hub-steer-recall plan §4.1 (§2.3 S3/S4): AgentCard.hold — the field exists on the card
  // ONLY while the agent's live hello caps include hold.v1; absent (never false) otherwise, on
  // every card surface (get()/list()/agent_up).
  it('hold.v1 ⇒ card.hold === true; without it "hold" in card === false, across get()/list()/agent_up', () => {
    const clock = { t: 1_000_000 };
    const reg = createRegistry({ now: () => clock.t, log: memLog(), pidAlive: () => true });
    const events: HubEvent[] = recordBus(reg);

    const withHold = reg.register(
      hello({ agentId: { pid: 4242, nonce: "holdcapAAAAAAAAAAA" }, caps: ["ev.v1", "cmd.v1", "hold.v1"] }),
      fakeConn(),
    );
    expect(reg.get(withHold.agentKey)!.hold).toBe(true);
    expect(reg.list().find((v) => v.agentKey === withHold.agentKey)!.hold).toBe(true);
    const up = events.findLast((e) => e.type === "agent_up");
    expect(up?.type === "agent_up" && up.agent.hold).toBe(true);

    const noHold = reg.register(
      hello({ agentId: { pid: 4242, nonce: "noholdcapAAAAAAAAAA" }, caps: ["ev.v1", "cmd.v1"] }),
      fakeConn(),
    );
    expect("hold" in reg.get(noHold.agentKey)!).toBe(false);
    expect("hold" in reg.list().find((v) => v.agentKey === noHold.agentKey)!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// worktree-diff plan §1.6 (D3): wtdiff.v1 rides the preview gate + the /proc probe on BOTH
// cap surfaces — the fourth feature on the same shared-declaration seam.
// ---------------------------------------------------------------------------

describe("wtdiff.v1 cap coexistence (worktree-diff D3, §1.6)", () => {
  it("preview on: wtdiff.v1 joins BOTH surfaces (set-equal, alongside preview/spawn/runtx)", async () => {
    const home = tmp.make("wh-coexist-wtd-");
    const fe = fakeFrontend();
    const hub = await startHub(config({ home, port: 0, preview: "on" }), fe.factory, { uid: process.getuid?.() ?? 0 });
    if ("exists" in hub) throw new Error("unexpected exists");
    const browserCaps = [...hub.info.caps];

    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = [...(ack["caps"] as string[])];
    c.sock.destroy();

    expect(browserCaps.sort()).toEqual(agentCaps.sort());
    expect(browserCaps).toContain(WTDIFF_HUB_CAP);
    for (const cap of [...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...RUNTX_HUB_CAPS, PREVIEW_HUB_CAP, PREVIEW_LAN_HUB_CAP]) {
      expect(browserCaps).toContain(cap);
    }
  });

  it("preview loopback: wtdiff.v1 still declared (LAN availability rides preview.lan.v1, not its own cap)", async () => {
    const home = tmp.make("wh-coexist-wtd-lb-");
    const fe = fakeFrontend();
    const hub = await startHub(config({ home, port: 0, preview: "loopback" }), fe.factory, {
      uid: process.getuid?.() ?? 0,
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    expect(hub.info.caps).toContain(WTDIFF_HUB_CAP);
    expect(hub.info.caps).not.toContain(PREVIEW_LAN_HUB_CAP);
  });

  it("preview off (default): wtdiff.v1 absent from BOTH surfaces", async () => {
    const home = tmp.make("wh-coexist-wtd-off-");
    const fe = fakeFrontend();
    const hub = await start(fe.factory, home);
    if ("exists" in hub) throw new Error("unexpected exists");
    expect(hub.info.caps).not.toContain(WTDIFF_HUB_CAP);
    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["caps"]).not.toContain(WTDIFF_HUB_CAP);
    c.sock.destroy();
  });
});
