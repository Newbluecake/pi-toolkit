import { describe, expect, it } from "vitest";
import { parseMeasureArgs } from "../../src/cache-ttl/measure-args.js";

describe("parseMeasureArgs", () => {
  it("bare measure ⇒ start with defaults (model from ctx.model)", () => {
    expect(parseMeasureArgs("measure")).toEqual({
      ok: true,
      command: "start",
      long: false,
      estimate: false,
      yes: false,
    });
    expect(parseMeasureArgs("")).toEqual({ ok: true, command: "start", long: false, estimate: false, yes: false });
  });

  it("keeps the model's case and splits at the first slash only", () => {
    const r = parseMeasureArgs("measure My-Relay/Claude-Sonnet-4.5");
    expect(r).toMatchObject({ ok: true, command: "start", model: { provider: "My-Relay", id: "Claude-Sonnet-4.5" } });
    const nested = parseMeasureArgs("measure openrouter/Anthropic/Claude-3");
    expect(nested).toMatchObject({ ok: true, model: { provider: "openrouter", id: "Anthropic/Claude-3" } });
  });

  it("normalises only the verb and flags (case-insensitive), never the model", () => {
    const r = parseMeasureArgs("MEASURE  Prov/ID-X --LONG --Estimate --YES");
    expect(r).toEqual({
      ok: true,
      command: "start",
      model: { provider: "Prov", id: "ID-X" },
      long: true,
      estimate: true,
      yes: true,
    });
  });

  it("flag order is free (all 6 permutations incl. the model position)", () => {
    const parts = ["--long", "--estimate", "--yes"];
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const p of perms) {
      const flags = p.map((i) => parts[i]!);
      const a = parseMeasureArgs(`measure ${flags.join(" ")} a/b`);
      const b = parseMeasureArgs(`measure a/b ${flags.join(" ")}`);
      const c = parseMeasureArgs(`measure ${flags[0]} a/b ${flags[1]} ${flags[2]}`);
      for (const r of [a, b, c]) {
        expect(r).toEqual({
          ok: true,
          command: "start",
          model: { provider: "a", id: "b" },
          long: true,
          estimate: true,
          yes: true,
        });
      }
    }
  });

  it("works with an optional leading verb and with array input", () => {
    expect(parseMeasureArgs("--long")).toMatchObject({ ok: true, command: "start", long: true });
    expect(parseMeasureArgs(["measure", "--yes", "p/m"])).toMatchObject({ ok: true, yes: true, model: { id: "m" } });
  });

  it("status / cancel (verb case-insensitive)", () => {
    expect(parseMeasureArgs("measure status")).toEqual({ ok: true, command: "status" });
    expect(parseMeasureArgs("measure STATUS")).toEqual({ ok: true, command: "status" });
    expect(parseMeasureArgs("measure Cancel")).toEqual({ ok: true, command: "cancel" });
  });

  it("anything after status/cancel is a usage error", () => {
    for (const raw of ["measure status --long", "measure cancel a/b", "measure status extra", "measure cancel --yes"]) {
      expect(parseMeasureArgs(raw)).toMatchObject({ ok: false, error: "flags-after-subcommand" });
    }
  });

  it("rejects unknown flags (incl. -x, --flag=value, removed --full/--gaps)", () => {
    for (const raw of ["measure --full", "measure --gaps=3", "measure -y", "measure --long=1", "measure --tokens 5"]) {
      const r = parseMeasureArgs(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["unknown-flag", "bad-model-ref"]).toContain(r.error);
    }
    expect(parseMeasureArgs("measure --full")).toMatchObject({ ok: false, error: "unknown-flag" });
    expect(parseMeasureArgs("measure -y")).toMatchObject({ ok: false, error: "unknown-flag" });
  });

  it("rejects duplicate flags, also across different case", () => {
    expect(parseMeasureArgs("measure --long --long")).toMatchObject({ ok: false, error: "duplicate-flag" });
    expect(parseMeasureArgs("measure --yes --YES")).toMatchObject({ ok: false, error: "duplicate-flag" });
  });

  it("rejects a second model and malformed model refs", () => {
    expect(parseMeasureArgs("measure a/b c/d")).toMatchObject({ ok: false, error: "extra-model" });
    for (const raw of ["measure foo", "measure /x", "measure x/", "measure foo/ --yes"]) {
      expect(parseMeasureArgs(raw)).toMatchObject({ ok: false, error: "bad-model-ref" });
    }
  });

  it("a subcommand word in a non-first position is not silently taken as a model", () => {
    expect(parseMeasureArgs("measure --long status")).toMatchObject({ ok: false, error: "unexpected-argument" });
    expect(parseMeasureArgs("measure a/b cancel")).toMatchObject({ ok: false, error: "unexpected-argument" });
    expect(parseMeasureArgs("measure measure")).toMatchObject({ ok: false, error: "unexpected-argument" });
  });

  it("error results carry a detail string and never claim ok", () => {
    const r = parseMeasureArgs("measure --nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("--nope");
  });
});
