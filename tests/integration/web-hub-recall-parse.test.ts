// web-hub-steer-recall plan §4.1 (P-protocol): end-to-end recall parse/forward over the REAL
// stack — real `startHub` + real `createHttpFrontend` HTTP listener + real agent unix socket +
// a FAKE agent (raw frames on the socket, exactly like `web-hub-control.test.ts`'s legacy-agent
// scenario, but without the full `activate()` — the agent side is P-core's package). Pins:
//   1. `POST /api/cmd {op:"recall", target, expect, junk}` forwards a frame whose `cmd` is
//      EXACTLY {op:"recall", target} (decodeHubFrame-valid, everything else dropped);
//   2. the agent's typed `cmd_result` round-trips to the HTTP 200 body unchanged;
//   3. an agent that never advertised `hold.v1` ⇒ 409 E_UNSUPPORTED and zero cmd frames.
import { afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { FrontendFactory } from "../../src/web-hub/hub/ports.js";
import { decodeHubFrame } from "../../src/web-hub/protocol/messages.js";
import { config as hubConfig, connectClient, hello, tmpDirs, type TestClient } from "../web-hub/hub/helpers.js";
import { login, postJson } from "../web-hub/http/helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];
let clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.sock.destroy();
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

const TARGET = "t".repeat(16);

describe("web-hub recall parse/forward integration (steer-recall §4.1)", () => {
  it("POST /api/cmd recall forwards EXACTLY {op:'recall', target} and round-trips the typed result", async () => {
    const home = tmp.make("wh-recall-parse-");
    const frontend: FrontendFactory = (d) => createHttpFrontend(d);
    const started = await startHub(hubConfig({ home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
    if ("exists" in started) throw new Error("unexpected hub singleton collision");
    const hub = started;
    hubs.push(hub);

    // fake agent WITH the caps recall needs (cmd.v1 + hold.v1)
    const agent = await connectClient(hub.paths.socketPath);
    clients.push(agent);
    agent.send(
      hello({
        agentId: { pid: process.pid, nonce: "recallparseAAAAAA" },
        epoch: "e-parse-1",
        cwd: "/tmp/recall",
        caps: ["ev.v1", "cmd.v1", "hold.v1"],
      }),
    );
    await agent.waitFrame((f) => f["t"] === "hello_ack");
    // discover our agentKey from hello_ack — the registry-side view is not exposed here, and the
    // loopback agentKey allocation is `a<pid>-<nonce[0..6]>`, so just read it off the ack.
    const agentKey = (agent.frames.find((f) => (f as { t?: string }).t === "hello_ack") as { agentKey: string })
      .agentKey;

    const cookie = await login(hub.httpPort, hub.paths.tokenFile);
    const origin = `http://127.0.0.1:${hub.httpPort}`;

    const pending = postJson(
      hub.httpPort,
      "/api/cmd",
      { agentKey, id: "a".repeat(16), op: "recall", target: TARGET, expect: { sessionId: "s1" }, junk: 1 },
      { Cookie: cookie, Origin: origin },
    );
    const raw = await agent.waitFrame((f) => f["t"] === "cmd");
    // the raw agent-side frame decodes and carries EXACTLY the recall pair — expect/junk dropped
    const frame = decodeHubFrame(raw);
    expect(frame).toBeDefined();
    expect(frame !== undefined && frame.t === "cmd" && (frame.cmd as object)).toEqual({ op: "recall", target: TARGET });
    expect(frame !== undefined && frame.t === "cmd" && "expect" in (frame.cmd as object)).toBe(false);

    agent.send({
      t: "cmd_result",
      rid: raw["rid"] as string,
      id: raw["id"] as string,
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "the full recalled body" },
    });
    const res = await pending;
    expect(res.status).toBe(200);
    // "HTTP 200 body 一致": the typed result rides back verbatim (plus the echoed cmd id)
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      id: "a".repeat(16),
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "the full recalled body" },
    });
  }, 20_000);

  it("an invalid target ⇒ 400 before anything reaches the agent", async () => {
    const home = tmp.make("wh-recall-bad-");
    const frontend: FrontendFactory = (d) => createHttpFrontend(d);
    const started = await startHub(hubConfig({ home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
    if ("exists" in started) throw new Error("unexpected hub singleton collision");
    const hub = started;
    hubs.push(hub);

    const agent = await connectClient(hub.paths.socketPath);
    clients.push(agent);
    agent.send(
      hello({
        agentId: { pid: process.pid, nonce: "recallbadAAAAAAA" },
        epoch: "e-parse-2",
        cwd: "/tmp/recall",
        caps: ["ev.v1", "cmd.v1", "hold.v1"],
      }),
    );
    const ack = (await agent.waitFrame((f) => f["t"] === "hello_ack")) as { agentKey: string };
    const cookie = await login(hub.httpPort, hub.paths.tokenFile);

    const res = await postJson(
      hub.httpPort,
      "/api/cmd",
      { agentKey: ack.agentKey, id: "b".repeat(16), op: "recall", target: "nope" },
      { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_BAD_REQUEST", message: "target required" });
    expect(agent.frames.some((f) => (f as { t: string }).t === "cmd")).toBe(false);
  }, 20_000);

  it("an agent that never advertised hold.v1 ⇒ 409 E_UNSUPPORTED, zero cmd frames", async () => {
    const home = tmp.make("wh-recall-cap-");
    const frontend: FrontendFactory = (d) => createHttpFrontend(d);
    const started = await startHub(hubConfig({ home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
    if ("exists" in started) throw new Error("unexpected hub singleton collision");
    const hub = started;
    hubs.push(hub);

    const agent = await connectClient(hub.paths.socketPath);
    clients.push(agent);
    agent.send(
      hello({
        agentId: { pid: process.pid, nonce: "recallnocapAAAAA" },
        epoch: "e-parse-3",
        cwd: "/tmp/recall",
        caps: ["ev.v1", "cmd.v1"], // has cmd.v1, lacks hold.v1
      }),
    );
    const ack = (await agent.waitFrame((f) => f["t"] === "hello_ack")) as { agentKey: string };
    const cookie = await login(hub.httpPort, hub.paths.tokenFile);

    const res = await postJson(
      hub.httpPort,
      "/api/cmd",
      { agentKey: ack.agentKey, id: "c".repeat(16), op: "recall", target: TARGET },
      { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` },
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_UNSUPPORTED" });
    expect(agent.frames.some((f) => (f as { t: string }).t === "cmd")).toBe(false);
  }, 20_000);
});
