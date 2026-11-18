/** Existing-installation maintenance lease. Location inventory is NOT proof of
 * stopped writers: inspect original producer identities + actual pi/hub processes,
 * fixed source profiles, entry files, then acquire the original hub singleton.
 * Same-uid trusted operator must inventory/disable external autostarters; no daemon
 * or claim that a v2 marker prevents malicious direct execution of old source. */
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HeldDirectory, parse } from "../terminal-v2-maintenance/files.js";
import { acquireSingleton, type SingletonResult } from "../../../src/web-hub/hub/singleton.js";
import { identityEquals, resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { captureTerminalSource } from "./snapshot.js";
import { readRetainedSource, type RetainedSourceInventory } from "./source-reader.js";
import { acquireRetainedLock, type RetainedLock } from "./lock.js";
import { pinSourceProfile, type SourceProfilePin } from "./source-profile.js";
import { pinInstallationEntries, type InstallationEntries } from "./entries.js";
import { recoverMaintenanceSocket, recordMaintenanceSocket } from "./maintenance-socket.js";
import { maintenanceArtifactSha256 } from "./publication.js";
const pathSchema = Type.String({ minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000]*$" });
export const InstallationProfileSchema = Type.Object(
  {
    v: Type.Literal(1),
    kind: Type.Literal("terminal-retained-O7239"),
    home: pathSchema,
    stateDir: pathSchema,
    agentDir: pathSchema,
    socketPath: pathSchema,
    xdgRuntimeDir: Type.Optional(pathSchema),
    piCli: pathSchema,
    oldPackageRoot: pathSchema,
    newPackageRoot: pathSchema,
    launchers: Type.Array(pathSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    autostartFiles: Type.Array(pathSchema, { maxItems: 64, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type InstallationProfile = Static<typeof InstallationProfileSchema>;
const boot = () => {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new Error("E_RETAINED_KERNEL_UNKNOWN");
  return value;
};
function starttime(stat: string): string {
  const end = stat.lastIndexOf(") ");
  if (end < 1) throw new Error("E_RETAINED_PROCESS_UNKNOWN");
  const value = stat.slice(end + 2).split(" ")[19];
  if (!value || !/^[0-9]{1,32}$/.test(value)) throw new Error("E_RETAINED_PROCESS_UNKNOWN");
  return value;
}
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}
export function assertNoRetainedProducers(profile: InstallationProfile, inventory: RetainedSourceInventory): void {
  const currentBoot = boot();
  const isBoot = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  for (const authority of inventory.authorities) {
    if (
      (!isBoot(authority.process.bootId) || authority.process.bootId === currentBoot) &&
      (["pid", "mnt", "user"] as const).some(
        (kind) => authority.namespaces[kind] !== readlinkSync(`/proc/self/ns/${kind}`),
      )
    )
      throw new Error("E_RETAINED_PRODUCER_NAMESPACE_UNKNOWN");
  }
  for (const producer of inventory.producers) {
    const p = producer.process;
    if (isBoot(p.bootId) && p.bootId !== currentBoot) continue; // A producer-identity check, NEVER debt release.
    try {
      const st = lstatSync(`/proc/${p.pid}`),
        actual = starttime(readFileSync(`/proc/${p.pid}/stat`, "utf8"));
      if (st.uid === p.uid && actual === p.starttime)
        throw new Error(`E_RETAINED_PRODUCER_ALIVE:${producer.recordKey}`);
    } catch (e) {
      if (!["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
  }
  const names = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  if (names.length > 32768) throw new Error("E_RETAINED_PROCESS_CAPACITY");
  for (const name of names) {
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      if (lstatSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
      const args = readFileSync(`/proc/${pid}/cmdline`).toString().split("\0");
      const candidate = args.some(
        (arg) =>
          arg === profile.piCli ||
          arg.startsWith(profile.oldPackageRoot + "/") ||
          arg.startsWith(profile.newPackageRoot + "/"),
      );
      if (!candidate) continue;
      const env = readFileSync(`/proc/${pid}/environ`).toString().split("\0");
      if (env.includes(`HOME=${profile.home}`) || env.includes(`PI_CODING_AGENT_DIR=${profile.agentDir}`))
        throw new Error("E_RETAINED_INSTALLATION_PROCESS_ALIVE");
    } catch (e) {
      if (!["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
  }
}
function assertSourceBindings(profile: InstallationProfile, agent: HeldDirectory, directory: HeldDirectory) {
  const settings = parse(agent.read("settings.json", 1048576).bytes),
    toolkit = parse(agent.read("pi-toolkit.json", 1048576).bytes);
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (
    !record(settings) ||
    !Array.isArray(settings.packages) ||
    settings.packages.length !== 1 ||
    ![profile.oldPackageRoot, profile.newPackageRoot].includes(String(settings.packages[0])) ||
    (settings.packages[0] === profile.newPackageRoot && directory.absent("active-operation.json")) ||
    (settings.extensions !== undefined && (!Array.isArray(settings.extensions) || settings.extensions.length !== 0))
  )
    throw new Error("E_RETAINED_SOURCE_BINDING_UNKNOWN");
  if (
    !record(toolkit) ||
    !record(toolkit.webHub) ||
    toolkit.webHub.enabled !== true ||
    (toolkit.webHub.nodeLoader !== undefined && toolkit.webHub.nodeLoader !== "")
  )
    throw new Error("E_RETAINED_LOADER_BINDING_UNKNOWN");
  if (!agent.absent("pi-subagent.json")) throw new Error("E_RETAINED_LEGACY_SETTINGS_REVIEW");
  for (const path of [join(profile.agentDir, "extensions"), join(profile.home, ".pi/extensions")]) {
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink() || readdirSync(path).length)
        throw new Error("E_RETAINED_EXTRA_EXTENSIONS_UNMEASURED");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (!absent(join(profile.home, ".pi/settings.json"))) throw new Error("E_RETAINED_HOME_PROJECT_SOURCE_UNMEASURED");
}
export interface ExistingInstallationLease {
  profile: InstallationProfile;
  directory: HeldDirectory;
  state: HeldDirectory;
  oldSource: SourceProfilePin;
  newSource: SourceProfilePin;
  guard(): void;
  revalidate(): void;
  sealEntries(): void;
  release(): Promise<void>;
}
export async function acquireExistingInstallation(
  installationPath: string,
  expectedState: string,
  deadline: number,
): Promise<ExistingInstallationLease> {
  if (process.platform !== "linux" || process.env.PI_SECURE_SESSION || process.env.PI_SECURE_VAULT)
    throw new Error("E_RETAINED_PLAIN_LINUX_REQUIRED");
  const directory = new HeldDirectory(installationPath);
  let lock: RetainedLock | undefined, state: HeldDirectory | undefined, socketDir: HeldDirectory | undefined;
  let owner: Extract<SingletonResult, { kind: "owner" }> | undefined;
  let released = false,
    entriesPin: InstallationEntries | undefined;
  try {
    lock = await acquireRetainedLock(directory, deadline);
    const profileFile = directory.read("profile.json", 32768),
      raw = parse(profileFile.bytes);
    if (!Value.Check(InstallationProfileSchema, raw)) throw new Error("E_RETAINED_INSTALLATION_PROFILE");
    const profile = raw;
    if (profile.stateDir !== expectedState) throw new Error("E_RETAINED_STATE_MISMATCH");
    const paths = resolveHubPaths({ home: profile.home, uid: process.getuid!(), xdgRuntimeDir: profile.xdgRuntimeDir });
    if (paths.stateDir !== profile.stateDir || paths.socketPath !== profile.socketPath)
      throw new Error("E_RETAINED_ORIGINAL_PATHS_UNKNOWN");
    state = new HeldDirectory(profile.stateDir);
    socketDir = new HeldDirectory(dirname(profile.socketPath));
    // Original stale hub sockets/locks are never reset. Only a durably identified
    // socket previously bound by THIS maintenance tool has a separate recovery path.
    if (!absent(paths.startLock)) throw new Error("E_RETAINED_ORIGINAL_START_LOCK_PRESENT");
    if (realpathSync(profile.piCli) !== profile.piCli) throw new Error("E_RETAINED_PI_CLI_PHYSICAL_PATH_REQUIRED");
    const piMetadata = () => {
      const s = lstatSync(profile.piCli);
      if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o022) !== 0 || (s.uid !== 0 && s.uid !== process.getuid?.()))
        throw new Error("E_RETAINED_PI_CLI_UNSAFE");
      return JSON.stringify([s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
    };
    const originalPi = piMetadata();
    const oldSource = pinSourceProfile(profile.oldPackageRoot, "old"),
      newSource = pinSourceProfile(profile.newPackageRoot, "new");
    // An executable copied from another maintenance release cannot initialize first
    // and only discover its wrong identity later at publication.
    maintenanceArtifactSha256(profile);
    entriesPin = pinInstallationEntries(profile, installationPath);
    const agent = new HeldDirectory(profile.agentDir);
    // Current installed loading sources are measured, not merely named by I.
    // Unknown package/extension/custom-loader layouts refuse before any entry seal.
    try {
      assertSourceBindings(profile, agent, directory);
    } catch (e) {
      agent.close();
      throw e;
    }
    // Pin entry inventory separately; it is not a handwritten "stopped" boolean.
    // Autostart files must contain no active direct pi/old-package launch. Unit files
    // require explicit operator disable/removal from active search paths before this
    // profile can be used; unsupported active formats refuse rather than guess.
    const entries: Array<{ dir: HeldDirectory; file: ReturnType<HeldDirectory["read"]> }> = [];
    try {
      for (const file of profile.autostartFiles) {
        const parent = new HeldDirectory(dirname(file));
        try {
          const captured = parent.read(file.slice(dirname(file).length + 1), 131072);
          const active = captured.bytes
            .toString()
            .split(/\r?\n/)
            .filter((line) => line.trim() && !/^\s*#/.test(line));
          if (
            active.some((line) =>
              [profile.piCli, profile.oldPackageRoot, ...profile.launchers].some((value) => line.includes(value)),
            )
          )
            throw new Error("E_RETAINED_AUTOSTART_ACTIVE_OR_UNKNOWN");
          entries.push({ dir: parent, file: captured });
        } catch (e) {
          parent.close();
          throw e;
        }
      }
      const snapshot = captureTerminalSource(state, () => lock!.guard());
      let inventory: RetainedSourceInventory;
      try {
        inventory = readRetainedSource(snapshot);
        assertNoRetainedProducers(profile, inventory);
        snapshot.verify();
      } finally {
        snapshot.close();
      }
      const preliminaryGuard = () => {
        lock!.guard();
        directory.verify(profileFile);
        state!.check();
        socketDir!.check();
        agent.check();
        assertSourceBindings(profile, agent, directory);
        oldSource.verify();
        newSource.verify();
        entriesPin!.verify();
        if (piMetadata() !== originalPi) throw new Error("E_RETAINED_PI_CLI_CHANGED");
        for (const e of entries) e.dir.verify(e.file);
      };
      if (!absent(paths.socketPath))
        recoverMaintenanceSocket({
          directory,
          state,
          socketDir,
          socketPath: paths.socketPath,
          profileFile,
          newSourceSha256: newSource.sha256,
          guard: preliminaryGuard,
        });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      timer.unref();
      let acquired: SingletonResult;
      try {
        acquired = await acquireSingleton(paths, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (acquired.kind !== "owner") throw new Error("E_RETAINED_ORIGINAL_SINGLETON_BUSY");
      owner = acquired;
      let ownerFile: ReturnType<HeldDirectory["read"]> | undefined;
      const guard = () => {
        if (released || Date.now() >= deadline || !owner?.server.listening)
          throw new Error("E_RETAINED_MAINTENANCE_LOST");
        preliminaryGuard();
        if (ownerFile) directory.verify(ownerFile);
        const socket = lstatSync(paths.socketPath);
        if (
          !socket.isSocket() ||
          socket.uid !== process.getuid?.() ||
          !identityEquals(socket, owner.identity.socket) ||
          !identityEquals(socketDir!.identity, owner.identity.dir)
        )
          throw new Error("E_RETAINED_ORIGINAL_SINGLETON_CHANGED");
      };
      ownerFile = recordMaintenanceSocket({
        directory,
        state,
        socketPath: paths.socketPath,
        profileFile,
        newSourceSha256: newSource.sha256,
        guard,
      });
      const revalidate = () => {
        guard();
        oldSource.verifyBytes();
        newSource.verifyBytes();
        agent.check();
        for (const e of entries) e.dir.verify(e.file);
        assertNoRetainedProducers(profile, inventory);
        guard();
      };
      revalidate();
      return {
        profile,
        directory,
        state,
        oldSource,
        newSource,
        guard,
        revalidate,
        sealEntries() {
          revalidate();
          entriesPin!.seal(directory, guard);
          revalidate();
        },
        async release() {
          if (released) return;
          released = true;
          try {
            await owner!.release();
          } finally {
            agent.close();
            for (const e of entries) e.dir.close();
            entriesPin!.close();
            socketDir!.close();
            state!.close();
            try {
              await lock!.release();
            } finally {
              directory.close();
            }
          }
        },
      };
    } catch (e) {
      agent.close();
      for (const entry of entries) entry.dir.close();
      throw e;
    }
  } catch (e) {
    try {
      await owner?.release();
    } finally {
      entriesPin?.close();
      socketDir?.close();
      state?.close();
      try {
        await lock?.release();
      } finally {
        directory.close();
      }
    }
    throw e;
  }
}
