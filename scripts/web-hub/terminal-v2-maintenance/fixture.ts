/** Owned native-PTY environment for the authorized controlled build, not a
 * production shell/env override. No user rc, shell history or existing HOME is used.
 * Same pre-exec system-rc audit as the real backend gate; no /etc changes/sourcing.
 */
import { chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { TerminalTestFixture } from "../../../src/web-hub/hub/terminal/v2/environment.js";
import { systemRcPreflight } from "./system-rc.js";
import { HeldDirectory } from "./files.js";
import type { ControlledScope } from "./scope.js";
export function createOwnedFixture(scope: ControlledScope): TerminalTestFixture {
  scope.check();
  systemRcPreflight();
  const cwd = scope.directory.mkdir("cwd");
  const home = new HeldDirectory(scope.home);
  const rcFiles = [
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
  ].map((name) => {
    home.create(
      name,
      Buffer.from(
        name === ".bashrc"
          ? 'PS1="controlled> "\nHISTFILE=/dev/null\nprintf "TOOL_RC_READY\\n"\n'
          : name === ".bash_profile"
            ? '. "$HOME/.bashrc"\n'
            : "",
      ),
    );
    return join(home.path, name);
  });
  const shell = join(scope.directory.path, "bash"),
    binary = realpathSync("/usr/bin/bash");
  // Fixed native shell, not a caller-provided executable or arbitrary command input.
  scope.directory.create(
    "bash",
    Buffer.from(
      `#!/bin/sh\n[ "$HOME" = '${scope.home}' ] || exit 123\nexport BASH_COMPLETION_VERSINFO=fixture-disabled\nexec '${binary}' "$@"\n`,
    ),
  );
  chmodSync(shell, 0o700);
  home.sync();
  cwd.sync();
  scope.directory.sync();
  home.close();
  cwd.close();
  return Object.freeze({
    root: scope.directory.path,
    home: scope.home,
    cwd: cwd.path,
    shell,
    shellKind: "bash",
    uid: process.getuid!(),
    gid: process.getgid!(),
    rcFiles,
  });
}
