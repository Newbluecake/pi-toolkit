/** r2 cross-process acceptance: actual wireWebHub/UDS/HTTP/SSE/local proof/Python PTY.
 * Only fake-pi and audited uid/rc DI; no target/receipt/proof replacement. */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedMachine, cardFor, drained, LIMITS } from "./web-hub-terminal-compat-baseline.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { login, openSse, postJson } from "../web-hub/http/helpers.js";
import { TERMINAL_HTTP_PATHS } from "../../src/web-hub/protocol/terminal-paths.js";

const machines: ReturnType<typeof isolatedMachine>[] = [];
const machine = (enabled = true, limits: object = {}) => {
  const m = isolatedMachine(enabled, limits);
  machines.push(m);
  return m;
};
afterEach(async () => {
  for (const m of machines.splice(0).reverse()) await m.close();
});
const journal = (h: any) =>
  JSON.parse(readFileSync(join(h.paths.stateDir, "terminal-v1", "terminal-resource-fence-v1.json"), "utf8"));
async function pwd(b: any, card: any, a: any, expected: string, tag: string) {
  await b.input(card, a, `printf '${tag}=%s:%s\\n' "$$" "$(pwd -P)"\n`);
  await waitUntil(
    () => new RegExp(`${tag}=\\d+:${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n`).test(b.output(a.termId)),
    5000,
    "canonical PTY cwd",
  );
  return Number(new RegExp(`${tag}=(\\d+):`).exec(b.output(a.termId))![1]);
}
describe("#45 real per-session terminal", () => {
  it("T1/T4: machine-on no launch terminal; two independent agent cwd snapshots, third process cwd", async () => {
    const m = machine();
    const h = await m.hub(undefined, { source: "plain" });
    expect(h.caps).toEqual(expect.arrayContaining(["terminal.ui.v1", "terminal.session.v1"]));
    expect(journal(h).resources).toEqual([]);
    const a = await m.agent(undefined, { sessionId: "A" }),
      b = await m.agent(undefined, { sessionId: "B" });
    const ca = await cardFor(h, "A"),
      cb = await cardFor(h, "B");
    expect(ca.agentId.pid).toBe(a.peer.child.pid);
    expect(cb.agentId.pid).toBe(b.peer.child.pid);
    expect(ca.agentId.pid).not.toBe(cb.agentId.pid);
    expect(h.pid).not.toBe(process.pid);
    expect((await a.peer.command("snapshot")).processCwd).toBe(m.processCwd);
    expect((await b.peer.command("snapshot")).processCwd).toBe(m.processCwd);
    const browser = await m.browser(h),
      ta = await browser.open(ca),
      tb = await browser.open(cb);
    const pa = await pwd(browser, ca, ta, realpathSync(a.fixture.cwd), "A_PWD");
    const pb = await pwd(browser, cb, tb, realpathSync(b.fixture.cwd), "B_PWD");
    expect(pa).not.toBe(pb);
    expect(existsSync(`/proc/${pa}/stat`)).toBe(true);
    expect(a.fixture.cwd).not.toBe(m.processCwd);
    expect(b.fixture.cwd).not.toBe(m.home);
    const rev = journal(h).revision;
    await browser.close(ca, ta);
    await browser.close(cb, tb);
    await drained(h, rev + 2);
    expect(existsSync(`/proc/${pa}/stat`)).toBe(false);
    expect(existsSync(`/proc/${pb}/stat`)).toBe(false);
    expect((await a.peer.command("snapshot")).resources).toBe(0);
    expect((await b.peer.command("snapshot")).resources).toBe(0);
  }, 90000);
  it.each(["denied", undefined, "secure", "locked"])(
    "T2: machine-on source %s cannot later become enabled",
    async (source) => {
      const m = machine();
      const h = await m.hub(undefined, { ...(source === undefined ? {} : { source }) });
      expect(existsSync(join(h.paths.stateDir, "terminal-v1"))).toBe(false);
      const a = await m.agent(undefined, { sessionId: "A" });
      await cardFor(h, "A", false);
      expect(h.caps).not.toContain("terminal.ui.v1");
      const status = JSON.parse(readFileSync(h.paths.hubJson, "utf8")).terminal;
      expect(status).toMatchObject({
        state: "unavailable",
        reason: source === "denied" ? "startup-domain-denied" : "startup-domain-unknown",
      });
      const cookie = await login(h.port, h.paths.tokenFile);
      expect(
        (
          await postJson(
            h.port,
            TERMINAL_HTTP_PATHS.prepare,
            {},
            { Cookie: cookie, Origin: `http://127.0.0.1:${h.port}` },
          )
        ).status,
      ).toBe(404);
      // An eligible agent initializes its own local journal/authority independently.
      expect((await a.peer.command("snapshot")).backendCount).toBe(0);
    },
    30000,
  );
  it("T3 conflict: legal machine-off strips legacy launch terminal without storage/cap; unknown source is unavailable, not off", async () => {
    const m = machine(false),
      h = await m.hub(undefined, { source: "plain", legacy: true });
    expect(h.caps).not.toContain("terminal.ui.v1");
    expect(JSON.parse(readFileSync(h.paths.hubJson, "utf8"))).not.toHaveProperty("terminal");
    expect(existsSync(join(h.paths.stateDir, "terminal-v1"))).toBe(false);
    const cookie = await login(h.port, h.paths.tokenFile);
    expect(
      (
        await postJson(
          h.port,
          TERMINAL_HTTP_PATHS.prepare,
          {},
          { Cookie: cookie, Origin: `http://127.0.0.1:${h.port}` },
        )
      ).status,
    ).toBe(404);
  });
  it("T5: current ctx cwd affects new opens only; same process session boundary adopts new cwd", async () => {
    const m = machine(),
      h = await m.hub(undefined, { source: "plain" }),
      a = await m.agent();
    let card = await cardFor(h, a.sessionId);
    const b = await m.browser(h),
      first = await b.open(card);
    const pid = await pwd(b, card, first, realpathSync(a.fixture.cwd), "BEFORE");
    const nextCwd = join(a.fixture.root, "next");
    mkdirSync(nextCwd, { mode: 0o700 });
    await a.peer.command("cwd", { cwd: nextCwd });
    const second = await b.open(card);
    await pwd(b, card, second, realpathSync(nextCwd), "NEW");
    expect(await pwd(b, card, first, realpathSync(a.fixture.cwd), "UNCHANGED")).toBe(pid);
    await b.close(card, first);
    await b.close(card, second);
    await drained(h);
    await a.peer.command("session", { sessionId: "switched", cwd: nextCwd });
    card = await cardFor(h, "switched");
    const third = await b.open(card);
    await pwd(b, card, third, realpathSync(nextCwd), "SWITCHED");
    expect(card.agentId.pid).toBe(a.peer.child.pid);
    await b.close(card, third);
    await drained(h);
    expect((await a.peer.command("snapshot")).backendCount).toBe(3);
  }, 90000);
  it.each([false, true])(
    "T6: first reconnect raw status cannot replay a positive declaration (throws=%s)",
    async (guardThrows) => {
      const m = machine(),
        h = await m.hub(undefined, { source: "plain" }),
        a = await m.agent();
      await cardFor(h, a.sessionId);
      expect(
        a.peer.messages.filter((x) => x.event === "status-write").some((x) => JSON.parse(x.raw).terminalSession),
      ).toBe(true);
      await h.peer.close();
      await a.peer.command("guard", { allowed: false, throws: guardThrows });
      const before = a.peer.messages.length;
      const h2 = await m.hub(undefined, { source: "plain" });
      await cardFor(h2, a.sessionId, false);
      const statuses = a.peer.messages.slice(before).filter((x) => x.event === "status-write");
      expect(statuses.length).toBeGreaterThan(0);
      expect(JSON.parse(statuses[0].raw)).not.toHaveProperty("terminalSession");
      expect(statuses.every((x) => !JSON.parse(x.raw).terminalSession)).toBe(true);
      expect((await a.peer.command("snapshot")).backendCount).toBe(0);
    },
    40000,
  );
  it("T7: restart rejects old cookie as terminal proof; real new login restores open", async () => {
    const m = machine(),
      h = await m.hub(undefined, { source: "plain" }),
      a = await m.agent();
    let card = await cardFor(h, a.sessionId);
    const b = await m.browser(h),
      first = await b.open(card);
    await b.close(card, first);
    await drained(h);
    b.sse.close();
    await h.peer.close();
    const h2 = await m.hub(undefined, { source: "plain" });
    card = await cardFor(h2, a.sessionId);
    const stale = await postJson(
      h2.port,
      TERMINAL_HTTP_PATHS.prepare,
      {
        ...b.identity,
        agentKey: card.agentKey,
        expect: { sessionId: card.session.sessionId, epoch: card.epoch },
        cols: 80,
        rows: 24,
      },
      { Cookie: b.cookie, Origin: `http://127.0.0.1:${h2.port}` },
    );
    expect(stale.status).not.toBe(200);
    expect((await a.peer.command("snapshot")).backendCount).toBe(1);
    const fresh = await m.browser(h2);
    const second = await fresh.open(card);
    await fresh.close(card, second);
    await drained(h2);
    expect((await a.peer.command("snapshot")).backendCount).toBe(2);
  }, 90000);
  it("T9/T11: same actual SSE A→zero→B keeps boot binding; stale A ticket denies, no extra fork", async () => {
    const m = machine(),
      h = await m.hub(undefined, { source: "plain" }),
      a = await m.agent(undefined, { sessionId: "A" });
    const ca = await cardFor(h, "A"),
      browser = await m.browser(h),
      ta = await browser.open(ca);
    const ticket = await browser.post(ca, "prepare", { cols: 80, rows: 24 });
    expect(ticket.status).toBe(200);
    await browser.close(ca, ta);
    await drained(h);
    await a.peer.command("guard", { allowed: false });
    await waitUntil(
      () => a.peer.messages.filter((x) => x.event === "status-write").some((x) => !JSON.parse(x.raw).terminalSession),
      3000,
    );
    expect(
      (
        await browser.post(ca, "open", {
          openId: ticket.body.openId,
          createTicket: ticket.body.createTicket,
          tabId: "stale",
          cols: 80,
          rows: 24,
        })
      ).status,
    ).not.toBe(200);
    const zero = await h.peer.command("snapshot");
    expect(zero.cards.every((c: any) => !c.status?.terminalSession)).toBe(true);
    expect(browser.sse.ended).toBe(false);
    expect(zero.caps).toEqual(h.caps);
    const b = await m.agent(undefined, { sessionId: "B" }),
      cb = await cardFor(h, "B"),
      tb = await browser.open(cb);
    await pwd(browser, cb, tb, realpathSync(b.fixture.cwd), "B_AFTER_ZERO");
    expect(browser.sse.events.filter((e) => e.event === "terminal_connection")).toHaveLength(1);
    expect(browser.sse.events.filter((e) => e.event === "hello")).toHaveLength(1);
    expect((await a.peer.command("snapshot")).backendCount).toBe(1);
    await browser.close(cb, tb);
    await drained(h);
  }, 90000);
  it("T10: one principal across independent agents uses machine ceiling, not their conflicting globals", async () => {
    const m = machine(true, { maxTotal: 2, maxPerPrincipal: 2 }),
      h = await m.hub(undefined, { source: "plain" });
    const a = await m.agent(undefined, { sessionId: "A", limits: { maxTotal: 1, maxPerPrincipal: 1 } }),
      b = await m.agent(undefined, { sessionId: "B", limits: { maxTotal: 32, maxPerPrincipal: 8 } });
    const ca = await cardFor(h, "A"),
      cb = await cardFor(h, "B"),
      browser = await m.browser(h);
    const ta = await browser.open(ca),
      tb = await browser.open(cb);
    const ticket = await browser.post(cb, "prepare", { cols: 80, rows: 24 });
    expect(ticket.status).toBe(200);
    const denied = await browser.post(cb, "open", {
      openId: ticket.body.openId,
      createTicket: ticket.body.createTicket,
      tabId: "over",
      cols: 80,
      rows: 24,
    });
    expect(denied.body).toMatchObject({ ok: false, code: "E_LIMIT" });
    expect((await a.peer.command("snapshot")).backendCount + (await b.peer.command("snapshot")).backendCount).toBe(2);
    expect(journal(h).resources).toHaveLength(2);
    await browser.close(ca, ta);
    await browser.close(cb, tb);
    await drained(h);
  }, 90000);
  it.each(["missing", "file", "no-access"])(
    "T14: %s cwd fails fixed-error with zero helper/fallback",
    async (fault) => {
      const m = machine(),
        h = await m.hub(undefined, { source: "plain" }),
        a = await m.agent(),
        card = await cardFor(h, a.sessionId),
        b = await m.browser(h);
      expect(process.getuid!()).not.toBe(0);
      // Prime the real backend constructor with its audited isolated uid/rc.
      const good = await b.open(card);
      await b.close(card, good);
      await drained(h);
      await a.peer.command("validated-constructor");
      const before = await a.peer.command("snapshot");
      const bad = join(a.fixture.root, fault);
      if (fault === "file") writeFileSync(bad, "not directory");
      if (fault === "no-access") {
        mkdirSync(bad, { mode: 0o700 });
        chmodSync(bad, 0o600);
      }
      await a.peer.command("cwd", { cwd: bad });
      const p = await b.post(card, "prepare", { cols: 80, rows: 24 });
      expect(p.status).toBe(200);
      const o = await b.post(card, "open", {
        openId: p.body.openId,
        createTicket: p.body.createTicket,
        tabId: "bad",
        cols: 80,
        rows: 24,
      });
      expect(o.status).not.toBe(200);
      expect(o.body).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
      if (fault === "no-access") chmodSync(bad, 0o700);
      const state = await a.peer.command("snapshot");
      expect(state.managed).toEqual(before.managed);
      expect(state.backendSuccesses).toBe(1);
      expect(state.backendCount).toBe(2);
    },
    30000,
  );
});

