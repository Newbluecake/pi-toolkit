import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import type { FrontendFactory, LanAssembly } from "../../../src/web-hub/hub/ports.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { parseHubSpawnConfig } from "../../../src/web-hub/hub/spawn/config.js";
import { config, connectClient, hello, tmpDirs, waitFor, type TestClient } from "./helpers.js";

const seams = vi.hoisted(() => ({
  rotate: undefined as undefined | (() => Promise<void>),
  preview: undefined as undefined | (() => Promise<void>),
  identity: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../../../src/web-hub/hub/admin.js", async (original) => {
  const mod = await original<typeof import("../../../src/web-hub/hub/admin.js")>();
  return {
    ...mod,
    recoverRotateIntent: async (...args: Parameters<typeof mod.recoverRotateIntent>) => {
      await seams.rotate?.();
      return mod.recoverRotateIntent(...args);
    },
  };
});
vi.mock("../../../src/web-hub/hub/preview/fs.js", async (original) => {
  const mod = await original<typeof import("../../../src/web-hub/hub/preview/fs.js")>();
  return {
    ...mod,
    resolvePreviewDenyContext: async (...args: Parameters<typeof mod.resolvePreviewDenyContext>) => {
      await seams.preview?.();
      return mod.resolvePreviewDenyContext(...args);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const mod = await original<typeof import("node:fs/promises")>();
  return {
    ...mod,
    readFile: async (...args: Parameters<typeof mod.readFile>) => {
      if (args[0] === "/proc/self/stat") await seams.identity?.();
      return mod.readFile(...args);
    },
  };
});

const tmp = tmpDirs();
const clients: TestClient[] = [];
const hubs: RunningHub[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const c of clients.splice(0)) c.sock.destroy();
  for (const h of hubs.splice(0)) await h.close("test");
  seams.rotate = undefined;
  seams.preview = undefined;
  seams.identity = undefined;
  tmp.cleanup();
});

function latch() {
  let release = (): void => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { pending, release };
}

const lan = { port: 40002, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };

describe("startup close gate", () => {
  it("every close dependency is initialized before the socket exposes shutdown", () => {
    const text = readFileSync(new URL("../../../src/web-hub/hub/hub.ts", import.meta.url), "utf8");
    const source = ts.createSourceFile("hub.ts", text, ts.ScriptTarget.Latest, true);
    const vars = new Map<string, ts.VariableDeclaration>();
    let exposure = Number.POSITIVE_INFINITY;
    const walk = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) vars.set(node.name.text, node);
      if (ts.isCallExpression(node) && node.expression.getText(source) === "createAgentServer")
        exposure = node.getStart(source);
      ts.forEachChild(node, walk);
    };
    walk(source);
    expect(Number.isFinite(exposure)).toBe(true);
    const assemblyText = readFileSync(new URL("../../../src/web-hub/hub/assembly.ts", import.meta.url), "utf8");
    const assembly = ts.createSourceFile("assembly.ts", assemblyText, ts.ScriptTarget.Latest, true);
    const factory = assembly.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "createHubAssembly",
    );
    expect(factory?.body).toBeDefined();
    const initialized = new Set<string>();
    const collect = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) initialized.add(node.name.text);
      ts.forEachChild(node, collect);
    };
    collect(factory!.body!);
    for (const name of [
      "kdfInFlight",
      "lanBlockedByRotate",
      "lanClosedByRotateScan",
      "supersedeWaitCancels",
      "supersedeTimer",
      "unsubscribeSupersedeOnDialogs",
      "supersede",
      "stopFence",
      "idle",
      "tick",
      "rotateScan",
      "uploadInflightTick",
      "uploadSweepTick",
      "spawnSup",
      "firstPromptFwd",
      "spawnHistory",
      "previewRoutes",
      "worktreeDiffRoutes",
      "worktreeGraphRoutes",
      "agentServer",
      "fe",
      "uploads",
    ]) {
      expect(initialized.has(name), `${name} must have an explicit initial value`).toBe(true);
    }
    const ctxDeclaration = vars.get("ctx");
    expect(ctxDeclaration?.initializer?.getText(source)).toContain("createHubAssembly(");
    expect(ctxDeclaration!.getStart(source)).toBeLessThan(exposure);
    expect(text.indexOf("ctx.close = close;")).toBeGreaterThan(-1);
    expect(text.indexOf("ctx.close = close;")).toBeLessThan(exposure);

    // Registry/history handles now come from the synchronous sub-assembly. Its invocation
    // and initialized outputs must still precede socket exposure (no late/TDZ dependencies).
    const registryText = readFileSync(
      new URL("../../../src/web-hub/hub/assembly-registry.ts", import.meta.url),
      "utf8",
    );
    const registrySource = ts.createSourceFile("assembly-registry.ts", registryText, ts.ScriptTarget.Latest, true);
    const registryVars = new Map<string, ts.VariableDeclaration>();
    const collectRegistry = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) registryVars.set(node.name.text, node);
      ts.forEachChild(node, collectRegistry);
    };
    collectRegistry(registrySource);
    expect(text.indexOf("= assembleRegistry(ctx)")).toBeGreaterThan(-1);
    expect(text.indexOf("= assembleRegistry(ctx)")).toBeLessThan(exposure);
    for (const name of ["registry", "history", "runTx", "runFileReader"]) {
      expect(registryVars.get(name)?.initializer, name).toBeDefined();
    }
    for (const name of [
      "owner",
      "hubJson",
      "closing",
      "resolveClosed",
      "closed",
      "log",
      "rootScope",
      "now",
      "startup",
      "startTimer",
    ]) {
      const declaration = vars.get(name);
      expect(declaration, name).toBeDefined();
      expect(declaration!.getStart(source), name).toBeLessThan(exposure);
      // `let x: T | undefined` is initialized to undefined when its declaration executes.
      expect(
        declaration!.initializer !== undefined || declaration!.type?.getText(source).includes("undefined"),
        name,
      ).toBe(true);
    }
  });

  it.each(["lan", "rotate", "spawn-init", "preview", "listen", "ui", "identity"] as const)(
    "admin close during %s: all later handles stay unexposed and publication is skipped",
    async (window) => {
      const home = tmp.make("wh-startgate-");
      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      const gate = latch();
      let entered = false;
      const block = async () => {
        entered = true;
        await gate.pending;
      };
      const frontendClose = vi.fn(async () => {});
      const frontendBuilt = vi.fn();
      const lateLanCleanup = vi.fn();
      const reaperClose = vi.fn();
      const frontend: FrontendFactory = () => {
        frontendBuilt();
        return {
          listen: async () => {
            if (window === "listen") await block();
            return { port: 43210 };
          },
          close: frontendClose,
          clientCount: () => 0,
          ui: {
            serve: async () => false,
            refresh: async () => {
              if (window === "ui") await block();
              return { state: "unbuilt", candidates: [] };
            },
            status: () => ({ state: "unbuilt", candidates: [] }),
          },
        };
      };
      const assembly: LanAssembly = {
        build: async (args) => {
          await block();
          args.scope.defer(lateLanCleanup);
          const limiter = createLoginLimiter({ now: Date.now });
          return {
            ...args,
            store: fakeLanStore(),
            kdf: fakeKdf(),
            limiter,
            admission: createKdfAdmission({ now: Date.now, isTightened: () => false }),
            hosts: createHostsPort(),
          };
        },
      };
      if (window === "rotate") seams.rotate = block;
      if (window === "preview") seams.preview = block;
      if (window === "identity") seams.identity = block;
      const pkg = join(home, "node_modules/@earendil-works/pi-coding-agent");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.2" }),
      );
      writeFileSync(join(pkg, "cli.js"), "// fixture\n");
      const started = startHub(
        config({
          home,
          ...(window === "lan" ? { lan } : {}),
          ...(window === "preview" ? { preview: "on" as const } : {}),
          ...(window === "spawn-init"
            ? {
                launcher: [process.execPath, join(pkg, "cli.js")] as const,
                spawn: (() => {
                  const parsed = parseHubSpawnConfig({
                    roots: [home],
                    restore: true,
                    maxProcesses: 4,
                    maxPerPrincipal: 2,
                    ratePerMinute: 30,
                    maxLifetimeMinutes: 720,
                    registerTimeoutS: 10,
                    lan: "off",
                  });
                  if (!parsed.ok) throw new Error(parsed.detail);
                  return parsed.spawn;
                })(),
              }
            : {}),
        }),
        frontend,
        {
          lanAssembly: assembly,
          ...(window === "spawn-init"
            ? {
                spawnSeams: {
                  reaper: {
                    start: async () => {
                      await block();
                      return true;
                    },
                    available: true,
                    track: () => {},
                    untrack: () => {},
                    close: reaperClose,
                    onUnavailable: () => () => {},
                    onRestart: () => () => {},
                  },
                },
              }
            : {}),
        },
      );
      await waitFor(() => entered);
      const c = await connectClient(paths.socketPath);
      clients.push(c);
      c.send(hello());
      await c.waitFrame((f) => f["t"] === "hello_ack");
      c.send({ t: "hub_ctl", rid: "early-close", op: "shutdown", reason: "restart" });
      await c.waitFrame((f) => f["t"] === "hub_ctl_ack");
      await expect(started).resolves.toEqual({ exists: false, closed: true, reason: "restart" });
      expect(existsSync(paths.hubJson)).toBe(false);
      expect(existsSync(paths.socketPath)).toBe(false);
      const lines = readFileSync(paths.logFile, "utf8");
      expect(lines).not.toContain('"msg":"hub started"');
      expect(lines.match(/"msg":"hub closing"/g)).toHaveLength(1);
      expect(lines.match(/"msg":"hub closed"/g)).toHaveLength(1);
      gate.release();
      if (window === "lan") {
        await waitFor(() => lateLanCleanup.mock.calls.length === 1);
        expect(frontendBuilt).not.toHaveBeenCalled();
      } else if (window === "spawn-init") {
        await waitFor(() => reaperClose.mock.calls.length >= 2);
        expect(frontendBuilt).not.toHaveBeenCalled();
      } else if (window === "preview" || window === "rotate") {
        expect(frontendBuilt).not.toHaveBeenCalled();
        expect(frontendClose).not.toHaveBeenCalled();
      } else {
        await waitFor(() => frontendClose.mock.calls.length >= 1);
      }
      expect(existsSync(paths.hubJson)).toBe(false);
      // Teardown released singleton ownership even though the old startup step finished late.
      const successor = await startHub(config({ home }), frontend);
      if ("exists" in successor) throw new Error("successor not running");
      hubs.push(successor);
      expect(successor.httpPort).toBe(43210);
    },
    15_000,
  );
});
