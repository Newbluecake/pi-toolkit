/**
 * #23 web-update-stuck plan §2.3 / P-B step 0 — the epoch-up compat golden.
 *
 * Captured from `dev` BEFORE any `registry.ts`/`agent/index.ts` epoch-up change
 * (`PI_TOOLKIT_EPOCH_UP_GOLDEN_CAPTURE=1`; refuses to overwrite an existing file), over the
 * REAL hub HTTP stack per plan §2.3: a real `createRegistry` + real `createHttpFrontend`
 * (assembled through `tests/web-hub/http/helpers.ts`'s `fakeDeps` fixture), a real browser-side
 * SSE connection (`/api/events`, real login, real `/api/subscribe`) whose RAW wire text is
 * captured verbatim, and the registry bus events recorded in order.
 *
 * Three scenarios (each: register(old caps, e-old) → silent claim-window disconnect →
 * register(new caps, e-new) on the SAME agentId):
 *   s1  old caps WITHOUT hold.v1   — the pre-feature agent: only `gap` (must stay byte-equal)
 *   s2  old caps WITH hold.v1      — Y7.2's agent: `agent_up` then `gap` (must stay byte-equal)
 *   s3  OLD hub × NEW agent        — reconnect hello carries the new (then-unknown) cap
 *                                    `epoch.up.v1` without hold.v1. On the old hub: only `gap`
 *                                    plus the hub-internal `caps` bus event (run-transcript
 *                                    revalidation only, never SSE). Kept as the old-hub EVIDENCE
 *                                    for the §2.3 matrix row「老 hub × 新 agent」— it is NOT
 *                                    compared against the current implementation (whose
 *                                    registry answers this scenario with agent_up + gap, pinned
 *                                    by the separate `new hub × new agent` it-block below).
 *
 * After the change the suite asserts s1/s2 byte-for-byte (bus events + normalized raw SSE),
 * determinism across two runs, and the new hub × new agent behavior. Never regenerate the
 * golden to make a diff pass: a diff means observable wire behavior changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import { fakeDeps, login, makeTmp, parseSseBlock, postJson, type SseEvent } from "../http/helpers.js";
import { fakeConn, hello, memLog } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "fixtures", "web-hub", "epoch-up-compat-golden.json");
const CAPTURE = process.env.PI_TOOLKIT_EPOCH_UP_GOLDEN_CAPTURE === "1";

/** Fixed clock: deterministic SSE ring ids (`lastId` seeds from `now()`), deterministic cards. */
const T = 1_700_000_000_000;

/** The caps a pre-#23 agent sends under the configs RC2 targets (hold NOT wired). */
const NO_HOLD = ["ev.v1", "cmd.v1"] as const;
/** The caps a pre-#23 default-config agent sends (hold.v1 ⇒ Y7.2 already refreshes). */
const WITH_HOLD = ["ev.v1", "cmd.v1", "hold.v1"] as const;
/** A NEW agent (post-#23) under a hold-off config: the tail-appended epoch-up cap. */
const NEW_AGENT_NO_HOLD = ["ev.v1", "cmd.v1", "epoch.up.v1"] as const;

interface ScenarioOut {
  firstCaps: string[];
  secondCaps: string[];
  busEvents: HubEvent[];
  sse: string;
}

/**
 * The connect burst's only non-deterministic fields: the random `c…` clientId and the
 * OS-assigned listener port inside the `hub` frame. Both are normalized to placeholders —
 * everything else (ids, event names, JSON payload bytes, frame ORDER) is asserted verbatim.
 */
function normalizeSse(text: string): string {
  return text.replace(/"clientId":"c[A-Za-z0-9_-]+"/g, '"clientId":"<client>"').replace(/"port":\d+/g, '"port":<port>');
}

interface RawSse {
  clientId(): string | undefined;
  text(): string;
  waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
  close(): void;
}