describe("T8 real boot privacy → history fork → actual fake-pi child", () => {
  it.each(["healthy", "degraded", "mark-failure"])(
    "privacy=false terminal=true %s",
    async (fault) => {
      expect(process.getuid!()).not.toBe(0);
      const m = machine(),
        state = join(m.home, ".pi/agent/web-hub"),
        cwd = join(m.home, "project"),
        sessions = join(m.home, ".pi/agent/sessions/d1");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      mkdirSync(cwd, { mode: 0o700 });
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(sessions, "a.jsonl"),
        `${JSON.stringify({ type: "session", version: 3, id: "locked-source", cwd, timestamp: new Date().toISOString() })}\n`,
      );
      writeFileSync(
        join(state, "privacy.json"),
        fault === "degraded" ? "{corrupt" : JSON.stringify({ version: 1, locked: { "locked-source": true } }),
        { mode: 0o600 },
      );
      const h = await m.hub(undefined, { source: "plain", spawn: true });
      expect(h.caps).toContain("terminal.session.v1");
      expect(h.caps).not.toContain("privacy.v1");
      const cookie = await login(h.port, h.paths.tokenFile),
        headers = { Cookie: cookie, Origin: `http://127.0.0.1:${h.port}` };
      // Public privacy routes intentionally stay off despite the internal store.
      expect((await postJson(h.port, "/api/privacy/lock", {}, headers)).status).toBe(404);
      if (fault === "mark-failure") mkdirSync(join(state, "privacy.json.tmp"), { mode: 0o700 });
      try {
        const response = await postJson(
          h.port,
          "/api/headless",
          {
            id: "forkprivacy0123456789",
            cwd,
            confirm: true,
            expectCwd: cwd,
            session: { key: "d1/a.jsonl", id: "locked-source", mode: "fork" },
          },
          headers,
        );
        expect(response.status, response.body).toBe(fault === "healthy" ? 202 : 500);
        if (fault === "healthy") {
          await waitUntil(() => existsSync(join(cwd, ".privacy-entry.json")), 10000, "real fork child entry");
          const observed = JSON.parse(readFileSync(join(cwd, ".privacy-entry.json"), "utf8"));
          expect(observed).toMatchObject({ marked: true });
          expect(observed.id).not.toBe("locked-source");
          expect(observed.pid).toBeGreaterThan(0);
          expect(JSON.parse(readFileSync(join(state, "privacy.json"), "utf8")).locked[observed.id]).toBe(true);
          expect(existsSync(`/proc/${observed.pid}/stat`)).toBe(true);
          console.log(`T8_REAL_CHILD ${JSON.stringify(observed)}`);
        } else {
          expect(JSON.parse(response.body)).toEqual({ error: "E_INTERNAL" });
          expect(existsSync(join(cwd, ".privacy-entry.json"))).toBe(false);
          expect(existsSync(join(state, "spawns.json"))).toBe(false);
        }
      } finally {
        /* The owned fault directory is retained until fixture teardown. */
      }
    },
    30000,
  );
});
