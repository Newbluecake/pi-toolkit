import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, list, send, until, type Peer } from "./helpers/fabric-xs-harness.js";
import { parseTakeConfirm } from "../../src/web-hub/protocol/xs-alias.js";

/**
 * alias-force-default plan §9 (AF6) integration ①–⑧ (#72): cwd-derived auto-claim, `--force` takeover, the
 * `xs_alias_evt` real-time notice, pin barrier, unnotifiable holders, tombstones, the human "decided" mark and
 * mixed old/new fleets — a REAL hub child process × 3 real activate()-built stacks over real sockets. Only the pi
 * host/provider is fake. The hub clock is injected through `StartHubDeps.now` (test fixture only, `skew` op).
 *
 * Fixture additions (tests/integration/helpers/fabric-xs-process.ts, none of them production hooks):
 *  - `XW_CWD`: the peer's working directory (the basename is what auto-claim derives the alias from);
 *  - `XW_TUI_CONFIRM=1`: a TUI-mode peer whose `ui.confirm` is recorded (`inspect().confirms`) and answered by the
 *    `confirmAnswer` op — the interactive force/take confirmation;
 *  - `XW_STRIP_V2=1` / `XW_HUB_STRIP_V2=1`: remove `xs.alias.v2` from the peer's own `hello` / `hello_ack` caps, so
 *    the other side sees a pre-v2 agent / hub ON THE WIRE (the v2 gates key on exactly that).
 */

let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 30_000);

const HUB_ALIAS = { XW_HUB_ALIAS_JSON: "{}" };
const NO_AUTO = { XW_ALIAS_JSON: '{"autoFromCwd":false}' };
const DAY_MS = 86_400_000;

/** Boot agents SEQUENTIALLY (shared HOME/settings file; UUIDv7 refs collide within ~16 ms). */
async function agents(...specs: Array<[string, Record<string, string>?]>): Promise<Peer[]> {
  const out: Peer[] = [];
  for (const [name, env] of specs) out.push(await h.boot("agent", name, undefined, true, false, env ?? {}));
  return out;
}
const cmd = (p: Peer, args: string): Promise<string> => p.rpc("cmd", { args });
const sid = async (p: Peer): Promise<string> => (await p.rpc("inspect")).sessionId;
const ref = (id: string) => id.slice(0, 12);
const notes = async (p: Peer): Promise<string[]> => (await p.rpc("inspect")).notifications as string[];
const confirms = async (p: Peer): Promise<Array<{ title: string; detail: string }>> =>
  (await p.rpc("inspect")).confirms as Array<{ title: string; detail: string }>;
const texts = async (p: Peer, text: string) =>
  ((await p.rpc("inspect")).messages as Array<{ content: string }>).filter((m) => m.content.includes(text));
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
/** Poll slower than `until` (each status read triggers a hub round trip). */
async function settle<T>(read: () => Promise<T>, accept: (v: T) => boolean, label: string): Promise<T> {
  return until(
    async () => {
      await nap(250);
      return read();
    },
    accept,
    label,
  );
}
async function sees(p: Peer, id: string, label: string): Promise<void> {
  await until(
    async () => {
      await nap(400); // stay under the hub's listPerMin
      return ((await list(p)).rows as Array<{ ref: string }> | undefined) ?? [];
    },
    (rows) => rows.some((r) => r.ref === ref(id)),
    label,
  );
}
function findFile(root: string, name: string): string | undefined {
  const hit = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).find(
    (f) => f === name || f.endsWith(`/${name}`),
  );
  return hit === undefined ? undefined : join(root, hit);
}
interface AliasFile {
  records: Array<{ alias: string; sessionId: string; state: string; origin?: string }>;
  tombstones: Array<{ sessionId: string; alias: string; reason: string; forced?: boolean }>;
}
/** The hub's persisted binding table (undefined until the first write). */
function aliasTable(): AliasFile | undefined {
  const f = findFile(h.home, "xs-aliases.json");
  return f === undefined ? undefined : (JSON.parse(readFileSync(f, "utf8")) as AliasFile);
}
const holderOf = (alias: string): string | undefined =>
  aliasTable()?.records.find((r) => r.alias === alias && r.state === "held")?.sessionId;
