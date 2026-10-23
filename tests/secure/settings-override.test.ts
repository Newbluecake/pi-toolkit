import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsFromFile,
  readSettingsNoMigrate,
} from "../../src/config/settings.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "./helpers.js";

let v: FakeVault | undefined;
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
});

const USER = {
  bashJobs: { dir: "/user/bash-jobs" },
  workflow: { journalDir: "/user/workflows" },
  fabric: { enabled: true, crossSession: { enabled: true } },
  externalAgents: { droid: { enabled: true } },
  feishuNotify: { enabled: true },
};

describe("loadSettings secure override (plan §2.4 step 2)", () => {
  it("no verdict and plain verdict ⇒ identical output to the legacy parser", () => {
    const before = JSON.stringify(loadSettings(USER));
    v = makeFakeVault();
    freezeDomain(v, { cwd: v.outside });
    expect(JSON.stringify(loadSettings(USER))).toBe(before);
    expect(loadSettings(USER).bashJobs.dir).toBe("/user/bash-jobs");
  });

  it("secure ⇒ in-vault roots and D8 pushes off, whatever the user file says", () => {
    v = makeFakeVault();
    freezeDomain(v);
    const s = loadSettings(USER);
    expect(s.bashJobs.dir).toBe(join(v.state, "bash-jobs"));
    expect(s.workflow.journalDir).toBe(join(v.state, "workflows"));
    expect(s.fabric.crossSession.enabled).toBe(false);
    expect(s.fabric.enabled).toBe(true); // tree fabric is not a D8 push
    expect(s.externalAgents.droid.enabled).toBe(false);
    expect(s.feishuNotify.enabled).toBe(false);
    // non-overridden siblings keep the user's / default values
    expect(s.bashJobs.retentionMs).toBe(loadSettings({}).bashJobs.retentionMs);
  });

  it("locked ⇒ D8 pushes off, roots untouched (nothing runs anyway)", () => {
    v = makeFakeVault();
    freezeDomain(v, { mountinfo: v.unmounted });
    const s = loadSettings(USER);
    expect(s.bashJobs.dir).toBe("/user/bash-jobs");
    expect(s.fabric.crossSession.enabled).toBe(false);
    expect(s.feishuNotify.enabled).toBe(false);
  });

  it("never mutates DEFAULT_SETTINGS (overrides clone every nested object)", () => {
    const snapshot = JSON.stringify(DEFAULT_SETTINGS);
    v = makeFakeVault();
    freezeDomain(v);
    const s = loadSettings(undefined);
    expect(s.feishuNotify).not.toBe(DEFAULT_SETTINGS.feishuNotify);
    expect(s.fabric.crossSession).not.toBe(DEFAULT_SETTINGS.fabric.crossSession);
    expect(s.externalAgents.droid).not.toBe(DEFAULT_SETTINGS.externalAgents.droid);
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(snapshot);
  });

  it("both file entry points (loadSettingsFromFile / readSettingsNoMigrate) are overridden", () => {
    v = makeFakeVault();
    const file = join(v.tmp, "user-settings.json");
    writeFileSync(file, JSON.stringify(USER));
    freezeDomain(v);
    for (const s of [loadSettingsFromFile(file), readSettingsNoMigrate(file)]) {
      expect(s.bashJobs.dir).toBe(join(v.state, "bash-jobs"));
      expect(s.workflow.journalDir).toBe(join(v.state, "workflows"));
      expect(s.feishuNotify.enabled).toBe(false);
    }
  });
});
