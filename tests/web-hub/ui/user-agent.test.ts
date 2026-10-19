// @vitest-environment node
/**
 * `ui/src/logic/userAgent.ts` (LAN security r2 §3.2, package D): UA → display label. Display-only
 * helper; unknown input degrades to "" (the card shows its i18n 「未知设备」 instead).
 */
import { describe, expect, it } from "vitest";
import { userAgentLabel, userAgentParts } from "../../../src/web-hub/ui/src/logic/userAgent.js";

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const EDGE_WIN = `${CHROME_WIN} Edg/155.0.0.0`;
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const OPERA = `${CHROME_WIN} OPR/110.0.0.0`;

describe("userAgentLabel", () => {
  it("parses the common desktop/mobile browsers", () => {
    expect(userAgentLabel(CHROME_WIN)).toBe("Chrome 130 · Windows");
    expect(userAgentLabel(EDGE_WIN)).toBe("Edge 155 · Windows"); // Edg checked before Chrome
    expect(userAgentLabel(OPERA)).toBe("Opera 110 · Windows");
    expect(userAgentLabel(FIREFOX_LINUX)).toBe("Firefox 128 · Linux");
    expect(userAgentLabel(SAFARI_IPHONE)).toBe("Safari 26 · iPhone");
    expect(userAgentLabel(SAFARI_MAC)).toBe("Safari 17 · macOS");
  });

  it("degrades to partial labels or the empty string", () => {
    expect(userAgentLabel(undefined)).toBe("");
    expect(userAgentLabel("")).toBe("");
    expect(userAgentLabel("   ")).toBe("");
    expect(userAgentLabel("curl/8.1.0")).toBe("");
    // known OS, unknown browser → OS alone
    expect(userAgentLabel("SomeCustomAgent (X11; Linux x86_64)")).toBe("Linux");
    // known browser, unknown OS → browser alone
    expect(userAgentLabel("Mozilla/5.0 Firefox/128.0")).toBe("Firefox 128");
  });

  it("never throws on garbage and never echoes the raw UA", () => {
    const junk = "🦄".repeat(300) + " Chrome/";
    const label = userAgentLabel(junk);
    expect(typeof label).toBe("string");
    expect(label).not.toContain("🦄");
    expect(userAgentParts(junk).browser).toBeUndefined();
  });
});
