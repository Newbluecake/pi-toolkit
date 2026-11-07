/**
 * A (hub self-version) — the OUTCOME matrix. Once the hub's own version comes from the code it
 * actually loaded (self-version.ts → `main.ts`), the two comparisons that used to share the
 * launcher's number must still land where the web-hub-version plan §4 table expects:
 *
 *   `registry.card().outdated` = `compareVersions(agent.pluginVersion, hubVersion) < 0`
 *   `supersede.observe(agent.pluginVersion)` = only when `> 0` (a strictly NEWER agent)
 *
 * Rows cover older / equal / newer agent against the three hub identities a release can produce
 * (self-read fresh, self-read over a stale launcher, self-read older install with a newer agent
 * on disk), plus prerelease ordering. Both objects are driven with the SAME `hubVersion`, exactly
 * as `assembly-registry.ts` wires them (`registry`'s `onVersion` hook feeds the controller).
 */
import { describe, expect, it } from "vitest";

import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { createSupersede, SUPERSEDE_DEFAULT_MAX_WAIT_MS } from "../../../src/web-hub/hub/supersede.js";
import { fakeConn, hello, memLog } from "./helpers.js";

interface Row {
  /** What the scenario is, for the test name. */
  readonly name: string;
  readonly hub: string;
  readonly agent: string;
  readonly outdated: boolean;
  readonly supersedes: boolean;
}

const ROWS: readonly Row[] = [
  // The bug this fix exists for: the hub runs the NEW disk code, the agent is still the old
  // release. The page must say "outdated", and the hub must NOT replace itself.
  { name: "old agent × self-read new hub", hub: "0.10.2", agent: "0.10.1", outdated: true, supersedes: false },
  { name: "same version", hub: "0.10.2", agent: "0.10.2", outdated: false, supersedes: false },
  // The normal upgrade path: new disk release, hub still on the old code.
  { name: "new agent × older hub", hub: "0.10.1", agent: "0.10.2", outdated: false, supersedes: true },
  // An agent jumping several releases still supersedes exactly once.
  { name: "much newer agent × old hub", hub: "0.10.1", agent: "0.12.0", outdated: false, supersedes: true },
  // A rollback: the disk went BACK, so the surviving agents are the newer side.
  { name: "old hub × newer surviving agent", hub: "0.9.0", agent: "0.10.2", outdated: false, supersedes: true },
  // Prerelease ordering follows the core triple (compareVersions), never lexicographic text.
  { name: "prerelease agent vs release hub", hub: "1.0.0", agent: "1.0.0-rc.1", outdated: false, supersedes: false },
];

interface Wiring {
  readonly outdated: boolean;
  readonly supersedeState: ReturnType<ReturnType<typeof createSupersede>["state"]>;
}

/** Exactly `assembly-registry.ts`'s wiring: one `hubVersion` for both, `onVersion` → `observe`. */
function wire(hubVersion: string, agentVersion: string): Wiring {
  const now = (): number => 1_000;
  const ctl = createSupersede({
    hubVersion,
    now,
    openDialogs: () => [],
    // Never quiet: the quiet path is supersede.test.ts's job, this file only pins the judgement.
    inflight: () => 1,
    restart: () => undefined,
  });
  const reg = createRegistry({
    now,
    log: memLog(),
    hubVersion,
    onVersion: (v) => ctl.observe(v),
  });
  const { agentKey } = reg.register(
    {
      ...hello({ pluginVersion: agentVersion, buildId: `${agentVersion}@deadbeef` }),
      agentId: { pid: 7_700, nonce: "M".repeat(16) },
    },
    fakeConn(),
  );
  return { outdated: reg.get(agentKey)?.outdated === true, supersedeState: ctl.state() };
}

describe("outdated × supersede matrix under self-read hub versions", () => {
  it.each(ROWS)("$name ($agent vs hub $hub)", (row) => {
    const w = wire(row.hub, row.agent);
    expect(w.outdated).toBe(row.outdated);
    if (!row.supersedes) {
      expect(w.supersedeState).toBeUndefined();
      return;
    }
    expect(w.supersedeState).toMatchObject({
      nextVersion: row.agent,
      since: 1_000,
      deadlineAt: 1_000 + SUPERSEDE_DEFAULT_MAX_WAIT_MS,
    });
  });

  it("the stale-launcher buildId never enters the comparison", () => {
    // The release bug's exact shape: launcher activated at 0.10.1, disk is 0.10.2, so `main.ts`
    // hands both objects the self version and `${0.10.2}@unknown` as the build id. The old agent
    // is then "outdated" and cannot trigger a replacement — the two rows that used to disagree
    // (page: outdated; hub: restart itself) now agree.
    const w = wire("0.10.2", "0.10.1");
    expect(w.outdated).toBe(true);
    expect(w.supersedeState).toBeUndefined();
  });

  it("a newer agent's buildId does not matter either — only pluginVersion decides", () => {
    const newer = wire("0.10.1", "0.10.2");
    expect(newer.supersedeState).toMatchObject({ nextVersion: "0.10.2" });
  });
});
