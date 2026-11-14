// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { captureLegacyScenarios } from "./__baseline__/legacyScenario.js";

it("matches the recorded 60b2e838 element DOM and ordered request intents for old-cap/history/restore-off inputs", async () => {
  const { recordedFrom, ...expected } = JSON.parse(
    readFileSync(resolve("tests/web-hub/ui/__baseline__/legacy-60b2e838.json"), "utf8"),
  );
  expect(recordedFrom).toMatch(/^60b2e838/);
  expect(await captureLegacyScenarios()).toEqual(expected);
});
