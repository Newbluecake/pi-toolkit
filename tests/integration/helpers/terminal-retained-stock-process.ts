/** Launch the SEALED installation launcher, not a test-authored N host. All
 * business imports/loaders/hub startup belong to the selected installed package
 * and the profile's original pi CLI. No backend seam or runtime monkey patch. */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { observeUntil } from "../../../scripts/web-hub/terminal-v2-maintenance/http-client.js";
import type { prepareStockRetained } from "./terminal-retained-stock-setup.js";
type Installation = Awaited<ReturnType<typeof prepareStockRetained>>;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function proc(pid: number) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8"),
      fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      state: fields[0],
      parentPid: Number(fields[1]),
      uid: Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1]),
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      starttime: fields[19],
      argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    };
  } catch {
    return undefined;
  }
}
export function children(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
export function descendants(pid: number): ReturnType<typeof proc>[] {
  return children(pid)
    .flatMap((child) => [proc(child), ...descendants(child)])
    .filter(Boolean);
}
/** Historical bare-jiti negative control, NOT a product startup positive.
 * No config/plain marker/host aliases: the repaired production spawn plan is
 * intentionally absent. The positive below uses only the sealed pi launcher. */
export function probeBareStockMainCounterexample(f: Installation) {
  const require = createRequire(f.profile.piCli);
  const jitiPackage = require.resolve("jiti/package.json");
  const jitiCli = join(dirname(jitiPackage), "lib/jiti-cli.mjs");
  const main = join(f.profile.newPackageRoot, "src/web-hub/hub/main.ts");
  const env = {
    HOME: f.f.home,
    PATH: "/usr/bin:/bin",
    PI_CODING_AGENT_DIR: f.agentDir,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME!,
    TMPDIR: process.env.TMPDIR!,
    JITI_FS_CACHE: "false",
  };
  const result = spawnSync(process.execPath, [jitiCli, main], {
    cwd: f.f.cwd,
    env,
    timeout: 30000,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const evidence = {
    sdkCli: { path: f.profile.piCli, sha256: digest(f.profile.piCli) },
    jitiPackage,
    jitiCli: { path: jitiCli, sha256: digest(jitiCli) },
    main: { path: main, sha256: digest(main) },
    configSupplied: false,
    terminalSourceSupplied: false,
    resolverOverrides: false,
    pid: result.pid,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  writeFileSync(join(f.base, "stock-main-bare-counterexample.json"), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  expect(result.status, `bare jiti has no product host aliases: ${result.stderr}`).toBe(1);
  expect(result.stderr).toContain("Cannot find module '@sinclair/typebox'");
  return evidence;
}
export async function stockProcess(
  f: Installation,
  label: string,
  sameSession = false,
  own?: (stop: () => Promise<void>) => void,
) {
  // Opt-in passive V8 coverage, as in the independently accepted loader gate.
  // No hooks, test loader, source rewrite, backend wrapper or resolver mutation.
  const passiveCoverage: { directory: string; files?: string[]; backendFactoryCalls?: number } | null =
    process.env.PI_TOOLKIT_STOCK_OBSERVE === "1" ? { directory: join(f.base, `${label}-v8`) } : null;
  if (passiveCoverage) mkdirSync(passiveCoverage.directory, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    HOME: f.f.home,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    PI_CODING_AGENT_DIR: f.agentDir,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME!,
    TMPDIR: process.env.TMPDIR!,
    JITI_FS_CACHE: "false",
    npm_config_offline: "true",
  };
  if (passiveCoverage) env.NODE_V8_COVERAGE = passiveCoverage.directory;
  const args = [
    "--mode",
    "rpc",
    "--no-skills",
    "--no-themes",
    "--no-prompt-templates",
    "--no-context-files",
    "--session-dir",
    join(f.agentDir, "stock-sessions"),
    ...(sameSession ? ["--session", f.oldInfo.sessionFile as string] : []),
  ];
  const child = spawn(f.profile.launchers[0]!, args, { cwd: f.f.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let output = "",
    transcript = "",
    errors = "",
    next = 0,
    hub: any;
  const replies = new Map<string, any>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    transcript = (transcript + chunk).slice(-262144);
    output += chunk;
    if (output.length > 2 * 1024 * 1024) {
      child.stdin.end();
      return;
    }
    const lines = output.split("\n");
    output = lines.pop()!;
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.type === "response") replies.set(message.id, message);
      } catch {
        /* Non-JSON diagnostic is not an RPC success. */
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    errors = (errors + chunk).slice(-65536);
  });
  child.on("error", (error) => {
    errors += error.message;
  });
  const rpc = async (type: string, value: object = {}) => {
    const id = `${label}-${++next}`;
    child.stdin.write(JSON.stringify({ id, type, ...value }) + "\n");
    const reply = await observeUntil<any>(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`stock ${label} exited: ${errors}`);
        return replies.get(id);
      },
      Boolean,
      45000,
    );
    if (!reply.success) throw new Error(`stock ${type} failed: ${JSON.stringify(reply)}`);
    return reply.data;
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const owned = [proc(child.pid!), ...descendants(child.pid!)].filter((p) => !!p);
    const signalOwned = (signal: "SIGTERM" | "SIGKILL") => {
      for (const pin of [...owned].reverse()) {
        const current = proc(pin!.pid);
        if (
          current &&
          current.state !== "Z" &&
          current.starttime === pin!.starttime &&
          JSON.stringify(current.argv) === JSON.stringify(pin!.argv)
        ) {
          try {
            process.kill(current.pid, signal);
          } catch {
            /* Already exited. */
          }
        }
      }
    };
    // Capture only descendants of OUR launcher before EOF can orphan a detached
    // hub. This also covers startup/assertion failure before hub.json was read.
    if (!hub) {
      const ownHub = descendants(child.pid!).find((p) =>
        p?.argv.includes(join(f.profile.newPackageRoot, "src/web-hub/hub/main.ts")),
      );
      if (ownHub) hub = { pid: ownHub.pid, identity: ownHub };
    }
    try {
      if (hub && child.exitCode === null) {
        await rpc("prompt", { message: "/webhub stop" });
        await observeUntil(
          async () => proc(hub.pid),
          (p) => !p || p.state === "Z",
          20000,
        );
      }
    } finally {
      child.stdin.end();
      const timer = setTimeout(() => signalOwned("SIGTERM"), 15000);
      const hard = setTimeout(() => signalOwned("SIGKILL"), 20000);
      timer.unref();
      hard.unref();
      try {
        expect(await closed).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(timer);
        clearTimeout(hard);
        signalOwned("SIGTERM");
        // Failure-only cleanup is scoped to the exact recorded stock child identity.
        const current = hub && proc(hub.pid);
        if (
          current &&
          current.starttime === hub.identity.starttime &&
          current.argv.includes(join(f.profile.newPackageRoot, "src/web-hub/hub/main.ts"))
        ) {
          process.kill(hub.pid, "SIGTERM");
          await observeUntil(
            async () => proc(hub.pid),
            (p) => !p || p.state === "Z",
            15000,
          );
        }
        writeFileSync(join(f.base, `${label}-stderr.txt`), errors, { mode: 0o600 });
        writeFileSync(join(f.base, `${label}-stdout.txt`), transcript, { mode: 0o600 });
      }
    }
  };
  own?.(stop);
  try {
    const state = await rpc("get_state"),
      commands = await rpc("get_commands");
    const webhub = commands.commands.find((c: any) => c.name === "webhub");
    expect(webhub).toBeTruthy();
    // Source info comes from the ORIGINAL SDK resource loader, not our version
    // string. The source-forced sealed launcher must bind this exact consumer.
    expect(JSON.stringify(webhub.sourceInfo)).toContain(f.profile.newPackageRoot);
    // N1 auto-spawns. Later full pi processes retain the real stopped marker;
    // explicit start clears it and the original connection backoff spawns anew.
    if (existsSync(join(f.paths.stateDir, "stopped"))) await rpc("prompt", { message: "/webhub start" });
    hub = await observeUntil(
      async () => {
        try {
          const record = JSON.parse(readFileSync(f.paths.hubJson, "utf8")),
            identity = proc(record.pid);
          return identity && identity.state !== "Z" ? { ...record, identity } : undefined;
        } catch {
          return undefined;
        }
      },
      Boolean,
      45000,
    );
    const expectedMain = join(f.profile.newPackageRoot, "src/web-hub/hub/main.ts");
    const hostRequire = createRequire(f.profile.piCli);
    const jitiCli = join(dirname(hostRequire.resolve("jiti/package.json")), "lib/jiti-cli.mjs");
    expect(hub.identity.argv).toEqual([process.execPath, jitiCli, expectedMain]);
    expect(hub.socket).toBe(f.paths.socketPath);
    expect(hub.procStartTicks).toBe(Number(hub.identity.starttime));
    const initial = Object.fromEntries(
      readFileSync(`/proc/${hub.pid}/environ`, "utf8")
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    const hostAliases = JSON.parse(initial.JITI_ALIAS!);
    for (const request of ["typebox", "typebox/value", "typebox/compile"]) {
      expect(hostAliases[request]).toBe(hostRequire.resolve(request));
      expect(hostAliases[`@sinclair/${request}`]).toBe(hostRequire.resolve(request));
    }
    expect(Object.keys(hostAliases)).toHaveLength(6);
    expect(initial.JITI_TSCONFIG_PATHS).toBe("false");
    expect(initial.PI_WEBHUB_TERMINAL_SOURCE).toBe("plain");
    expect(JSON.parse(initial.PI_WEBHUB_CONFIG!).home).toBe(f.f.home);
    expect(JSON.parse(initial.PI_WEBHUB_LAUNCHER!)).toEqual([process.execPath, f.profile.piCli]);
    // Stock pi setupCli intentionally rewrites kernel cmdline to `pi`.
    // Bind the direct sealed-launcher child by real ppid/uid/starttime/boot,
    // then corroborate its ORIGINAL SDK registration on authenticated SSE.
    const pi = children(child.pid!)
      .map(proc)
      .find(
        (p) =>
          p !== undefined &&
          p.parentPid === child.pid &&
          p.uid === process.getuid!() &&
          p.argv.length === 1 &&
          p.argv[0] === "pi",
      );
    writeFileSync(
      join(f.base, `${label}-startup-processes.json`),
      JSON.stringify({ launcher: proc(child.pid!), descendants: descendants(child.pid!) }, null, 2),
      { mode: 0o600 },
    );
    expect(pi).toBeTruthy();
    expect(pi!.pid).not.toBe(child.pid);
    const piEnv = readFileSync(`/proc/${pi!.pid}/environ`, "utf8").split("\0");
    expect(piEnv).toContain(`PI_CODING_AGENT_DIR=${f.agentDir}`);
    expect(piEnv).toContain(`HOME=${f.f.home}`);
    expect(piEnv.some((entry) => entry.startsWith("JITI_ALIAS="))).toBe(false);
    expect(existsSync(join(f.profile.newPackageRoot, "node_modules"))).toBe(false);
    const evidence = {
      label,
      launcherPid: child.pid,
      pi,
      hub,
      extension: webhub.sourceInfo,
      productSpawn: {
        hostAliases,
        tsconfigPaths: initial.JITI_TSCONFIG_PATHS,
        terminalSource: initial.PI_WEBHUB_TERMINAL_SOURCE,
        exactKernelArgv: hub.identity.argv,
      },
      sealedLauncher: { path: f.profile.launchers[0], sha256: digest(f.profile.launchers[0]!) },
      sdkCli: { path: f.profile.piCli, sha256: digest(f.profile.piCli) },
      loadedMain: { path: expectedMain, sha256: digest(expectedMain) },
      extensionEntry: {
        path: join(f.profile.newPackageRoot, "index.ts"),
        sha256: digest(join(f.profile.newPackageRoot, "index.ts")),
      },
      maintenance: {
        path: join(f.profile.newPackageRoot, "dist/maintenance/cli.mjs"),
        sha256: digest(join(f.profile.newPackageRoot, "dist/maintenance/cli.mjs")),
      },
      args,
      sessionId: state.sessionId,
      noModelPrompt: true,
      productionBackendInjected: false,
      passiveCoverage,
    };
    writeFileSync(join(f.base, `${label}-loaded.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    return {
      rpc,
      stop,
      child,
      state,
      hub,
      evidence,
      async closeProof() {
        await stop();
        if (passiveCoverage) {
          const files = readdirSync(passiveCoverage.directory).filter((name) =>
            name.startsWith(`coverage-${hub.pid}-`),
          );
          const scripts = files.flatMap(
            (name) => JSON.parse(readFileSync(join(passiveCoverage.directory, name), "utf8")).result,
          );
          const backend = scripts.find((script: any) =>
            script.url.endsWith(join(f.profile.newPackageRoot, "src/web-hub/hub/terminal/v2/backend.ts")),
          );
          expect(backend, "actual consumer backend module must be loaded, not just a plan string").toBeTruthy();
          const factory = backend.functions.find((fn: any) => fn.functionName === "createTerminalBackend");
          expect(factory, "real production backend factory coverage must exist").toBeTruthy();
          expect(factory.ranges[0].count).toBe(0);
          passiveCoverage.files = files.map((name) => join(passiveCoverage.directory, name));
          passiveCoverage.backendFactoryCalls = factory.ranges[0].count;
          writeFileSync(join(f.base, `${label}-loaded.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
        }
        return {
          ...(await closed),
          piGone: !proc(pi!.pid) || proc(pi!.pid)?.state === "Z",
          hubGone: !proc(hub.pid) || proc(hub.pid)?.state === "Z",
        };
      },
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw new Error(`stock ${label} startup: ${String(error)}; stderr: ${errors}; stdout: ${transcript.slice(-8192)}`);
  }
}
