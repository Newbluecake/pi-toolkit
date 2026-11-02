// Pure read-only command whitelist for the jev gate coarse filter
// (§6.4.1 step 2b). Motivation: read-only `git status`/`log`/`reflog`/
// `stash list` chains were the top gate false-positive shape (git-index
// race rules intercept them); a chain whose EVERY parsed segment is
// provably read-only passes the coarse filter synchronously — no runGate,
// no classifier call.
//
// Conservative by construction: anything not on the list ⇒ not exempt
// (the normal gate path is unchanged). The caller only invokes this on a
// fully-ok parse (`ok:false` falls back), with no redirect anywhere
// (`git status > /etc/x` writes — the tokenizer drops the redirect, so
// argv alone cannot prove read-only) and a non-empty command list.
// Unquoted command substitutions (`$( … )`, backticks) share the
// shell-parse sink, so their inner segments are judged too (`echo
// $(git commit)` is not exempt); substitutions inside DOUBLE quotes do
// not recurse — their `$(`/backtick residue survives in argv and rejects
// the whole chain (`git status "$(git commit)"` is not exempt either).
// Wrapper unwrapping (sudo/timeout/env/…) and git global-option stripping
// (`git -C x …`) already happened in shell-parse.
//
// Pi-free; no module-scope state (I4).

import type { SimpleCommand } from "./contracts.js";
import type { ParseShellResult } from "./shell-parse.js";

/** git subcommands that never write regardless of flags/args.
 *  `reflog` is special-cased below (`git reflog expire/delete` rewrite
 *  history); `stash`/`worktree`/`branch`/`tag`/`remote`/`config` have
 *  write forms and are narrowed to their list-only shapes. */
const GIT_SAFE_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "describe",
  "shortlog",
  "rev-parse",
  "ls-files",
  "version",
]);

/** `git branch` list-mode flags only — `-d/-D/-m/-M/-c/-C/-t/-f/-u/…` write,
 *  and a bare positional creates a branch, so positionals are rejected. */
const GIT_BRANCH_SAFE_FLAGS = new Set([
  "-l",
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "-q",
  "--quiet",
  "-i",
  "--ignore-case",
  "--show-current",
  "--no-color",
  "--color",
]);

const GIT_TAG_LIST_FLAGS = new Set(["-l", "--list"]);

/** Generic read-only programs. `env` never survives wrapper unwrapping
 *  (listed for completeness); `find`/`date`/`hostname` are guarded in
 *  `isReadOnlyCommand` because they carry write forms. */
const COMMON_READONLY_PROGRAMS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "ps",
  "env",
  "which",
  "whoami",
  "hostname",
  "date",
  "wc",
  "stat",
  "du",
  "df",
  "file",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "uname",
  "uptime",
  "free",
  "echo",
  "true",
  "false",
  "test",
]);

/** `find` primaries that write or execute: reject the whole command. */
const FIND_WRITE_ARGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0"]);

function isReadOnlyGitArgv(argv: readonly string[]): boolean {
  // shell-parse already stripped global options (`-C x`, `-c k=v`,
  // `--git-dir=…`, `--no-pager`, …) and normalized argv[0] to `git`.
  let i = argv[0] === "git" ? 1 : 0;
  if (argv[i] === "--") i++;
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (sub === undefined) return true; // bare `git` (e.g. after `--version` stripping)
  switch (sub) {
    case "reflog": {
      // `git reflog` / `-3` / `show` / `exists` read; `expire`/`delete`
      // rewrite; `--expire*` is expire-only — rejected even in flag position.
      const next = rest[0];
      return (
        (next === undefined || next === "show" || next === "exists" || next.startsWith("-")) &&
        !rest.some((a) => a.startsWith("--expire"))
      );
    }
    case "stash": // `git stash` alone pushes
    case "worktree":
      return rest[0] === "list";
    case "branch":
      return rest.every((a) => GIT_BRANCH_SAFE_FLAGS.has(a));
    case "tag":
      return (
        rest.length === 0 ||
        (rest.some((a) => GIT_TAG_LIST_FLAGS.has(a)) &&
          rest.every((a) => GIT_TAG_LIST_FLAGS.has(a) || !a.startsWith("-")))
      );
    case "remote":
      return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"));
    case "config":
      return (
        (rest[0] === "--get" || rest[0] === "-l" || rest[0] === "--list") &&
        rest.slice(1).every((a) => !a.startsWith("-"))
      );
    default:
      return GIT_SAFE_SUBCOMMANDS.has(sub);
  }
}

function isReadOnlyCommand(cmd: SimpleCommand): boolean {
  // Substitution residue: a `$(` or backtick that survived into a word —
  // it executes for real in a shell but never became a judged segment
  // (the tokenizer does not recurse into double quotes), so never exempt.
  if (cmd.argv.some((a) => a.includes("$(") || a.includes("`"))) return false;
  const program = cmd.program;
  if (program === "git") return isReadOnlyGitArgv(cmd.argv);
  if (program === "find") {
    return !cmd.argv.some((a) => FIND_WRITE_ARGS.has(a) || a.startsWith("-fprint"));
  }
  if (program === "date") {
    // `-s`/`--set` set the clock — and so does a bare operand (`date 0102030405`);
    // only `+FORMAT` display operands are safe.
    return (
      !cmd.argv.some((a) => a === "-s" || a === "--set" || a.startsWith("--set=")) &&
      cmd.positionals.every((p) => p.startsWith("+"))
    );
  }
  if (program === "hostname") {
    // a bare operand SETS the name; `-F`/`--file` set it from a file.
    return (
      cmd.positionals.length === 0 && !cmd.argv.some((a) => a === "-F" || a === "--file" || a.startsWith("--file="))
    );
  }
  return COMMON_READONLY_PROGRAMS.has(program);
}

/** True when the parse is fully ok, carries no redirect, and every parsed
 *  segment (command substitutions included — they run for real) is on the
 *  read-only whitelist. Conservative: any doubt ⇒ false. */
export function isPureReadonlyShell(res: ParseShellResult): boolean {
  if (!res.ok || res.hasRedirect || res.commands.length === 0) return false;
  return res.commands.every(isReadOnlyCommand);
}
