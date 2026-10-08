/**
 * web-hub content-preview — PV3 hub-assembly tests (plan v3 §6 PV3 / §4.5.1 / §4.7 caps rows).
 *
 * Real `startHub` over a fake frontend (hub.test.ts / hub-spawn.test.ts's pattern). Pins:
 * - the three caps combinations: `off` keeps BOTH surfaces deep-equal to the pre-PV3
 *   composition (§4.7 "off 时与现状深相等"), `loopback` adds exactly `preview.v1`, `on`
 *   (the default config shape here mirrors it) adds both caps — with `hello_ack.caps` and
 *   `HubInfo.caps` always agreeing (same `extraHubCaps` instance, "两处声明的集合必须一致");
 * - `FrontendDeps.preview`: wired with the configured mode, absent when off;
 * - the runtime `close()` order (§4.5.1): spawn shutdown → preview dispose → fe.close —
 *   observed by wrapping the captured routes object's `dispose` in place;
 * - the startup-failure unwind (fe.listen rejects): preview dispose runs BEFORE fe.close.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { previewProcFdAvailable } from "../../../src/web-hub/hub/preview/fs.js";
import {
  DIALOG_BG_HUB_CAPS,
  P2_HUB_CAPS,
  PREVIEW_ABS_HUB_CAP,
  PREVIEW_DIR_HUB_CAP,
  PREVIEW_HUB_CAP,
  PREVIEW_LAN_HUB_CAP,
  RUNTX_HUB_CAPS,
  UPLOAD_HUB_CAPS,
} from "../../../src/web-hub/protocol/version.js";
import { config, connectClient, hello, tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

/** The pre-PV3 caps composition: admin.caps() always reports `ctl.v1` (no lan configured ⇒
 * no `lan.v1`), then the frozen cap groups. fleet-drawer F3b appended RUNTX_HUB_CAPS after
 * DIALOG_BG, ahead of any preview tail — the baseline tracks the current composition. */
function baselineCaps(): string[] {
  return ["ctl.v1", ...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...DIALOG_BG_HUB_CAPS, ...RUNTX_HUB_CAPS];
}

interface FakeFrontend extends FrontendFactory {
  deps: FrontendDeps[];
  closed: number;
}

function fakeFrontend(order: string[], listenFails = false): FakeFrontend {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    // wrap the captured routes' dispose IN PLACE (hub.ts holds the same object reference) so
    // the close/startup-failure order assertions can observe hub.ts's own calls
    if (deps.preview !== undefined) {
      const orig = deps.preview.dispose.bind(deps.preview);
      deps.preview.dispose = (reason, deadline): Promise<void> => {
        order.push(`preview.dispose:${reason}`);
        return orig(reason, deadline);
      };
    }
    return {
      listen: async () => {
        if (listenFails) throw new Error("listen failed (test)");
        return { port: 43210 };
      },
      close: async () => {
        order.push("fe.close");
        f.closed++;
      },
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  }) as FakeFrontend;
  f.deps = [];
  f.closed = 0;
  return f;
}

interface Kit {
  hub: RunningHub;
  fe: FakeFrontend;
  order: string[];
}

async function startKit(
  opts: { preview?: "on" | "loopback"; listenFails?: boolean; getuid?: () => number; home?: string } = {},
): Promise<Kit | { failed: true; order: string[] }> {
  const home = opts.home ?? tmp.make("wh-hubpreview-");
  const order: string[] = [];
  const fe = fakeFrontend(order, opts.listenFails === true);
  try {
    const hub = await startHub(
      config({
        home,
        port: 0,
        ...(opts.preview === undefined ? {} : { preview: opts.preview }),
      }),
      fe,
      {
        uid: process.getuid?.() ?? 0,
        ...(opts.getuid === undefined ? {} : { getuid: opts.getuid }),
      },
    );
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
    return { hub, fe, order };
  } catch (err) {
    void err;
    return { failed: true, order };
  }
}

// ---------------------------------------------------------------------------
// caps (§4.7)
// ---------------------------------------------------------------------------

