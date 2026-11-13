/** Isolated real-PTY UID fixture, using the same pre-exec system-rc audit as P1-A. */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { assertTerminalFixture, type TerminalTestFixture } from "../../src/web-hub/agent/terminal/environment.js";
function systemRcPreflight(): void {
  const files = [
    "/etc/profile",
    "/etc/bashrc",
    "/etc/zshenv",
    "/etc/zshrc",
    "/etc/zprofile",
    "/etc/zlogin",
    "/etc/locale.conf",
    ...readdirSync("/etc/profile.d")
      .filter((f) => f.endsWith(".sh") || f === "sh.local")
      .map((f) => `/etc/profile.d/${f}`),
  ];
  for (const file of files.filter(existsSync)) {
    const st = lstatSync(file);
    if (!st.isFile() || st.mode & 0o022) throw new Error("unsafe fixture system startup");
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((s) => !s.trim().startsWith("#"))
      .join("\n");
    if (/(?:^|[;\s])(?:export\s+)?(?:HOME|ZDOTDIR)\s*=|(?:unset|read)\s+(?:HOME|ZDOTDIR)/m.test(code))
      throw new Error("system startup redirects fixture HOME: coverage refused before exec");
  }
}
export function makeTerminalFixture(): { fixture: TerminalTestFixture; cleanup(): void } {
  const kind = "bash";
  systemRcPreflight();
  const root = mkdtempSync(join(tmpdir(), "tp-"));
  chmodSync(root, 0o700);
  const home = join(root, "h"),
    cwd = join(root, "w");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  // No leftover optional init/history files can reference a real user path: fresh owned root.
  const names = [
    ".bash_profile",
    ".bash_login",
    ".profile",
    ".bashrc",
    ".bash_logout",
    ".zshenv",
    ".zprofile",
    ".zshrc",
    ".zlogin",
    ".zlogout",
  ];
  const rcFiles = names.map((n) => join(home, n));
  for (const file of rcFiles) writeFileSync(file, "", { mode: 0o600 });
  writeFileSync(
    join(home, ".bash_profile"),
    'export PROFILE_COUNT=$(( ${PROFILE_COUNT:-0} + 1 ))\n. "$HOME/.bashrc"\n',
  );
  writeFileSync(
    join(home, ".bashrc"),
    'export RC_COUNT=$(( ${RC_COUNT:-0} + 1 ))\nexport RC_API_KEY=from-fixture-rc\nPS1="fixture> "\nHISTFILE=/dev/null\nprintf "RC_READY\\n"\n',
  );
  writeFileSync(join(home, ".zprofile"), "export PROFILE_COUNT=$(( ${PROFILE_COUNT:-0} + 1 ))\n");
  writeFileSync(
    join(home, ".zshrc"),
    'export RC_COUNT=$(( ${RC_COUNT:-0} + 1 ))\nexport RC_API_KEY=from-fixture-rc\nPS1="fixture> "\nHISTFILE=/dev/null\nprintf "RC_READY\\n"\n',
  );
  const shell = join(root, kind);
  expect(existsSync(`/usr/bin/${kind}`), `real ${kind} required; no fallback/skip`).toBe(true);
  const binary = realpathSync(`/usr/bin/${kind}`);
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$HOME" = '${home}' ] || exit 123\nexport BASH_COMPLETION_VERSINFO=fixture-disabled\nexec '${binary}' "$@"\n`,
    { mode: 0o700 },
  );
  const f = {
    root,
    home,
    cwd,
    shell,
    shellKind: kind,
    uid: process.getuid!(),
    gid: process.getgid!(),
    rcFiles,
  };
  assertTerminalFixture(f);
  return { fixture: f, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
