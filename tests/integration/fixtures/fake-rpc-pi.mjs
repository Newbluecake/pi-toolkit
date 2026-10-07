#!/usr/bin/env node
/**
 * web-hub-spawn plan §SP13: a programmable fake `pi --mode rpc` child for the managed-spawn
 * integration tests (`tests/integration/web-hub-headless.test.ts`).
 *
 * The hub's supervisor forks it exactly like the real thing — `node <this-entry> --mode rpc`,
 * `detached` (own process group), cwd pinned via `/proc/self/fd/N`, env carrying
 * `PI_WEBHUB_HEADLESS=1` + `PI_WEBHUB_SPAWN_ID=<id>` — and this script plays BOTH halves of the
 * real child's role well enough to exercise the whole managed-spawn state machine with REAL
 * processes, REAL /proc identity (its own pid/starttime/pgrp/uid) and REAL timing:
 *
 *   agent half: connect `<HOME>/.pi/agent/web-hub/hub.sock`, send `hello{kind:"rpc"}` (own pid,
 *               `cwd: process.cwd()`, caps `cmd.v1`+`dialog.v1`), await `hello_ack`, then `session`.
 *   stdio half: speak pi's rpc-mode NDJSON on stdin/stdout — answer nothing on its own, echo
 *               `cmd` frames to ok results when `--cmd-echo` (logging every received cmd id to
 *               stderr so the tests can pin the `fp_<spawnId>` first-prompt delivery), report
 *               received `extension_ui_response` frames to stderr, exit on stdin EOF.
 *
 * `process.title = "pi"` mirrors the real cli (`dist/cli/setup.js` sets `process.title = APP_NAME`),
 * so `/proc/<pid>/cmdline` shows neither the script path nor `--mode` — the exact reason identity
 * verification (arch §7.4) never trusts cmdline.
 *
 * default-model plan (H9): the hub forks a FIXED PREFIX + an optional `--model <ref>` TAIL
 * (`<entry> --mode rpc [--model <ref>]`, two independent argv elements — never joined), so this
 * fake honors `--model` too:
 *   - `FAKE_ARGV_OUT=<path>` (env): write `process.argv` as JSON to that file, then continue.
 *   - `--model nosuch/<…>`: pi's startup model-rejection shape — print
 *     `Error: Model "nosuch/<…>" not found. Use --list-models to see available models.` to
 *     stderr and exit 1 BEFORE the socket half (the D5 delayed-verdict cells).
 *
 * web-hub-spawn-restore plan RS8: the restore fork's argv TAIL is a session coordinate, honored too:
 *   - `--session <abs file>`: read the file's header line (`{type:"session", id, cwd}`), report
 *     `sessionId = header.id` + `sessionFile = <file>` (a missing/garbage file ⇒ a fresh id, like
 *     pi's F22 "opens an empty session at that path").
 *   - `--session-id <id>`: report that id (no sessionFile — pi creates it lazily).
 *   - `--write-session` (switch): report `sessionFile = $HOME/.pi/agent/sessions/fake/<id>.jsonl`,
 *     write its header right after going live, then emit `status{busy:true}` → `status{busy:false}`
 *     (one completed "turn" — the hub's sessionPersisted evidence path).
 *   Argv is still dumped to `FAKE_ARGV_OUT` (default-model H9) and, per process, appended as one
 *   JSON line (`{pid, argv}`) to `<cwd>/.fake-pi-argv.log` (restore tests read every fork's argv).
 *
 * Switches (all optional):
 *   --ignore-eof           stdin EOF does NOT exit (orphan-kill tests)
 *   --ignore-term          SIGTERM does NOT exit (reaper/recovery KILL ladder)
 *   --no-hello             never connect/send hello (register-timeout test)
 *   --cmd-echo             answer `cmd` frames with ok results; log `CMD <id> …` to stderr
 *   --emit-ui select|confirm|editor|input
 *                          emit one regular `extension_ui_request` line (auto-cancel path)
 *   --emit-ui marker       emit ask_user's marker select AND a `dialogs` frame with one open
 *                          item (marker-hold path: must NOT be auto-cancelled while held)
 *   --emit-ui-huge select|confirm|editor
 *                          emit a 1 MiB single-line ui_request (over-limit head answer, #9)
 *   --emit-ui-bad-head     emit a 100 KiB line with the ui prefix but no extractable id
 *                          (protocol error ⇒ supervisor stops the child)
 *   --flood N              write N MiB of junk lines to stdout
 *   --stderr-flood N       write N MiB to stderr (stderr sink bounds, H6)
 *
 * Everything the tests assert on rides STDERR (which the hub tees into
 * `<stateDir>/spawn/<spawnId>.stderr.log`) or the socket. Startup line:
 *   FAKE-PI pid=<pid> umask=0oNNN cwd=<cwd>
 * Runtime markers: `UI-SENT <id> <ms>`, `UI-RESP <id> cancelled=<bool> <ms>`, `CMD <id> <op>`,
 * `SUPERSEDED`, `EOF-IGNORED`, `TERM-IGNORED`, `EXIT <code>`.
 */