/** Real SSE GET whose response bytes are ALSO accumulated verbatim (the golden's 原文 half). */
function openRawSse(port: number, cookie: string): Promise<RawSse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        headers: { Cookie: cookie, Accept: "text/event-stream" },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`sse connect failed: ${res.statusCode}`));
          return;
        }
        let raw = "";
        let buf = "";
        const events: SseEvent[] = [];
        const waiters: Array<() => void> = [];
        const notify = (): void => {
          for (const w of [...waiters]) w();
        };
        const sse: RawSse = {
          clientId: () => events.find((e) => e.event === "hello")?.data?.clientId as string | undefined,
          text: () => raw,
          waitFor(pred, ms = 3_000) {
            return new Promise((res2, rej2) => {
              const check = (): boolean => {
                const hit = events.find((e) => pred(e));
                if (hit !== undefined) {
                  cleanup();
                  res2(hit);
                  return true;
                }
                return false;
              };
              const timer = setTimeout(() => {
                cleanup();
                rej2(new Error(`waitFor timeout; got ${events.map((e) => e.event).join(",")}`));
              }, ms);
              const cleanup = (): void => {
                clearTimeout(timer);
                const i = waiters.indexOf(onEv);
                if (i >= 0) waiters.splice(i, 1);
              };
              const onEv = (): void => {
                check();
              };
              if (!check()) waiters.push(onEv);
            });
          },
          close: () => req.destroy(),
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseSseBlock(block);
            if (ev !== undefined) events.push(ev);
          }
          notify();
        });
        res.on("error", () => undefined);
        resolve(sse);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

async function runScenario(caps: { first: readonly string[]; second: readonly string[] }): Promise<ScenarioOut> {
  const tmp = makeTmp("pwh-epochup-");
  try {
    const deps = fakeDeps(tmp.dir);
    const reg = createRegistry({ now: () => T, log: memLog(), pidAlive: () => true });
    const fe = createHttpFrontend({
      ...deps,
      now: () => T,
      // fixed pid/port-free info: the `hub` frame stays deterministic after port normalization
      info: () => ({ version: "9.9.9", buildId: "b1", pid: 1, startedAt: 1, proto: PROTO }),
      registry: reg,
      bus: reg.bus,
    });
    const { port } = await fe.listen();
    try {
      const cookie = await login(port, deps.paths.tokenFile);
      const sse = await openRawSse(port, cookie);
      try {
        await sse.waitFor((e) => e.event === "agents"); // connect burst: hello, hub, agents
        const busEvents: HubEvent[] = [];
        reg.bus.subscribe((e) => busEvents.push(e));
        const { agentKey } = reg.register(hello({ caps: [...caps.first], epoch: "e-old" }), fakeConn());
        await sse.waitFor((e) => e.event === "agent_up");
        // subscribe BEFORE the reconnect so the scoped `gap` frame reaches this client on the wire
        const res = await postJson(port, "/api/subscribe", { clientId: sse.clientId(), agentKey }, { Cookie: cookie });
        expect(res.status).toBe(202);
        await sse.waitFor((e) => e.event === "history");
        reg.onClose(agentKey, false); // socket dropped, no bye ⇒ claim window, silent
        await settle();
        reg.register(hello({ caps: [...caps.second], epoch: "e-new" }), fakeConn());
        await settle(); // bus → onHubEvent → sse.publish are synchronous; flush TCP delivery
        return { firstCaps: [...caps.first], secondCaps: [...caps.second], busEvents, sse: normalizeSse(sse.text()) };
      } finally {
        sse.close();
      }
    } finally {
      await fe.close();
    }
  } finally {
    tmp.cleanup();
  }
}

const SCENARIOS = {
  "s1-old-caps-no-hold": { first: NO_HOLD, second: NO_HOLD },
  "s2-old-caps-with-hold": { first: WITH_HOLD, second: WITH_HOLD },
  "s3-old-hub-new-agent": { first: NO_HOLD, second: NEW_AGENT_NO_HOLD },
} as const;

async function captureAll(): Promise<Record<string, ScenarioOut>> {
  const scenarios: Record<string, ScenarioOut> = {};
  for (const [name, caps] of Object.entries(SCENARIOS)) scenarios[name] = await runScenario(caps);
  return scenarios;
}

const types = (events: HubEvent[]): string[] => events.map((e) => e.type);

