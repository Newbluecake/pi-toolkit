/**
 * #39 P3a hub slot: the single effective-path seam and the read-only identity check
 * (arch.md §3.4, §6.4). P3b/P4 own the production entry points; this kernel is what they
 * will call.
 *
 * - `resolveHubSlot` mirrors `src/web-hub/agent/index.ts:610-618` EXACTLY through the SAME
 *   `resolveHubPaths` formula (imported, never re-implemented): `deps.paths` wins, else
 *   `launchHome ?? (HOME non-empty ? HOME : homedir())`. cwd / ARMORY_MEMORY_ROOT /
 *   PI_CODING_AGENT_DIR never participate, so every cwd of one Hub resolves ONE slot
 *   (task A06). Pinned by P0 `contracts.test.ts` C5 at this exact composition seam.
 * - `checkHubSlot` is PURE READ-ONLY: no mkdir, no write, no item-body read. A slot whose
 *   stateDir/hub-memory/blocks is a symlink or not a directory, whose namespace identity
 *   (uid / realpath / dev / ino / host) disagrees with the slot, or which is half-created
 *   (namespace without blocks or the reverse) is INERT — the caller must not read items
 *   and must not write; repair is the user's `/mem hub adopt` action (P3b), never automatic.
 *
 * FS access goes ONLY through `../safe-fs.js` primitives (tests/memory/fs-guard.test.ts:
 * no `node:fs` import anywhere under src/memory except safe-fs). Directory metadata is
 * read without listing: stateDir must belong to slot.uid; hub-memory/blocks must also
 * have no group/other permission bits. Existing directories are NEVER chmod'd.
 *
 * Pi-free; no module-scope mutable state (I4); no timers (I5).
 */
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveHubPaths } from "../../web-hub/protocol/paths.js";
import { canonicalDir, inspectDirSecurityNoFollow, readRegular, statRegularIfExists } from "../safe-fs.js";
import type { EffectiveHubSlot } from "./types.js";
import { isMemoryTimestamp, readUntrustedValue, type RawRecord } from "./limits.js";

export interface HubSlotEnvLike {
  readonly HOME?: string;
  readonly XDG_RUNTIME_DIR?: string;
}

export interface HubSlotDeps {
  /** WebHub's own resolved paths (assembly passes the SAME object it used). Wins over home. */
  readonly paths?: { readonly stateDir: string };
  /** Explicit test/sandbox seam (WebHub `deps.launchHome`). */
  readonly launchHome?: string;
  readonly env?: HubSlotEnvLike;
  readonly homedir?: () => string;
  readonly getuid?: () => number;
  /** Recorded verbatim; default: "web-hub" iff a paths override was injected. */
  readonly source?: "web-hub" | "default-slot";
}

/** Same precedence as wireWebHub: paths ?? resolveHubPaths(launchHome ?? HOME-nonempty ?? homedir()). */
export function resolveHubSlot(deps: HubSlotDeps): EffectiveHubSlot {
  const env = deps.env ?? {};
  const uid = (deps.getuid ?? (() => process.getuid?.() ?? 0))();
  const home = deps.launchHome ?? (env.HOME !== undefined && env.HOME !== "" ? env.HOME : (deps.homedir ?? homedir)());
  const paths =
    deps.paths ??
    resolveHubPaths({
      home,
      uid,
      xdgRuntimeDir: env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== "" ? env.XDG_RUNTIME_DIR : undefined,
    });
  return {
    effectiveStateDir: paths.stateDir,
    uid,
    source: deps.source ?? (deps.paths !== undefined ? "web-hub" : "default-slot"),
  };
}

/** Minimal slot identity every hub-slot/hub-store entry point accepts (cwd never part of it). */
export interface HubSlotRef {
  readonly effectiveStateDir: string;
  readonly uid: number;
}

/** `<effectiveStateDir>/hub-memory` — the hub store root (arch §3.4 file table). */
export const hubMemoryRoot = (slot: HubSlotRef): string => join(slot.effectiveStateDir, "hub-memory");

