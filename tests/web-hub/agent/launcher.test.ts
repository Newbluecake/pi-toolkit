import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveJitiCli, shouldSpawnHub, spawnHub } from "../../../src/web-hub/agent/launcher.js";
import type { HubConfig } from "../../../src/web-hub/hub/ports.js";
import { TIMING } from "../../../src/web-hub/protocol/messages.js";
import { tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-launch-");
});
afterEach(() => tmp.cleanup());

/** npm-global layout: <p>/lib/node_modules/@earendil-works/pi-coding-agent + nested jiti, <p>/bin/pi symlink. */
function piLayout(): { piPkg: string; jitiCli: string; bin: string } {
  const piPkg = join(tmp.dir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(piPkg, "dist"), { recursive: true });
  writeFileSync(join(piPkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  writeFileSync(join(piPkg, "dist", "cli.js"), "");
  const jiti = join(piPkg, "node_modules", "jiti");
  mkdirSync(join(jiti, "lib"), { recursive: true });
  writeFileSync(
    join(jiti, "package.json"),
    JSON.stringify({ name: "jiti", exports: { ".": "./lib/jiti.mjs", "./package.json": "./package.json" } }),
  );
  writeFileSync(join(jiti, "lib", "jiti-cli.mjs"), "");
  mkdirSync(join(tmp.dir, "bin"));
  const bin = join(tmp.dir, "bin", "pi");
  symlinkSync(join("..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), bin);
  return { piPkg, jitiCli: join(jiti, "lib", "jiti-cli.mjs"), bin };
}

describe("resolveJitiCli", () => {
  it("argv1 is a symlink (bin/pi → dist/cli.js): realpath, walk up to the pi package, resolve jiti", () => {
    const { jitiCli, bin } = piLayout();
    expect(resolveJitiCli({ argv1: bin, override: "" })).toEqual({ ok: true, jitiCli });
  });

  it("pi package not found above argv1 ⇒ reason", () => {
    const file = join(tmp.dir, "elsewhere.js");
    writeFileSync(file, "");
    const r = resolveJitiCli({ argv1: file, override: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("pi package not found");
  });

  it("pi package present but jiti not resolvable ⇒ reason", () => {
    const piPkg = join(tmp.dir, "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(join(piPkg, "dist"), { recursive: true });
    writeFileSync(join(piPkg, "package.json"), "{}");
    writeFileSync(join(piPkg, "dist", "cli.js"), "");
    const r = resolveJitiCli({ argv1: join(piPkg, "dist", "cli.js"), override: "" });
    expect(r.ok).toBe(false);
  });

  it("override (settings.webHub.nodeLoader) wins; a missing override is an error, not a fallback", () => {
    const { bin } = piLayout();
    const custom = join(tmp.dir, "my-jiti-cli.mjs");
    writeFileSync(custom, "");
    expect(resolveJitiCli({ argv1: bin, override: custom })).toEqual({ ok: true, jitiCli: custom });
    const r = resolveJitiCli({ argv1: bin, override: join(tmp.dir, "missing.mjs") });
    expect(r.ok).toBe(false);
  });

  it("argv1 missing / realpath failure ⇒ reason", () => {
    expect(resolveJitiCli({ argv1: undefined, override: "" }).ok).toBe(false);
    expect(resolveJitiCli({ argv1: join(tmp.dir, "nope"), override: "" }).ok).toBe(false);
    const throwing = resolveJitiCli({
      argv1: "/x",
      override: "",
      realpath: () => {
        throw new Error("boom");
      },
    });
    expect(throwing).toEqual({ ok: false, reason: expect.stringContaining("boom") });
  });

  it("works on the repo's own pi dev dependency", () => {
    const argv1 = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    const r = resolveJitiCli({ argv1, override: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jitiCli).toMatch(/jiti[/\\]lib[/\\]jiti-cli\.mjs$/);
  });
});

describe("spawnHub", () => {
  const config: HubConfig = {
    v: 1,
    home: "/tmp/h",
    port: 7878,
    idleExitMinutes: 10,
    pluginVersion: "1.0.0",
    buildId: "1.0.0@abc",
  };
  const plan = { execPath: "/usr/bin/node", jitiCli: "/j/jiti-cli.mjs", argv1: "/p/cli.js" };

  it("detached, stdio ignore, env carries config + launcher, child unref'd and its async error swallowed", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    spawnHub(plan, "/pkg/src/web-hub/hub/main.ts", config, spawnImpl as never);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args, o] = spawnImpl.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe("/usr/bin/node");
    expect(args).toEqual(["/j/jiti-cli.mjs", "/pkg/src/web-hub/hub/main.ts"]);
    expect(o.detached).toBe(true);
    expect(o.stdio).toBe("ignore");
    const env = o.env as Record<string, string>;
    expect(JSON.parse(env.PI_WEBHUB_CONFIG!)).toEqual(config);
    expect(JSON.parse(env.PI_WEBHUB_LAUNCHER!)).toEqual(["/usr/bin/node", "/p/cli.js"]);
    expect(child.unref).toHaveBeenCalled();
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("a throwing spawn never propagates", () => {
    const spawnImpl = vi.fn(() => {
      throw new Error("EAGAIN");
    });
    expect(() => spawnHub(plan, "/m.ts", config, spawnImpl as never)).not.toThrow();
  });
});

describe("shouldSpawnHub", () => {
  const base = { autoStart: true, headless: false, launcherOk: true, lastSpawnAt: undefined, now: 100_000 };
  it("30s throttle", () => {
    expect(shouldSpawnHub(base)).toBe(true);
    expect(shouldSpawnHub({ ...base, lastSpawnAt: base.now - TIMING.spawnThrottleMs + 1 })).toBe(false);
    expect(shouldSpawnHub({ ...base, lastSpawnAt: base.now - TIMING.spawnThrottleMs })).toBe(true);
  });
  it("PI_WEBHUB_HEADLESS=1 never spawns; autoStart off / no launcher never spawn", () => {
    expect(shouldSpawnHub({ ...base, headless: true })).toBe(false);
    expect(shouldSpawnHub({ ...base, autoStart: false })).toBe(false);
    expect(shouldSpawnHub({ ...base, launcherOk: false })).toBe(false);
  });
});
