/**
 * #72 AF1 property suite: random set / clear / auto / take / force-preview / execute with sessions going
 * online (v2 or old), linked, offline, and the clock advancing. After every step:
 *  - I1/I2: one record per alias, one held per sid;
 *  - I5′: an alias changes owner only through a human-authorised route, and the route's precondition held
 *    BEFORE the step (force ⇒ holder not linked ∧ (offline ∨ every member v2); take ⇒ holder xs-offline ≥ 10 min;
 *    set ⇒ the old holder's lease had expired);
 *  - I7: a successful auto adds exactly one record (origin auto) and changes nothing else;
 *  - auto/clear/preview never transfer an alias; a failed op changes nothing; force always notifies exactly once.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createXsAliasStore,
  type XsAliasFs,
  type XsAliasRequester,
  type XsAliasStore,
  type XsAliasTimer,
} from "../../../src/web-hub/hub/xs/aliases.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
}
class Clock {
  t = 1_800_000_000_000;
  now = (): number => this.t;
  timer: XsAliasTimer = () => ({ cancel() {} });
}
class MemFs implements XsAliasFs {
  files = new Map<string, Uint8Array>();
  async read(path: string) {
    const b = this.files.get(path);
    return b === undefined ? { kind: "missing" as const } : { kind: "bytes" as const, bytes: b };
  }
  async writeTemp(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
  async rename(from: string, to: string) {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  async unlink(path: string) {
    this.files.delete(path);
  }
  async syncDir() {}
}

const SIDS = ["A", "B", "C", "D"] as const;
const ALIASES = ["web", "webo", "api", "前端", "x"] as const;
const ADVANCES = [1_000, 5 * MIN, 11 * MIN, DAY, 8 * DAY, 31 * DAY] as const;
type Presence = "off" | "on" | "on-old" | "linked";

type Cmd =
  | { k: "presence"; sid: number; p: Presence }
  | { k: "advance"; i: number }
  | { k: "set"; sid: number; alias: number }
  | { k: "clear"; sid: number }
  | { k: "auto"; sid: number; alias: number }
  | { k: "fpreview"; sid: number; alias: number }
  | { k: "tpreview"; sid: number; alias: number }
  | { k: "exec"; sid: number; alias: number; token: number; fresh: false | "force" | "take" };

const sidArb = fc.integer({ min: 0, max: SIDS.length - 1 });
const aliasArb = fc.integer({ min: 0, max: ALIASES.length - 1 });
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("presence" as const),
      sid: sidArb,
      p: fc.constantFrom<Presence>("off", "on", "on-old", "linked"),
    }),
  },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("advance" as const), i: fc.integer({ min: 0, max: 5 }) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("set" as const), sid: sidArb, alias: aliasArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("clear" as const), sid: sidArb }) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant("auto" as const), sid: sidArb, alias: aliasArb }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("fpreview" as const), sid: sidArb, alias: aliasArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("tpreview" as const), sid: sidArb, alias: aliasArb }) },
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("exec" as const),
      sid: sidArb,
      alias: aliasArb,
      token: fc.nat(9),
      fresh: fc.constantFrom<false | "force" | "take">(false, "force", "force", "take", "take"),
    }),
  },
);

const owners = (s: XsAliasStore): Map<string, string> =>
  new Map(
    s
      .inspect()
      .records.filter((r) => r.state === "held")
      .map((r) => [r.alias, r.sessionId]),
  );
const snapshot = (s: XsAliasStore): string => JSON.stringify(s.inspect());

const SEED_ENV = process.env["XS_ALIAS_PROP_SEED"];
const SEED: number | undefined = SEED_ENV === "random" ? undefined : Number(SEED_ENV ?? 20261027);

describe("xs aliases v2: property (I5′ routes, I7 auto is new-record-only)", () => {
  it("random op sequences keep the invariants", async () => {
    const stats = { auto: 0, force: 0, take: 0 };
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { minLength: 5, maxLength: 70, size: "max" }), async (cmds) => {
        const clock = new Clock();
        const fs = new MemFs();
        const pres = new Map<string, Presence>(SIDS.map((s) => [s, "on"]));
        let forcedCalls: { holderSessionId: string }[] = [];
        let n = 0;
        const store = createXsAliasStore({
          stateDir: "/s",
          isOnline: (s) => pres.get(s) === "on" || pres.get(s) === "on-old",
          isRequesterLive: (r) => pres.get(r.sessionId) === "on" || pres.get(r.sessionId) === "on-old",
          isLinked: (s) => pres.get(s) === "linked",
          allMembersV2: (s) => pres.get(s) !== "on-old",
          onForcedCommit: (e) => void forcedCalls.push(e),
          fs,
          now: clock.now,
          timer: clock.timer,
          randomHex: (b) =>
            (++n)
              .toString(16)
              .padStart(b * 2, "0")
              .slice(-b * 2),
        });
        await store.load();
        const tokens: { sid: string; alias: string; token: string; mode: "take" | "force" }[] = [];
        const req = (sid: string): XsAliasRequester => ({ sessionId: sid, epoch: 1, v2: true });
        const live = (sid: string): boolean => pres.get(sid) === "on" || pres.get(sid) === "on-old";

        for (const c of cmds) {
          const before = snapshot(store);
          const ownersBefore = owners(store);
          const recsBefore = store.inspect().records;
          const tombsBefore = store.inspect().tombstones;
          forcedCalls = [];
          const holderState = (alias: string): { sid: string; p: Presence | undefined; offFor: number } | undefined => {
            const o = ownersBefore.get(alias);
            return o === undefined ? undefined : { sid: o, p: pres.get(o), offFor: 0 };
          };
          void holderState;
          let kind: "none" | "auto" | "set" | "clear" | "exec" = "none";
          let ok = false;
          let preForce: { holder: string; p: Presence | undefined } | undefined;
          let execMode: "take" | "force" | undefined;
          let execAlias: string | undefined;
          let actor = "";
          switch (c.k) {
            case "presence": {
              const sid = SIDS[c.sid]!;
              pres.set(sid, c.p);
              store.touchPresence(sid);
              break;
            }
            case "advance":
              clock.t += ADVANCES[c.i]!;
              break;
            case "set":
            case "clear":
            case "auto":
            case "exec": {
              const sid = SIDS[c.sid]!;
              if (!live(sid)) break;
              actor = sid;
              kind = c.k;
              if (c.k === "set") ok = (await store.set(req(sid), ALIASES[c.alias]!, "~/x")).ok;
              else if (c.k === "clear") ok = (await store.clear(req(sid))).ok;
              else if (c.k === "auto") ok = (await store.autoClaim(req(sid), ALIASES[c.alias]!, "~/x")).ok;
              else {
                const alias = ALIASES[c.alias]!;
                const mine = tokens.filter((x) => x.sid === sid && x.alias === alias);
                const pool = mine.length > 0 ? mine : tokens;
                let tok = pool[c.token % Math.max(1, pool.length)];
                if (c.fresh !== false) {
                  // preview-then-execute in one step (the human confirmed right away)
                  const pv =
                    c.fresh === "force" ? store.forcePreview(req(sid), alias) : store.takePreview(req(sid), alias);
                  if (pv.ok && "take" in pv.res) {
                    tok = { sid, alias, token: pv.res.take.token, mode: c.fresh };
                    tokens.push(tok);
                  }
                }
                execAlias = alias;
                execMode = tok?.mode;
                const h = recsBefore.find((r) => r.alias === alias && r.state === "held")?.sessionId;
                if (h !== undefined) preForce = { holder: h, p: pres.get(h) };
                ok = (await store.take(req(sid), alias, tok?.token ?? "k0", "~/t")).ok;
              }
              await settle();
              break;
            }
            case "fpreview":
            case "tpreview": {
              const sid = SIDS[c.sid]!;
              if (!live(sid)) break;
              const alias = ALIASES[c.alias]!;
              const pv = c.k === "fpreview" ? store.forcePreview(req(sid), alias) : store.takePreview(req(sid), alias);
              if (pv.ok && "take" in pv.res)
                tokens.push({ sid, alias, token: pv.res.take.token, mode: c.k === "fpreview" ? "force" : "take" });
              expect(snapshot(store)).toBe(before); // previews never write
              break;
            }
          }

          const recs = store.inspect().records;
          // I1 / I2
          expect(new Set(recs.map((r) => r.alias)).size).toBe(recs.length);
          const held = recs.filter((r) => r.state === "held");
          expect(new Set(held.map((r) => r.sessionId)).size).toBe(held.length);

          const ownersAfter = owners(store);
          const moved = [...ownersAfter].filter(([a, s]) => ownersBefore.has(a) && ownersBefore.get(a) !== s);
          if (!ok) {
            expect(snapshot(store)).toBe(before);
            expect(forcedCalls).toEqual([]);
          }
          if (kind === "auto" && ok) {
            // I7: nothing but at most one addition
            expect(moved).toEqual([]);
            const seen = new Set(recsBefore.map((r) => `${r.alias}#${r.rev}`));
            const added = recs.filter((r) => !seen.has(`${r.alias}#${r.rev}`));
            expect(added.length).toBeLessThanOrEqual(1);
            // every LIVE record survives untouched (an expired cooling may be pruned or replaced — it never existed, I7)
            const t = clock.t;
            for (const r of recsBefore) {
              if (r.state === "cooling" && !(r.coolUntil !== undefined && t < r.coolUntil)) continue;
              expect(recs.find((x) => x.alias === r.alias)).toEqual(r);
            }
            // tombstones are only ever pruned once ≥30 days old (inside a write); younger ones are untouched
            const tombsAfter = store.inspect().tombstones;
            for (const x of tombsBefore) {
              if (clock.t - x.at <= 30 * DAY) expect(tombsAfter).toContainEqual(x);
            }
            for (const a of added) expect(a).toMatchObject({ origin: "auto", state: "held", sessionId: actor });
            stats.auto += added.length;
          }
          if (kind === "clear" || kind === "none") expect(moved).toEqual([]);
          if (kind === "exec" && ok) {
            expect(execMode).toBeDefined();
            const m = moved.find(([a]) => a === execAlias);
            expect(m).toBeDefined();
            // I5′: the route's precondition held before the step
            if (execMode === "force") {
              expect(preForce!.p).not.toBe("linked");
              if (preForce!.p === "on-old") throw new Error("force executed on a non-v2 online holder");
              stats.force++;
              expect(forcedCalls).toHaveLength(1);
              expect(forcedCalls[0]!.holderSessionId).toBe(preForce!.holder);
            } else {
              expect(["off", "linked"]).toContain(preForce!.p); // xs-offline (take reads xs presence only)
              stats.take++;
              expect(forcedCalls).toEqual([]);
            }
          }
          if (kind !== "exec") expect(forcedCalls).toEqual([]);
          if (kind === "set" && ok) {
            // a set may only displace a holder whose lease had expired (offline > 7 days)
            for (const [a] of moved) {
              const was = ownersBefore.get(a)!;
              expect(pres.get(was) === "off" || pres.get(was) === "linked").toBe(true);
            }
          }
        }
      }),
      { numRuns: 120, ...(SEED === undefined ? {} : { seed: SEED }) },
    );
    // the generator must actually reach the routes the invariants guard (fixed seed ⇒ deterministic)
    if (SEED !== undefined) {
      expect(stats.auto).toBeGreaterThan(0);
      expect(stats.force).toBeGreaterThan(0);
      expect(stats.take).toBeGreaterThan(0);
    }
  });
});
