import { describe, expect, it } from "vitest";
import {
  buildInitParams,
  buildUpdateSettingsParams,
  extractSettingsEcho,
  isFullSettingsEcho,
  mapThinkingToEffort,
  verifyEffectiveSettings,
} from "../../../src/external-agent/droid/settings.js";

describe("droid/settings buildInitParams（冻结导出）", () => {
  it("生产路径：machineId/cwd/modelId + autonomy high + autoRejectPermissionRequests:false", () => {
    expect(buildInitParams({ cwd: "/a", modelId: "gpt-6-luna", reasoningEffort: "low" })).toEqual({
      machineId: "pi-toolkit",
      cwd: "/a",
      modelId: "gpt-6-luna",
      autonomyLevel: "high",
      autoRejectPermissionRequests: false,
      reasoningEffort: "low",
    });
  });
  it("resume 带 sessionId；conformance 覆盖 autonomyLevel（D7）", () => {
    const p = buildInitParams({ cwd: "/a", modelId: "m", sessionId: "s-1", autonomyLevel: "off" });
    expect(p.sessionId).toBe("s-1");
    expect(p.autonomyLevel).toBe("off");
    expect(buildInitParams({ cwd: "/a", modelId: "m" })).not.toHaveProperty("sessionId");
    expect(buildInitParams({ cwd: "/a", modelId: "m" })).not.toHaveProperty("reasoningEffort");
  });
});

describe("droid/settings buildUpdateSettingsParams", () => {
  it("无条件带 autonomy high + autoRejectPermissionRequests:false（§4.4/§4.3）", () => {
    expect(buildUpdateSettingsParams({ modelId: "kimi-k3" })).toEqual({
      modelId: "kimi-k3",
      autonomyLevel: "high",
      autoRejectPermissionRequests: false,
    });
    expect(buildUpdateSettingsParams({ modelId: "kimi-k3", reasoningEffort: "high" }).reasoningEffort).toBe("high");
  });
});

describe("droid/settings echo 提取与校验", () => {
  it("extractSettingsEcho 兼容 {settings:{…}} 包装与裸 settings 对象", () => {
    expect(extractSettingsEcho({ settings: { modelId: "m", autonomyLevel: "high", reasoningEffort: "low" } })).toEqual({
      modelId: "m",
      autonomyLevel: "high",
      reasoningEffort: "low",
    });
    expect(extractSettingsEcho({ modelId: "m" })).toEqual({ modelId: "m" });
    expect(extractSettingsEcho("junk")).toBeUndefined();
    expect(isFullSettingsEcho(extractSettingsEcho({ restrictToolIds: ["Read"] }))).toBe(false); // S/47 部分 echo
    expect(isFullSettingsEcho(extractSettingsEcho({ modelId: "m" }))).toBe(true);
  });

  it("verifyEffectiveSettings：modelId 不符（S5 静默回落）/ autonomy ≠ high / echo 缺失 ⇒ fail closed", () => {
    expect(
      verifyEffectiveSettings({ modelId: "gpt-6-luna", autonomyLevel: "high" }, { modelId: "gpt-6-luna" }),
    ).toBeUndefined();
    expect(verifyEffectiveSettings({ modelId: "gpt-6-sol", autonomyLevel: "high" }, { modelId: "gpt-6-luna" })).toMatch(
      /gpt-6-sol/,
    );
    expect(
      verifyEffectiveSettings({ modelId: "gpt-6-luna", autonomyLevel: "medium" }, { modelId: "gpt-6-luna" }),
    ).toMatch(/medium/);
    expect(verifyEffectiveSettings(undefined, { modelId: "gpt-6-luna" })).toMatch(/settings echo/);
  });
});

describe("droid/settings mapThinkingToEffort（arch §8.3）", () => {
  const efforts = ["low", "medium", "high"] as const;
  it("undefined ⇒ 目录 defaultEffort；目录未知 ⇒ 不发", () => {
    expect(mapThinkingToEffort(undefined, efforts, "medium")).toBe("medium");
    expect(mapThinkingToEffort(undefined, undefined, undefined)).toBeUndefined();
  });
  it("off ⇒ off/none/minimal 第一个受支持；都没有 ⇒ 最低档", () => {
    expect(mapThinkingToEffort("off", ["off", "high"], "high")).toBe("off");
    expect(mapThinkingToEffort("off", ["none", "minimal", "high"], "high")).toBe("none");
    expect(mapThinkingToEffort("off", ["minimal", "high"], "high")).toBe("minimal");
    expect(mapThinkingToEffort("off", ["high"], "high")).toBe("high"); // 最低受支持档
  });
  it("low/medium/high ⇒ 受支持原样；否则最近档（同距取低）", () => {
    expect(mapThinkingToEffort("low", efforts, "medium")).toBe("low");
    expect(mapThinkingToEffort("medium", ["low", "high"], "low")).toBe("low"); // 同距取低
    expect(mapThinkingToEffort("high", ["none", "max"], undefined)).toBe("max"); // high 距 max 更近
  });
  it("目录未知 ⇒ 合法档位名透传，非法名字不发", () => {
    expect(mapThinkingToEffort("low", undefined, undefined)).toBe("low");
    expect(mapThinkingToEffort("bogus", undefined, undefined)).toBeUndefined();
    expect(mapThinkingToEffort("bogus", efforts, "medium")).toBe("medium");
  });
});
