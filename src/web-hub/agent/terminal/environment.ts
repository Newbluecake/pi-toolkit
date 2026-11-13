/** pi→helper inheritance, r4 §5.3. This reduces accidental inheritance; it is NOT isolation. */
import { Value } from "@sinclair/typebox/value";
import { TerminalAgentDisplayMetadataSchema, type TerminalAgentDisplayMetadata } from "../../protocol/terminal.js";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const TERMINAL_ENV_BYTES = 32 * 1024;
const ALLOW = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TZ",
]);
const DENY = /API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE|BEARER/i;
const INJECT =
  /^(?:PI_|ARMORY_|BASH_FUNC_|LD_|DYLD_|PYTHON)|^(?:ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|PROMPT_COMMAND|PS4|NODE_OPTIONS|NODE_PATH|RUBYOPT|PERL5OPT|SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|DBUS_SESSION_BUS_ADDRESS|ZDOTDIR|XDG_CONFIG_HOME)$/i;
const CREDENTIAL =
  /:\/\/[^/\s]*@|-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|(?:^|\s)(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]+|AKIA[A-Z0-9]{16}|Bearer\s)/i;
export class TerminalBackendError extends Error {
  constructor(readonly code: "E_BACKEND_CAPABILITY" | "E_BAD_REQUEST" | "E_DEADLINE" | "E_LIMIT" | "E_UNKNOWN_EFFECT") {
    super(code); // Never include user values / underlying OS diagnostics.
  }
}

export function cleanTerminalEnvironment(source: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (DENY.test(key) || INJECT.test(key)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") continue;
    if (!ALLOW.has(key)) continue;
    if (value.includes("\0") || Buffer.byteLength(value) > 8192 || CREDENTIAL.test(value))
      throw new TerminalBackendError("E_BAD_REQUEST");
    if (key === "PATH" && !validTerminalPath(value)) throw new TerminalBackendError("E_BAD_REQUEST");
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
    if (bytes > TERMINAL_ENV_BYTES) throw new TerminalBackendError("E_BAD_REQUEST");
    out[key] = value;
  }
  out.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  // UID lookup belongs in the killable helper. Do not forward pi's HOME/user hints.
  delete out.HOME;
  delete out.USER;
  delete out.LOGNAME;
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return out;
}
export function validTerminalPath(value: string): boolean {
  return value.length > 0 && value.split(":").every((p) => isAbsolute(p) && !p.split("/").includes(".."));
}

/** Internal test-only seam. Never accepted from settings, HTTP, wire or env. Production
 * factory does not accept this record. A wrapper inside the scratch may exec the real shell. */
export interface TerminalTestFixture {
  root: string;
  uid: number;
  gid: number;
  home: string;
  cwd: string;
  shell: string;
  shellKind: "bash" | "zsh";
  rcFiles: string[];
  startDelayMs?: number;
  execDelayMs?: number;
}
export function assertTerminalFixture(f: TerminalTestFixture): void {
  const uid = process.getuid?.();
  const root = realpathSync(f.root);
  const s = lstatSync(f.root);
  if (
    uid === undefined ||
    f.uid !== uid ||
    f.gid !== process.getgid?.() ||
    s.uid !== uid ||
    !s.isDirectory() ||
    (s.mode & 0o777) !== 0o700 ||
    root !== resolve(f.root)
  )
    throw new TerminalBackendError("E_BAD_REQUEST");
  const inside = (path: string, directory = false): void => {
    const physical = realpathSync(path);
    const rel = relative(root, physical);
    const st = statSync(physical);
    if (
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      physical !== resolve(path) ||
      st.uid !== uid ||
      (directory ? !st.isDirectory() || (st.mode & 0o777) !== 0o700 : !st.isFile())
    )
      throw new TerminalBackendError("E_BAD_REQUEST");
  };
  inside(f.home, true);
  inside(f.cwd, true);
  inside(f.shell);
  if (!(statSync(f.shell).mode & 0o111)) throw new TerminalBackendError("E_BAD_REQUEST");
  for (const file of f.rcFiles) inside(file);
  // All native user startup candidates must be enumerated and checked, not just the happy rc.
  const required =
    f.shellKind === "bash"
      ? [".bash_profile", ".bash_login", ".profile", ".bashrc", ".bash_logout"]
      : [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];
  for (const file of required) inside(resolve(f.home, file));
}

/** Panel only. Invalid optional labels are omitted, never rewritten or truncated. */
export function terminalDisplayMetadata(raw: unknown, cwd: string): TerminalAgentDisplayMetadata {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const result: TerminalAgentDisplayMetadata = {};
  for (const key of ["shellName", "userLabel", "hostLabel", "cwd"] as const) {
    const value = key === "cwd" ? cwd : source[key];
    if (value !== undefined && Value.Check(TerminalAgentDisplayMetadataSchema, { [key]: value }))
      Object.assign(result, { [key]: value });
  }
  return result;
}
