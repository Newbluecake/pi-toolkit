/** Separate durable publication phase. Never restores auth or old resource state.
 * Terminal generation floor stays N even in the explicitly terminal-OFF old mode.
 * Prepared is not complete; the fixed launcher refuses an incomplete tip. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HeldDirectory, digest, json, parse, type CapturedFile } from "../terminal-v2-maintenance/files.js";
import { publishRetainedFile } from "./durable.js";
import type { ExistingInstallationLease, InstallationProfile } from "./installation.js";
import type { RetainedInitializationResult } from "./engine.js";
import { verifySelectedPackageLoad } from "./load-probe.js";
import { captureTerminalSource } from "./snapshot.js";
const closed = <T extends TProperties>(p: T) => Type.Object(p, { additionalProperties: false });
const sha = Type.String({ pattern: "^[a-f0-9]{64}$" }),
  token = Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}$" });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const floorSchema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("terminal-v2-retained-floor"),
  operationId: token,
  sourceInstallationId: sha,
  sourceManifestSha256: sha,
  newSourceSha256: sha,
  maintenanceSha256: sha,
  piRuntimeSha256: sha,
  stateDir: path,
  agentDir: path,
  piCli: path,
  newPackageRoot: path,
  oldPackageRoot: path,
  initialMode: Type.Union([Type.Literal("new"), Type.Literal("old-off")]),
});
const preparedSchema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("terminal-publication-prepared"),
  sequence: Type.Integer({ minimum: 1, maximum: 64 }),
  operationId: token,
  floorSha256: sha,
  mode: Type.Union([Type.Literal("new"), Type.Literal("old-off")]),
  previousCompletionSha256: Type.Union([sha, Type.Null()]),
  settingsBeforeSha256: sha,
  settingsAfterSha256: sha,
  toolkitBeforeSha256: sha,
  toolkitAfterSha256: sha,
});
const completeSchema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("terminal-publication-complete"),
  preparedSha256: sha,
  loadedEntry: path,
  packageLoadSha256: sha,
});
export type PublicationPrepared = Static<typeof preparedSchema>;
export interface PublicationChain {
  floor: Static<typeof floorSchema>;
  floorFile: CapturedFile;
  last?: { prepared: PublicationPrepared; preparedFile: CapturedFile; completionFile?: CapturedFile };
  verify(): void;
  proveDurable(guard: () => void): void;
}
function shape<T>(schema: Parameters<typeof Value.Check>[0], value: unknown): T {
  if (!Value.Check(schema, value)) throw new Error("E_RETAINED_PUBLICATION_SHAPE");
  return value as T;
}
function artifactSha256(file: string): string {
  const before = lstatSync(file);
  const identity = (s: typeof before) =>
    JSON.stringify([s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
  if (
    !before.isFile() ||
    (before.uid !== 0 && before.uid !== process.getuid?.()) ||
    (before.mode & 0o022) !== 0 ||
    before.nlink !== 1 ||
    before.size > 8 * 1024 * 1024
  )
    throw new Error("E_RETAINED_RUNTIME_ARTIFACT");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(fstatSync(fd)) !== identity(before)) throw new Error("E_RETAINED_RUNTIME_ARTIFACT_CHANGED");
    const bytes = Buffer.alloc(before.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const got = readSync(fd, bytes, n, bytes.length - n, n);
      if (!got) break;
      n += got;
    }
    if (
      n !== before.size ||
      identity(fstatSync(fd)) !== identity(before) ||
      identity(lstatSync(file)) !== identity(before)
    )
      throw new Error("E_RETAINED_RUNTIME_ARTIFACT_CHANGED");
    return digest(bytes.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}
// Immutable per loaded executable, not re-read from a filename after an updater
// may have replaced that file while this process is still running old code.
const loadedMaintenanceSha256 = artifactSha256(fileURLToPath(import.meta.url));
export function maintenanceArtifactSha256(profile: InstallationProfile): string {
  const actual = artifactSha256(join(profile.newPackageRoot, "dist/maintenance/cli.mjs"));
  if (loadedMaintenanceSha256 !== actual) throw new Error("E_RETAINED_MAINTENANCE_EXECUTABLE_CHANGED");
  return actual;
}
export function piRuntimeSha256(profile: InstallationProfile): string {
  return digest(
    json(
      [profile.piCli, join(dirname(profile.piCli), "index.js"), join(dirname(profile.piCli), "../package.json")].map(
        (path) => ({ path, sha256: artifactSha256(path) }),
      ),
    ),
  );
}
export function readPublicationChain(directory: HeldDirectory): PublicationChain {
  const floorFile = directory.read("floor.json", 16384),
    floor = shape<Static<typeof floorSchema>>(floorSchema, parse(floorFile.bytes));
  const names = directory.names().filter((name) => name.includes("publication"));
  if (names.some((name) => !/^publication-\d{4}-(prepared|complete)\.json$/.test(name)))
    throw new Error("E_RETAINED_PUBLICATION_PARTIAL");
  const pins: CapturedFile[] = [floorFile];
  let previous: string | null = null,
    last: PublicationChain["last"];
  for (let sequence = 1; sequence <= 64; sequence++) {
    const prefix = `publication-${String(sequence).padStart(4, "0")}`,
      name = `${prefix}-prepared.json`;
    if (!names.includes(name)) {
      if (names.some((n) => n.startsWith(prefix)) || names.some((n) => Number(n.slice(12, 16)) > sequence))
        throw new Error("E_RETAINED_PUBLICATION_CHAIN_GAP");
      break;
    }
    const preparedFile = directory.read(name, 8192),
      prepared = shape<PublicationPrepared>(preparedSchema, parse(preparedFile.bytes));
    pins.push(preparedFile);
    if (
      prepared.sequence !== sequence ||
      prepared.operationId !== floor.operationId ||
      prepared.floorSha256 !== digest(floorFile.bytes) ||
      prepared.previousCompletionSha256 !== previous
    )
      throw new Error("E_RETAINED_PUBLICATION_CHAIN_CHANGED");
    const completionName = `${prefix}-complete.json`;
    if (!names.includes(completionName)) {
      if (names.some((n) => Number(n.slice(12, 16)) > sequence)) throw new Error("E_RETAINED_PUBLICATION_CHAIN_GAP");
      last = { prepared, preparedFile };
      break;
    }
    const completionFile = directory.read(completionName, 2048),
      completion = shape<Static<typeof completeSchema>>(completeSchema, parse(completionFile.bytes));
    pins.push(completionFile);
    if (
      completion.preparedSha256 !== digest(preparedFile.bytes) ||
      completion.loadedEntry !== join(prepared.mode === "new" ? floor.newPackageRoot : floor.oldPackageRoot, "index.ts")
    )
      throw new Error("E_RETAINED_PUBLICATION_COMPLETION_CHANGED");
    previous = digest(completionFile.bytes);
    last = { prepared, preparedFile, completionFile };
  }
  const verify = () => {
    for (const pin of pins) directory.verify(pin);
    if (JSON.stringify(directory.names().filter((name) => name.includes("publication"))) !== JSON.stringify(names))
      throw new Error("E_RETAINED_PUBLICATION_CHANGED");
  };
  verify();
  return {
    floor,
    floorFile,
    ...(last ? { last } : {}),
    verify,
    proveDurable(guard) {
      verify();
      for (const pin of pins) {
        guard();
        directory.syncFile(pin);
        guard();
      }
      directory.sync();
      guard();
      verify();
    },
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("E_RETAINED_SETTINGS_SHAPE");
  return value as Record<string, unknown>;
}
export function targetSettings(
  profile: InstallationProfile,
  mode: "new" | "old-off",
  settings: CapturedFile,
  toolkit: CapturedFile,
): { settings: Buffer; toolkit: Buffer } {
  const s = structuredClone(object(parse(settings.bytes))),
    t = structuredClone(object(parse(toolkit.bytes)));
  if (
    !Array.isArray(s.packages) ||
    s.packages.length !== 1 ||
    ![profile.oldPackageRoot, profile.newPackageRoot].includes(String(s.packages[0])) ||
    (s.extensions !== undefined && (!Array.isArray(s.extensions) || s.extensions.length !== 0))
  )
    throw new Error("E_RETAINED_PACKAGE_BINDING_UNKNOWN");
  const webHub = object(t.webHub),
    terminal = object(webHub.terminal);
  if (webHub.enabled !== true || (webHub.nodeLoader !== undefined && webHub.nodeLoader !== ""))
    throw new Error("E_RETAINED_LOADER_BINDING_UNKNOWN");
  s.packages = [mode === "new" ? profile.newPackageRoot : profile.oldPackageRoot];
  terminal.enabled = mode === "new";
  return { settings: json(s), toolkit: json(t) };
}
export function assertPublicationBinding(
  profile: InstallationProfile,
  mode: "new" | "old-off",
  settings: CapturedFile,
  toolkit: CapturedFile,
): void {
  const target = targetSettings(profile, mode, settings, toolkit);
  // Semantics, not unrelated settings formatting, are the running admission gate.
  if (
    JSON.stringify(parse(target.settings)) !== JSON.stringify(parse(settings.bytes)) ||
    JSON.stringify(parse(target.toolkit)) !== JSON.stringify(parse(toolkit.bytes))
  )
    throw new Error("E_RETAINED_PUBLICATION_BINDING_CHANGED");
}
function replaceSettings(dir: HeldDirectory, name: string, before: CapturedFile, after: Buffer, guard: () => void) {
  if (before.bytes.equals(after)) return;
  guard();
  dir.verify(before);
  const temp = dir.create(`.pending-${name}`, after);
  guard();
  dir.verify(before);
  dir.verify(temp);
  // No await between exact original CAS and rename; no auth or old resource file is restored.
  renameRetained(dir, name, before, temp, guard);
}
import { renameSync } from "node:fs";
function renameRetained(dir: HeldDirectory, name: string, before: CapturedFile, temp: CapturedFile, guard: () => void) {
  guard();
  dir.verify(before);
  dir.verify(temp);
  renameSync(dir.at(temp.name), dir.at(name));
  dir.sync();
  guard();
  const result = dir.read(name, temp.bytes.length);
  if (
    result.fingerprint.dev !== temp.fingerprint.dev ||
    result.fingerprint.ino !== temp.fingerprint.ino ||
    !result.bytes.equals(temp.bytes)
  )
    throw new Error("E_RETAINED_SETTINGS_CHANGED");
}
export interface RetainedPublicationHooks {
  /** Internal owned fault fixture ONLY, after actual config fsync and before probe. */
  beforePackageLoad?(): void;
}
export async function publishRetained(
  lease: ExistingInstallationLease,
  initialization: RetainedInitializationResult,
  mode: "new" | "old-off",
  deadline: number,
  hooks: RetainedPublicationHooks = {},
) {
  lease.revalidate();
  const { directory, profile } = lease,
    guard = () => lease.guard();
  const expectedFloor = {
    v: 1,
    kind: "terminal-v2-retained-floor",
    operationId: initialization.operationId,
    sourceInstallationId: initialization.sourceInstallationId,
    sourceManifestSha256: initialization.sourceManifestSha256,
    newSourceSha256: lease.newSource.sha256,
    maintenanceSha256: maintenanceArtifactSha256(profile),
    piRuntimeSha256: piRuntimeSha256(profile),
    stateDir: profile.stateDir,
    agentDir: profile.agentDir,
    piCli: profile.piCli,
    newPackageRoot: profile.newPackageRoot,
    oldPackageRoot: profile.oldPackageRoot,
    initialMode: directory.absent("floor.json") ? mode : readPublicationChain(directory).floor.initialMode,
  };
  if (directory.absent("floor.json")) {
    if (directory.names().some((n) => n.includes("publication"))) throw new Error("E_RETAINED_FLOOR_MISSING");
    publishRetainedFile(directory, "floor.json", json(expectedFloor), guard);
  }
  let chain = readPublicationChain(directory);
  if (!chain.floorFile.bytes.equals(json(expectedFloor))) throw new Error("E_RETAINED_FLOOR_CHANGED");
  const agent = new HeldDirectory(profile.agentDir);
  try {
    if (!agent.absent("pi-subagent.json")) throw new Error("E_RETAINED_LEGACY_SETTINGS_REVIEW");
    let settings = agent.read("settings.json", 1048576),
      toolkit = agent.read("pi-toolkit.json", 1048576);
    let target = targetSettings(profile, mode, settings, toolkit);
    const previous = chain.last;
    if (previous?.completionFile && previous.prepared.mode === mode) {
      assertPublicationBinding(profile, mode, settings, toolkit);
      chain.proveDurable(guard);
      lease.revalidate();
      return {
        phase: "publication-complete" as const,
        mode,
        sequence: previous.prepared.sequence,
        outcome: "already-complete" as const,
      };
    }
    if (previous && !previous.completionFile && previous.prepared.mode !== mode)
      throw new Error("E_RETAINED_PUBLICATION_PENDING_OTHER_MODE");
    let prepared = previous && !previous.completionFile ? previous.prepared : undefined;
    if (!prepared) {
      const sequence = (previous?.prepared.sequence ?? 0) + 1;
      if (sequence > 64) throw new Error("E_RETAINED_PUBLICATION_CAPACITY");
      prepared = {
        v: 1,
        kind: "terminal-publication-prepared",
        sequence,
        operationId: initialization.operationId,
        floorSha256: digest(chain.floorFile.bytes),
        mode,
        previousCompletionSha256: previous?.completionFile ? digest(previous.completionFile.bytes) : null,
        settingsBeforeSha256: digest(settings.bytes),
        settingsAfterSha256: digest(target.settings),
        toolkitBeforeSha256: digest(toolkit.bytes),
        toolkitAfterSha256: digest(target.toolkit),
      };
      publishRetainedFile(
        directory,
        `publication-${String(sequence).padStart(4, "0")}-prepared.json`,
        json(prepared),
        guard,
      );
      chain = readPublicationChain(directory);
    }
    if (
      ![prepared.settingsBeforeSha256, prepared.settingsAfterSha256].includes(digest(settings.bytes)) ||
      ![prepared.toolkitBeforeSha256, prepared.toolkitAfterSha256].includes(digest(toolkit.bytes)) ||
      digest(target.settings) !== prepared.settingsAfterSha256 ||
      digest(target.toolkit) !== prepared.toolkitAfterSha256
    )
      throw new Error("E_RETAINED_PUBLICATION_SOURCE_CHANGED");
    guard();
    chain.verify();
    replaceSettings(agent, "settings.json", settings, target.settings, guard);
    replaceSettings(agent, "pi-toolkit.json", toolkit, target.toolkit, guard);
    settings = agent.read("settings.json", 1048576);
    toolkit = agent.read("pi-toolkit.json", 1048576);
    assertPublicationBinding(profile, mode, settings, toolkit);
    agent.syncFile(settings);
    agent.syncFile(toolkit);
    agent.sync();
    guard();
    chain.verify();
    lease.revalidate();
    hooks.beforePackageLoad?.();
    const loaded = await verifySelectedPackageLoad(lease, mode, deadline);
    const source = captureTerminalSource(lease.state, guard);
    try {
      if (source.manifestSha256 !== initialization.sourceManifestSha256)
        throw new Error("E_RETAINED_SOURCE_CHANGED_DURING_PUBLICATION");
      source.verify();
    } finally {
      source.close();
    }
    guard();
    chain.verify();
    agent.verify(settings);
    agent.verify(toolkit);
    const complete = publishRetainedFile(
      directory,
      `publication-${String(prepared.sequence).padStart(4, "0")}-complete.json`,
      json({
        v: 1,
        kind: "terminal-publication-complete",
        preparedSha256: digest(chain.last!.preparedFile.bytes),
        loadedEntry: loaded.entry,
        packageLoadSha256: loaded.sha256,
      }),
      guard,
    );
    directory.sync();
    guard();
    agent.verify(settings);
    agent.verify(toolkit);
    directory.verify(complete);
    readPublicationChain(directory).verify();
    lease.revalidate();
    return { phase: "publication-complete" as const, mode, sequence: prepared.sequence, outcome: "committed" as const };
  } finally {
    agent.close();
  }
}
