// feishu-bot plan v2 §9 (F9): the `feishuBot.*` entries in SETTING_SPECS — the TUI editor
// surface F0 suggested and F9 owns. All non-live; `staleMessageS`/`debounceMs` deliberately
// carry NO `time:true` (no *Ms⇄*S conversion — F0 froze them out of TIME_SETTING_MS_PATHS).

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import {
  currentOf,
  defaultOf,
  effectOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
  settingKeys,
  writeSetting,
  type SettingsStore,
} from "../../src/config/setting-specs.js";

const EXPOSED = [
  "feishuBot.enabled",
  "feishuBot.securityAlerts",
  "feishuBot.xsMirror",
  "feishuBot.allowGroups",
  "feishuBot.groupRootTopics",
  "feishuBot.notify",
  "feishuBot.spawnScope",
  "feishuBot.staleMessageS",
  "feishuBot.files.outbound",
  "feishuBot.files.inbound",
  "feishuBot.files.maxInboundMiB",
] as const;

describe("setting-specs feishuBot (F9)", () => {
  it("exposes the nine F0 leaves plus LAN security P0 securityAlerts", () => {
    for (const key of EXPOSED) {
      expect(settingKeys(), key).toContain(key);
      expect(isKnownSettingKey(key), key).toBe(true);
    }
    // the whole feishuBot surface is just these — no stray siblings
    expect(
      settingKeys()
        .filter((k) => k.startsWith("feishuBot"))
        .sort(),
    ).toEqual([...EXPOSED].sort());
  });

  it("keeps feishuBot.debounceMs JSON-only (the editor forbids *Ms storage keys)", () => {
    // the shared spec-table invariant (tests/ui/settings-editor.test.ts) forbids exposed *Ms
    // keys; the milliseconds storage key stays a hand-edited pi-subagent.json leaf
    expect(settingKeys()).not.toContain("feishuBot.debounceMs");
    expect(DEFAULT_SETTINGS.feishuBot.debounceMs).toBe(1_500);
  });

  it("kinds, ranges and enum values match the F0 frozen settings block", () => {
    expect(SETTING_SPECS["feishuBot.enabled"]?.kind).toBe("boolean");
    expect(SETTING_SPECS["feishuBot.allowGroups"]?.kind).toBe("boolean");
    expect(SETTING_SPECS["feishuBot.groupRootTopics"]?.kind).toBe("boolean");
    expect(SETTING_SPECS["feishuBot.files.inbound"]?.kind).toBe("boolean");
    expect(SETTING_SPECS["feishuBot.notify"]).toMatchObject({ kind: "enum", values: ["bound", "off"] });
    expect(SETTING_SPECS["feishuBot.spawnScope"]).toMatchObject({ kind: "enum", values: ["known", "roots"] });
    expect(SETTING_SPECS["feishuBot.files.outbound"]).toMatchObject({
      kind: "enum",
      values: ["auto", "buttons", "off"],
    });
    expect(SETTING_SPECS["feishuBot.staleMessageS"]).toMatchObject({ kind: "number", min: 30, max: 3_600 });
    expect(SETTING_SPECS["feishuBot.files.maxInboundMiB"]).toMatchObject({ kind: "number", min: 1, max: 100 });
  });

  it("defaults come from DEFAULT_SETTINGS.feishuBot (editor never invents values)", () => {
    const d = DEFAULT_SETTINGS.feishuBot;
    expect(defaultOf(SETTING_SPECS["feishuBot.enabled"]!)).toBe(d.enabled);
    expect(defaultOf(SETTING_SPECS["feishuBot.allowGroups"]!)).toBe(d.allowGroups);
    expect(defaultOf(SETTING_SPECS["feishuBot.groupRootTopics"]!)).toBe(d.groupRootTopics);
    expect(defaultOf(SETTING_SPECS["feishuBot.notify"]!)).toBe(d.notify);
    expect(defaultOf(SETTING_SPECS["feishuBot.spawnScope"]!)).toBe(d.spawnScope);
    expect(defaultOf(SETTING_SPECS["feishuBot.staleMessageS"]!)).toBe(d.staleMessageS);
    expect(defaultOf(SETTING_SPECS["feishuBot.files.outbound"]!)).toBe(d.files.outbound);
    expect(defaultOf(SETTING_SPECS["feishuBot.files.inbound"]!)).toBe(d.files.inbound);
    expect(defaultOf(SETTING_SPECS["feishuBot.files.maxInboundMiB"]!)).toBe(d.files.maxInboundMiB);
    expect(currentOf(DEFAULT_SETTINGS, SETTING_SPECS["feishuBot.enabled"]!)).toBe(false);
  });

  it("every leaf is non-live and its description names the /reload + /webhub restart dance", () => {
    for (const key of EXPOSED) {
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
      expect(effectOf(spec)).toBe("takes effect after /reload");
      expect(spec.description ?? "").toContain("change: /reload then /webhub restart");
    }
  });

  it("staleMessageS is NOT a time:true spec (stored domain = live domain)", () => {
    expect(SETTING_SPECS["feishuBot.staleMessageS"]!.time).toBeUndefined();
    // parsing keeps the typed value as-is: seconds stay seconds
    expect(parseSettingValue(SETTING_SPECS["feishuBot.staleMessageS"]!, "600")).toEqual({
      ok: true,
      stored: 600,
      live: 600,
    });
  });

  it("parseSettingValue enforces the ranges", () => {
    expect(parseSettingValue(SETTING_SPECS["feishuBot.staleMessageS"]!, "29").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["feishuBot.staleMessageS"]!, "3601").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["feishuBot.files.maxInboundMiB"]!, "101").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["feishuBot.files.maxInboundMiB"]!, "12.5").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["feishuBot.notify"]!, "all").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["feishuBot.enabled"]!, "yes")).toEqual({
      ok: true,
      stored: true,
      live: true,
    });
  });

  it("writeSetting mutates the live feishuBot block and persists the stored key", () => {
    const persisted: Array<[string, unknown]> = [];
    const store: SettingsStore = {
      current: structuredClone(DEFAULT_SETTINGS),
      persist: (key, value) => {
        persisted.push([key, value]);
        return undefined;
      },
      path: "/tmp/settings.json",
    };
    const result = writeSetting(store, "feishuBot.notify", { stored: "off", live: "off" });
    expect(store.current.feishuBot.notify).toBe("off");
    expect(result.next).toBe("off");
    expect(persisted).toEqual([["feishuBot.notify", "off"]]);
  });
});
