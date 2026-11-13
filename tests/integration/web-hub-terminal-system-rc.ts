/** Test-only pre-exec audit: native system rc must not redirect the scratch HOME/ZDOTDIR.
 * System rc is trusted, not sandboxed; do not execute/source it to perform this check.
 * Symlinks to root-owned targets in /etc or /usr are normal distro packaging. Group 0 is treated
 * as administrative (like uid 0); write access by any other group/world is refused.
 * This is a mode/ownership check, not an ACL audit or protection from concurrent root edits. */
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";

interface SystemRcOptions {
  /** Unit tests substitute a private scratch filesystem; production /etc is never modified. */
  root?: string;
  files?: readonly string[];
  /** Unit-test scratch files belong to the test uid. Real system startup always requires uid 0. */
  ownerUid?: number;
}
const osCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "IO_ERROR";
};
const fail = (file: string, reason: string): never => {
  // Diagnostics contain paths/fixed reasons only, never rc contents or underlying error messages.
  throw new Error(`unsafe fixture system startup: ${file}: ${reason}`);
};
const inside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Returns the physical files audited, for unit assertions. Missing optional rc is fine;
 * dangling symlinks, unreadable inputs and discovery failures are not silently skipped. */
export function systemRcPreflight(options: SystemRcOptions = {}): string[] {
  const root = options.root ?? "/";
  const ownerUid = options.ownerUid ?? 0;
  const profileDir = join(root, "etc/profile.d");
  let files = options.files;
  if (!files) {
    let entries: string[];
    try {
      entries = readdirSync(profileDir);
    } catch (error) {
      if (osCode(error) !== "ENOENT") fail(profileDir, `cannot list startup directory (${osCode(error)})`);
      entries = [];
    }
    files = [
      "profile",
      "bashrc",
      "bash.bashrc",
      "zshenv",
      "zshrc",
      "zprofile",
      "zlogin",
      "zsh/zshenv",
      "zsh/zshrc",
      "zsh/zprofile",
      "zsh/zlogin",
      "locale.conf",
    ]
      .map((name) => join(root, "etc", name))
      .concat(entries.filter((f) => f.endsWith(".sh") || f === "sh.local").map((f) => join(profileDir, f)));
  }
  const audited: string[] = [];
  for (const file of files) {
    try {
      lstatSync(file); // Unlike existsSync, distinguishes missing optional rc from dangling symlinks.
    } catch (error) {
      if (osCode(error) === "ENOENT") continue;
      fail(file, `cannot inspect startup file (${osCode(error)})`);
    }
    let physical: string;
    try {
      physical = realpathSync(file);
    } catch (error) {
      fail(file, `cannot resolve startup file (${osCode(error)})`);
    }
    if (![join(root, "etc"), join(root, "usr")].some((dir) => inside(dir, physical)))
      fail(file, `resolved target outside trusted /etc or /usr: ${physical}`);
    let st: Stats;
    try {
      st = statSync(physical);
    } catch (error) {
      fail(file, `cannot stat resolved target (${osCode(error)})`);
    }
    if (!st.isFile()) fail(file, "resolved target is not a regular file");
    if (st.uid !== ownerUid) fail(file, "resolved target is not owned by trusted root uid");
    if (st.mode & 0o002) fail(file, "resolved target is world-writable");
    if (st.mode & 0o020 && st.gid !== 0) fail(file, "resolved target is writable by non-root group");
    let text: string;
    try {
      text = readFileSync(physical, "utf8");
    } catch (error) {
      fail(file, `cannot read startup file (${osCode(error)})`);
    }
    const code = text
      .split("\n")
      .filter((s) => !s.trim().startsWith("#"))
      .join("\n");
    if (/(?:^|[;\s])(?:export\s+)?(?:HOME|ZDOTDIR)\s*=|(?:unset|read)\s+(?:HOME|ZDOTDIR)/m.test(code))
      fail(file, "system startup redirects fixture HOME/ZDOTDIR: coverage refused before exec");
    audited.push(physical);
  }
  return audited;
}
