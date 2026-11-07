/**
 * jev-reflex · #25 B0 (BA §4.4/§4.5): the port table is DERIVED from BUILTIN_SCRIPTS — never
 * hand-listed. Pins the derivation against the current catalog AND the disagreement throws on
 * synthetic catalogs.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import {
  MVP_PORTS,
  TOOLLESS_PORTS,
  derivePortTable,
  portDefaultsOf,
  portOfScript,
  portSignatureOf,
} from "../../../src/reflex/core/port-defaults.js";
import type { RScriptV1 } from "../../../src/reflex/core/types.js";

describe("port-defaults (derived from BUILTIN_SCRIPTS)", () => {
  it("MVP_PORTS lists each builtin port once, in catalog order", () => {
    expect(MVP_PORTS).toEqual(["jobs.list", "fleet.status", "quota.summary", "git.status"]);
    expect(new Set(MVP_PORTS).size).toBe(MVP_PORTS.length);
  });

  it("defaults equal the (unique) builtin script's requires/agreement/render field by field", () => {
    for (const s of BUILTIN_SCRIPTS) {
      const d = portDefaultsOf(s.port.id)!;
      expect(d, s.id).toBeDefined();
      expect(d.requires).toEqual(s.requires);
      expect(d.agreement.tools).toEqual(s.agreement.tools);
      expect(d.agreement.bashShapes).toEqual(s.agreement.bashShapes);
      expect(d.render).toEqual(s.render);
    }
  });

  it("signatures are the agreement vocabulary; TOOLLESS_PORTS is exactly the empty-signature set", () => {
    expect(portSignatureOf("jobs.list")!.tools).toEqual(new Set(["bash_job:list", "bash_job:status"]));
    expect(portSignatureOf("git.status")!.tools).toEqual(new Set(["git status", "git diff"]));
    expect(portSignatureOf("quota.summary")!.empty).toBe(true);
    expect(TOOLLESS_PORTS).toEqual(["quota.summary"]);
  });

  it("portOfScript reverse-maps every builtin id; unknown ids are undefined", () => {
    for (const s of BUILTIN_SCRIPTS) expect(portOfScript(s.id)).toBe(s.port.id);
    expect(portOfScript("draft.jobs-n")).toBeUndefined();
    expect(portOfScript("nope")).toBeUndefined();
  });
});

describe("derivePortTable on synthetic catalogs (contract-break detection)", () => {
  const base = BUILTIN_SCRIPTS[0]!; // jobs.list
  const clone = (over: Partial<RScriptV1>): RScriptV1 => ({ ...base, ...over }) as RScriptV1;

  it("two scripts on one port with identical defaults derive fine (signature unions)", () => {
    const table = derivePortTable([base, clone({ id: "jobs.list.v2", version: 2 })]);
    expect(table.mvpPorts).toEqual(["jobs.list"]);
    expect(table.defaults.get("jobs.list")!.render.title).toBe(base.render.title);
  });

  it("same-port scripts disagreeing on ANY default field throw at derivation", () => {
    for (const bad of [
      clone({ id: "jobs.x", render: { ...base.render, title: "different" } }),
      clone({ id: "jobs.x", requires: [...base.requires, "git"] as RScriptV1["requires"] }),
      clone({ id: "jobs.x", agreement: { tools: [...base.agreement.tools, "extra"], bashShapes: [] } }),
    ]) {
      expect(() => derivePortTable([base, bad]), (bad as RScriptV1).id).toThrow(/disagree/);
    }
  });

  it("an id mapping to two ports throws", () => {
    const git = BUILTIN_SCRIPTS[3]!; // git.status port
    const a = clone({ id: "dup.id" });
    const b = { ...git, id: "dup.id" } as RScriptV1;
    expect(() => derivePortTable([a, b])).toThrow(/two ports/);
  });
});
