/** Actual installed SDK/package load, no bound session. Diagnostics contain ONLY
 * closed stage/status enums and bounded elapsed milliseconds, never paths, loader
 * errors, stderr, settings, tokens or environment. Original 20s/22s budgets stay. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ExistingInstallationLease } from "./installation.js";
export const LOAD_PROBE_STAGES = [
  "starting",
  "sdk-profile",
  "sdk-import",
  "settings",
  "loader-create",
  "loader-reload",
  "extensions",
  "receipt",
] as const;
type Stage = (typeof LOAD_PROBE_STAGES)[number];
const PROGRAM = `
const {pathToFileURL}=require('node:url'); const {join,dirname}=require('node:path');
const home=process.env.HOME,agentDir=process.env.PI_CODING_AGENT_DIR,piCli=process.argv[1],entry=process.argv[2];
let aborted=false; const started=Date.now();
const stage=name=>require('node:fs').writeSync(3,JSON.stringify({stage:name,ms:Math.min(30000,Math.max(0,Date.now()-started))})+'\\n');
const timer=setTimeout(()=>process.exit(75),20000);timer.unref();
process.stdin.on('end',()=>{aborted=true;process.exit(75)});process.stdin.resume();
(async()=>{
 stage('sdk-profile');
 const pkg=JSON.parse(require('node:fs').readFileSync(join(dirname(piCli),'../package.json'),'utf8'));
 if(pkg.name!=='@earendil-works/pi-coding-agent'||pkg.version!=='1.5.0')throw Error('SDK profile');
 stage('sdk-import');
 const sdk=await import(pathToFileURL(join(dirname(piCli),'index.js')).href);
 stage('settings');
 const settingsManager=sdk.SettingsManager.create(home,agentDir);
 stage('loader-create');
 const loader=new sdk.DefaultResourceLoader({cwd:home,agentDir,settingsManager,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true});
 stage('loader-reload'); await loader.reload(); stage('extensions'); const loaded=loader.getExtensions();
 if(aborted||loaded.errors.length||!loaded.extensions.some(e=>e.path===entry))throw Error('load');
 if(aborted)throw Error('aborted');
 stage('receipt'); clearTimeout(timer);process.stdout.write(JSON.stringify({v:1,kind:'selected-package-loaded-without-session',entry})+'\\n',()=>process.exit(0));
})().catch(()=>process.exit(75));
`;
/** Exported solely for real-process protocol tests using owned synthetic SDK files.
 * The maintenance entry below still derives all paths from its validated lease. */
export async function runSelectedPackageProbe(
  piCli: string,
  entry: string,
  home: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<string> {
  const started = Date.now();
  const child = spawn(process.execPath, ["-e", PROGRAM, piCli, entry], {
    cwd: home,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "ignore", "pipe"],
  });
  let stage: Stage = "starting",
    childMs = 0,
    pending = "",
    bytes = 0,
    output = "",
    overflow = false;
  // Kill only the process group we just created. No name/ps lookup or site signal.
  const stop = () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  const diagnostic = (reason: "deadline" | "child-failed" | "spawn-error" | "receipt" | "output-limit") => {
    const elapsedMs = Math.min(30000, Math.max(0, Date.now() - started));
    console.error(`T51_LOAD_PROBE stage=${stage} elapsedMs=${elapsedMs} childMs=${childMs} reason=${reason}`);
  };
  child.stdin.on("error", () => undefined);
  (child.stdio[3] as Readable).on("data", (buffer: Buffer) => {
    // Separate inherited fd3: arbitrary/noisy SDK stderr cannot erase the last stage.
    bytes += buffer.length;
    if (bytes > 8192) return;
    pending += buffer.toString();
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (
          Object.keys(value).sort().join(",") !== "ms,stage" ||
          !LOAD_PROBE_STAGES.includes(value.stage) ||
          !Number.isInteger(value.ms) ||
          value.ms < childMs ||
          value.ms > 30000
        )
          continue;
        stage = value.stage;
        childMs = value.ms;
      } catch {
        /* arbitrary stderr is not a diagnostic channel */
      }
    }
  });
  child.stdout.on("data", (buffer: Buffer) => {
    if (output.length + buffer.length > 8192) {
      overflow = true;
      stop();
    } else output += buffer.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => {
          settled = true;
          stop();
          diagnostic("deadline");
          reject(new Error("E_RETAINED_LOAD_PROBE_DEADLINE"));
        },
        Math.max(1, Math.min(22000, deadline - Date.now())),
      );
      timer.unref();
      child.once("error", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        diagnostic("spawn-error");
        reject(new Error("E_RETAINED_LOAD_PROBE_FAILED"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0 && !overflow) resolve();
        else {
          diagnostic(overflow ? "output-limit" : "child-failed");
          reject(new Error("E_RETAINED_LOAD_PROBE_FAILED"));
        }
      });
    });
    let receipt: unknown;
    try {
      receipt = JSON.parse(output);
    } catch {
      diagnostic("receipt");
      throw new Error("E_RETAINED_LOAD_PROBE_RECEIPT");
    }
    if (JSON.stringify(receipt) !== JSON.stringify({ v: 1, kind: "selected-package-loaded-without-session", entry })) {
      diagnostic("receipt");
      throw new Error("E_RETAINED_LOAD_PROBE_RECEIPT");
    }
    return output;
  } finally {
    stop();
  }
}
export async function verifySelectedPackageLoad(
  lease: ExistingInstallationLease,
  mode: "new" | "old-off",
  deadline: number,
): Promise<{ entry: string; sha256: string }> {
  lease.revalidate();
  const profile = lease.profile,
    entry = join(mode === "new" ? profile.newPackageRoot : profile.oldPackageRoot, "index.ts");
  if (!profile.piCli.endsWith("/dist/cli.js")) throw new Error("E_RETAINED_PI_SDK_LOCATION_UNKNOWN");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: profile.home,
    PI_CODING_AGENT_DIR: profile.agentDir,
    PI_TOOLKIT_ENTRY: "src",
    NODE_OPTIONS: "",
    JITI_FS_CACHE: "false",
  };
  delete env.PI_WEBHUB_CONFIG;
  delete env.PI_WEBHUB_TERMINAL_SOURCE;
  delete env.NODE_PATH;
  if (profile.xdgRuntimeDir) env.XDG_RUNTIME_DIR = profile.xdgRuntimeDir;
  else delete env.XDG_RUNTIME_DIR;
  const output = await runSelectedPackageProbe(profile.piCli, entry, profile.home, env, deadline);
  lease.revalidate();
  const { createHash } = await import("node:crypto");
  return { entry, sha256: createHash("sha256").update(output).digest("hex") };
}
