import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWebHubCommand } from "../../../src/commands/webhub.js";
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-agent-dir-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

function setup(raw?: string, record?: Record<string, unknown>) {
  const paths = pathsIn(tmp.dir);
  if (record !== undefined) writeFileSync(paths.hubJson, JSON.stringify(record));
  const { pi } = fakePi();
  return wireWebHub(pi, {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir, ...(raw === undefined ? {} : { PI_CODING_AGENT_DIR: raw }) },
    paths,
    argv1: "/nonexistent/pi",
  });
}

describe("#54 P4 T-HB1: agentDir diagnostics", () => {
  it.each([undefined, "", "relative"])("default resolution (%s) + legacy record is silent", (raw) => {
    expect(setup(raw, { pid: 123 }).alias!.statusLines()).toEqual([]);
  });

  it("explicit default and matching env are silent", () => {
    expect(setup(`${tmp.dir}/.pi/agent`, {}).alias!.statusLines()).toEqual([]);
    expect(setup("/custom/agent", { agentDir: "/custom/agent" }).alias!.statusLines()).toEqual([]);
  });

  it("new hub × default agent reports mismatch via the real /webhub status warning channel", async () => {
    const control = setup(undefined, { agentDir: "/custom/hub" });
    const { ctx, state } = fakeCtx({ mode: "tui" });
    await createWebHubCommand({ control: () => control }).handler("status", ctx as ExtensionCommandContext);
    expect(state.notifyCalls).toContainEqual([
      `hub agentDir /custom/hub ≠ 本会话 ${tmp.dir}/.pi/agent：网页新建会话使用 hub 的目录；如需切换，请从目标环境执行 /webhub restart。`,
      "warning",
    ]);
  });

  it.each([undefined, null, 123, {}, ""])(
    "old/malformed field %s + env gives unknown and default mismatch",
    (agentDir) => {
      const lines = setup("/custom/session", { agentDir }).alias!.statusLines();
      expect(lines).toEqual([
        "hub 的 agentDir 未知（旧版 hub 或默认）；缺失字段按 ~/.pi/agent 判断。",
        `hub agentDir ${tmp.dir}/.pi/agent ≠ 本会话 /custom/session：网页新建会话使用 hub 的目录；如需切换，请从目标环境执行 /webhub restart。`,
      ]);
    },
  );

  it("two non-default dirs mismatch, without claiming the hub dir is unknown", () => {
    const lines = setup("/custom/session", { agentDir: "/custom/hub" }).alias!.statusLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("hub agentDir /custom/hub ≠ 本会话 /custom/session");
  });

  it("missing or corrupt hub file is silent, not diagnosed as an old running hub", () => {
    const control = setup("/custom/session");
    expect(control.alias!.statusLines()).toEqual([]);
    writeFileSync(pathsIn(tmp.dir).hubJson, "{");
    expect(control.alias!.statusLines()).toEqual([]);
  });

  it("hub-sourced controls cannot forge terminal lines; alias warnings remain intact", () => {
    const lines = setup(undefined, {
      agentDir: "/custom/\nhub\u001b",
      alias: { degraded: true, reason: "corrupt", path: "/state/xs-aliases.json" },
    }).alias!.statusLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("alias store degraded");
    expect(lines[2]).toContain("/custom/hub");
    expect(lines[2]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});
