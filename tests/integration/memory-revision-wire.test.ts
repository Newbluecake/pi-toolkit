import { expect, it } from "vitest";
import { wireFixture } from "../memory/govern/revision-wire-helpers.js";

it("actual root activate consumes parsed positive cap and native provider capability without root business logic", async () => {
  const h = await wireFixture({ root: true });
  expect(h.settings.incremental).toMatchObject({ enabled: true, auto: false, jobCostCapUsd: 0.1 });
  await h.writePair();
  await h.natural();
  expect(h.observed).toHaveLength(1);
  expect(h.suggestions()).toHaveLength(1);
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(h.generate!.mock.calls[0]![0].registry).toBe(h.registry);
  expect(h.generate!.mock.calls[0]![0].jobCostCapUsd).toBe(0.1);
});

it("root default suggestion mode plus zero paid budget keeps the existing Jev write/tagging client operational", async () => {
  const h = await wireFixture({ root: true, cap: 0 });
  await h.writePair();
  await h.natural();
  expect(h.observed).toHaveLength(1);
  expect(h.calls.length).toBeGreaterThan(0);
  expect(h.calls.every((c) => c.payload.max_output_tokens === undefined)).toBe(true);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});