// ───────────────────────── read-only slot policy/identity check ─────────────────────────

export interface HubDirIdentity {
  readonly uid: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
}

export interface HubFileIdentity {
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
}

/** All fs access of this module funnels through here (tests inject counters/fakes). */
export interface HubSlotIo {
  /** undefined = ENOENT; "not-dir" = symlink or not a real directory. */
  inspectDir(path: string): HubDirIdentity | "not-dir" | undefined;
  /** undefined = ENOENT; "not-file" = symlink or not a regular file. */
  statFile(path: string): HubFileIdentity | "not-file" | undefined;
  /** undefined = missing/unresolvable; only called after the policy checks passed. */
  realpath(path: string): string | undefined;
  /** namespace/items/audit reads; throws on missing (callers gate on statFile first). */
  readUtf8File(path: string): string;
}

const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Real-fs default over safe-fs primitives only (fs-guard clean). */
export const defaultIo: HubSlotIo = {
  inspectDir(path) {
    try {
      return inspectDirSecurityNoFollow(path);
    } catch (err) {
      if (isEnoent(err)) return undefined;
      // inspectDirSecurityNoFollow throws MemoryError for symlinks / non-directories.
      return "not-dir";
    }
  },
  statFile(path) {
    try {
      const st = statRegularIfExists(dirname(path), basename(path));
      return st === undefined ? undefined : { mode: st.mode, dev: st.dev, ino: st.ino };
    } catch {
      return "not-file"; // symlink / not a regular file (safe-fs refuses both)
    }
  },
  realpath(path) {
    return canonicalDir(path)?.real;
  },
  readUtf8File(path) {
    return readRegular(dirname(path), basename(path)).text;
  },
};

export interface HubNamespaceV1 {
  readonly v: 1;
  readonly uid: number;
  readonly stateDirReal: string;
  readonly stateDev: number;
  readonly stateIno: number;
  readonly host: string;
  readonly createdAt: string;
}

export type HubSlotCheck = "absent" | "ok" | { readonly inert: string };

export interface CheckHubSlotOptions {
  /** This machine's hub host fingerprint (`hubHostFingerprint`); cross-host ⇒ inert. */
  readonly expectedHost?: string;
  readonly io?: HubSlotIo;
}

/** Parse namespace.json from untrusted bytes; undefined = corrupt (never throws). */
export function parseHubNamespace(text: string): HubNamespaceV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const shape = readUntrustedValue(parsed);
  if (!shape.ok || shape.value === null || typeof shape.value !== "object" || Array.isArray(shape.value))
    return undefined;
  const record = shape.value as RawRecord;
  const keys = Object.keys(record);
  if (keys.length !== 7) return undefined;
  if (record.v !== 1) return undefined;
  if (typeof record.uid !== "number" || !Number.isInteger(record.uid)) return undefined;
  if (
    typeof record.stateDirReal !== "string" ||
    typeof record.host !== "string" ||
    typeof record.createdAt !== "string"
  )
    return undefined;
  if (typeof record.stateDev !== "number" || !Number.isInteger(record.stateDev)) return undefined;
  if (typeof record.stateIno !== "number" || !Number.isInteger(record.stateIno)) return undefined;
  if (!isMemoryTimestamp(record.createdAt)) return undefined;
  if (!/^[a-f0-9]{16}$/.test(record.host)) return undefined;
  const { stateDirReal, host, createdAt } = record;
  return {
    v: 1,
    uid: record.uid,
    stateDirReal,
    stateDev: record.stateDev,
    stateIno: record.stateIno,
    host,
    createdAt,
  };
}

/**
 * Read-only verdict: "absent" (no store at all — first authorized write may create it),
 * "ok" (namespace identity matches this slot), or `{inert}` (fail closed: no item read,
 * no write; user adopt action required). Never creates anything, never reads item bodies.
 */
