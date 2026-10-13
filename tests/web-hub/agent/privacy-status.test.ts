import { describe, expect, it } from "vitest";
import { formatPrivacyStatusLines } from "../../../src/web-hub/agent/privacy-status.js";

describe("formatPrivacyStatusLines (web-hub-privacy plan v2.1, P3)", () => {
  it("settings off ⇒ no lines (feature silence, even with a live record)", () => {
    expect(formatPrivacyStatusLines({ degraded: false }, { settingsEnabled: false, hasHubRecord: true })).toEqual([]);
    expect(formatPrivacyStatusLines({ degraded: true }, { settingsEnabled: false, hasHubRecord: true })).toEqual([]);
    expect(formatPrivacyStatusLines(undefined, { settingsEnabled: false, hasHubRecord: false })).toEqual([]);
  });

  it("settings on + no hub.json record ⇒ no lines (main status line already reports stopped)", () => {
    expect(formatPrivacyStatusLines(undefined, { settingsEnabled: true, hasHubRecord: false })).toEqual([]);
  });

  it("settings on + record without the field ⇒ old-hub/restart-pending warning", () => {
    const lines = formatPrivacyStatusLines(undefined, { settingsEnabled: true, hasHubRecord: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("warning");
    expect(lines[0]).toContain("privacy.v1");
  });

  it("on: one info line stating the LAN-password vs loopback-click-confirm difference", () => {
    const lines = formatPrivacyStatusLines({ degraded: false }, { settingsEnabled: true, hasHubRecord: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^privacy=on /);
    expect(lines[0]).toContain("LAN");
    expect(lines[0]).toContain("loopback");
    expect(lines[0]).toContain("点击确认");
  });

  it("degraded: the info line plus a .bak warning", () => {
    const lines = formatPrivacyStatusLines({ degraded: true }, { settingsEnabled: true, hasHubRecord: true });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^privacy=on /);
    expect(lines[1]).toContain("warning");
    expect(lines[1]).toContain(".bak");
  });
});
