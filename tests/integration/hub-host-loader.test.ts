/** Production stock-jiti regression. Never import startHub or a test loader.
 * Optional PI_TOOLKIT_HUB_LOADER_CONSUMER selects an independently unpacked git/npm/ZIP
 * package. No dependency install or consumer mutation; all state stays under TMPDIR.
 * Retained-installation publication/sealed-launcher acceptance is a separate gate.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveLauncherPlan, spawnHub } from "../../src/web-hub/agent/launcher.js";
import { verifyProcIdentity } from "../../src/web-hub/agent/proc-identity.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { privateLogin, privatePost, privateSse } from "../../scripts/web-hub/terminal-v2-maintenance/http-client.js";

const consumer = resolve(process.env.PI_TOOLKIT_HUB_LOADER_CONSUMER ?? ".");
const piCli = realpathSync(resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
const resolved = resolveLauncherPlan({ argv1: piCli, override: "" });
if (!resolved.ok) throw new Error(resolved.reason);
const plan = resolved.plan;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(40);
  }
  throw new Error(`deadline: ${label}`);
}
function proc(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return {
      state: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
      startTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
      argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    };
  } catch {
    return undefined;
  }
}
function envOf(pid: number): Record<string, string> {
  return Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf("=");
        return [s.slice(0, i), s.slice(i + 1)];
      }),
  );
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "hl-"));
  const home = join(base, "h"),
    agent = join(home, ".pi/agent");
  for (const p of [agent, join(base, "c"), join(base, "t"), join(base, "cwd")])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const paths = resolveHubPaths({ home, uid: process.getuid!() });
  // Never let a long scratch path silently select a shared XDG or /tmp fallback.
  expect(paths.socketPath.startsWith(base + "/")).toBe(true);
  expect(Buffer.byteLength(paths.socketPath)).toBeLessThan(100);
  expect(existsSync(paths.socketPath)).toBe(false);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    PI_CODING_AGENT_DIR: agent,
    XDG_CACHE_HOME: join(base, "c"),
    TMPDIR: join(base, "t"),
    JITI_FS_CACHE: "false",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    LANG: "C.UTF-8",
  };
  return { base, home, agent, paths, env };
}
const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });

describe("production hub host loader", () => {
  it("closed production env: native TypeBox root/value/compile identities defeat shadow peers and user paths", () => {
    const f = fixture();
    const shadow = join(f.base, "shadow");
    mkdirSync(shadow);
    const marker = join(f.base, "marker");
    const evil = join(shadow, "evil.mjs");
    writeFileSync(
      evil,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'EXECUTED'); throw new Error('SHADOW_EXECUTED');`,
    );
    for (const name of ["typebox", "@sinclair/typebox"]) {
      const dir = join(shadow, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name,
          type: "module",
          exports: { ".": "./index.mjs", "./value": "./index.mjs", "./compile": "./index.mjs" },
        }),
      );
      cpSync(evil, join(dir, "index.mjs"));
    }
    const tsconfig = join(shadow, "tsconfig.json");
    put(tsconfig, {
      compilerOptions: { baseUrl: ".", paths: { typebox: ["./evil.mjs"], "@sinclair/typebox": ["./evil.mjs"] } },
    });
    const script = join(shadow, "identity.ts");
    writeFileSync(
      script,
      `
import assert from 'node:assert/strict';
import {Type as oldType} from '@sinclair/typebox';
import {Type as newType} from 'typebox';
import * as oldValue from '@sinclair/typebox/value';
import * as newValue from 'typebox/value';
import * as oldCompile from '@sinclair/typebox/compile';
import * as newCompile from 'typebox/compile';
const root = await import(${JSON.stringify(pathToFileURL(plan.hostAliases.typebox).href)});
const value = await import(${JSON.stringify(pathToFileURL(plan.hostAliases["typebox/value"]).href)});
const compile = await import(${JSON.stringify(pathToFileURL(plan.hostAliases["typebox/compile"]).href)});
assert.equal(oldType, root.Type); assert.equal(newType, root.Type);
assert.equal(oldValue.Value, value.Value); assert.equal(newValue.Value, value.Value);
assert.equal(oldCompile.Compile, compile.Compile); assert.equal(newCompile.Compile, compile.Compile);
assert.equal(typeof compile.Compile, 'function');
delete process.env.JITI_ALIAS; delete process.env.JITI_TSCONFIG_PATHS;
assert.equal((await import('typebox/value')).Value, value.Value);
assert.equal(value.Value.Check(root.Type.String(), 'valid'), true);
console.log('PASS native TypeBox identities and lazy import after env scrub');
`,
    );
    // The production launcher, not this test, supplies every alias and the paths override.
    const saved = { ...process.env };
    let result: ReturnType<typeof spawnSync> | undefined;
    try {
      process.env.JITI_ALIAS = JSON.stringify({ typebox: evil, unrelated: evil });
      process.env.JITI_TSCONFIG_PATHS = tsconfig;
      const wrapper = ((exec: string, argv: string[], options: any) => {
        expect(JSON.parse(options.env.JITI_ALIAS)).toEqual(plan.hostAliases);
        expect(options.env.JITI_TSCONFIG_PATHS).toBe("false");
        const env = {
          ...f.env,
          JITI_ALIAS: options.env.JITI_ALIAS,
          JITI_TSCONFIG_PATHS: options.env.JITI_TSCONFIG_PATHS,
        };
        result = spawnSync(exec, argv, { cwd: shadow, env, timeout: 30_000, encoding: "utf8" });
        put(join(f.base, "identity.json"), {
          argv: [exec, ...argv],
          aliases: plan.hostAliases,
          tsconfigPaths: env.JITI_TSCONFIG_PATHS,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        return { on() {}, unref() {} };
      }) as unknown as typeof spawn;
      expect(
        spawnHub(
          plan,
          script,
          { v: 1, home: f.home, port: 0, idleExitMinutes: 1, pluginVersion: "0.12.2", buildId: "test" },
          wrapper,
        ),
      ).toEqual({ blocked: false });
      expect(result?.status, String(result?.stderr)).toBe(0);
      expect(result?.stdout).toContain("PASS native TypeBox identities");
      expect(process.env.JITI_ALIAS).toContain("unrelated");
      expect(process.env.JITI_TSCONFIG_PATHS).toBe(tsconfig);
      // A resolvable local peer cannot become a fallback when the selected host is missing.
      expect(createRequire(script).resolve("typebox")).toBe(join(shadow, "node_modules/typebox/index.mjs"));
      const fakePi = join(f.base, "host/node_modules/@earendil-works/pi-coding-agent");
      mkdirSync(join(fakePi, "dist"), { recursive: true });
      writeFileSync(join(fakePi, "package.json"), '{"name":"@earendil-works/pi-coding-agent"}');
      writeFileSync(join(fakePi, "dist/cli.js"), "");
      const missingHost = resolveLauncherPlan({ argv1: join(fakePi, "dist/cli.js"), override: plan.jitiCli });
      expect(missingHost).toEqual({ ok: false, reason: expect.stringContaining("hub host TypeBox resolution failed") });
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const key of ["JITI_ALIAS", "JITI_TSCONFIG_PATHS"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it(
    "real SDK RPC auto-spawns consumer main, serves HTTP/SSE, scrubs managed child env, restart preserves proc identity",
    { timeout: 150_000 },
    async () => {
      const f = fixture();
      if (process.env.PI_TOOLKIT_HUB_LOADER_CONSUMER) expect(existsSync(join(consumer, "node_modules"))).toBe(false);
      const main = join(consumer, "src/web-hub/hub/main.ts");
      const config = {
        v: 1 as const,
        home: f.home,
        port: 0,
        idleExitMinutes: 1,
        pluginVersion: "0.12.2",
        buildId: "test",
      };
      // Exact production spawn parameters without config prove the full static graph loads.
      let diagnostic: ReturnType<typeof spawnSync> | undefined;
      spawnHub(plan, main, config, ((exec: string, argv: string[], options: any) => {
        const env = {
          ...f.env,
          JITI_ALIAS: options.env.JITI_ALIAS,
          JITI_TSCONFIG_PATHS: options.env.JITI_TSCONFIG_PATHS,
        };
        diagnostic = spawnSync(exec, argv, { cwd: f.home, env, timeout: 30_000, encoding: "utf8" });
        return { on() {}, unref() {} };
      }) as unknown as typeof spawn);
      expect(diagnostic?.status, String(diagnostic?.stderr)).toBe(2);
      expect(diagnostic?.stderr).toContain("PI_WEBHUB_CONFIG is not set");
      const bare = spawnSync(plan.execPath, [plan.jitiCli, main], {
        cwd: f.home,
        env: f.env,
        timeout: 30_000,
        encoding: "utf8",
      });
      // Bare jiti is deliberately the counterexample, never a production positive.
      if (process.env.PI_TOOLKIT_HUB_LOADER_CONSUMER) {
        expect(bare.status).toBe(1);
        expect(bare.stderr).toContain("Cannot find module '@sinclair/typebox'");
      }
      put(join(f.agent, "settings.json"), { packages: [consumer] });
      put(join(f.agent, "pi-toolkit.json"), {
        webHub: {
          enabled: true,
          autoStart: true,
          port: 0,
          control: true,
          webCommands: true,
          terminal: { enabled: false },
          lan: { enabled: false },
          privacy: false,
          spawn: { enabled: true, roots: [join(f.base, "cwd")] },
        },
        quota: { enabled: false },
        load: { enabled: false },
        traffic: { enabled: false },
        schedule: { enabled: false },
        memory: { enabled: false },
        title: { enabled: false },
        topicSwitch: { enabled: false },
        reflex: { enabled: false },
      });
      const argv = [
        piCli,
        "--mode",
        "rpc",
        "--no-skills",
        "--no-themes",
        "--no-prompt-templates",
        "--no-context-files",
      ];
      // Passive built-in V8 observation: no hooks/loader/argv changes or resolver overrides.
      // The preceding consumer runs also exercise the same path without this observer.
      const coverageDir = join(f.base, "v8");
      mkdirSync(coverageDir, { mode: 0o700 });
      f.env.NODE_V8_COVERAGE = coverageDir;
      const child = spawn(process.execPath, argv, { cwd: join(f.base, "cwd"), env: f.env, stdio: "pipe" });
      const exit = new Promise((r) => child.once("close", (code, signal) => r({ code, signal })));
      let stderr = "",
        buffer = "",
        seq = 0;
      child.stderr!.on("data", (b) => {
        stderr = (stderr + b).slice(-65536);
      });
      const replies = new Map<string, any>();
      child.stdout!.on("data", (b) => {
        buffer += b;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          try {
            const m = JSON.parse(line);
            if (m.type === "response") replies.set(m.id, m);
          } catch {}
        }
      });
      const rpc = async (type: string, data: object = {}) => {
        const id = `loader-${++seq}`;
        child.stdin!.write(JSON.stringify({ id, type, ...data }) + "\n");
        const reply = await until(() => {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`pi exited: ${stderr}`);
          return replies.get(id);
        }, `RPC ${type}: ${stderr}`);
        expect(reply.success, JSON.stringify(reply)).toBe(true);
        return reply.data;
      };
      const records: any[] = [];
      const owned = new Map<number, string | undefined>();
      const own = (pid: number) => {
        const p = proc(pid);
        if (p) owned.set(pid, p.startTicks);
      };
      const signalOwned = (signal: "SIGTERM" | "SIGKILL") => {
        for (const [pid, ticks] of owned) {
          const p = proc(pid);
          if (p && p.state !== "Z" && p.startTicks === ticks) {
            try {
              process.kill(pid, signal);
            } catch {}
          }
        }
      };
      let sse: Awaited<ReturnType<typeof privateSse>> | undefined;
      const closeSse = () => {
        sse?.close();
        sse = undefined;
      };
      try {
        const commands = (await rpc("get_commands")).commands;
        expect(commands.find((c: any) => c.name === "webhub")?.sourceInfo).toBeTruthy();
        const readHub = () => {
          try {
            return JSON.parse(readFileSync(f.paths.hubJson, "utf8"));
          } catch {
            return undefined;
          }
        };
        const ready = async (old?: number) => {
          const hub = await until(() => {
            const h = readHub();
            if (h && h.pid !== old) {
              own(h.pid);
              return h;
            }
            return undefined;
          }, `new private hub: ${stderr}`);
          expect(hub.socket).toBe(f.paths.socketPath);
          expect(hub.terminal).toBeUndefined();
          expect(hub.argv).toEqual([process.execPath, plan.jitiCli, main]);
          expect(
            await verifyProcIdentity({ pid: hub.pid, procStartTicks: hub.procStartTicks, argv: hub.argv }),
          ).toEqual({ ok: true });
          const initial = envOf(hub.pid);
          expect(JSON.parse(initial.JITI_ALIAS!)).toEqual(plan.hostAliases);
          expect(initial.JITI_TSCONFIG_PATHS).toBe("false");
          expect(JSON.parse(initial.PI_WEBHUB_CONFIG!).home).toBe(f.home);
          expect(JSON.parse(initial.PI_WEBHUB_LAUNCHER!)).toEqual([process.execPath, piCli]);
          const response = await fetch(`http://127.0.0.1:${hub.port}/`, { signal: AbortSignal.timeout(5000) });
          expect(response.status).toBe(200);
          const cookie = await privateLogin(hub.port, f.paths.tokenFile);
          sse = await privateSse(hub.port, cookie);
          const hello = await sse.wait((e) => e.event === "hello");
          expect(typeof hello.data.clientId).toBe("string");
          const hubEvent = await sse.wait((e) => e.event === "hub");
          expect(hubEvent.data.caps).not.toContain("terminal.tabs.v2");
          await until(
            () =>
              sse!.events.find(
                (e) => ["agents", "agent_up"].includes(e.event) && JSON.stringify(e.data).includes(String(child.pid)),
              ),
            "parent agent reconnect within production backoff",
          );
          records.push({
            ...hub,
            initialEnv: {
              HOME: initial.HOME,
              PI_CODING_AGENT_DIR: initial.PI_CODING_AGENT_DIR,
              JITI_ALIAS: JSON.parse(initial.JITI_ALIAS!),
              JITI_TSCONFIG_PATHS: initial.JITI_TSCONFIG_PATHS,
            },
            procIdentity: "verified",
            http: response.status,
            sse: true,
          });
          return { hub, cookie };
        };
        const { hub, cookie } = await ready();
        const spawned = await privatePost(
          hub.port,
          "/api/headless",
          { id: randomUUID(), cwd: join(f.base, "cwd"), confirm: true },
          cookie,
        );
        expect(spawned.status, JSON.stringify(spawned.body)).toBe(202);
        const managedPid = await until(() => {
          const children = readFileSync(`/proc/${hub.pid}/task/${hub.pid}/children`, "utf8")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
          return children.find((pid) => {
            const p = proc(pid);
            return p?.argv.includes(piCli) && p.argv.includes("--mode");
          });
        }, "managed pi child");
        own(managedPid);
        const managedEnv = envOf(managedPid);
        expect(managedEnv.JITI_ALIAS).toBeUndefined();
        expect(managedEnv.JITI_TSCONFIG_PATHS).toBeUndefined();
        expect(managedEnv.PI_WEBHUB_HEADLESS).toBe("1");
        expect(envOf(child.pid!).JITI_ALIAS).toBeUndefined();
        records.push({ managedPid, loaderKeysAbsent: true, parentLoaderKeysAbsent: true });
        closeSse();
        await rpc("prompt", { message: "/webhub restart" });
        await until(() => (!proc(hub.pid) ? true : undefined), "old own hub PID gone");
        const next = await ready(hub.pid);
        expect(next.hub.nonce).not.toBe(hub.nonce);
        closeSse();
        await rpc("prompt", { message: "/webhub stop" });
        await until(() => (!proc(next.hub.pid) ? true : undefined), "second own hub PID gone");
        expect(existsSync(f.paths.socketPath)).toBe(false);
        child.stdin!.end();
        expect(await exit).toEqual({ code: 0, signal: null });
        for (const record of records.filter((r) => r.pid !== undefined)) {
          const files = readdirSync(coverageDir).filter((name) => name.startsWith(`coverage-${record.pid}-`));
          const modules = files.flatMap((name) => JSON.parse(readFileSync(join(coverageDir, name), "utf8")).result);
          const actualTargets = [plan.hostAliases.typebox, plan.hostAliases["typebox/value"]];
          for (const target of actualTargets) {
            const loaded = modules.find((entry: any) => entry.url === pathToFileURL(target).href);
            expect(loaded, `real hub ${record.pid} loaded host ${target}`).toBeTruthy();
            expect(loaded.functions.some((fn: any) => fn.ranges.some((r: any) => r.count > 0))).toBe(true);
          }
          record.passivelyObservedHostModules = actualTargets;
          record.passiveCoverageFiles = files.map((name) => join(coverageDir, name));
        }
        const coverage = readdirSync(coverageDir).filter((name) => name.startsWith(`coverage-${child.pid}-`));
        const scripts = coverage.flatMap((name) => JSON.parse(readFileSync(join(coverageDir, name), "utf8")).result);
        const bundle = join(consumer, "dist/bundle/index.js");
        const actualBundle = scripts.find((entry: any) => entry.url.startsWith(pathToFileURL(bundle).href + "?v="));
        if (existsSync(bundle)) {
          expect(actualBundle, "actual consumer bundle must execute, not just exist on disk").toBeTruthy();
          expect(actualBundle.functions.some((fn: any) => fn.ranges.some((r: any) => r.count > 0))).toBe(true);
        } else {
          expect(actualBundle).toBeUndefined();
          expect(scripts.some((entry: any) => entry.url.includes(join(consumer, "src/index.ts")))).toBe(true);
        }
        put(join(f.base, "result.json"), {
          consumer,
          piCli,
          piVersion: JSON.parse(readFileSync(join(dirname(dirname(piCli)), "package.json"), "utf8")).version,
          jitiVersion: JSON.parse(readFileSync(createRequire(piCli).resolve("jiti/package.json"), "utf8")).version,
          aliases: plan.hostAliases,
          typeboxVersion: JSON.parse(readFileSync(join(dirname(plan.hostAliases.typebox), "../package.json"), "utf8"))
            .version,
          artifacts: Object.fromEntries(
            [
              "index.ts",
              "src/web-hub/agent/launcher.ts",
              "src/web-hub/hub/main.ts",
              ...(existsSync(join(consumer, "dist/bundle/index.js")) ? ["dist/bundle/index.js"] : []),
            ].map((p) => [p, sha(join(consumer, p))]),
          ),
          agentArgv: [process.execPath, ...argv],
          loadedEntry: actualBundle?.url ?? join(consumer, "src/index.ts"),
          passiveCoverageFiles: coverage.map((name) => join(coverageDir, name)),
          records,
          diagnosticExit: diagnostic?.status,
          bareCounterexampleExit: bare.status,
          exit: { code: 0 },
          terminalEnabled: false,
        });
        console.log(`HUB_LOADER_EVIDENCE ${join(f.base, "result.json")}`);
      } finally {
        closeSse();
        // Only owned private PIDs, pinned by starttime; never a global census or reused PID.
        if (existsSync(f.paths.hubJson)) {
          try {
            own(JSON.parse(readFileSync(f.paths.hubJson, "utf8")).pid);
          } catch {}
        }
        signalOwned("SIGTERM");
        child.stdin!.end();
        const force = setTimeout(() => {
          signalOwned("SIGKILL");
          child.kill("SIGKILL");
        }, 3000);
        force.unref();
        await exit;
        await until(
          () =>
            [...owned].every(([pid, ticks]) => {
              const p = proc(pid);
              return !p || p.state === "Z" || p.startTicks !== ticks;
            })
              ? true
              : undefined,
          "private descendants settled",
          5000,
        );
        clearTimeout(force);
        writeFileSync(join(f.base, "agent-stderr.log"), stderr, { mode: 0o600 });
      }
    },
  );
});
