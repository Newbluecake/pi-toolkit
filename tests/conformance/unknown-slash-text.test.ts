/** #40 real pi 1.4 input contracts. No provider credentials or user state are used. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireSecureGuards } from "../../src/secure/guards.js";
import wireFeishuNotify from "../../src/feishu-notify/index.js";
import { BUILTIN_BRIDGE_NAMES, BUILTIN_DENY_NAMES } from "../../src/web-hub/agent/command-policy.js";
import { createTuiHarness, textTurn } from "./tui-harness.js";
import { disposeHarnessDirs, withSession, assistantTextMsg } from "./agent-session-harness.js";

const PI_ROOT = resolve("node_modules/@earendil-works/pi-coding-agent");
const PI_VERSION = (JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8")) as { version: string }).version;
afterEach(disposeHarnessDirs);

async function until(check: () => boolean, detail: () => string = () => "", ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`unknown-slash conformance timeout: ${detail()}`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

function userText(messages: unknown[]): string[] {
  return (messages as Array<{ role?: string; content?: unknown }>)
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n"),
    );
}

describe(`unknown-slash installed pi ${PI_VERSION} (1.0–1.3 unverified)`, () => {
  it("covers the installed builtin command list and hidden TUI commands without guessing names", () => {
    const source = readFileSync(join(PI_ROOT, "dist/core/slash-commands.js"), "utf8");
    const names = [...source.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]!);
    const tui = readFileSync(join(PI_ROOT, "dist/modes/interactive/interactive-mode.js"), "utf8");
    const hiddenAndDirect = [...tui.matchAll(/text === "\/([^"\s]+)"/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    expect(hiddenAndDirect).toContain("arminsayshi");
    for (const name of new Set([...names, ...hiddenAndDirect])) {
      expect(BUILTIN_BRIDGE_NAMES.has(name) || BUILTIN_DENY_NAMES.has(name), `${PI_VERSION}: /${name}`).toBe(true);
    }
  });

  it("real TUI submits unknown text once after host trim; known handler failures never become user messages", async () => {
    const inputs: string[] = [];
    const calls: string[] = [];
    const h = await createTuiHarness({
      scripted: [textTurn("ok")],
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.registerCommand("slashprobe", {
            handler: async (args) => {
              calls.push(args);
              throw new Error("SLASH-PROBE-FAIL");
            },
          });
          pi.on("input", (e) => {
            inputs.push(e.text);
            return { action: "continue" };
          });
        },
      ],
    });
    try {
      void h.mode.run().catch(() => undefined);
      h.terminal.type("  /notregistered raw  ");
      h.terminal.type("\r");
      await until(() => h.modelRuntime.callCount() === 1 && !h.session.isStreaming);
      expect(inputs).toEqual(["/notregistered raw"]);
      expect(userText(h.modelRuntime.requestMessages[0]!)).toEqual(["/notregistered raw"]);
      h.terminal.type("/slashprobe bad");
      h.terminal.type("\r");
      await until(() => calls.length === 1);
      expect(calls).toEqual(["bad"]);
      expect(inputs).toEqual(["/notregistered raw"]);
      expect(h.modelRuntime.callCount()).toBe(1);
      expect(h.renderFullFrame().join("\n")).toContain("SLASH-PROBE-FAIL");
    } finally {
      await h.dispose();
    }
  });

  it("pins ASCII-space extension parsing, case, prefix, suffix and raw newline semantics", async () => {
    const calls: string[] = [];
    await withSession(
      {
        scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "ok") }],
        extensionFactories: [
          (pi: ExtensionAPI) =>
            pi.registerCommand("slashprobe", {
              handler: async (args) => {
                calls.push(args);
              },
            }),
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("/slashprobe ok", { source: "rpc" });
        expect(calls).toEqual(["ok"]);
        for (const text of [
          "/slashprobe\tx",
          "/slashprobe\nx",
          "/slashprobe\n",
          "/Slashprobe",
          "/slashprobe2",
          "/slashprobe:2",
          " /slashprobe",
          "//slashprobe",
        ]) {
          await session.prompt(text, { source: "rpc" });
          expect(userText(modelRuntime.requestMessages.at(-1)!)).toContain(text);
        }
        expect(calls).toEqual(["ok"]);
        expect(modelRuntime.callCount()).toBe(8);
      },
    );
  });

  it("matches real duplicate invocation names without stripping :n", async () => {
    let api!: ExtensionAPI;
    const calls: string[] = [];
    await withSession(
      {
        scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "ok") }],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            api = pi;
            pi.registerCommand("duplicate", {
              handler: async (args) => {
                calls.push(`one:${args}`);
              },
            });
          },
          (pi: ExtensionAPI) =>
            pi.registerCommand("duplicate", {
              handler: async (args) => {
                calls.push(`two:${args}`);
              },
            }),
        ],
      },
      async ({ session, modelRuntime }) => {
        const names = api
          .getCommands()
          .filter((c) => c.name.startsWith("duplicate"))
          .map((c) => c.name);
        expect(names).toEqual(["duplicate:1", "duplicate:2"]);
        await session.prompt("/duplicate:1 x");
        await session.prompt("/duplicate:2 y");
        expect(calls).toEqual(["one:x", "two:y"]);
        expect(modelRuntime.callCount()).toBe(0);
        await session.prompt("/duplicate");
        expect(modelRuntime.callCount()).toBe(1);
        expect(calls).toEqual(["one:x", "two:y"]);
      },
    );
  });

  it("records the existing real notify input transform without firing notification lifecycle events", async () => {
    const root = mkdtempSync(join(tmpdir(), "slash-notify-input-"));
    const old = process.env.FEISHU_NOTIFY_CONFIG_PATH;
    process.env.FEISHU_NOTIFY_CONFIG_PATH = join(root, "absent-config.json");
    const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
    const key = Symbol.for("pi-subagent:feishu-notify:host");
    const globals = globalThis as Record<symbol, unknown>;
    const previous = globals[key];
    delete globals[key];
    try {
      wireFeishuNotify({
        on: (name: string, fn: (e: unknown, ctx: unknown) => unknown) => {
          handlers.set(name, fn);
        },
        events: { on: () => () => {} },
        registerCommand() {},
      } as unknown as ExtensionAPI);
      const input = handlers.get("input")!;
      const ctx = { hasUI: false };
      expect(await input({ text: "/unknown  @notify\n tail  " }, ctx)).toEqual({
        action: "transform",
        text: "/unknown  \n tail",
      });
      expect(await input({ text: "/unknown  #notify  " }, ctx)).toEqual({ action: "transform", text: "/unknown" });
      expect(await input({ text: "/unknown raw  " }, ctx)).toBeUndefined();
    } finally {
      await handlers.get("session_shutdown")?.({}, {});
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
      if (old === undefined) delete process.env.FEISHU_NOTIFY_CONFIG_PATH;
      else process.env.FEISHU_NOTIFY_CONFIG_PATH = old;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("LOCKED handles unknown slash before later input handlers and never starts a provider run", async () => {
    const later: string[] = [];
    await withSession(
      {
        scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "must-not-run") }],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            wireSecureGuards(pi, {
              isChildSession: false,
              domain: {
                kind: "locked",
                reason: "test-lock",
                vaults: [],
                config: { present: true, enabled: true, valid: true, vaults: [], invalid: [] },
              },
            });
            pi.on("input", (e) => {
              later.push(e.text);
              return { action: "continue" };
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("/unknown raw\n  x  ", { source: "rpc" });
        await session.sendUserMessage("/unknown raw", { expandPromptTemplates: false });
        expect(later).toEqual([]);
        expect(modelRuntime.callCount()).toBe(0);
        expect(session.sessionManager.getBranch().filter((e) => e.type === "message")).toEqual([]);
      },
    );
  });

  it("real RPC child sends unknown raw text to a local fake provider; known args/throw stay handled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-unknown-slash-rpc-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const bodies: Array<{ messages: unknown[] }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (b: Buffer) => {
        body += b.toString();
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body) as { messages: unknown[] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"id":"probe","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake provider not bound");
    const probe = join(root, "probe.ts");
    writeFileSync(
      probe,
      `export default function(pi) { pi.registerCommand("slashprobe", {handler: async (args,ctx) => {ctx.ui.notify("SLASH-CALL:"+args,"error"); if(args!=="ok") throw new Error("SLASH-FAIL"); }}); }`,
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [probe], packages: [] }));
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "slash-test": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "test-only",
            models: [
              {
                id: "fake",
                contextWindow: 200000,
                maxTokens: 128,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const child = spawn(
      process.execPath,
      [join(PI_ROOT, "dist/cli.js"), "--mode", "rpc", "--no-session", "--provider", "slash-test", "--model", "fake"],
      {
        cwd: root,
        env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const records: Array<Record<string, unknown>> = [];
    let buffer = "",
      stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line) records.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const send = (record: object) => child.stdin.write(`${JSON.stringify(record)}\n`);
    const response = (id: string) => records.find((r) => r.type === "response" && r.id === id);
    try {
      send({ id: "ready", type: "get_commands" });
      await until(
        () => response("ready") !== undefined,
        () => stderr,
        15000,
      );
      expect(JSON.stringify(response("ready"))).toContain("slashprobe");
      const text = "/notregistered\t raw\n  tail  ";
      send({ id: "unknown", type: "prompt", message: text });
      await until(
        () => records.some((r) => r.type === "agent_settled"),
        () => stderr + JSON.stringify(records),
        15000,
      );
      expect(response("unknown")).toMatchObject({ success: true, data: { disposition: "started" } });
      expect(bodies).toHaveLength(1);
      expect(userText(bodies[0]!.messages)).toContain(text);
      for (const [id, args] of [
        ["bad", "bad args"],
        ["known", "ok"],
      ]) {
        send({ id, type: "prompt", message: `/slashprobe ${args}` });
        await until(
          () => response(id!) !== undefined,
          () => stderr,
        );
        expect(response(id!)).toMatchObject({ success: true, data: { disposition: "handled" } });
      }
      expect(bodies).toHaveLength(1);
      expect(
        records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => r.message),
      ).toEqual(["SLASH-CALL:bad args", "SLASH-CALL:ok"]);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((r) => {
        if (child.exitCode !== null || child.signalCode !== null) r();
        else child.once("exit", () => r());
      });
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
