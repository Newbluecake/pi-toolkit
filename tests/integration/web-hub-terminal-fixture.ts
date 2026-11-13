/** Isolated real-PTY UID fixture, using the same pre-exec system-rc audit as P1-A. */
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { assertTerminalFixture, type TerminalTestFixture } from "../../src/web-hub/agent/terminal/environment.js";
import { systemRcPreflight } from "./web-hub-terminal-system-rc.js";

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
  assert(existsSync(`/usr/bin/${kind}`), `real ${kind} required; no fallback/skip`);
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
