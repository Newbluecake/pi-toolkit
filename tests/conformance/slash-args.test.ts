/**
 * web-hub-slash-args plan §8 conformance (P4) — the pi-interface contracts the whole
 * `/name␠` argument-completion feature stands on, against REAL pi. NOT part of the normal
 * `npm test` gate in spirit: run `npm run test:conformance` before any pi peer bump, exactly
 * like consult-preserve / fabric-wake.
 *
 * Two halves:
 *
 *  A. REAL `pi --mode rpc` child + fake hub socket (rpc-bash-jobs.test.ts's harness family):
 *     the settings file lists THIS package the regular way with `webHub.enabled`, so the REAL
 *     main-session wiring runs in a real pi process. Pinned contracts:
 *      - the agent's `hello.caps` carries `cmd.args.v1` (the cap gate for args + complete_req);
 *      - the `commands` slot frame keeps `args` rows (toolkit `complete:true` + usage table,
 *        builtin usage-only) — i.e. real pi's registerCommand surfaces our commands and the
 *        frame passes the hub schema byte-for-byte;
 *      - `complete_req` for `/webhub` answers `ok:true` from the REAL S-own completer
 *        (wrapCommandApi's capture) with the per-item deny filter applied (only `status`
 *        survives), and an unknown command answers E_UNKNOWN_COMMAND.
 *
 *  B. REAL `InteractiveMode` (tui-harness.ts) + a probe extension: the TUI-side S-tui capture
 *     path. Pinned contracts:
 *      - `ctx.ui.addAutocompleteProvider(factory)` EXISTS in interactive mode and pi REPLAYS
 *        the factory with the composed base provider as `current` (§4.5's only lever);
 *      - the base provider honors `registerCommand`'s `getArgumentCompletions`: asking it for
 *        `/zzargprobe x` returns exactly the probe's items with `prefix === "x"` (the
 *        whole-argument-prefix semantics our engine re-checks);
 *      - a command WITHOUT a completer yields no argument suggestions (null/empty — the
 *        assumption that keeps wrong-branch answers out via the prefix guard).
 *
 * Any failure here is pi interface drift: re-read plan §2's "限制" and §4.5 before touching
 * `src/web-hub/agent/command-complete.ts` or bumping the pi peer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { PROTO, CMD_ARGS_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import { createTuiHarness } from "./tui-harness.js";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PI_CLI = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

// ---------------------------------------------------------------------------
// A. real pi --mode rpc child
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(PI_CLI))("slash-args conformance — real pi --mode rpc (S-own + caps)", () => {
  const CAPS = ["ev.v1", "ctl.v1", "cmd.v1", "command.v1", CMD_ARGS_HUB_CAP];
  let home: string | undefined;
  let workdir: string | undefined;
  let child: ChildProcess | undefined;
  let server: net.Server | undefined;
  const frames: Array<Record<string, unknown>> = [];
  let agentSock: net.Socket | undefined;

  /** Resolve the next frame matching pred (already-received frames included). */
  function nextFrame(pred: (f: Record<string, unknown>) => boolean, ms = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    return new Promise((resolve_, reject) => {
      const poll = setInterval(() => {
        const hit = frames.find(pred);
        if (hit !== undefined) {
          clearInterval(poll);
          resolve_(hit);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error(`frame wait timeout; got ${frames.map((f) => f["t"]).join(",")}`));
        }
      }, 25);
      poll.unref();
    });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "pwh-conf-slash-args-"));
    workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });
    // Regular installation shape (never -e): settings.json lists THIS package.
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
    writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify({ webHub: { enabled: true } }));

    // Fake hub socket at the exact path the agent side derives from HOME.
    const stateDir = join(agentDir, "web-hub");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const socketPath = join(stateDir, "hub.sock");
    rmSync(socketPath, { force: true });
    server = net.createServer((sock) => {
      agentSock = sock;
      const dec = new NdjsonDecoder({
        maxFrameBytes: 512 * 1024,
        onFrame: (raw: unknown) => {
          const frame = raw as Record<string, unknown>;
          frames.push(frame);
          if (frame["t"] === "hello") {
            sock.write(
              `${JSON.stringify({
                t: "hello_ack",
                hubVersion: "1.2.3",
                buildId: "1.2.3@conf-slash-args",
                proto: { major: PROTO.major, minor: PROTO.minor },
                agentKey: "a-conf-slash-args-01",
                pingMs: 10_000,
                leaseMs: 30_000,
                http: { port: 0 },
                caps: CAPS,
              })}\n`,
            );
          }
          // session / status / commands / ping … collected, deliberately not answered
        },
        onError: () => {},
      });
      sock.on("data", (c: Buffer) => dec.push(c));
      sock.on("error", () => {});
    });
    await new Promise<void>((res) => server!.listen(socketPath, res));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("PI_WEBHUB_")) continue;
      env[k] = v;
    }
    env["HOME"] = home;
    env["PI_WEBHUB_HEADLESS"] = "1";
    env["PI_WEBHUB_SPAWN_ID"] = "conf-slash-args-1";
    child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--session-id", "0197c0de-0000-7000-8000-000000000042"], {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.resume();
    child.stderr?.resume();
  }, 60_000);

  afterAll(() => {
    child?.kill("SIGKILL");
    server?.close();
    agentSock?.destroy();
    for (const p of [home, workdir]) if (p !== undefined) rmSync(p, { recursive: true, force: true });
  });

  it("hello advertises cmd.args.v1 (agent cap) and the commands frame keeps args rows", async () => {
    // first boot pays jiti's full TypeScript load of the whole package — allow up to 60s
    const helloFrame = (await nextFrame((f) => f["t"] === "hello", 60_000)) as { caps?: unknown };
    expect(
      Array.isArray(helloFrame.caps) && (helloFrame.caps as string[]).includes(CMD_ARGS_HUB_CAP),
      "pi interface drift: the agent wiring no longer advertises cmd.args.v1 in hello.caps — re-check web-hub-slash-args plan §4.1 and src/web-hub/agent/index.ts capsExtra",
    ).toBe(true);

    const commands = (await nextFrame((f) => f["t"] === "commands")) as unknown as {
      items?: Array<Record<string, unknown>>;
    };
    const items = commands.items ?? [];
    expect(
      items.length,
      "commands frame missing/empty — the closed hub schema may have rejected it (drift)",
    ).toBeGreaterThan(0);
    const webhub = items.find((r) => r["name"] === "webhub") as
      { args?: { complete?: unknown; usage?: unknown } } | undefined;
    expect(webhub, "the /webhub command never registered under real pi (drift: registerCommand surface)").toBeDefined();
    expect(
      webhub?.args?.complete === true,
      "pi interface drift: registerCommand's getArgumentCompletions no longer reaches the args hints (plan §4.4)",
    ).toBe(true);
    expect(typeof webhub?.args?.usage).toBe("string");
    const model = items.find((r) => r["name"] === "model") as
      { args?: { usage?: unknown; complete?: unknown } } | undefined;
    expect(model?.args?.usage).toBe("<provider/model>");
    expect(model?.args?.complete).toBeUndefined();
  }, 30_000);

  it("complete_req round-trips through the real S-own engine (deny-filtered); unknown ⇒ E_UNKNOWN_COMMAND", async () => {
    // wait for the commands frame first (route admission on the real hub side needs it; here it
    // also proves the engine's own classifyCommand will find the command)
    await nextFrame((f) => f["t"] === "commands");

    const rid = "conf-complete-1";
    agentSock?.write(
      `${JSON.stringify({ t: "complete_req", rid, name: "webhub", prefix: "", deadlineMs: 1500, origin: { listener: "loopback" } })}\n`,
    );
    const reply = (await nextFrame((f) => f["t"] === "complete_reply" && f["rid"] === rid)) as {
      ok?: unknown;
      source?: unknown;
      items?: Array<{ value: string }>;
      code?: unknown;
    };
    expect(
      reply.ok === true,
      `pi interface drift: the real S-own completion engine did not answer ok (got ${String(reply.code)}) — re-check wrapCommandApi's argCompleters capture (plan §4.4)`,
    ).toBe(true);
    expect(reply.source).toBe("own");
    const values = (reply.items ?? []).map((i) => i.value);
    expect(values).toContain("status"); // the only web-allowed /webhub subcommand
    for (const denied of ["passwd", "2fa", "user", "open", "unlock", "restart"]) {
      expect(values.some((v) => v === denied || v.startsWith(`${denied} `))).toBe(false);
    }

    const rid2 = "conf-complete-2";
    agentSock?.write(
      `${JSON.stringify({ t: "complete_req", rid: rid2, name: "definitely-not-a-command", prefix: "", deadlineMs: 1500, origin: { listener: "loopback" } })}\n`,
    );
    const reply2 = (await nextFrame((f) => f["t"] === "complete_reply" && f["rid"] === rid2)) as {
      ok?: unknown;
      code?: unknown;
    };
    expect(reply2.ok).toBe(false);
    expect(reply2.code).toBe("E_UNKNOWN_COMMAND");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// B. real InteractiveMode (TUI harness) — the S-tui capture path
// ---------------------------------------------------------------------------

interface Suggestions {
  items: Array<{ value: string; label: string; description?: string }>;
  prefix: string;
}

describe("slash-args conformance — real InteractiveMode (S-tui replay + registerCommand completions)", () => {
  const PROBE_ITEMS = [
    { value: "xray", label: "xray", description: "probe item" },
    { value: "xylophone", label: "xylophone", description: "probe item" },
  ];

  function probeExtension(): { factory: ExtensionFactory; state: { current?: unknown; ctxMode?: string } } {
    const state: { current?: unknown; ctxMode?: string } = {};
    const factory: ExtensionFactory = (pi) => {
      pi.registerCommand("zzargprobe", {
        description: "conformance probe: argument completion",
        handler: async () => undefined,
        getArgumentCompletions: (argumentPrefix: string) =>
          PROBE_ITEMS.filter((i) => i.value.startsWith(argumentPrefix.trim())),
      });
      pi.registerCommand("zznocomplete", {
        description: "conformance probe: no completer",
        handler: async () => undefined,
      });
      pi.on("session_start", (_event, ctx) => {
        state.ctxMode = ctx.mode;
        const ui = (ctx as { ui?: { addAutocompleteProvider?: (f: (current: unknown) => unknown) => void } }).ui;
        if (typeof ui?.addAutocompleteProvider === "function") {
          // EXACTLY the wiring's passthrough shape (plan §4.5): store current, return it as-is.
          ui.addAutocompleteProvider((current) => {
            state.current = current;
            return current;
          });
        }
      });
    };
    return { factory, state };
  }

  it("addAutocompleteProvider is replayed with the base provider; registerCommand's getArgumentCompletions is honored", async () => {
    const probe = probeExtension();
    const harness = await createTuiHarness({ scripted: [], extensionFactories: [probe.factory] });
    try {
      const provider = probe.state.current as
        | {
            getSuggestions(
              lines: string[],
              cursorLine: number,
              cursorCol: number,
              options: { signal: AbortSignal; force?: boolean },
            ): Promise<Suggestions | null>;
          }
        | undefined;
      expect(
        provider,
        "pi interface drift: ctx.ui.addAutocompleteProvider was not called back (factory never replayed) — the S-tui capture of web-hub-slash-args plan §4.5 is dead; re-check pi's setupAutocompleteProvider replay semantics",
      ).toBeDefined();
      expect(probe.state.ctxMode).toBe("tui");

      const ctl = new AbortController();
      const res = await provider!.getSuggestions(["/zzargprobe x"], 0, "/zzargprobe x".length, {
        signal: ctl.signal,
        force: false,
      });
      expect(
        res !== null && typeof res === "object",
        "pi interface drift: the base provider returned nothing for a slash-arg query (plan §2: commands with a completer must answer items, never fall through to file completion)",
      ).toBe(true);
      expect(res!.prefix).toBe("x"); // the whole-argument-prefix contract (§4.3 #5's guard)
      expect(res!.items.map((i) => i.value)).toEqual(["xray", "xylophone"]);

      const empty = await provider!.getSuggestions(["/zzargprobe "], 0, "/zzargprobe ".length, {
        signal: ctl.signal,
        force: false,
      });
      expect(empty?.prefix).toBe("");
      expect(empty?.items.length).toBe(2);

      const none = await provider!.getSuggestions(["/zznocomplete x"], 0, "/zznocomplete x".length, {
        signal: ctl.signal,
        force: false,
      });
      expect(
        none === null || none === undefined || none.items.length === 0,
        "pi interface drift: a command WITHOUT getArgumentCompletions produced argument suggestions — the prefix guard's no-fallthrough assumption (plan §2) no longer holds",
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});