describe("hub assembly × preview caps (PV3, §4.7)", () => {
  it("mode off: no preview key ⇒ both surfaces deep-equal the pre-PV3 composition", async () => {
    const kit = await startKit();
    if ("failed" in kit) throw new Error("startHub failed");
    expect(kit.fe.deps[0]!.preview).toBeUndefined();

    const c = await connectClient(kit.hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = [...(ack["caps"] as string[])];
    const browserCaps = [...kit.hub.info.caps];
    expect(browserCaps).toEqual(agentCaps);
    expect(browserCaps).toEqual(baselineCaps());
    expect(browserCaps).not.toContain(PREVIEW_HUB_CAP);
    expect(browserCaps).not.toContain(PREVIEW_LAN_HUB_CAP);
    expect(browserCaps).not.toContain(PREVIEW_ABS_HUB_CAP);
    c.sock.destroy();
  });

  it("mode loopback: exactly preview.v1 is added, on BOTH surfaces", async () => {
    const kit = await startKit({ preview: "loopback" });
    if ("failed" in kit) throw new Error("startHub failed");
    expect(kit.fe.deps[0]!.preview?.mode).toBe("loopback");

    const c = await connectClient(kit.hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = ack["caps"] as string[];
    expect([...agentCaps].sort()).toEqual([...kit.hub.info.caps].sort());
    // dir-plan §3.5/§3.6 (P1b): preview.dir.v1 joins ONLY when /proc/self/fd is available —
    // the listing itself is proc-bound, so a /proc-less platform never declares it.
    expect([...kit.hub.info.caps]).toEqual([
      ...baselineCaps(),
      PREVIEW_HUB_CAP,
      PREVIEW_ABS_HUB_CAP,
      ...(previewProcFdAvailable() ? [PREVIEW_DIR_HUB_CAP] : []),
    ]);
    c.sock.destroy();
  });

  it("mode on: both preview.v1 and preview.lan.v1, agreeing on both surfaces", async () => {
    const kit = await startKit({ preview: "on" });
    if ("failed" in kit) throw new Error("startHub failed");
    expect(kit.fe.deps[0]!.preview?.mode).toBe("on");

    const c = await connectClient(kit.hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = ack["caps"] as string[];
    expect([...agentCaps].sort()).toEqual([...kit.hub.info.caps].sort());
    expect([...kit.hub.info.caps]).toEqual([
      ...baselineCaps(),
      PREVIEW_HUB_CAP,
      PREVIEW_ABS_HUB_CAP,
      ...(previewProcFdAvailable() ? [PREVIEW_DIR_HUB_CAP] : []),
      PREVIEW_LAN_HUB_CAP,
    ]);
    c.sock.destroy();
  });
});

// ---------------------------------------------------------------------------
// §4.5.1 lifecycle wiring
// ---------------------------------------------------------------------------

describe("hub assembly × preview dispose wiring (§4.5.1)", () => {
  it("runtime close(): preview dispose runs after the frontend's other domains, before fe.close", async () => {
    const kit = await startKit({ preview: "on" });
    if ("failed" in kit) throw new Error("startHub failed");
    await kit.hub.close("test");
    expect(kit.order).toContain("preview.dispose:close");
    expect(kit.order.indexOf("preview.dispose:close")).toBeLessThan(kit.order.indexOf("fe.close"));
    // close() must be exactly-once per surface even when both close paths could run
    expect(kit.fe.closed).toBe(1);
    // §4.5.1's full order (spawn shutdown → preview dispose → fe.close): the runtime half is
    // pinned above (preview < fe.close); the spawn half is pinned on source order — the dispose
    // call sits textually between `spawnSup.shutdown` and `fe.close` inside close()'s body.
    const src = readFileSync(new URL("../../../src/web-hub/hub/hub.ts", import.meta.url), "utf8");
    const closeBody = src.slice(src.indexOf("hub closing"));
    const at = {
      spawn: closeBody.indexOf("spawnSup.shutdown"),
      preview: closeBody.indexOf('previewRoutes.dispose("close"'),
      fe: closeBody.indexOf("fe.close"),
    };
    expect(at.spawn).toBeGreaterThan(-1);
    expect(at.preview).toBeGreaterThan(at.spawn);
    expect(at.fe).toBeGreaterThan(at.preview);
  });

  it("startup failure (fe.listen rejects): the reverse-order unwind disposes preview BEFORE fe.close", async () => {
    const outcome = await startKit({ preview: "on", listenFails: true });
    expect("failed" in outcome).toBe(true);
    if ("failed" in outcome) {
      expect(outcome.order).toContain("preview.dispose:startup-failure");
      expect(outcome.order).toContain("fe.close");
      expect(outcome.order.indexOf("preview.dispose:startup-failure")).toBeLessThan(outcome.order.indexOf("fe.close"));
    }
  });

  it("a successful hub that is closed then started again never re-declares (singleton owns the port)", async () => {
    // sanity around the off case: closing a no-preview hub never emits a dispose line
    const kit = await startKit();
    if ("failed" in kit) throw new Error("startHub failed");
    await kit.hub.close("test");
    expect(kit.order).not.toContain("preview.dispose:close");
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 P1a: uid-0 warning (§2.9) + deny-context degradation WARN (§2.6)
// ---------------------------------------------------------------------------

/** Parse the hub's own log file into JSON lines (createHubLog's format). */
function hubLogLines(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("hub assembly × preview uid-0 warning (§2.9)", () => {
  it("getuid ⇒ 0: EXACTLY one stable warn line, event+mode only, no path/username", async () => {
    const kit = await startKit({ preview: "on", getuid: () => 0 });
    if ("failed" in kit) throw new Error("startHub failed");
    const warns = hubLogLines(kit.hub.paths.logFile).filter((l) => l["event"] === "preview.root_uid");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      level: "warn",
      event: "preview.root_uid",
      mode: "on",
      msg: "web-hub preview: hub is running as root — OS permission checks no longer limit preview; only the denylist applies",
    });
    // exactly the two data fields — nothing else rides the line
    expect(
      Object.keys(warns[0]!)
        .filter((k) => !["t", "level", "pid", "msg"].includes(k))
        .sort(),
    ).toEqual(["event", "mode"]);
  });

  it("getuid ⇒ 1000: no warn line", async () => {
    const kit = await startKit({ preview: "on", getuid: () => 1000 });
    if ("failed" in kit) throw new Error("startHub failed");
    expect(hubLogLines(kit.hub.paths.logFile).some((l) => l["event"] === "preview.root_uid")).toBe(false);
  });

  it("getuid undefined (platform without it): no warn line", async () => {
    const kit = await startKit({ preview: "loopback", getuid: undefined });
    if ("failed" in kit) throw new Error("startHub failed");
    expect(hubLogLines(kit.hub.paths.logFile).some((l) => l["event"] === "preview.root_uid")).toBe(false);
  });

  it("preview off: no warn line even as root", async () => {
    const kit = await startKit({ getuid: () => 0 });
    if ("failed" in kit) throw new Error("startHub failed");
    expect(hubLogLines(kit.hub.paths.logFile).some((l) => l["event"] === "preview.root_uid")).toBe(false);
  });
});

describe("hub assembly × preview deny-context resolution (§2.6)", () => {
  it("an agentDir whose realpath FAILS (ENOTDIR through a file) degrades with a path-free WARN", async () => {
    const holder = tmp.make("wh-denyctx-hub-");
    const blocker = join(holder, "plain-file");
    writeFileSync(blocker, "x");
    // `PI_CODING_AGENT_DIR` pointing through a regular file can never realpath ⇒ that member
    // degrades to literal-only; home stays valid so the hub itself starts normally.
    const prev = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = join(blocker, "sub");
    try {
      const kit = await startKit({ preview: "on", home: join(holder, "home") });
      if ("failed" in kit) throw new Error("startHub failed");
      const lines = hubLogLines(kit.hub.paths.logFile);
      const degraded = lines.filter((l) => l["event"] === "preview.deny_ctx_degraded");
      expect(degraded).toHaveLength(1);
      expect(degraded[0]).toMatchObject({
        level: "warn",
        which: "agentDir",
        msg: "preview deny context: realpath failed",
      });
      expect(JSON.stringify(degraded[0])).not.toContain(holder); // never a path
    } finally {
      if (prev === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = prev;
    }
  });
});
