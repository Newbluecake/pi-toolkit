import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, list, send, until, type Peer } from "./helpers/fabric-xs-harness.js";
import { parseTakeConfirm } from "../../src/web-hub/protocol/xs-alias.js";

/**
 * alias-plan §9 (AL6): session aliases end to end — a real hub child (binding table on via
 * `crossSession.alias`) × 3 real activate()-built stacks over real sockets. Only the pi host/provider is
 * fake. The hub's CLOCK is injected through `StartHubDeps.now` (test fixture only — production has no hook),
 * which is how the 10-minute take threshold is crossed without sleeping.
 */

let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 30_000);

const HUB_ALIAS = { XW_HUB_ALIAS_JSON: "{}" };
/** Boot agents SEQUENTIALLY (shared HOME/settings file; UUIDv7 refs collide within ~16 ms). */
async function agents(...specs: Array<[string, Record<string, string>?]>): Promise<Peer[]> {
  const out: Peer[] = [];
  for (const [name, env] of specs) out.push(await h.boot("agent", name, undefined, true, false, env ?? {}));
  return out;
}
const cmd = (p: Peer, args: string): Promise<string> => p.rpc("cmd", { args });
const sid = async (p: Peer): Promise<string> => (await p.rpc("inspect")).sessionId;
const ref = (id: string) => id.slice(0, 12);
const mention = (p: Peer, text: string): Promise<Array<{ action: string } | null>> => p.rpc("mention", { text });
const handled = (r: Array<{ action: string } | null>) => r.some((x) => x?.action === "handled");
const texts = async (p: Peer, text: string) =>
  ((await p.rpc("inspect")).messages as Array<{ content: string }>).filter((m) => m.content.includes(text));
const aliasOf = (id: string) => async (p: Peer) =>
  ((await list(p)).rows as Array<{ ref: string; alias?: string }> | undefined)?.find((r) => r.ref === ref(id))?.alias;
