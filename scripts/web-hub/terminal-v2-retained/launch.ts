/** Fixed launcher admission. Lock covers source/floor/binding check -> actual fork.
 * It never launches O with terminal on. Existing actor/hub processes may coexist;
 * maintenance's separate census + original singleton refuses until they stop. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { terminalMarkersV2Match, createInitialTerminalLedgerV2 } from "../../../src/web-hub/protocol/terminal-v2.js";
import { HeldDirectory, digest, json, parse, exactKeys } from "../terminal-v2-maintenance/files.js";
import { InstallationProfileSchema, type InstallationProfile } from "./installation.js";
import {
  readPublicationChain,
  assertPublicationBinding,
  maintenanceArtifactSha256,
  piRuntimeSha256,
} from "./publication.js";
import { pinSourceProfile } from "./source-profile.js";
import { acquireRetainedLock } from "./lock.js";
import { readRetainedIntent } from "./engine.js";
import { pinInstallationEntries } from "./entries.js";
function assertNoExtraExtensions(profile: InstallationProfile) {
  // Closed initial launcher profile: no unmeasured global/project extension paths.
  // Unsupported source layout refuses; ordinary chat/state is never repaired.
  for (const directory of [join(profile.agentDir, "extensions"), join(process.cwd(), ".pi/extensions")]) {
    try {
      if (readdirSync(directory).length) throw new Error("E_RETAINED_EXTRA_EXTENSIONS_UNMEASURED");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const project = join(process.cwd(), ".pi/settings.json");
  try {
    const value: unknown = JSON.parse(readFileSync(project, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || "packages" in value || "extensions" in value)
      throw new Error("E_RETAINED_PROJECT_PACKAGES_UNMEASURED");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export async function launchRetained(installationPath: string, args: readonly string[]): Promise<number> {
  if (process.env.PI_SECURE_SESSION || process.env.PI_SECURE_VAULT) throw new Error("E_RETAINED_PLAIN_LINUX_REQUIRED");
  if (
    args.some(
      (arg) =>
        ["--no-extensions", "--extension", "--extensions", "-e"].includes(arg) ||
        /^-e./.test(arg) ||
        arg.startsWith("--extension="),
    )
  )
    throw new Error("E_RETAINED_LAUNCH_OVERRIDE_DENIED");
  const directory = new HeldDirectory(installationPath),
    lock = await acquireRetainedLock(directory, Date.now() + 30000);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const profileFile = directory.read("profile.json", 32768),
      raw = parse(profileFile.bytes);
    if (!Value.Check(InstallationProfileSchema, raw)) throw new Error("E_RETAINED_INSTALLATION_PROFILE");
    const profile = raw,
      chain = readPublicationChain(directory);
    if (!chain.last?.completionFile) throw new Error("E_RETAINED_PUBLICATION_NOT_COMPLETE");
    const source = pinSourceProfile(profile.newPackageRoot, "new"),
      old = pinSourceProfile(profile.oldPackageRoot, "old");
    if (
      chain.floor.newSourceSha256 !== source.sha256 ||
      chain.floor.maintenanceSha256 !== maintenanceArtifactSha256(profile) ||
      chain.floor.piRuntimeSha256 !== piRuntimeSha256(profile) ||
      chain.floor.newPackageRoot !== profile.newPackageRoot ||
      chain.floor.oldPackageRoot !== profile.oldPackageRoot ||
      chain.floor.piCli !== profile.piCli ||
      chain.floor.agentDir !== profile.agentDir ||
      chain.floor.stateDir !== profile.stateDir
    )
      throw new Error("E_RETAINED_LAUNCH_FLOOR_CHANGED");
    const { intent, file: intentFile } = readRetainedIntent(directory),
      state = new HeldDirectory(profile.stateDir),
      agent = new HeldDirectory(profile.agentDir),
      entries = pinInstallationEntries(profile, directory.path);
    let evidence: HeldDirectory | undefined, root: HeldDirectory | undefined;
    try {
      if (
        intent.operationId !== chain.floor.operationId ||
        intent.sourceManifestSha256 !== chain.floor.sourceManifestSha256 ||
        intent.installationSha256 !== chain.floor.sourceInstallationId ||
        intent.state.path !== state.path ||
        intent.state.dev !== state.identity.dev ||
        intent.state.ino !== state.identity.ino ||
        digest(directory.read("installation-anchor.json", 4096).bytes) !== chain.floor.sourceInstallationId
      )
        throw new Error("E_RETAINED_LAUNCH_INSTALLATION_CHANGED");
      evidence = new HeldDirectory(intent.evidencePath);
      root = new HeldDirectory(join(state.path, "terminal-v2"));
      const marker = root.read("marker.json", 2048),
        witness = state.read(".terminal-initialized-v2", 2048),
        complete = evidence.read("initialization-complete.json", 4096),
        mapping = evidence.read("mapping.json", 65536);
      const initial = createInitialTerminalLedgerV2(
        intent.marker,
        parse(mapping.bytes) as Parameters<typeof createInitialTerminalLedgerV2>[1],
      );
      if (
        digest(mapping.bytes) !== intent.mappingSha256 ||
        !terminalMarkersV2Match(intent.marker, parse(marker.bytes)) ||
        !terminalMarkersV2Match(intent.marker, parse(witness.bytes)) ||
        intent.marker.initialization !== "offline-retained-unknown" ||
        !complete.bytes.equals(
          json({
            v: 1,
            kind: "retained-initialization-complete",
            operationId: intent.operationId,
            intentSha256: digest(intentFile.bytes),
            initialLedgerSha256: digest(json(initial)),
            markerSha256: digest(json(intent.marker)),
          }),
        )
      )
        throw new Error("E_RETAINED_LAUNCH_INITIALIZATION_CHANGED");
      const settings = agent.read("settings.json", 1048576),
        toolkit = agent.read("pi-toolkit.json", 1048576);
      if (!agent.absent("pi-subagent.json")) throw new Error("E_RETAINED_LEGACY_SETTINGS_REVIEW");
      assertPublicationBinding(profile, chain.last.prepared.mode, settings, toolkit);
      assertNoExtraExtensions(profile);
      entries.verify();
      source.verifyBytes();
      old.verifyBytes();
      chain.proveDurable(() => lock.guard());
      directory.verify(profileFile);
      directory.verify(intentFile);
      root.verify(marker);
      state.verify(witness);
      evidence.verify(complete);
      evidence.verify(mapping);
      agent.verify(settings);
      agent.verify(toolkit);
      lock.guard();
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
      // No await between final guard and fork. Parent remains until ordinary pi exits;
      // no timeout, kill, resume of unknown input or signal forwarding is invented.
      child = spawn(process.execPath, [profile.piCli, ...args], { cwd: process.cwd(), env, stdio: "inherit" });
      await new Promise<void>((resolve, reject) => {
        child!.once("spawn", resolve);
        child!.once("error", reject);
      });
    } finally {
      root?.close();
      evidence?.close();
      entries.close();
      agent.close();
      state.close();
    }
  } finally {
    await lock.release();
    directory.close();
  }
  return await new Promise<number>((resolve) => {
    if (child!.exitCode !== null) return resolve(child!.exitCode!);
    if (child!.signalCode !== null) return resolve(75);
    child!.once("close", (code) => resolve(code ?? 75));
  });
}
