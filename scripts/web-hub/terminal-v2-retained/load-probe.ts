/** Actual installed pi1.5 SDK loads/activates the selected package through ordinary
 * settings, without factory substitution/noExtensions/-e. No agent session is bound:
 * the probe cannot auto-start a hub or expose a terminal declaration if the parent
 * CLI dies. Normal owned process exit follows load completion. This is package-load
 * identity, NOT PTY, physical cleanup, auth recovery or service deployment proof. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExistingInstallationLease } from "./installation.js";
const PROGRAM = `
const {pathToFileURL}=require('node:url'); const {join,dirname}=require('node:path');
const home=process.env.HOME,agentDir=process.env.PI_CODING_AGENT_DIR,piCli=process.argv[1],entry=process.argv[2];
let aborted=false;
const timer=setTimeout(()=>process.exit(75),20000);timer.unref();
process.stdin.on('end',()=>{aborted=true;process.exit(75)});process.stdin.resume();
(async()=>{
 const pkg=JSON.parse(require('node:fs').readFileSync(join(dirname(piCli),'../package.json'),'utf8'));
 if(pkg.name!=='@earendil-works/pi-coding-agent'||pkg.version!=='1.5.0')throw Error('SDK profile');
 const sdk=await import(pathToFileURL(join(dirname(piCli),'index.js')).href);
 const settingsManager=sdk.SettingsManager.create(home,agentDir);
 const loader=new sdk.DefaultResourceLoader({cwd:home,agentDir,settingsManager,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true});
 await loader.reload();const loaded=loader.getExtensions();
 if(aborted||loaded.errors.length||!loaded.extensions.some(e=>e.path===entry))throw Error('load');
 if(aborted)throw Error('aborted');
 clearTimeout(timer);process.stdout.write(JSON.stringify({v:1,kind:'selected-package-loaded-without-session',entry})+'\\n',()=>process.exit(0));
})().catch(()=>process.exit(75));
`;
export async function verifySelectedPackageLoad(
  lease: ExistingInstallationLease,
  mode: "new" | "old-off",
  deadline: number,
): Promise<{ entry: string; sha256: string }> {
  lease.revalidate();
  const profile = lease.profile,
    entry = join(mode === "new" ? profile.newPackageRoot : profile.oldPackageRoot, "index.ts");
  // The SDK path is derived ONLY from the fixed installed pi CLI, not a module adapter.
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
  const child = spawn(process.execPath, ["-e", PROGRAM, profile.piCli, entry], {
    cwd: profile.home,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  let output = "";
  child.stdout.on("data", (b: Buffer) => {
    output += b.toString();
    if (output.length > 8192) child.stdin.end();
  });
  child.stdin.on("error", () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          child.stdin.end();
          reject(new Error("E_RETAINED_LOAD_PROBE_DEADLINE"));
        },
        Math.max(1, Math.min(22000, deadline - Date.now())),
      );
      timer.unref();
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("E_RETAINED_LOAD_PROBE_FAILED"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error("E_RETAINED_LOAD_PROBE_FAILED"));
      });
    });
    const receipt: unknown = JSON.parse(output);
    if (JSON.stringify(receipt) !== JSON.stringify({ v: 1, kind: "selected-package-loaded-without-session", entry }))
      throw new Error("E_RETAINED_LOAD_PROBE_RECEIPT");
    lease.revalidate();
    const { createHash } = await import("node:crypto");
    return { entry, sha256: createHash("sha256").update(output).digest("hex") };
  } finally {
    child.stdin.end();
  }
}