import net from "node:net";
import process from "node:process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.title = "pi"; // real pi rewrites argv; cmdline must not leak "--mode" (arch §7.4)

const argv = process.argv.slice(2);
// Per-spawn switches: the hub forks a fixed-prefix argv (`<entry> --mode rpc` + the optional
// default-model `--model <ref>` tail), so behavior switches
// ride a file in the child's cwd (`.fake-pi-switches`, one switch per line) keyed by the test
// that created the directory — the hub-side argv/env stay byte-identical to production.
try {
  const fs = await import("node:fs");
  const switchFile = `${process.cwd()}/.fake-pi-switches`;
  if (fs.existsSync(switchFile)) {
    for (const line of fs.readFileSync(switchFile, "utf8").split("\n")) {
      const s = line.trim();
      if (s !== "" && !argv.includes(s)) argv.push(s);
    }
  }
} catch {
  /* unreadable switch file — run with argv switches only */
}
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

// default-model plan H9: dump the received argv (JSON) before anything else can exit.
try {
  const out = process.env.FAKE_ARGV_OUT;
  if (out) {
    const fs2 = await import("node:fs");
    fs2.writeFileSync(out, JSON.stringify(process.argv));
  }
} catch {
  /* argv dump is best-effort */
}
// web-hub-spawn-restore RS8: every fork's argv, one JSON line per process (cwd-local file so
// the hub's env stays byte-identical to production — the switch file pattern again).
try {
  const fs3 = await import("node:fs");
  fs3.appendFileSync(
    `${process.cwd()}/.fake-pi-argv.log`,
    `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) })}\n`,
  );
} catch {
  /* best-effort */
}

const log = (line) => {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* stderr gone — nothing to do */
  }
};

// default-model plan H9: the startup model-rejection shape (a `nosuch/*` provider can never
// resolve — pi prints `Error: Model "…" not found. …` and exits 1 before going live).
{
  const modelRef = valueOf("--model", "");
  if (modelRef.startsWith("nosuch/")) {
    log(`Error: Model "${modelRef}" not found. Use --list-models to see available models.`);
    process.exit(1);
  }
}

const now = () => Date.now();
const nonce = `fp${process.pid.toString(36).padStart(8, "0").slice(-8)}nonceAAAAAAAA`;
// web-hub-spawn-restore RS8: session coordinates from the restore argv tail (see header).
let sessionId = `sess-fake-${process.pid.toString(36)}`;
let sessionFile;
{
  const fs4 = await import("node:fs");
  const file = valueOf("--session", "");
  const byId = valueOf("--session-id", "");
  if (file !== "") {
    sessionFile = file;
    try {
      const header = JSON.parse(fs4.readFileSync(file, "utf8").split("\n")[0]);
      if (header && header.type === "session" && typeof header.id === "string") sessionId = header.id;
    } catch {
      /* missing/garbage file: pi opens an empty session at that path (F22) — fresh id */
    }
  } else if (byId !== "") {
    sessionId = byId;
  } else if (has("--write-session")) {
    sessionFile = `${process.env.HOME ?? "/nonexistent"}/.pi/agent/sessions/fake/${sessionId}.jsonl`;
  }
}
const epoch = `fake-epoch-${process.pid}`;

log(`FAKE-PI pid=${process.pid} umask=0o${process.umask().toString(8).padStart(3, "0")} cwd=${process.cwd()}`);

// ---------------------------------------------------------------------------
// socket half — hello / session (mirrors wireWebHub's frames, kind:"rpc")
// ---------------------------------------------------------------------------

let sock = null;
const sockSend = (frame) => {
  if (sock === null) return;
  try {
    sock.write(`${JSON.stringify(frame)}\n`);
  } catch {
    /* connection gone — the hub-side exit/reap is the truth */
  }
};

function uiClosedItem(dialogId) {
  return {
    dialogId,
    source: "ask_user",
    toolCallId: `toolu_${dialogId}`,
    questions: [{ question: "fake question", options: [{ label: "a" }, { label: "b" }] }],
    allowCancel: true,
    openedAt: now(),
  };
}