export function checkHubSlot(slot: HubSlotRef, opts: CheckHubSlotOptions = {}): HubSlotCheck {
  const io = opts.io ?? defaultIo;
  try {
    const stateSt = io.inspectDir(slot.effectiveStateDir);
    if (stateSt === undefined) return "absent";
    if (stateSt === "not-dir") return { inert: "state-dir-not-dir" };
    if (!dirSecurityMatches(stateSt, slot.uid, false)) return { inert: "state-dir-security" };
    const root = hubMemoryRoot(slot);
    const rootSt = io.inspectDir(root);
    if (rootSt === undefined) return "absent";
    if (rootSt === "not-dir") return { inert: "hub-memory-not-dir" };
    if (!dirSecurityMatches(rootSt, slot.uid)) return { inert: "hub-memory-security" };
    const nsSt = io.statFile(join(root, "namespace.json"));
    const blocksSt = io.inspectDir(join(root, "blocks"));
    if (nsSt === undefined && blocksSt === undefined) return "absent";
    if (nsSt === undefined) return { inert: "namespace-missing" };
    if (blocksSt === undefined) return { inert: "blocks-missing" };
    if (blocksSt === "not-dir") return { inert: "blocks-not-dir" };
    if (!dirSecurityMatches(blocksSt, slot.uid)) return { inert: "blocks-security" };
    if (nsSt === "not-file") return { inert: "namespace-not-file" };
    if ((nsSt.mode & 0o777) !== 0o600) return { inert: "namespace-mode" };
    const namespace = parseHubNamespace(io.readUtf8File(join(root, "namespace.json")));
    if (namespace === undefined) return { inert: "namespace-corrupt" };
    if (namespace.uid !== slot.uid) return { inert: "namespace-uid" };
    if (namespace.stateDev !== stateSt.dev || namespace.stateIno !== stateSt.ino)
      return { inert: "namespace-identity" };
    const real = io.realpath(slot.effectiveStateDir);
    if (real === undefined || namespace.stateDirReal !== real) return { inert: "namespace-identity" };
    if (opts.expectedHost !== undefined && namespace.host !== opts.expectedHost) return { inert: "host-mismatch" };
    return "ok";
  } catch {
    return { inert: "slot-check-failed" };
  }
}

/** Used by hub-store when stamping a fresh namespace; identity is re-derived, not trusted. */
export const hubNamespaceFile = "namespace.json";
export const hubItemsFile = "items.json";
export const hubAuditFile = "audit.jsonl";
export const hubBlocksDir = "blocks";

/** Missing or non-integral metadata fails closed, including injected/unsupported stats. */
export function dirSecurityMatches(st: HubDirIdentity, uid: number, privateMode = true): boolean {
  return (
    Number.isInteger(st.uid) &&
    st.uid === uid &&
    Number.isInteger(st.mode) &&
    Number.isInteger(st.dev) &&
    Number.isInteger(st.ino) &&
    (!privateMode || (st.mode & 0o077) === 0)
  );
}

/** P3c lock-await CAS. Read-only; includes absent optional directories and namespace
 * bytes as well as no-follow file identity. File uid is not part of safe-fs's API.
 * Directory uid/mode/devino are always mandatory; no repair/chmod is performed. */
export function captureHubSlotIdentity(slot: HubSlotRef, io: HubSlotIo = defaultIo): string {
  const root = hubMemoryRoot(slot);
  const dirs = [slot.effectiveStateDir, root, join(root, "blocks"), join(root, "blocks", ".trash")].map((path, i) => {
    const st = io.inspectDir(path);
    if (i >= 2 && st === undefined) return [path, null];
    if (!st || st === "not-dir" || !dirSecurityMatches(st, slot.uid, i !== 0))
      throw new Error("unsafe hub directory identity");
    return [path, st];
  });
  const path = join(root, "namespace.json");
  const st = io.statFile(path);
  if (st === "not-file" || (st && (st.mode & 0o777) !== 0o600)) throw new Error("unsafe hub namespace");
  const bytes = st ? io.readUtf8File(path) : null;
  const after = io.statFile(path);
  if (JSON.stringify(after) !== JSON.stringify(st)) throw new Error("hub namespace changed");
  return JSON.stringify({ slot, dirs, namespace: [st ?? null, bytes] });
}
