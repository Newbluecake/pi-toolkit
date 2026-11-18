/** Recover ONLY a socket this fixed maintenance tool itself bound and durably
 * identified. Never unlinks an original O/N hub socket, witness or resource file.
 * PID absence is used ONLY for this maintenance writer, NEVER to retire debt.
 * Same-uid trusted operational record, not a defence against handwritten forgery. */
import { lstatSync, readFileSync, readlinkSync, renameSync, unlinkSync } from "node:fs";
import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HeldDirectory, digest, json, parse, type CapturedFile } from "../terminal-v2-maintenance/files.js";
import { publishRetainedFile } from "./durable.js";
const closed = <T extends TProperties>(p: T) => Type.Object(p, { additionalProperties: false });
const num = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const schema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("retained-maintenance-socket-owner"),
  profileSha256: hash,
  newSourceSha256: hash,
  state: closed({ path: text, dev: num, ino: num }),
  socket: closed({
    path: text,
    dev: num,
    ino: num,
    ctimeMs: Type.Number(),
    mtimeMs: Type.Number(),
    uid: num,
    mode: num,
  }),
  process: closed({
    bootId: text,
    pid: Type.Integer({ minimum: 1 }),
    starttime: Type.String({ pattern: "^[0-9]{1,32}$" }),
    uid: num,
  }),
  namespaces: closed({ pid: text, mnt: text, user: text }),
});
type Record = Static<typeof schema>;
function starttime(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
    value = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/)[19];
  if (!value || !/^\d{1,32}$/.test(value)) throw new Error("E_RETAINED_MAINTENANCE_PROCESS_UNKNOWN");
  return value;
}
function boot() {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new Error("E_RETAINED_MAINTENANCE_BOOT_UNKNOWN");
  return value;
}
const namespaces = () => ({
  pid: readlinkSync("/proc/self/ns/pid"),
  mnt: readlinkSync("/proc/self/ns/mnt"),
  user: readlinkSync("/proc/self/ns/user"),
});
function socket(path: string) {
  const s = lstatSync(path);
  if (!s.isSocket() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600)
    throw new Error("E_RETAINED_SOCKET_NOT_TOOL_OWNED");
  return { path, dev: s.dev, ino: s.ino, ctimeMs: s.ctimeMs, mtimeMs: s.mtimeMs, uid: s.uid, mode: s.mode };
}
export function recoverMaintenanceSocket(input: {
  directory: HeldDirectory;
  state: HeldDirectory;
  socketDir: HeldDirectory;
  socketPath: string;
  profileFile: CapturedFile;
  newSourceSha256: string;
  guard(): void;
}) {
  const { directory, state, socketDir, socketPath, profileFile, newSourceSha256, guard } = input;
  guard();
  if (directory.absent("maintenance-socket-owner.json")) throw new Error("E_RETAINED_ORIGINAL_SOCKET_PRESENT");
  const recordFile = directory.read("maintenance-socket-owner.json", 16384),
    raw = parse(recordFile.bytes);
  if (!Value.Check(schema, raw)) throw new Error("E_RETAINED_MAINTENANCE_SOCKET_RECORD");
  const record = raw;
  if (
    record.profileSha256 !== digest(profileFile.bytes) ||
    record.newSourceSha256 !== newSourceSha256 ||
    record.state.path !== state.path ||
    record.state.dev !== state.identity.dev ||
    record.state.ino !== state.identity.ino ||
    record.socket.path !== socketPath ||
    JSON.stringify(record.namespaces) !== JSON.stringify(namespaces()) ||
    record.process.bootId !== boot() ||
    JSON.stringify(record.socket) !== JSON.stringify(socket(socketPath))
  )
    throw new Error("E_RETAINED_SOCKET_NOT_TOOL_OWNED");
  try {
    if (
      lstatSync(`/proc/${record.process.pid}`).uid === record.process.uid &&
      starttime(record.process.pid) === record.process.starttime
    )
      throw new Error("E_RETAINED_MAINTENANCE_PROCESS_ALIVE");
  } catch (e) {
    if (!["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
  guard();
  directory.verify(recordFile);
  socketDir.check();
  if (JSON.stringify(record.socket) !== JSON.stringify(socket(socketPath)))
    throw new Error("E_RETAINED_SOCKET_NOT_TOOL_OWNED");
  unlinkSync(socketPath);
  socketDir.sync();
  guard();
}
export function recordMaintenanceSocket(input: {
  directory: HeldDirectory;
  state: HeldDirectory;
  socketPath: string;
  profileFile: CapturedFile;
  newSourceSha256: string;
  guard(): void;
}): CapturedFile {
  const { directory, state, socketPath, profileFile, newSourceSha256, guard } = input;
  const record: Record = {
    v: 1,
    kind: "retained-maintenance-socket-owner",
    profileSha256: digest(profileFile.bytes),
    newSourceSha256,
    state: { path: state.path, dev: state.identity.dev, ino: state.identity.ino },
    socket: socket(socketPath),
    process: { bootId: boot(), pid: process.pid, starttime: starttime(process.pid), uid: process.getuid!() },
    namespaces: namespaces(),
  };
  const bytes = json(record);
  guard();
  if (directory.absent("maintenance-socket-owner.json"))
    return publishRetainedFile(directory, "maintenance-socket-owner.json", bytes, guard);
  const prior = directory.read("maintenance-socket-owner.json", 16384);
  if (!Value.Check(schema, parse(prior.bytes))) throw new Error("E_RETAINED_MAINTENANCE_SOCKET_RECORD");
  const temp = directory.create(".pending-maintenance-socket-owner.json", bytes);
  guard();
  directory.verify(prior);
  directory.verify(temp);
  renameSync(directory.at(temp.name), directory.at(prior.name));
  directory.sync();
  guard();
  const result = directory.read(prior.name, 16384);
  if (
    result.fingerprint.dev !== temp.fingerprint.dev ||
    result.fingerprint.ino !== temp.fingerprint.ino ||
    !result.bytes.equals(bytes)
  )
    throw new Error("E_RETAINED_MAINTENANCE_SOCKET_CHANGED");
  directory.verify(result);
  guard();
  return result;
}
