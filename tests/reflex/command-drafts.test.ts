/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex · #25 B4: `/reflex drafts`, the drafts-only lines of `/reflex status`, and `reset draft.x`
 * (command.ts). The off-state byte-identity half is proven end-to-end by `drafts-off-parity.test.ts`; here
 * it is pinned at unit level: with drafts absent / disabled the output equals the pre-drafts text.
 */
import { describe, expect, it } from "vitest";
import { createReflexCommand, draftsText, statusText, type ReflexCommandDeps } from "../../src/reflex/command.js";
import { BUILTIN_SCRIPTS } from "../../src/reflex/core/catalog.js";
import { compileCatalog } from "../../src/reflex/core/match.js";
import type { Capability, DraftLoadResult, LoadedDraft, ReflexStatusSnapshot } from "../../src/reflex/core/types.js";
import { draftHash, templateHash } from "../../src/reflex/core/identity.js";
import { queueDraft } from "./drafts/helpers.js";

const ALL: ReadonlySet<Capability> = new Set<Capability>(["bashJobs", "fleet", "quota", "git"]);

const snap = (): ReflexStatusSnapshot => ({
  enabled: true,
  generation: 1,
  disposed: false,
  inFlight: false,
  scripts: BUILTIN_SCRIPTS.map((s) => ({ id: s.id, state: "shadow" as const, strikes: 0 })),
  counters: { candidates: 0, answered: 0, ambiguous: 0, repeat: 0, reasked: 0, corrected: 0 },
  unknownAutoResolve: [],
});

const loadedDraft = (id: string, port: "jobs.list" | "git.status" = "jobs.list"): LoadedDraft => {
  const script = queueDraft(id, port);
  return { file: `${id}.json`, script, draftHash: draftHash(script), templateHash: templateHash(script) };
};

interface DraftState {
  enabled: boolean;
  result: DraftLoadResult | undefined;
  loading: boolean;
}

function deps(
  d: DraftState | undefined,
  over: Partial<ReflexCommandDeps> = {},
  auto: readonly string[] = [],
): ReflexCommandDeps {
  return {
    enabled: () => true,
    autoResolve: () => auto,
    snapshot: snap,
    catalog: BUILTIN_SCRIPTS,
    matcher: compileCatalog(BUILTIN_SCRIPTS),
    capabilities: () => ALL,
    reset: () => false, // draft ids are never known to the builtin reset
    ...(d === undefined
      ? {}
      : {
          drafts: {
            enabled: () => d.enabled,
            dir: () => "/agent/reflex/drafts",
            result: () => d.result,
            loading: () => d.loading,
            counters: () => ({ candidates: 3, ambiguous: 1, reasked: 2, corrected: 1 }),
          },
        }),
    ...over,
  };
}

async function run(dep: ReflexCommandDeps, args: string): Promise<string> {
  const out: string[] = [];
  const cmd = createReflexCommand(dep);
  await (cmd.handler as any)(args, {
    sessionManager: { getBranch: () => [] },
    ui: { notify: (m: string) => out.push(m) },
  });
  return out.join("\n");
}