describe("#23 epoch-up compat golden (plan §2.3, recorded pre-change on dev)", () => {
  afterEach(() => {
    // nothing timer-bound survives runScenario (fixed clock, no vi timers)
  });

  it("s1/s2: bus events + raw SSE stay byte-identical to the pre-change golden", async () => {
    const fresh = await captureAll();
    if (CAPTURE && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      const out = {
        note: "#23 P-B compat golden — captured on UNMODIFIED dev (pre epoch.up.v1). Never regenerate to fix a diff.",
        scenarios: fresh,
      };
      writeFileSync(FIXTURE, `${JSON.stringify(out, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), "golden missing — capture it BEFORE changing any source").toBe(true);
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as { scenarios: Record<string, ScenarioOut> };
    for (const name of ["s1-old-caps-no-hold", "s2-old-caps-with-hold"]) {
      expect(fresh[name], `${name} (bus + SSE must be byte-equal)`).toEqual(golden.scenarios[name]);
    }
  });

  it("s1: old caps without hold ⇒ reclaim with changed epoch publishes ONLY gap (agents without either cap keep the pre-feature wire)", async () => {
    const out = await runScenario(SCENARIOS["s1-old-caps-no-hold"]!);
    expect(types(out.busEvents)).toEqual(["agent_up", "gap"]);
    const frames = out.sse.split("\n\n").filter((b) => b.length > 0);
    const names = frames.map((f) => /event: (\S+)/.exec(f)?.[1]);
    expect(names).toEqual(["hello", "hub", "agents", "agent_up", "history", "gap"]);
  });

  it("s2: old caps with hold.v1 ⇒ agent_up (new epoch) BEFORE gap, unchanged from Y7.2", async () => {
    const out = await runScenario(SCENARIOS["s2-old-caps-with-hold"]!);
    expect(types(out.busEvents)).toEqual(["agent_up", "agent_up", "gap"]);
    const names = out.sse
      .split("\n\n")
      .filter((b) => b.length > 0)
      .map((f) => /event: (\S+)/.exec(f)?.[1]);
    expect(names).toEqual(["hello", "hub", "agents", "agent_up", "history", "agent_up", "gap"]);
    const up = out.busEvents[1]!;
    expect(up.type === "agent_up" && up.agent.epoch).toBe("e-new");
  });

  it("s3 (new hub × new agent): a reclaim carrying epoch.up.v1 without hold.v1 ⇒ agent_up (new epoch) then gap — the #23 D14 condition", async () => {
    // NOT compared against the golden: the golden's s3 records the OLD hub's answer (gap only +
    // the hub-internal caps bus event), which is exactly what an un-upgraded hub still does.
    const out = await runScenario(SCENARIOS["s3-old-hub-new-agent"]!);
    expect(types(out.busEvents)).toEqual(["agent_up", "agent_up", "gap", "caps"]);
    const names = out.sse
      .split("\n\n")
      .filter((b) => b.length > 0)
      .map((f) => /event: (\S+)/.exec(f)?.[1]);
    expect(names).toEqual(["hello", "hub", "agents", "agent_up", "history", "agent_up", "gap"]);
    const up = out.busEvents[1]!;
    expect(up.type === "agent_up" && up.agent.epoch).toBe("e-new");
  });

  it("golden s3 stays archived as the OLD-hub evidence: gap-only + hub-internal caps event, no agent_up after the first register", async () => {
    expect(existsSync(FIXTURE), "golden missing — capture it BEFORE changing any source").toBe(true);
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as { scenarios: Record<string, ScenarioOut> };
    const s3 = golden.scenarios["s3-old-hub-new-agent"]!;
    expect(types(s3.busEvents)).toEqual(["agent_up", "gap", "caps"]);
    // exactly ONE agent_up — the initial register. The reclaim itself must stay silent on an
    // old hub: no second card event, no epoch refresh for the unknown cap.
    expect(s3.sse.match(/event: agent_up/g)?.length).toBe(1);
    expect(s3.sse).toContain("event: gap");
  });

  it("is deterministic: two fresh s1 runs are byte-identical", async () => {
    const first = await runScenario(SCENARIOS["s1-old-caps-no-hold"]!);
    const second = await runScenario(SCENARIOS["s1-old-caps-no-hold"]!);
    expect(second).toEqual(first);
  });
});
