/**
 * jev-reflex · #25 B0 evidence identity (BA §4.5, K8): templateHash semantics (id/version
 * invariance, any-template change ⇒ change, object-key-order invariance), draftHash audit
 * variance, identityKey rendering, and resolveIdentity's three branches (draft row / current
 * builtin / legacy).
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { draftHash, identityKey, resolveIdentity, templateHash } from "../../../src/reflex/core/identity.js";
import { makeDraft } from "../helpers/turn.js";
import type { RScriptV1 } from "../../../src/reflex/core/types.js";

const JOBS = BUILTIN_SCRIPTS[0]!;
const GIT = BUILTIN_SCRIPTS[3]!;

describe("templateHash — matching-semantics hash", () => {
  it("changing id / version / origin / lineage / render / agreement / examples leaves it", () => {
    const h = templateHash(JOBS);
    const renamed: RScriptV1 = { ...JOBS, id: "jobs.list.v2", version: 7, lineage: "draft.jobs" };
    expect(templateHash(renamed)).toBe(h);
    expect(templateHash({ ...JOBS, render: { ...JOBS.render, title: "other" } })).toBe(h);
    expect(
      templateHash({
        ...JOBS,
        agreement: { tools: ["anything"], bashShapes: [] },
        intent: { ...JOBS.intent, examples: { hit: ["x", "y", "z", "w", "v"], miss: ["a", "b", "c", "d", "e"] } },
      }),
    ).toBe(h);
  });

  it("changing any template source — or the port — changes it", () => {
    const h = templateHash(JOBS);
    const swap = (strong: readonly string[]): RScriptV1 => ({ ...JOBS, intent: { ...JOBS.intent, strong } });
    expect(templateHash(swap([...JOBS.intent.strong, "多一个模板"]))).not.toBe(h);
    expect(templateHash(swap([...JOBS.intent.strong].reverse()))).not.toBe(h); // order is semantics
    expect(templateHash({ ...JOBS, intent: { ...JOBS.intent, weak: [...JOBS.intent.weak, "词"] } })).not.toBe(h);
    expect(templateHash({ ...JOBS, intent: { ...JOBS.intent, exclude: [...JOBS.intent.exclude, "词"] } })).not.toBe(h);
    expect(
      templateHash({
        ...GIT,
        intent: JOBS.intent,
        port: JOBS.port,
        requires: JOBS.requires,
        render: JOBS.render,
        agreement: JOBS.agreement,
      }),
    ).toBe(h);
    // same everything but a DIFFERENT port ⇒ different hash
    expect(templateHash({ ...JOBS, port: { id: "git.status" } })).not.toBe(h);
  });

  it("is independent of OBJECT key order (canonical JSON sorts keys)", () => {
    const h = templateHash(JOBS);
    const shuffled = JSON.parse(
      JSON.stringify(JOBS, (_k, v) => v, 0),
      (_k, v) => v,
    ) as RScriptV1;
    // rebuild with reversed key insertion order at every level
    const reorder = (obj: unknown): unknown => {
      if (Array.isArray(obj)) return obj.map(reorder);
      if (obj !== null && typeof obj === "object") {
        const entries = Object.entries(obj as Record<string, unknown>).reverse();
        return Object.fromEntries(entries.map(([k, v]) => [k, reorder(v)]));
      }
      return obj;
    };
    expect(templateHash(reorder(shuffled) as RScriptV1)).toBe(h);
  });
});

describe("draftHash — whole-document audit hash", () => {
  it("changes on a version bump or any content edit, even when templateHash does not", () => {
    const draft = makeDraft({ id: "draft.a" });
    const edited = { ...draft, version: 2 };
    expect(templateHash(edited)).toBe(templateHash(draft)); // semantics unchanged
    expect(draftHash(edited)).not.toBe(draftHash(draft)); // audit hash sees it
    expect(draftHash({ ...draft, render: { ...draft.render, title: "x" } })).not.toBe(draftHash(draft));
    expect(draftHash({ ...draft })).toBe(draftHash(draft));
  });
});

describe("identityKey", () => {
  it("renders `${lineage}#${templateHash}`", () => {
    expect(identityKey({ lineage: "draft.x", templateHash: "abc123", portId: "jobs.list", portVer: 1 })).toBe(
      "draft.x#abc123",
    );
  });
});

describe("resolveIdentity — three branches", () => {
  const draftX = makeDraft({ id: "draft.x", lineage: "draft.x" });
  const promoted = { ...JOBS, lineage: "draft.x", version: 2 }; // a promoted draft in the catalog

  it("a row carrying templateHash binds to THAT hash, with lineage from the loaded script", () => {
    const r = resolveIdentity({ scriptId: "draft.x", scriptVer: 1, templateHash: "deadbeef" }, BUILTIN_SCRIPTS, [
      draftX,
    ]);
    expect(r).toEqual({ lineage: "draft.x", templateHash: "deadbeef", portId: "jobs.list", portVer: 0 });
  });

  it("a templateHash row whose draft file is GONE falls back to the row id as lineage", () => {
    // no portId anywhere ⇒ unresolvable
    expect(
      resolveIdentity({ scriptId: "draft.gone", scriptVer: 1, templateHash: "deadbeef" }, BUILTIN_SCRIPTS, []),
    ).toBeUndefined();
    // the row naming its port resolves with the row id as lineage
    const r = resolveIdentity(
      { scriptId: "draft.gone", scriptVer: 1, templateHash: "deadbeef", portId: "jobs.list", portVer: 1 },
      BUILTIN_SCRIPTS,
      [],
    );
    expect(r).toEqual({ lineage: "draft.gone", templateHash: "deadbeef", portId: "jobs.list", portVer: 1 });
  });

  it("a builtin row with the current id@ver takes the catalog hash + lineage (renames survive)", () => {
    const r = resolveIdentity(
      { scriptId: JOBS.id, scriptVer: JOBS.version },
      [...BUILTIN_SCRIPTS.filter((s) => s.id !== JOBS.id), promoted],
      [],
    );
    // promoted replaces JOBS with version 2 — resolve against it directly instead:
    const r2 = resolveIdentity({ scriptId: promoted.id, scriptVer: 2 }, [promoted], []);
    expect(r2).toEqual({
      lineage: "draft.x",
      templateHash: templateHash(promoted),
      portId: promoted.port.id,
      portVer: 0,
    });
    void r;
  });

  it("an old-version builtin gets the legacy identity `${id}@${ver}#legacy` and never merges", () => {
    const r = resolveIdentity(
      { scriptId: JOBS.id, scriptVer: JOBS.version + 3, portId: "jobs.list", portVer: 1 },
      BUILTIN_SCRIPTS,
      [],
    );
    expect(r).toBeDefined();
    expect(identityKey(r!)).toBe(`${JOBS.id}@${JOBS.version + 3}#legacy`);
    expect(identityKey(r!)).not.toBe(
      identityKey(resolveIdentity({ scriptId: JOBS.id, scriptVer: JOBS.version }, BUILTIN_SCRIPTS, [])!),
    );
  });

  it("row portId/portVer win over the resolved script's", () => {
    const r = resolveIdentity(
      { scriptId: JOBS.id, scriptVer: JOBS.version, portId: "git.status", portVer: 4 },
      BUILTIN_SCRIPTS,
      [],
    );
    expect(r).toMatchObject({ portId: "git.status", portVer: 4 });
  });

  it("returns undefined when not even the port can be determined", () => {
    expect(resolveIdentity({ scriptId: "unknown.id", scriptVer: 1 }, [], [])).toBeUndefined();
  });
});