async function sees(p: Peer, id: string, label: string): Promise<void> {
  await until(
    async () => {
      await new Promise((r) => setTimeout(r, 400)); // stay under the hub's listPerMin
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
/** A holder that is OFFLINE for the hub: SIGKILL, then wait until the hub marks it so (it must not be takeable "online"). */
async function killAndWait(hub: Peer, p: Peer, id: string): Promise<{ file: string }> {
  const { sessionFile } = await p.rpc("inspect");
  await p.kill();
  await until(
    async () =>
      ((await hub.rpc("inspect")).agents as Array<{ session?: { sessionId?: string }; online?: boolean }>) ?? [],
    (agentsNow) => !agentsNow.some((a) => a.session?.sessionId === id && a.online !== false),
    "hub notices the holder is gone",
  );
  return { file: sessionFile };
}

describe("alias-plan §9 (AL6): session aliases over a real hub", () => {
  it("#1 set, send by alias (sender pins the full sessionId), from.alias header, @alias, validation + conflicts", async () => {
    h = new XsHarness();
    await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [a, b, c] = (await agents(["alpha", { XW_UI: "1" }], ["beta", { XW_UI: "1" }], ["gamma"])) as [
      Peer,
      Peer,
      Peer,
    ];
    const [aid, bid, cid] = await Promise.all([a, b, c].map(sid));
    await Promise.all([a, b, c].map((p) => cmd(p, "join")));
    await sees(b, aid, "B sees A");
    await new Promise((r) => setTimeout(r, 0));
    // set / get; the status line reports held.
    expect(await cmd(a, "alias 前端")).toContain("前端");
    expect(await cmd(a, "alias")).toContain("前端");
    expect(await cmd(a, "status")).toMatch(/alias @前端 held/);
    // normalisation: full-width/@ prefix lands on the same canonical alias (idempotent for the holder).
    expect(await cmd(a, "alias @前端")).toContain("前端");
    await until(
      () => aliasOf(aid)(b),
      (al) => al === "前端",
      "B's list row carries A's alias",
    );
    // B → "前端": resolved BEFORE names, delivered to A.
    const out = await send(b, "前端", "hello by alias");
    expect(out).toMatchObject({ effect: "applied" });
    expect(JSON.stringify(out)).not.toContain(aid); // the model-visible result never carries the full sessionId
    expect(await texts(a, "hello by alias")).toHaveLength(1);
    // header: B holds an alias too ⇒ A's incoming header carries ` alias="后端"` as its own field.
    expect(await cmd(b, "alias 后端")).toContain("后端");
    await new Promise((r) => setTimeout(r, 5_200)); // pairMinIntervalMs
    expect(await send(b, "前端", "second hello")).toMatchObject({ effect: "applied" });
    const got = (await texts(a, "second hello"))[0]!;
    expect(got.content).toContain(' alias="后端"');
    // a tool's `to` that is a ref still works (exact), as does the full sessionId.
    await new Promise((r) => setTimeout(r, 5_200));
    expect(await send(b, ref(aid), "by ref")).toMatchObject({ effect: "applied" });
    // @前端 end-to-end (explicit alias mention routes through the same resolve → send).
    await new Promise((r) => setTimeout(r, 5_200)); // pairMinIntervalMs
    await until(
      async () => handled(await mention(b, "@前端 ping via mention")),
      (ok) => ok,
      "@alias routes once the directory knows the alias",
    );
    await until(
      async () => (await texts(a, "ping via mention")).length,
      (n) => n >= 1,
      "A receives the @alias message",
    );
    // validation + conflicts (all refused by the human-only /fabric alias, nothing consumed).
    expect(await cmd(c, "alias 所有人")).toMatch(/保留词/);
    expect(await cmd(c, "alias _x")).toMatch(/不允许|开头|字符/);
    expect(await cmd(c, "alias 前端")).toMatch(/占用/);
    expect(await cmd(a, "alias abc0")).toContain("abc0");
    expect(await cmd(c, "alias abco")).toMatch(/相似/); // skeleton clash (0↔o)
    expect(await cmd(c, "alias こんにちは")).toContain("こんにちは"); // kana accepted
    expect(await cmd(c, "alias 한국어")).toContain("한국어"); // hangul accepted
    expect(bid.length + cid.length).toBeGreaterThan(0);
  }, 90_000);

  it("#2 channel scope: an alias is invisible without a shared channel (NO_TARGET, no fallback to names); clear ⇒ cooling", async () => {
    h = new XsHarness();
    await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [a, b, c] = (await agents(["alpha"], ["beta"], ["gamma"])) as [Peer, Peer, Peer];
    const [aid, bid] = await Promise.all([a, b, c].map(sid));
    await cmd(a, "join #a");
    await cmd(b, "join #a");
    await cmd(c, "join"); // #default only
    await sees(b, aid, "B sees A in #a");
    expect(await cmd(a, "alias 前端")).toContain("前端");
    expect(await send(b, "前端", "same channel")).toMatchObject({ effect: "applied" });
    expect(await send(c, "前端", "other channel")).toMatchObject({ status: "no_target", effect: "none" });
    expect(await texts(a, "other channel")).toHaveLength(0);
    // a name equal to the alias must NOT catch what the alias barrier refused: C's own name layer never
    // reaches A (A is not visible to C at all).
    expect(await send(c, aid, "by id, other channel")).toMatchObject({ status: "no_target" });
    // clear ⇒ cooling(A): only A may take it back for 10 min; C cannot register it.
    expect(await cmd(a, "alias --clear")).toContain("已清除");
    expect(await cmd(c, "alias 前端")).toMatch(/占用/);
    expect(await cmd(a, "alias 前端")).toContain("前端"); // A reclaims
    expect(bid.length).toBeGreaterThan(0);
  }, 60_000);

  it("#3 take: online ⇒ refused, offline <10m ⇒ refused, ≥10m ⇒ preview → confirm token → applied; old holder is told once; sends re-route", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [a, b, c] = (await agents(["alpha"], ["beta"], ["gamma"])) as [Peer, Peer, Peer];
    const [aid, bid, cid] = await Promise.all([a, b, c].map(sid));
    await Promise.all([a, b, c].map((p) => cmd(p, "join")));
    await sees(b, aid, "B sees A");
    expect(await cmd(a, "alias 前端")).toContain("前端");
    // holder ONLINE ⇒ the preview itself is refused.
    expect(await cmd(c, "alias 前端 --take")).toMatch(/在线/);
    const { file } = await killAndWait(hub, a, aid);
    // offline for seconds ⇒ "不足 10 分钟".
    expect(await cmd(c, "alias 前端 --take")).toMatch(/不足 10 分钟/);
    // cross the 10-minute line on the injected hub clock.
    await hub.rpc("skew", { ms: 11 * 60_000 });
    const preview = await cmd(c, "alias 前端 --take");
    const confirm = parseTakeConfirm(preview);
    expect(confirm).toMatchObject({ alias: "前端" });
    expect(preview).toMatch(/已离线 1\d 分钟/);
    // a token is single-use and bound to the requester: B cannot use C's token.
    expect(await cmd(b, "alias 前端 --take=k0000000000000000")).toMatch(/重新预览|没有可抢占/); // foreign token
    const taken = await cmd(c, `alias 前端 --take=${confirm!.token}`);
    expect(taken).toContain("已抢占");
    expect(await cmd(c, `alias 前端 --take=${confirm!.token}`)).toMatch(/重新预览|没有可抢占/); // consumed
    // the alias now routes to C.
    expect(await send(b, "前端", "to the new holder")).toMatchObject({ effect: "applied" });
    expect(await texts(c, "to the new holder")).toHaveLength(1);
    // A comes back (same session): told once that it lost the alias; no alias held.
    const a2 = await h.boot("agent", "alpha-back", file, true, false, { XW_UI: "1" }); // hasUI ⇒ lost notice shown
    expect(await sid(a2)).toBe(aid);
    await until(
      async () => ((await a2.rpc("inspect")).notifications as string[]).filter((n) => n.includes("前端")),
      (n) => n.length >= 1,
      "A is told it lost the alias",
    );
    const lost = ((await a2.rpc("inspect")).notifications as string[]).filter((n) => /抢占|认领/.test(n));
    expect(lost).toHaveLength(1);
    expect(await cmd(a2, "status")).toMatch(/alias - \(lost: taken\)/);
    expect(bid.length + cid.length).toBeGreaterThan(0);
  }, 90_000);

  it("#4 a damaged alias file ⇒ degraded across restarts, never falls back; file bytes unchanged; /webhub status line; fixing the file restores", async () => {
    h = new XsHarness();
    let hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [a, b] = (await agents(["alpha"], ["前端", { XW_SESSION_NAME: "1" }])) as [Peer, Peer];
    const [aid, bid] = await Promise.all([a, b].map(sid));
    await Promise.all([a, b].map((p) => cmd(p, "join")));
    await sees(a, bid, "A sees B");
    expect(await cmd(a, "alias 别名甲")).toContain("别名甲");
    const file = findFile(h.home, "xs-aliases.json")!;
    expect(file).toBeTruthy();
    // healthy hub: hub.json carries no alias key (byte-identical record).
    const hubJson = () => JSON.parse(readFileSync(findFile(h.home, "hub.json")!, "utf8")) as Record<string, unknown>;
    expect(hubJson().alias).toBeUndefined();
    // damage it, restart (twice): always degraded, bytes untouched, no .bak/tmp neighbours.
    const junk = "{ this is not json";
    for (let round = 0; round < 2; round++) {
      await hub.kill();
      if (round === 0) writeFileSync(file, junk);
      hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
      expect(readFileSync(file, "utf8")).toBe(junk);
      await sees(a, bid, `A reconnects to the degraded hub (round ${round})`);
    }
    // hub.json: alias store degraded (reason + path), and the agent renders it in /webhub status.
    expect(hubJson().alias).toMatchObject({ degraded: true, path: file });
    await a.rpc("cmd", { name: "webhub", args: "status" });
    const notes = (await a.rpc("inspect")).notifications as string[];
    expect(notes.some((n) => n.includes("alias store degraded") && n.includes(file))).toBe(true);
    expect(notes.some((n) => n.includes("/webhub restart"))).toBe(true);
    // the agent sees no hub cap ⇒ /fabric alias refuses locally; status says hub-cap off.
    expect(await cmd(a, "alias 别名乙")).toMatch(/不支持别名|降级|restart/);
    expect(await cmd(a, "status")).toMatch(/alias n\/a \(hub-cap off\)/);
    // alias-shaped name "前端" equals B's DISPLAY NAME: the guard answers UNAVAILABLE, B is never reached.
    const guarded = await send(a, "前端", "must not reach the namesake");
    expect(guarded).toMatchObject({ effect: "none" });
    expect(guarded.status).not.toBe("sent");
    expect(await texts(b, "must not reach the namesake")).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe(junk);
    // a human moves the file away ⇒ restart ⇒ ready with an EMPTY table: old alias gone, set works, hub.json clean.
    await hub.kill();
    rmSync(file);
    hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    await sees(a, bid, "A reconnects to the healthy hub");
    await until(
      () => cmd(a, "alias"),
      (t) => /alias -|无别名|未设置/.test(t) || !t.includes("别名甲"),
      "old alias is gone",
    );
    expect(await cmd(a, "alias 别名丙")).toContain("别名丙");
    expect(hubJson().alias).toBeUndefined();
    expect(aid.length).toBeGreaterThan(0);
  }, 120_000);

  it("#5 web origin × webCommandPolicy.fabric=confirm: generic confirm per command, preview output carries the parseable confirm line, take executes", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [holder, web] = (await agents(
      ["holder"],
      ["web", { XW_WEB_POLICY_JSON: '{"fabric":"confirm"}', XW_RUN_SLASH: "1" }],
    )) as [Peer, Peer];
    const [hid, wid] = await Promise.all([holder, web].map(sid));
    await Promise.all([holder, web].map((p) => cmd(p, "join")));
    await sees(web, hid, "web session sees the holder");
    expect(await cmd(holder, "alias 前端")).toContain("前端");
    const wcmd = (args: string, confirm: boolean) =>
      hub
        .rpc("webCmd", { sessionId: wid, args, name: "fabric", confirm })
        .then((r: { first: unknown; final: unknown }) => r);
    // policy=confirm: no confirm ⇒ E_CONFIRM_REQUIRED, nothing executed (the alias is still free to nobody).
    const first = await wcmd("alias 前端 --take", false);
    expect(JSON.stringify(first)).toContain("E_CONFIRM_REQUIRED");
    // holder is online ⇒ even a confirmed preview is refused by the hub (human sees the reason in the output).
    const online = await wcmd("alias 前端 --take", true);
    expect(capturedOutput(online.final)).toMatch(/在线/);
    await killAndWait(hub, holder, hid);
    await hub.rpc("skew", { ms: 11 * 60_000 });
    // preview (confirmed once for the policy): the captured output ends with the fixed confirm line.
    const preview = await wcmd("alias 前端 --take", true);
    const out = capturedOutput(preview.final);
    const confirm = parseTakeConfirm(out);
    expect(confirm).toMatchObject({ alias: "前端" });
    // execution is a NEW command (own cmdId) and needs its OWN policy confirm.
    const unconfirmed = await wcmd(`alias 前端 --take=${confirm!.token}`, false);
    expect(JSON.stringify(unconfirmed)).toContain("E_CONFIRM_REQUIRED");
    const done = await wcmd(`alias 前端 --take=${confirm!.token}`, true);
    expect(capturedOutput(done.final)).toContain("已抢占");
    expect(await cmd(web, "alias")).toContain("前端");
  }, 90_000);

  it("#6 mixed fleet: an alias-disabled (pre-alias) agent never sees aliases, and is unreachable BY alias without being broken", async () => {
    h = new XsHarness();
    await h.boot("hub", "hub", undefined, true, false, HUB_ALIAS);
    const [a, old] = (await agents(["alpha"], ["legacy", { XW_ALIAS_JSON: '{"enabled":false}' }])) as [Peer, Peer];
    const [aid, oid] = await Promise.all([a, old].map(sid));
    await Promise.all([a, old].map((p) => cmd(p, "join")));
    await sees(a, oid, "A sees the legacy agent");
    await sees(old, aid, "legacy sees A");
    expect(await cmd(a, "alias 前端")).toContain("前端");
    // legacy rows carry no alias field (byte-identical for it), and legacy cannot use /fabric alias.
    const rows = (await list(old)).rows as Array<Record<string, unknown>>;
    expect(rows.every((r) => !("alias" in r))).toBe(true);
    expect(await cmd(old, "alias 前端")).toMatch(/未启用|alias\.enabled=false/);
    // legacy → A by ref still works; its incoming header at A has no alias for it.
    expect(await send(old, ref(aid), "legacy by ref")).toMatchObject({ effect: "applied" });
    expect(await texts(a, "legacy by ref")).toHaveLength(1);
    // legacy gets A's message (A is alias-capable; legacy recipient is not ⇒ no ` alias=` field).
    await new Promise((r) => setTimeout(r, 5_200));
    expect(await send(a, ref(oid), "to legacy")).toMatchObject({ effect: "applied" });
    expect((await texts(old, "to legacy"))[0]!.content).not.toContain(" alias=");
  }, 60_000);
});

/** The captured command output of a web `cmd_late` frame: `data.output.entries[].text` joined by newlines. */
function capturedOutput(frame: unknown): string {
  const entries = (frame as { data?: { output?: { entries?: Array<{ text: string }> } } } | undefined)?.data?.output
    ?.entries;
  if (entries === undefined) throw new Error(`no captured output in ${JSON.stringify(frame)}`);
  return entries.map((e) => e.text).join("\n");
}
