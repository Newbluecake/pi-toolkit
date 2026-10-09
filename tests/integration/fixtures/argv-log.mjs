/**
 * web-hub session-history plan §4.8 step 5 (RH fixtures): a `NODE_OPTIONS=--import` hook that
 * records every child process's REAL argv as one JSON line (`{pid, argv: process.argv.slice(2)}`)
 * into `$ARGV_LOG`. Exists because pi rewrites its cmdline (`process.title = "pi"`), so
 * `/proc/<pid>/cmdline` can never show a `--session` tail — the argv must be captured before
 * pi's own boot code runs. Node ≥ 20.6 (repo requires ≥22).
 */
import { appendFileSync } from "node:fs";
import process from "node:process";

const out = process.env["ARGV_LOG"];
if (out !== undefined && out !== "") {
  try {
    appendFileSync(out, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) })}\n`);
  } catch {
    /* best-effort — a missing/unwritable log never breaks the child */
  }
}
