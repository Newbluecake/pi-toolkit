/** New→locked-old rollback uses identical on-disk state, no reset/deletion/healing. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedMachine, lockedBaseline, cardFor, drained } from "./web-hub-terminal-compat-baseline.js";
import { login, openSse, postJson } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { TERMINAL_HTTP_PATHS } from "../../src/web-hub/protocol/terminal-paths.js";
let baseline: Awaited<ReturnType<typeof lockedBaseline>>;
const machines: ReturnType<typeof isolatedMachine>[] = [];
const machine = () => {
  const m = isolatedMachine(true, { maxTotal: 1, maxPerPrincipal: 1 });
  machines.push(m);
  return m;
};
const journal = (h: any) => join(h.paths.stateDir, "terminal-v1", "terminal-resource-fence-v1.json");
const witness = (h: any) => join(h.paths.stateDir, ".terminal-initialized-v1");
const digest = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
afterEach(async () => {
  for (const m of machines.splice(0).reverse()) await m.close();
});
beforeAll(async () => {
  baseline = await lockedBaseline();
}, 240000);
describe("#45 isolated new-to-old rollback", () => {
  it("T13 clean: real drain/ACK then old cold-read, fresh login, real PTY open and reap", async () => {
    const m = machine(),
      h = await m.hub(undefined, { source: "plain" }),
      a = await m.agent(),
      card = await cardFor(h, a.sessionId),
      b = await m.browser(h);
    const t = await b.open(card);
    await b.input(card, t, 'printf "NEW_PID=%s\\n" "$$"\n');
    await waitUntil(() => /NEW_PID=\d+\r?\n/.test(b.output(t.termId)), 5000);
    const pid = Number(/NEW_PID=(\d+)/.exec(b.output(t.termId))![1]);
    const revision = JSON.parse(readFileSync(journal(h), "utf8")).revision;
    await b.close(card, t);
    await drained(h, revision + 2);
    expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
    const clean = readFileSync(journal(h), "utf8"),
      proof = digest(witness(h));
    expect(JSON.parse(clean).resources).toEqual([]);
    expect(readdirSync(join(h.paths.stateDir, "terminal-v1", "receipts"))).toEqual([]);
    await a.peer.close();
    await h.peer.close();
    const old = await m.hub(baseline.root, { legacy: true });
    expect(readFileSync(journal(old), "utf8")).toBe(clean);
    expect(digest(witness(old))).toBe(proof);
    const oa = await m.agent(baseline.root, { sessionId: "old-rollback" }),
      oc = await cardFor(old, "old-rollback", false),
      ob = await m.browser(old),
      ot = await ob.open(oc);
    await ob.input(oc, ot, 'printf "OLD_PID=%s\\n" "$$"; pwd -P\n');
    await waitUntil(
      () => /OLD_PID=\d+\r?\n/.test(ob.output(ot.termId)) && ob.output(ot.termId).includes(oa.fixture.cwd),
      5000,
    );
    const oldPid = Number(/OLD_PID=(\d+)/.exec(ob.output(ot.termId))![1]);
    expect(existsSync(`/proc/${oldPid}/stat`)).toBe(true);
    await ob.close(oc, ot);
    await drained(old);
    expect(existsSync(`/proc/${oldPid}/stat`)).toBe(false);
    expect(digest(witness(old))).toBe(proof);
  }, 90000);
  it("T13 dirty: actual unresolved row/receipt survives rollback, absent old producer cannot authorize a replacement fork", async () => {
    const m = machine(),
      h = await m.hub(undefined, { source: "plain" }),
      a = await m.agent(),
      card = await cardFor(h, a.sessionId),
      b = await m.browser(h);
    const t = await b.open(card);
    await b.input(card, t, 'printf "DIRTY_PID=%s\\n" "$$"\n');
    await waitUntil(() => /DIRTY_PID=\d+\r?\n/.test(b.output(t.termId)), 5000);
    const pid = Number(/DIRTY_PID=(\d+)/.exec(b.output(t.termId))![1]);
    // A real producer crash prevents the Node receipt writer from publishing any
    // waitpid proof. The Python helper still cleans its actual process group on EOF.
    a.peer.child.kill("SIGKILL");
    await waitUntil(() => a.peer.child.signalCode !== null, 5000, "producer actually dead");
    await waitUntil(() => !existsSync(`/proc/${pid}/stat`), 65000, "orphan helper reaps shell");
    await h.peer.close();
    expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
    const dirty = JSON.parse(readFileSync(journal(h), "utf8")),
      root = join(h.paths.stateDir, "terminal-v1"),
      receiptFiles = readdirSync(join(root, "receipts"));
    expect(dirty.resources).toHaveLength(1);
    expect(receiptFiles).toHaveLength(0);
    const witnessHash = digest(witness(h));
    const old = await m.hub(baseline.root, {
        legacy: true,
        legacyLimits: {
          maxPerSession: 2,
          maxPerPrincipal: 1,
          maxTotal: 1,
          inputIdleMs: 3600000,
          maxLifetimeMs: 28800000,
        },
      }),
      oa = await m.agent(baseline.root, { sessionId: "other-owner" }),
      oc = await cardFor(old, "other-owner", false);
    const cookie = await login(old.port, old.paths.tokenFile),
      stream = await openSse(old.port, { cookie });
    m.streams.push(stream);
    await stream.waitEnd();
    expect(stream.events.some((e) => e.event === "terminal_connection")).toBe(false);
    const prepare = await postJson(
      old.port,
      TERMINAL_HTTP_PATHS.prepare,
      { agentKey: oc.agentKey, expect: { sessionId: oc.session.sessionId, epoch: oc.epoch }, cols: 80, rows: 24 },
      { Cookie: cookie, Origin: `http://127.0.0.1:${old.port}` },
    );
    expect(prepare.status).toBe(503);
    expect(JSON.parse(prepare.body)).toMatchObject({ ok: false, code: "E_UNAVAILABLE" });
    expect((await oa.peer.command("snapshot")).backendCount).toBe(0);
    const retained = JSON.parse(readFileSync(journal(old), "utf8"));
    expect(retained.resources.map((r: any) => r.entry.identity)).toEqual(
      dirty.resources.map((r: any) => r.entry.identity),
    );
    expect(digest(witness(old))).toBe(witnessHash);
    expect(readdirSync(join(root, "receipts"))).toEqual(receiptFiles);
  }, 90000);
  it("T13 poison: old reader refuses corrupt new journal without deleting or initializing over witness", async () => {
    const m = machine(),
      h = await m.hub(undefined, { source: "plain" });
    await h.peer.close();
    const proof = digest(witness(h));
    // Explicit independent fault fixture, never modify the dirty-case evidence to clean it.
    writeFileSync(journal(h), "{broken-journal", { mode: 0o600 });
    const bytes = readFileSync(journal(h), "utf8");
    const old = await m.hub(baseline.root, { legacy: true }),
      cookie = await login(old.port, old.paths.tokenFile);
    const sse = await openSse(old.port, { cookie });
    m.streams.push(sse);
    await sse.waitEnd();
    expect(sse.events.some((e) => e.event === "terminal_connection")).toBe(false);
    const denied = await postJson(
      old.port,
      TERMINAL_HTTP_PATHS.prepare,
      {},
      { Cookie: cookie, Origin: `http://127.0.0.1:${old.port}` },
    );
    expect(denied.status).toBe(503);
    expect(JSON.parse(denied.body)).toMatchObject({ ok: false, code: "E_UNAVAILABLE" });
    expect(readFileSync(journal(old), "utf8")).toBe(bytes);
    expect(digest(witness(old))).toBe(proof);
  }, 30000);
});
