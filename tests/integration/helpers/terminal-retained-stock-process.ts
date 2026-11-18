/** Launch the SEALED installation launcher, not a test-authored N host. All
 * business imports/loaders/hub startup belong to the selected installed package
 * and the profile's original pi CLI. No backend seam or runtime monkey patch. */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
/** Fail-fast, genuine stock main module-load diagnostic. Missing config is
 * intentional: a loadable original main exits 2 before any service/PTY starts.
 * No plain provenance is supplied, and no resolver alias is added. */
export function probeStockMain(f: Installation) {
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
  writeFileSync(join(f.base, "stock-main-load.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  expect(result.status, `stock main must load before rejecting absent config: ${result.stderr}`).toBe(2);
  expect(result.stderr).toContain("PI_WEBHUB_CONFIG is not set");
  return evidence;
}
export async function stockProcess(f: Installation, label: string, sameSession = false) {
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
  try {
    const state = await rpc("get_state"),
      commands = await rpc("get_commands");
    const webhub = commands.commands.find((c: any) => c.name === "webhub");
    expect(webhub).toBeTruthy();
    // Source info comes from the ORIGINAL SDK resource loader, not our version
    // string. The source-forced sealed launcher must bind this exact consumer.
    expect(JSON.stringify(webhub.sourceInfo)).toContain(f.profile.newPackageRoot);
    await rpc("prompt", { message: "/webhub start" });
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
    expect(hub.identity.argv).toContain(expectedMain);
    expect(hub.identity.argv.some((arg: string) => arg.endsWith("jiti-cli.mjs"))).toBe(true);
    const pi = descendants(child.pid!).find((p) => p?.argv.includes(f.profile.piCli));
    expect(pi).toBeTruthy();
    expect(pi!.pid).not.toBe(child.pid);
    expect(existsSync(join(f.profile.newPackageRoot, "node_modules"))).toBe(false);
    const evidence = {
      label,
      launcherPid: child.pid,
      pi,
      hub,
      extension: webhub.sourceInfo,
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
