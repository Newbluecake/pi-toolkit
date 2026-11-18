#!/usr/bin/env node
/** Fixed existing-installation entry. No default HOME/state, arbitrary adapters,
 * drain flags, source-module loader, force/reset or implicit install. */
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { HeldDirectory, exactKeys, parse } from "../terminal-v2-maintenance/files.js";
import { acquireExistingInstallation, InstallationProfileSchema } from "./installation.js";
import { initializeRetained } from "./engine.js";
import { publishRetained, readPublicationChain, type RetainedPublicationHooks } from "./publication.js";
import { launchRetained } from "./launch.js";
export const RETAINED_USAGE = `pi-terminal-maint retained-preflight --installation I --state S
pi-terminal-maint retained-initialize --installation I --state S --evidence E
pi-terminal-maint publish-new --installation I --expect-operation O
pi-terminal-maint resume --installation I --state S --operation O
pi-terminal-maint rollback-inspect --installation I --state S
pi-terminal-maint publish-old-off --installation I --expect-operation O
Existing fixed O7239, plain Linux, Node22. Explicit physical paths only. Seals actual configured launchers, checks original producers/singleton and backs up ONLY terminal sources. Unknown remains charged; no reboot/gone/attach/reset/credential restore. Initialization and publication are separate durable phases; old terminal-ON is never authorized.`;
function options(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i],
      value = args[i + 1];
    if (!name || !value || !name.startsWith("--") || result.has(name) || value.startsWith("--"))
      throw new Error("E_RETAINED_USAGE");
    result.set(name, value);
  }
  return result;
}
function operation(directory: HeldDirectory) {
  const value = parse(directory.read("source-prepared.json", 16384).bytes);
  if (
    !exactKeys(value, [
      "v",
      "kind",
      "operationId",
      "installationSha256",
      "sourceManifestSha256",
      "state",
      "evidencePath",
    ]) ||
    value.v !== 1 ||
    value.kind !== "retained-source-pinned" ||
    typeof value.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{32,64}$/.test(value.operationId) ||
    typeof value.evidencePath !== "string"
  )
    throw new Error("E_RETAINED_PREPARATION_SHAPE");
  return { operationId: value.operationId, evidencePath: value.evidencePath };
}
function selectedState(installation: string): string {
  const directory = new HeldDirectory(installation);
  try {
    const value = parse(directory.read("profile.json", 32768).bytes);
    if (!Value.Check(InstallationProfileSchema, value)) throw new Error("E_RETAINED_INSTALLATION_PROFILE");
    return value.stateDir;
  } finally {
    directory.close();
  }
}
interface CliResult {
  exitCode: number;
  message: string;
}
async function execute(args: readonly string[], hooks: RetainedPublicationHooks): Promise<CliResult> {
  if (args[0] === "launch") {
    if (args[1] !== "--installation" || !args[2] || args[3] !== "--") throw new Error("E_RETAINED_USAGE");
    return { exitCode: await launchRetained(args[2], args.slice(4)), message: "" };
  }
  const command = args[0],
    publishing = command === "publish-new" || command === "publish-old-off";
  if (
    ![
      "retained-preflight",
      "retained-initialize",
      "resume",
      "publish-new",
      "publish-old-off",
      "rollback-inspect",
    ].includes(command ?? "")
  )
    throw new Error("E_RETAINED_USAGE");
  const parsed = options(args.slice(1)),
    installation = parsed.get("--installation");
  const required = publishing
    ? ["--installation", "--expect-operation"]
    : command === "retained-initialize"
      ? ["--installation", "--state", "--evidence"]
      : command === "resume"
        ? ["--installation", "--state", "--operation"]
        : ["--installation", "--state"];
  if (!installation || parsed.size !== required.length || required.some((key) => !parsed.has(key)))
    throw new Error("E_RETAINED_USAGE");
  const state = publishing ? selectedState(installation) : parsed.get("--state")!,
    deadline = Date.now() + 30000;
  const lease = await acquireExistingInstallation(installation, state, deadline);
  let evidence: HeldDirectory | undefined;
  try {
    lease.revalidate();
    if (command === "retained-preflight")
      return {
        exitCode: 0,
        message: JSON.stringify({
          phase: "preflight-complete",
          initialization: "not-performed",
          publication: "not-performed",
          oldSourceSha256: lease.oldSource.sha256,
          newSourceSha256: lease.newSource.sha256,
        }),
      };
    let evidencePath = parsed.get("--evidence");
    if (command !== "retained-initialize") {
      const saved = operation(lease.directory),
        expected = parsed.get(publishing ? "--expect-operation" : "--operation");
      if (command !== "rollback-inspect" && saved.operationId !== expected)
        throw new Error("E_RETAINED_OPERATION_MISMATCH");
      evidencePath = saved.evidencePath;
    }
    evidence = new HeldDirectory(evidencePath!);
    if ((publishing || command === "rollback-inspect") && evidence.absent("initialization-complete.json"))
      throw new Error("E_RETAINED_INITIALIZATION_NOT_COMPLETE");
    if (command !== "rollback-inspect") lease.sealEntries();
    const result = initializeRetained({
      state: lease.state,
      installation: lease.directory,
      evidence,
      guard: lease.guard,
    });
    lease.revalidate();
    if (command === "rollback-inspect")
      return {
        exitCode: 0,
        message: JSON.stringify({
          operationId: result.operationId,
          oldTerminalOnAllowed: false,
          reason: "retained-original-v1-not-clean",
          legacyObligations: result.legacyObligations,
          normalAllocations: result.normalAllocations,
          permittedPublication: "old-off-only",
        }),
      };
    if (publishing) {
      const published = await publishRetained(
        lease,
        result,
        command === "publish-new" ? "new" : "old-off",
        deadline,
        hooks,
      );
      return { exitCode: 0, message: JSON.stringify({ ...result, ...published }) };
    }
    if (command === "resume" && !lease.directory.absent("floor.json")) {
      const chain = readPublicationChain(lease.directory),
        mode = chain.last?.prepared.mode ?? chain.floor.initialMode;
      const published = await publishRetained(lease, result, mode, deadline, hooks);
      return { exitCode: 0, message: JSON.stringify({ ...result, ...published }) };
    }
    return { exitCode: 0, message: JSON.stringify(result) };
  } finally {
    evidence?.close();
    await lease.release();
  }
}
export async function retainedCli(args: readonly string[], hooks: RetainedPublicationHooks = {}): Promise<CliResult> {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, message: RETAINED_USAGE };
  try {
    return await execute(args, hooks);
  } catch (error) {
    const message = error instanceof Error ? error.message : "",
      code = /^E_[A-Z0-9_]+/.exec(message)?.[0] ?? "E_RETAINED_MAINTENANCE_UNKNOWN";
    return {
      exitCode: code === "E_RETAINED_USAGE" ? 64 : 1,
      message:
        code === "E_RETAINED_USAGE"
          ? RETAINED_USAGE
          : JSON.stringify({ error: code, effect: "unknown", evidenceRetained: true }),
    };
  }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const result = await retainedCli(process.argv.slice(2));
  if (result.message) console.log(result.message);
  process.exitCode = result.exitCode;
}