function connectAndHello() {
  const home = process.env.HOME ?? "/nonexistent";
  const socketPath = `${home}/.pi/agent/web-hub/hub.sock`;
  sock = net.connect(socketPath);
  sock.on("error", (err) => {
    log(`SOCKET-ERROR ${String(err && err.message)}`);
    sock = null;
  });
  sock.on("close", () => {
    sock = null;
  });
  let buf = "";
  let acked = false;
  sock.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (process.env.FAKE_DEBUG) log(`FRAME-IN ${JSON.stringify(frame).slice(0, 160)}`);
      if (!acked && frame.t === "hello_ack") {
        acked = true;
        sockSend({
          t: "session",
          sessionId,
          ...(sessionFile === undefined ? {} : { sessionFile }),
          cwd: process.cwd(),
          reason: "startup",
          leafId: null,
          mode: "rpc",
        });
        afterLive();
        continue;
      }
      if (frame.t === "cmd") {
        // the hub's command router delivers over the AGENT SOCKET (registry.send), not stdio —
        // the first-prompt fp_<spawnId> frame arrives here.
        log(`CMD ${frame.id} op=${frame.cmd && frame.cmd.op} retry=${frame.retry === true}`);
        if (has("--cmd-echo")) {
          sockSend({
            t: "cmd_result",
            rid: frame.rid,
            id: frame.id,
            ok: true,
            data: { op: frame.cmd && frame.cmd.op, delivery: "observed" },
          });
        }
        continue;
      }
      if (frame.t === "ping") {
        sockSend({ t: "pong", ts: frame.ts });
        continue;
      }
      if (frame.t === "superseded") {
        log(`SUPERSEDED ${JSON.stringify(frame).slice(0, 300)}`);
        process.exit(0);
      }
      // snapshot_req / branch_req: ignored — no browser subscription needs them here
    }
  });
  sock.write(
    `${JSON.stringify({
      t: "hello",
      proto: { major: 1, minor: 0 },
      pluginVersion: "1.0.0-fake",
      buildId: "1.0.0-fake@fixture",
      agentId: { pid: process.pid, nonce },
      epoch,
      kind: "rpc",
      launcher: [process.execPath, process.argv[1] ?? ""],
      cwd: process.cwd(),
      caps: ["cmd.v1", "dialog.v1"],
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// stdout half — extension_ui_request emission (rpc-mode wire shapes, V1 ordering)
// ---------------------------------------------------------------------------

const sentAt = new Map(); // id -> epoch ms
const emitLine = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

function emitUi(method, id, extra) {
  // V1: type first, id second — byte-compatible with pi's `output({type, id, ...request})`.
  emitLine({ type: "extension_ui_request", id, method, ...extra });
  sentAt.set(id, now());
  log(`UI-SENT ${id} ${now()}`);
}

function emitRegularUi(method) {
  emitUi(method, `ui-${method}-${process.pid}`, {
    title: `fake ${method}`,
    message: method === "confirm" ? "proceed?" : undefined,
    options: method === "select" ? [{ label: "a" }, { label: "b" }] : undefined,
  });
}

function emitHugeUi(method) {
  const id = `ui-huge-${method}-${process.pid}`;
  // ~1 MiB single line: a title padded past STDOUT_LINE_MAX so the hub must answer from the
  // ≤512-byte head (#9) — exactly the over-limit shape the real defense is for.
  const pad = "P".repeat(1024 * 1024);
  emitUi(method, id, { title: pad });
}

function emitBadHead() {
  // ~100 KiB line carrying the ui prefix but NO extractable id ("method" sits where "id"
  // must be — the head regex cannot correlate it ⇒ protocol error).
  const junk = "J".repeat(100 * 1024);
  emitLine({ type: "extension_ui_request", method: "select", title: junk });
}

function emitMarker() {
  const id = `ui-marker-${process.pid}`;
  // Open a dialogs slot FIRST so the marker hold's §4.4(a) fallback is not armed — the hub
  // must HOLD this one for the (absent) web dialog instead of auto-cancelling.
  sockSend({ t: "dialogs", epoch, open: [uiClosedItem(id)], closed: [] });
  emitUi("select", id, { title: "\u0000XYZ_ASK_USER", options: [{ label: "a" }] });
}

function floodStdout(miB) {
  const line = `${"x".repeat(64 * 1024 - 1)}\n`;
  let written = 0;
  const writeChunk = () => {
    while (written < miB * 1024 * 1024) {
      written += line.length;
      if (!process.stdout.write(line)) {
        process.stdout.once("drain", writeChunk);
        return;
      }
    }
    log(`FLOOD-DONE ${written}`);
  };
  writeChunk();
}

function floodStderr(miB) {
  const chunk = `${"e".repeat(64 * 1024 - 1)}\n`;
  let written = 0;
  const writeChunk = () => {
    while (written < miB * 1024 * 1024) {
      written += chunk.length;
      if (!process.stderr.write(chunk)) {
        process.stderr.once("drain", writeChunk);
        return;
      }
    }
    log(`STDERR-FLOOD-DONE ${written}`);
  };
  writeChunk();
}

// ---------------------------------------------------------------------------
// stdin half — rpc-mode command loop
// ---------------------------------------------------------------------------

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  for (;;) {
    const nl = stdinBuf.indexOf("\n");
    if (nl < 0) break;
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === "extension_ui_response") {
      const sent = sentAt.get(frame.id);
      log(`UI-RESP ${frame.id} cancelled=${frame.cancelled === true} ${now()} ${sent ?? "-"}`);
      continue;
    }
    // cmd frames ride the socket (answered there); superseded likewise. stdin beyond the
    // ui_response channel is nothing the hub ever sends — anything else is ignored.
  }
});
process.stdin.on("end", () => {
  diag("STDIN-EOF");
  if (has("--ignore-eof")) {
    log("EOF-IGNORED");
    return;
  }
  log("EXIT eof");
  process.exit(0);
});
process.stdin.on("error", () => {
  log("EXIT stdin-error");
  process.exit(0);
});

const diagFile = `${process.cwd()}/.fake-pi-diag`;
const diag = (line) => {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(diagFile, `${Date.now()} pid=${process.pid} ${line}\n`);
  } catch {}
};
// Broken-pipe hardening: after the hub dies, ANY stdout/stderr write rejects asynchronously
// as an 'error' event — without these listeners that is an uncaughtException and the fake
// dies SILENTLY (its stderr goes nowhere), which once cost an hour of debugging. Every
// abnormal exit now leaves a trace in the diag file.
process.stdout?.on?.("error", (err) => diag(`STDOUT-ERR ${String(err && err.message)}`));
process.stderr?.on?.("error", (err) => diag(`STDERR-ERR ${String(err && err.message)}`));
process.on("uncaughtException", (err) => {
  diag(`UNCAUGHT ${String(err && err.stack ? err.stack : err)}`);
  process.exit(70);
});
process.on("unhandledRejection", (err) => {
  diag(`UNHANDLED ${String(err)}`);
});
process.on("SIGTERM", () => {
  diag("SIGTERM");
  if (has("--ignore-term")) {
    log("TERM-IGNORED");
    return;
  }
  log("EXIT term");
  process.exit(0);
});
process.on("SIGINT", () => {
  log("EXIT int");
  process.exit(0);
});

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

function afterLive() {
  // fired once hello_ack arrived and the session frame went out — the record is `live`
  if (has("--write-session") && sessionFile !== undefined && valueOf("--session", "") === "") {
    // one simulated turn: the session file appears, then status busy → idle (RS3 evidence path)
    setTimeout(() => {
      try {
        const fs5 = require("node:fs");
        const dir = sessionFile.slice(0, sessionFile.lastIndexOf("/"));
        fs5.mkdirSync(dir, { recursive: true });
        fs5.writeFileSync(
          sessionFile,
          `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
        );
        log(`SESSION-WRITTEN ${sessionFile}`);
      } catch (err) {
        log(`SESSION-WRITE-FAILED ${String(err && err.message)}`);
      }
      sockSend({ t: "status", leafId: null, busy: true, pending: false });
      setTimeout(() => sockSend({ t: "status", leafId: null, busy: false, pending: false }), 50);
    }, 50);
  }
  const huge = valueOf("--emit-ui-huge", "");
  if (huge !== "") emitHugeUi(huge);
  if (has("--emit-ui-bad-head")) emitBadHead();
  const ui = valueOf("--emit-ui", "");
  if (ui === "marker") emitMarker();
  else if (ui !== "") emitRegularUi(ui);
  const flood = Number(valueOf("--flood", "0"));
  if (flood > 0) floodStdout(flood);
}

if (!has("--no-hello")) connectAndHello();

// --ignore-eof keep-alive: once the hub dies, stdin (EOF seen), the agent socket and both
// stdio pipes are gone — without a ref'd handle Node would drain the event loop and exit 0,
// silently defeating the whole "orphan must survive until the reaper's KILL" premise. Real
// rpc-mode pi stays alive via its own never-settling promise (`runRpcMode`'s `new Promise(() => {})`).
if (has("--ignore-eof")) {
  const keepAlive = setInterval(() => {}, 1 << 30);
  if (typeof keepAlive.unref === "function") {
    // deliberately NOT unref'd — this is the handle that keeps the orphan alive
  }
}

const stderrFlood = Number(valueOf("--stderr-flood", "0"));
if (stderrFlood > 0) floodStderr(stderrFlood);