describe("/reflex drafts", () => {
  it("disabled (or no drafts deps at all) ⇒ one 'disabled' line", async () => {
    expect(await run(deps(undefined), "drafts")).toMatch(/^reflex drafts: disabled/);
    expect(await run(deps({ enabled: false, result: undefined, loading: false }), "drafts")).toMatch(/disabled/);
  });

  it("enabled but not loaded yet / loading", () => {
    expect(draftsText(deps({ enabled: true, result: undefined, loading: false }))).toMatch(/尚未加载/);
    expect(draftsText(deps({ enabled: true, result: undefined, loading: true }))).toMatch(/loading/);
  });

  it("lists `loaded <id>@<ver>#<hash8> port=<p>` and `rejected <file> <code>`", () => {
    const a = loadedDraft("draft.alpha");
    const b = loadedDraft("draft.beta", "git.status");
    const text = draftsText(
      deps({
        enabled: true,
        loading: false,
        result: {
          loaded: [a, b],
          rejected: [
            { file: "loose.json", code: "perm" },
            { file: "dup.json", code: "duplicate", detail: "draft.alpha" },
          ],
        },
      }),
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain("loaded 2");
    expect(lines[0]).toContain("rejected 2");
    expect(lines[0]).toContain("dir=/agent/reflex/drafts");
    expect(text).toContain(`  loaded draft.alpha@1#${a.templateHash.slice(0, 8)} port=jobs.list`);
    expect(text).toContain(`  loaded draft.beta@1#${b.templateHash.slice(0, 8)} port=git.status`);
    expect(text).toContain("  rejected loose.json perm");
    expect(text).toContain("  rejected dup.json duplicate (draft.alpha)");
  });

  it("whole-directory failure is named, with its detail", () => {
    const text = draftsText(
      deps({
        enabled: true,
        loading: false,
        result: { loaded: [], rejected: [], failure: { code: "dir-untrusted", detail: "drafts dir" } },
      }),
    );
    expect(text).toContain("failure dir-untrusted (drafts dir)");
  });

  it("an empty / missing directory is stated explicitly", () => {
    expect(draftsText(deps({ enabled: true, loading: false, result: { loaded: [], rejected: [] } }))).toContain(
      "目录为空或不存在",
    );
  });
});

describe("/reflex status — draft lines only when drafts are enabled", () => {
  it("drafts absent / disabled ⇒ identical text (no 草案 line, no hint)", () => {
    const off = statusText(deps({ enabled: false, result: undefined, loading: false }, {}, ["draft.x"]), []);
    const none = statusText(deps(undefined, {}, ["draft.x"]), []);
    expect(off).toBe(none);
    expect(off).not.toContain("草案");
    expect(off).not.toContain("draft.* id");
  });

  it("enabled ⇒ one 草案 line with load state and counters; draft.* in autoResolve gets the ignore hint", () => {
    const text = statusText(
      deps({ enabled: true, loading: false, result: { loaded: [loadedDraft("draft.alpha")], rejected: [] } }, {}, [
        "jobs.list",
        "draft.alpha",
      ]),
      [],
    );
    expect(text).toContain("草案：enabled · loaded=1 rejected=0 · candidates=3 ambiguous=1 reasked=2 corrected=1");
    expect(text).toContain("autoResolve 含 draft.* id：草案不参与自动作答，已忽略。");
    expect(statusText(deps({ enabled: true, loading: false, result: { loaded: [], rejected: [] } }), [])).not.toContain(
      "autoResolve 含 draft.*",
    );
  });

  it("enabled + still loading / failed shows the state", () => {
    expect(statusText(deps({ enabled: true, loading: true, result: undefined }), [])).toContain("loading");
    expect(
      statusText(
        deps({ enabled: true, loading: false, result: { loaded: [], rejected: [], failure: { code: "timeout" } } }),
        [],
      ),
    ).toContain("failure=timeout");
  });
});

describe("/reflex reset draft.x", () => {
  it("drafts enabled ⇒ explicit error: drafts have no demotion state", async () => {
    const out = await run(
      deps({ enabled: true, loading: false, result: { loaded: [], rejected: [] } }),
      "reset draft.alpha",
    );
    expect(out).toContain("没有降级状态");
    expect(out).not.toContain("reset draft.alpha（strikes");
  });

  it("drafts off ⇒ the legacy 'unknown id' message, unchanged", async () => {
    expect(await run(deps(undefined), "reset draft.alpha")).toBe("reflex: 未知脚本 id「draft.alpha」");
    expect(await run(deps({ enabled: false, result: undefined, loading: false }), "reset draft.alpha")).toBe(
      "reflex: 未知脚本 id「draft.alpha」",
    );
  });

  it("a builtin id still resets normally with drafts on", async () => {
    const dep = deps({ enabled: true, loading: false, result: { loaded: [], rejected: [] } }, { reset: () => true });
    expect(await run(dep, "reset jobs.list")).toContain("reset jobs.list");
  });

  it("usage line mentions drafts only when enabled", async () => {
    expect(await run(deps(undefined), "bogus")).toBe("用法：/reflex [status] | explain <文本> | reset [id]");
    expect(await run(deps({ enabled: true, loading: false, result: undefined }), "bogus")).toBe(
      "用法：/reflex [status] | explain <文本> | reset [id] | drafts",
    );
  });
});