async function hubAgent(hub: Peer, id: string): Promise<{ agentKey: string; online?: boolean }> {
  const a = (
    (await hub.rpc("inspect")).agents as Array<{ agentKey: string; online?: boolean; session?: { sessionId?: string } }>
  ).find((x) => x.session?.sessionId === id);
  if (a === undefined) throw new Error(`hub does not know ${id}`);
  return a;
}
/** Session frames the hub received from one agent — a (re)connect or re-attach re-sends the session slot. */
async function sessionFrames(hub: Peer, key: string): Promise<number> {
  return ((await hub.rpc("inspect")).slotFrames as Array<{ key: string; t: string }>).filter(
    (f) => f.key === key && f.t === "session",
  ).length;
}
/** SIGKILL a peer and wait until the hub marks it offline (it must not be treated as an online holder). */
async function killAndWait(hub: Peer, p: Peer, id: string): Promise<{ file: string }> {
  const { sessionFile } = await p.rpc("inspect");
  await p.kill();
  await until(
    async () =>
      ((await hub.rpc("inspect")).agents as Array<{ session?: { sessionId?: string }; online?: boolean }>) ?? [],
    (now) => !now.some((a) => a.session?.sessionId === id && a.online !== false),
    "hub notices the holder is gone",
  );
  return { file: sessionFile };
}
const mkcwd = (name: string): string => {
  const dir = join(h.home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
/** Run `fn` while a resolve of `B` is held at its agent (the pin is taken, `send` not yet issued). */
async function withHeldResolve(b: Peer, text: string, to: string, whileHeld: () => Promise<void>) {
  await b.rpc("holdResolve");
  const resolved = b.event("resolved");
  const pending = send(b, to, text);
  await resolved;
  await whileHeld();
  await b.rpc("releaseResolve");
  return pending;
}

describe("alias-force-default §9 (AF6): auto-claim and forced takeover over a real hub", () => {
  it("①②④ concurrent same-cwd auto-claim → one winner, others skip:taken; D5 hint; --force (TUI) → real-time forced notice without reconnect; tombstone blocks re-claim for 30 days", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const env = { XW_UI: "1", XW_TUI_CONFIRM: "1", XW_CWD: mkcwd("payments") };
    const peers = (await agents(["alpha", env], ["beta", env], ["gamma", env])) as [Peer, Peer, Peer];
    const ids = await Promise.all(peers.map(sid));
    // ① all three join at once: they race to the same free name; the hub's single writer lets exactly one win.
    await Promise.all(peers.map((p) => cmd(p, "join")));
    const states = await settle(
      () => Promise.all(peers.map((p) => cmd(p, "status"))),
      (s) =>
        s.filter((t) => /alias @payments held \(auto\)/.test(t)).length === 1 &&
        s.filter((t) => /alias - · auto skip:taken/.test(t)).length === 2,
      "one winner, two auto skip:taken",
    );
    const w = states.findIndex((t) => /held \(auto\)/.test(t));
    const [l1, l2] = [0, 1, 2].filter((i) => i !== w) as [number, number];
    const [winner, loser1, loser2] = [peers[w]!, peers[l1]!, peers[l2]!];
    const [wid, l1id, l2id] = [ids[w]!, ids[l1]!, ids[l2]!];
    expect(holderOf("payments")).toBe(wid);
    expect(aliasTable()!.records.find((r) => r.alias === "payments")).toMatchObject({ origin: "auto" });
    expect((await notes(winner)).filter((n) => n.includes("已按目录名自动设置别名 @payments"))).toHaveLength(1);
    for (const l of [loser1, loser2])
      expect((await notes(l)).some((n) => n.includes("已按目录名自动设置别名"))).toBe(false); // skipped silently
    // D5: a human `set` on the auto-claimed name is a plain "taken", pointing at --force.
    const taken = await cmd(loser1, "alias payments");
    expect(taken).toMatch(/占用/);
    expect(taken).toContain("/fabric alias payments --force");
    // `--take` on an ONLINE holder is refused too, with the same pointer.
    expect(await cmd(loser1, "alias payments --take")).toMatch(/在线.*--force/);
    expect(holderOf("payments")).toBe(wid);

    // ② force (TUI confirm). The winner is online, so it must be told in real time — on its LIVE link.
    const winnerKey = (await hubAgent(hub, wid)).agentKey;
    const framesBefore = await sessionFrames(hub, winnerKey);
    const forced = await cmd(loser1, "alias payments --force");
    expect(forced).toContain("已抢占别名");
    const dialog = (await confirms(loser1)).at(-1)!;
    expect(dialog.title).toBe("强制抢占别名「payments」？");
    expect(dialog.detail).toContain("（自动认领）");
    expect(dialog.detail).toContain("当前在线");
    expect(holderOf("payments")).toBe(l1id);
    expect(aliasTable()!.records.find((r) => r.alias === "payments")!.origin).toBeUndefined(); // human-granted
    expect(aliasTable()!.tombstones).toContainEqual(
      expect.objectContaining({ sessionId: wid, alias: "payments", reason: "taken", forced: true }),
    );
    const lostNotes = await settle(
      () => notes(winner),
      (n) => n.some((t) => t.includes("强制抢占")),
      "the evicted holder is told in real time",
    );
    expect(lostNotes.filter((t) => t.includes("强制抢占"))).toHaveLength(1);
    expect(lostNotes.find((t) => t.includes("强制抢占"))).toContain("对方已人工确认");
    expect(await cmd(winner, "status")).toMatch(/alias - \(lost: taken\)/);
    // no reconnect and no re-attach: the notice rode the existing link (xs_alias_evt → reconcile).
    expect((await winner.rpc("inspect")).conn.state).toBe("live");
    expect(await sessionFrames(hub, winnerKey)).toBe(framesBefore);
    expect(await cmd(loser1, "status")).toMatch(/alias @payments held · lease/);
    expect(await cmd(loser1, "status")).not.toContain("(auto)");

    // ⑦ tombstone: the evicted session never auto-claims again within 30 days — even when the name is free.
    expect(await cmd(loser1, "alias --clear")).toContain("已清除");
    await hub.rpc("skew", { ms: 11 * 60_000 }); // cooling(l1) is over; the name is free, the tombstone is not
    await winner.rpc("reload");
    await settle(
      () => cmd(winner, "status"),
      (t) => /auto skip:taken/.test(t),
      "evicted session skips auto (tombstone)",
    );
    expect(holderOf("payments")).toBeUndefined();
    // control: the other loser has no tombstone and DOES claim the free name on its next join.
    await loser2.rpc("reload");
    await settle(
      () => cmd(loser2, "status"),
      (t) => /alias @payments held \(auto\)/.test(t),
      "a session without a tombstone claims the free name",
    );
    expect(holderOf("payments")).toBe(l2id);
    // 30 days later the tombstone is gone: free the name again, the formerly evicted session may claim.
    expect(await cmd(loser2, "alias --clear")).toContain("已清除");
    await hub.rpc("skew", { ms: 31 * DAY_MS });
    await winner.rpc("reload");
    await settle(
      () => cmd(winner, "status"),
      (t) => /alias @payments held \(auto\)/.test(t),
      "tombstone aged out ⇒ auto-claim allowed again",
    );
    expect(holderOf("payments")).toBe(wid);
  }, 240_000);

  it("③ pin barrier: a send resolved BEFORE a force still reaches the original holder; with the original holder offline it is NO_TARGET — never the new holder", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const env = { ...NO_AUTO, XW_UI: "1", XW_TUI_CONFIRM: "1" };
    const [a, b, c] = (await agents(["alpha", env], ["beta", env], ["gamma", env])) as [Peer, Peer, Peer];
    const [aid, , cid] = await Promise.all([a, b, c].map(sid));
    await Promise.all([a, b, c].map((p) => cmd(p, "join")));
    await sees(b, aid, "B sees A");
    expect(await cmd(a, "alias 前端")).toContain("前端");
    // round 1: B resolves 前端 → A, THEN C forces it away, THEN B's send is issued: it goes to A (the pin).
    const r1 = await withHeldResolve(b, "pinned to the first holder", "前端", async () => {
      expect(await cmd(c, "alias 前端 --force")).toContain("已抢占别名");
      expect(holderOf("前端")).toBe(cid);
    });
    expect(r1).toMatchObject({ effect: "applied" });
    expect(await texts(a, "pinned to the first holder")).toHaveLength(1);
    expect(await texts(c, "pinned to the first holder")).toHaveLength(0);
    await settle(
      () => notes(a),
      (n) => n.some((t) => t.includes("强制抢占")),
      "A learns it was evicted",
    );
    // round 2: B resolves 前端 → C; A forces it back from C; C DIES before B's send is issued ⇒ NO_TARGET.
    const r2 = await withHeldResolve(b, "must never reach the new holder", "前端", async () => {
      expect(await cmd(a, "alias 前端 --force")).toContain("已抢占别名");
      expect(holderOf("前端")).toBe(aid);
      await killAndWait(hub, c, cid);
    });
    expect(r2).toMatchObject({ status: "no_target", effect: "none" });
    expect(await texts(a, "must never reach the new holder")).toHaveLength(0);
    expect(((await hub.rpc("inspect")).deliveries as unknown[]).length).toBe(1); // only round 1 ever hit the wire
  }, 150_000);

  it("⑤ web force under webCommandPolicy.fabric=confirm: preview and execution each need their own confirm; the confirm line is parseable; the holder is told", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [holder, web] = (await agents(
      ["holder", { ...NO_AUTO, XW_UI: "1" }],
      ["web", { ...NO_AUTO, XW_WEB_POLICY_JSON: '{"fabric":"confirm"}', XW_RUN_SLASH: "1" }],
    )) as [Peer, Peer];
    const [hid, wid] = await Promise.all([holder, web].map(sid));
    await Promise.all([holder, web].map((p) => cmd(p, "join")));
    await sees(web, hid, "web session sees the holder");
    expect(await cmd(holder, "alias 前端")).toContain("前端");
    const wcmd = (args: string, confirm: boolean) =>
      hub.rpc("webCmd", { sessionId: wid, args, name: "fabric", confirm }) as Promise<{
        first: unknown;
        final: unknown;
      }>;
    expect(JSON.stringify(await wcmd("alias 前端 --force", false))).toContain("E_CONFIRM_REQUIRED");
    const preview = capturedOutput((await wcmd("alias 前端 --force", true)).final);
    expect(preview).toContain("强制抢占别名「前端」？");
    expect(preview).toContain("当前在线");
    const confirm = parseTakeConfirm(preview);
    expect(confirm).toMatchObject({ alias: "前端" });
    expect(holderOf("前端")).toBe(hid); // a preview changes nothing
    expect(JSON.stringify(await wcmd(`alias 前端 --take=${confirm!.token}`, false))).toContain("E_CONFIRM_REQUIRED");
    expect(capturedOutput((await wcmd(`alias 前端 --take=${confirm!.token}`, true)).final)).toContain("已抢占");
    expect(holderOf("前端")).toBe(wid);
    await settle(
      () => notes(holder),
      (n) => n.some((t) => t.includes("强制抢占")),
      "the web-forced holder is told",
    );
    expect(wid.length).toBeGreaterThan(0);
  }, 90_000);

  it("⑧a unnotifiable holders: an online pre-v2 agent and a linked holder with xs off refuse --force (take only); a just-offline holder can be forced but not taken; the old agent returns to the legacy notice", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [old, x, linked] = (await agents(
      ["old", { ...NO_AUTO, XW_UI: "1", XW_STRIP_V2: "1" }],
      ["xeno", { ...NO_AUTO, XW_UI: "1", XW_TUI_CONFIRM: "1" }],
      ["linked", { ...NO_AUTO, XW_UI: "1" }],
    )) as [Peer, Peer, Peer];
    const [oldId, xid, linkedId] = await Promise.all([old, x, linked].map(sid));
    await Promise.all([old, x, linked].map((p) => cmd(p, "join")));
    await sees(x, oldId, "X sees the pre-v2 agent");
    expect(await cmd(old, "alias legacy1")).toContain("legacy1");
    // pre-v2 holder ONLINE (a pre-v2 hello cannot receive the real-time notice) ⇒ force refused, nothing confirmed.
    expect(await cmd(x, "alias legacy1 --force")).toMatch(/无法实时通知.*--take/);
    expect(await confirms(x)).toHaveLength(0);
    expect(await cmd(x, "alias legacy1 --take")).toMatch(/在线/);
    expect(holderOf("legacy1")).toBe(oldId);
    // it dies: offline for seconds ⇒ take is "不足 10 分钟" but force goes through (nobody to notify live).
    const { file } = await killAndWait(hub, old, oldId);
    expect(await cmd(x, "alias legacy1 --take")).toMatch(/不足 10 分钟/);
    expect(await cmd(x, "alias legacy1 --force")).toContain("已抢占别名");
    expect(holderOf("legacy1")).toBe(xid);
    expect((await confirms(x)).at(-1)!.detail).toMatch(/已离线/);
    // the pre-v2 agent comes back: the hub writes it no v2 keys ⇒ the LEGACY "taken" notice, no "forced" wording.
    const back = await h.boot("agent", "old-back", file, true, false, { ...NO_AUTO, XW_UI: "1", XW_STRIP_V2: "1" });
    expect(await sid(back)).toBe(oldId);
    const legacy = await settle(
      () => notes(back),
      (n) => n.some((t) => t.includes("legacy1")),
      "the pre-v2 agent is told it lost the alias",
    );
    expect(legacy.filter((t) => t.includes("legacy1"))).toHaveLength(1);
    expect(legacy.join("\n")).not.toContain("强制抢占");
    expect(await cmd(back, "status")).toMatch(/alias - \(lost: taken\)/);

    // linked holder: connected to the hub with xs turned OFF — not xs-online, not notifiable ⇒ force refused.
    await sees(x, linkedId, "X sees the soon-to-be-linked holder");
    expect(await cmd(linked, "alias linked1")).toContain("linked1");
    await linked.rpc("settingsOff");
    await linked.rpc("reload");
    await until(
      async () => (await linked.rpc("inspect")).conn?.state,
      (state) => state === "live",
      "the xs-off holder is still connected to the hub",
    );
    await x.rpc("confirmAnswer", { answer: false }); // never execute while we wait for the hub to notice xs is off
    await settle(
      () => cmd(x, "alias linked1 --force"),
      (t) => /无法实时通知/.test(t),
      "force refused for a linked holder",
    );
    expect(holderOf("linked1")).toBe(linkedId);
    await hub.rpc("skew", { ms: 11 * 60_000 });
    expect(await cmd(x, "alias linked1 --force")).toMatch(/无法实时通知/); // still linked after 10 min
    await x.rpc("confirmAnswer", { answer: true });
    expect(await cmd(x, "alias linked1 --take")).toContain("已抢占别名"); // take only looks at xs presence
    expect(holderOf("linked1")).toBe(xid);
  }, 240_000);

  it("⑥ the human 'decided' mark survives /reload and a hub restart: a session that cleared its alias never auto-claims again (a fresh session in the same dir does)", async () => {
    h = new XsHarness();
    let hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const env = { XW_CWD: mkcwd("ledger") };
    const [x] = (await agents(["xray", env])) as [Peer];
    const xid = await sid(x);
    await cmd(x, "join");
    await settle(
      () => cmd(x, "status"),
      (t) => /alias @ledger held \(auto\)/.test(t),
      "auto-claim",
    );
    expect(await cmd(x, "alias --clear")).toContain("已关闭本会话的目录名自动别名");
    // the mark is a session entry, written before the request left.
    const { sessionFile } = await x.rpc("inspect");
    expect(readFileSync(sessionFile, "utf8")).toContain("subagent:xs-alias-decided");
    // hub restart (the table persists, the hub clock restarts), then past the cooling window, then /reload.
    await hub.kill();
    hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    await until(
      async () => ((await hub.rpc("inspect")).agents as Array<{ session?: { sessionId?: string } }>) ?? [],
      (a) => a.some((r) => r.session?.sessionId === xid),
      "X reconnects to the restarted hub",
    );
    await hub.rpc("skew", { ms: 11 * 60_000 });
    await x.rpc("reload");
    await settle(
      () => cmd(x, "status"),
      (t) => /alias - · auto skip:decided/.test(t),
      "decided mark restored from the session entries",
    );
    // control: the name is genuinely free — a brand-new session in the same directory claims it.
    const [y] = (await agents(["yankee", env])) as [Peer];
    const yid = await sid(y);
    await cmd(y, "join");
    await settle(
      () => cmd(y, "status"),
      (t) => /alias @ledger held \(auto\)/.test(t),
      "a fresh session in the same dir auto-claims the free name",
    );
    expect(holderOf("ledger")).toBe(yid);
    expect(holderOf("ledger")).not.toBe(xid);
  }, 150_000);

  it("⑧b v1-only hub × new agents: no auto-claim, no force, no v2 hint — plain aliasing and delivery by alias keep working, no frame is lost", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, { ...HUB_ALIAS, XW_HUB_STRIP_V2: "1" });
    const env = { XW_UI: "1", XW_TUI_CONFIRM: "1", XW_CWD: mkcwd("payments") };
    const [a, b] = (await agents(["alpha", env], ["beta", env])) as [Peer, Peer];
    const [aid, bid] = await Promise.all([a, b].map(sid));
    await Promise.all([a, b].map((p) => cmd(p, "join")));
    await sees(a, bid, "A sees B");
    await sees(b, aid, "B sees A");
    await nap(1500); // time an auto-claim would have needed
    for (const p of [a, b]) expect(await cmd(p, "status")).toMatch(/alias -$/m); // no `auto skip:` suffix on an old hub
    expect(holderOf("payments")).toBeUndefined();
    expect(await cmd(a, "alias team-a")).toContain("team-a");
    const refused = await cmd(b, "alias team-a");
    expect(refused).toMatch(/占用/);
    expect(refused).not.toContain("--force");
    expect(await cmd(b, "alias team-a --take")).not.toContain("--force");
    expect(await cmd(b, "alias team-a --force")).toContain("hub 不支持强制抢占");
    expect(await confirms(b)).toHaveLength(0);
    expect(holderOf("team-a")).toBe(aid);
    // delivery by alias is untouched.
    expect(await send(b, "team-a", "over the v1 hub")).toMatchObject({ effect: "applied" });
    expect(await texts(a, "over the v1 hub")).toHaveLength(1);
    expect(((await hub.rpc("inspect")).deliveries as unknown[]).length).toBe(1);
  }, 120_000);

  it("⑨a /new hands the alias to the new sid (origin kept, no tombstone, human mark inherited); a human-granted name moves too; fork inherits nothing", async () => {
    h = new XsHarness();
    await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [a, f] = (await agents(
      ["alpha", { XW_UI: "1", XW_CWD: mkcwd("billing") }],
      ["forky", { XW_UI: "1", XW_CWD: mkcwd("forky") }],
    )) as [Peer, Peer];
    for (const p of [a, f]) await cmd(p, "join");
    const held = (p: Peer, name: string, auto: boolean) =>
      settle(
        () => cmd(p, "status"),
        (t) => new RegExp(`alias @${name} held`).test(t) && /\(auto\)/.test(t) === auto,
        `${name} held${auto ? " (auto)" : ""}`,
      );
    await held(a, "billing", true);
    const sid0 = await sid(a);
    expect(holderOf("billing")).toBe(sid0);

    // /new (web 「清空」 fires the same session_shutdown{new}): the alias moves to the NEW sid, still auto-origin.
    const sid1 = (await a.rpc("replace")).sessionId as string;
    expect(sid1).not.toBe(sid0);
    await held(a, "billing", true);
    expect(holderOf("billing")).toBe(sid1);
    expect(aliasTable()!.records.find((r) => r.alias === "billing")).toMatchObject({ origin: "auto", state: "held" });
    expect(aliasTable()!.records.some((r) => r.sessionId === sid0)).toBe(false); // old sid: no record, no cooling
    expect((aliasTable()!.tombstones ?? []).some((t) => t.sessionId === sid0 || t.sessionId === sid1)).toBe(false);
    // handoff is silent: the one-shot auto notice belongs to the FIRST claim only
    expect((await notes(a)).filter((n) => n.includes("已按目录名自动设置别名 @billing"))).toHaveLength(1);

    // a human-granted name moves too (origin stays absent) and the human "decided" mark rides along
    expect(await cmd(a, "alias front-desk")).toContain("front-desk");
    await held(a, "front-desk", false);
    const sid2 = (await a.rpc("replace")).sessionId as string;
    await held(a, "front-desk", false);
    expect(holderOf("front-desk")).toBe(sid2);
    expect(aliasTable()!.records.find((r) => r.alias === "front-desk")!.origin).toBeUndefined();
    expect(aliasTable()!.records.some((r) => r.sessionId === sid1 && r.state === "held")).toBe(false);
    const { sessionFile } = await a.rpc("inspect");
    expect(readFileSync(sessionFile, "utf8")).toMatch(/subagent:xs-alias-decided[^\n]*"via":"inherit"/);
    // …so even a /reload that finds the old cwd name free never auto-claims it behind the human's back
    await a.rpc("reload");
    await nap(1500);
    expect(await cmd(a, "status")).toMatch(/alias @front-desk held/);
    expect(holderOf("billing")).toBeUndefined();

    // fork: the child session gets NOTHING — the parent keeps the name, no handoff, no inherited mark
    await held(f, "forky", true);
    const parent = await sid(f);
    const child = (await f.rpc("replace", { reason: "fork" })).sessionId as string;
    expect(child).not.toBe(parent);
    await nap(2500);
    expect(holderOf("forky")).toBe(parent);
    expect(aliasTable()!.records.some((r) => r.sessionId === child)).toBe(false);
    expect(await cmd(f, "status")).not.toMatch(/alias @forky held/);
    expect((aliasTable()!.tombstones ?? []).length).toBe(0);
  }, 240_000);

  it("⑨b forged prevSessionId is refused (online and offline victims); an alias taken before the /new is not restored by it", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [v, x, z] = (await agents(
      ["victim", { XW_UI: "1", XW_CWD: mkcwd("victim-dir") }],
      ["xeno", { XW_UI: "1", XW_TUI_CONFIRM: "1", XW_CWD: mkcwd("xeno-dir") }],
      ["zulu", { XW_UI: "1", XW_CWD: mkcwd("zulu-dir") }],
    )) as [Peer, Peer, Peer];
    for (const p of [v, x, z]) await cmd(p, "join");
    for (const [p, name] of [
      [v, "victim-dir"],
      [x, "xeno-dir"],
      [z, "zulu-dir"],
    ] as const)
      await settle(
        () => cmd(p, "status"),
        (t) => new RegExp(`alias @${name} held \\(auto\\)`).test(t),
        `${name} auto`,
      );
    const [vid, xid, zid] = await Promise.all([v, x, z].map(sid));
    const unknownSid = "0190a1b2-c3d4-7000-8000-0000000000ff";
    const forge = async (prev: string, alias: string) =>
      x.rpc("rawAlias", { fields: { alias, intent: "handoff", prevSessionId: prev } });

    // FORGERY: another socket names someone else's sid as its predecessor ⇒ stale, nothing moves
    for (const prev of [vid, zid, unknownSid])
      for (const alias of ["victim-dir", "zulu-dir"])
        expect(await forge(prev, alias), `${alias}/${prev}`).toMatchObject({
          ok: false,
          code: "E_XS_ALIAS_TAKE{stale}",
        });
    expect(holderOf("victim-dir")).toBe(vid);
    expect(holderOf("zulu-dir")).toBe(zid);
    // …and the victim being gone (offline holders are exactly what a thief aims at) changes nothing
    await killAndWait(hub, v, vid);
    expect(await forge(vid, "victim-dir")).toMatchObject({ ok: false, code: "E_XS_ALIAS_TAKE{stale}" });
    expect(holderOf("victim-dir")).toBe(vid);
    expect(holderOf("xeno-dir")).toBe(xid);

    // TAKEN BEFORE the /new: zulu's alias cache is frozen (bare gets held), xeno force-takes its name, zulu `/new`s.
    // The stale cache is stashed, the new sid asks for the handoff, the hub refuses — xeno keeps the name and zulu's
    // new session does not get it back (nor steal it via auto).
    await z.rpc("holdAlias");
    expect(await cmd(x, "alias zulu-dir --force")).toContain("已抢占别名");
    expect(holderOf("zulu-dir")).toBe(xid);
    const znew = (await z.rpc("replace")).sessionId as string;
    expect(znew).not.toBe(zid);
    await z.rpc("releaseAlias");
    await nap(3000);
    expect(holderOf("zulu-dir")).toBe(xid);
    expect(aliasTable()!.records.some((r) => r.sessionId === znew)).toBe(false);
    expect(await cmd(z, "status")).not.toMatch(/alias @zulu-dir held/);
  }, 240_000);
});

/** The captured command output of a web `cmd_late` frame: `data.output.entries[].text` joined by newlines. */
function capturedOutput(frame: unknown): string {
  const entries = (frame as { data?: { output?: { entries?: Array<{ text: string }> } } } | undefined)?.data?.output
    ?.entries;
  if (entries === undefined) throw new Error(`no captured output in ${JSON.stringify(frame)}`);
  return entries.map((e) => e.text).join("\n");
}
