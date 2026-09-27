/**
 * P5a tests (vue-plan.md v2.1 §2.1/§4.2/§5.2) for `src/web-hub/hub/unbuilt.ts`'s
 * `renderUnbuiltPage` / `detectUiLang` / `releaseUrlFor`. Pure functions — no
 * fs, no server. Not wired into any server yet (§5.3 P5a acceptance).
 */
import { describe, expect, it } from "vitest";

import { detectUiLang, releaseUrlFor, renderUnbuiltPage } from "../../../src/web-hub/hub/unbuilt.js";
import type { UiCandidateResult } from "../../../src/web-hub/hub/ui-root.js";

const REJECTED: readonly UiCandidateResult[] = [
  { kind: "package", dir: "/opt/pi-toolkit/dist/web-hub-ui", reason: "missing", detail: "ENOENT" },
  {
    kind: "external",
    dir: "/home/alice/.pi/agent/web-hub-ui/1.2.3",
    reason: "hash",
    detail: "assets/index-abcd1234.js: sha256 mismatch",
  },
];

describe("detectUiLang", () => {
  it("recognizes zh* case-insensitively, using only the first tag", () => {
    expect(detectUiLang("zh-CN,en;q=0.9")).toBe("zh");
    expect(detectUiLang("ZH")).toBe("zh");
    expect(detectUiLang("zh")).toBe("zh");
  });

  it("falls back to en for anything else, including absent/empty", () => {
    expect(detectUiLang("en-US,en;q=0.9")).toBe("en");
    expect(detectUiLang("fr")).toBe("en");
    expect(detectUiLang(undefined)).toBe("en");
    expect(detectUiLang("")).toBe("en");
    // "en,zh;q=0.5" — zh isn't first, so this is "en" per §2.1 (Accept-Language's own priority order).
    expect(detectUiLang("en,zh;q=0.5")).toBe("en");
  });
});

describe("releaseUrlFor", () => {
  it("builds the GitHub release tag URL from the version", () => {
    expect(releaseUrlFor("1.2.3")).toBe("https://github.com/Newbluecake/pi-toolkit/releases/tag/v1.2.3");
  });
});

describe("renderUnbuiltPage: structure and CSP-safety (both languages, both modes)", () => {
  const cases = [
    { lang: "zh" as const, mode: "token" as const },
    { lang: "zh" as const, mode: "password" as const },
    { lang: "en" as const, mode: "token" as const },
    { lang: "en" as const, mode: "password" as const },
  ];

  it.each(cases)("renders a well-formed, CSP-safe document ($lang/$mode)", ({ lang, mode }) => {
    const html = renderUnbuiltPage({
      lang,
      version: "1.2.3",
      mode,
      pkgDir: "/opt/pi-toolkit",
      rejected: REJECTED,
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain("pi-toolkit-web-ui-1.2.3.zip");
    expect(html).toContain("https://github.com/Newbluecake/pi-toolkit/releases/tag/v1.2.3");
    // Zero external resources / zero inline script or style — CSP §2.2, source-scan §4.3 vocabulary.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/eval\(/);
  });

  it("HTML-escapes an adversarial version string", () => {
    const html = renderUnbuiltPage({ lang: "en", version: '1.0.0"><script>alert(1)</script>', mode: "token" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes an adversarial pkgDir in token mode", () => {
    const html = renderUnbuiltPage({
      lang: "en",
      version: "1.2.3",
      mode: "token",
      pkgDir: '/tmp/"><img src=x onerror=alert(1)>',
    });
    // The raw, DOM-parseable tag must never appear unescaped — only its fully HTML-escaped,
    // inert text form (`onerror=` itself is not dangerous once `<`/`>`/`"` are entity-encoded,
    // so asserting its mere textual presence would be a false positive; the `<img` check below
    // is what actually proves the browser can't parse this back into a tag).
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("HTML-escapes adversarial candidate diagnostics in token mode", () => {
    const html = renderUnbuiltPage({
      lang: "en",
      version: "1.2.3",
      mode: "token",
      pkgDir: "/opt/pi-toolkit",
      rejected: [{ kind: "package", dir: '"><script>1</script>', reason: "missing" }],
    });
    expect(html).not.toMatch(/<script>1<\/script>/);
  });
});

describe("renderUnbuiltPage: token mode shows host diagnostics", () => {
  it("includes the absolute package directory", () => {
    const html = renderUnbuiltPage({ lang: "en", version: "1.2.3", mode: "token", pkgDir: "/opt/pi-toolkit" });
    expect(html).toContain("/opt/pi-toolkit");
  });

  it("includes each rejected candidate's kind and dir and reason, but never its detail", () => {
    const html = renderUnbuiltPage({
      lang: "en",
      version: "1.2.3",
      mode: "token",
      pkgDir: "/opt/pi-toolkit",
      rejected: REJECTED,
    });
    expect(html).toContain("package");
    expect(html).toContain("/opt/pi-toolkit/dist/web-hub-ui");
    expect(html).toContain("missing");
    expect(html).toContain("external");
    expect(html).toContain("/home/alice/.pi/agent/web-hub-ui/1.2.3");
    expect(html).toContain("hash");
    // "detail" values themselves must never appear (only kind/dir/reason).
    expect(html).not.toContain("ENOENT");
    expect(html).not.toContain("sha256 mismatch");
  });

  it("shows no candidates section when rejected is omitted", () => {
    const html = renderUnbuiltPage({ lang: "en", version: "1.2.3", mode: "token", pkgDir: "/opt/pi-toolkit" });
    expect(html).not.toContain("Candidate directory diagnostics");
  });
});

describe("renderUnbuiltPage: password mode never leaks host filesystem paths", () => {
  it("never includes the absolute package directory, even when one is supplied", () => {
    const html = renderUnbuiltPage({
      lang: "en",
      version: "1.2.3",
      mode: "password",
      pkgDir: "/opt/pi-toolkit",
      rejected: REJECTED,
    });
    expect(html).not.toContain("/opt/pi-toolkit");
  });

  it("never includes any rejected candidate's dir or reason or detail", () => {
    const html = renderUnbuiltPage({
      lang: "en",
      version: "1.2.3",
      mode: "password",
      pkgDir: "/opt/pi-toolkit",
      rejected: REJECTED,
    });
    for (const c of REJECTED) {
      expect(html).not.toContain(c.dir);
      if (c.reason !== undefined) expect(html.toLowerCase()).not.toContain(c.reason);
      if (c.detail !== undefined) expect(html).not.toContain(c.detail);
    }
    expect(html.toLowerCase()).not.toContain("reason");
  });

  it("contains no absolute host filesystem path other than the allow-listed '~/.pi/agent/' literal and the release URL", () => {
    const html = renderUnbuiltPage({
      lang: "en",
      version: "1.2.3",
      mode: "password",
      pkgDir: "/opt/pi-toolkit",
      rejected: REJECTED,
    });
    const releaseUrl = releaseUrlFor("1.2.3");
    const scrubbed = html.split("~/.pi/agent/").join("").split(releaseUrl).join("");
    // A UNIX absolute path of 2+ segments, e.g. /home/x/y or /opt/pi-toolkit/dist — NOT a bare
    // single-segment command mention like "/webhub status".
    expect(scrubbed).not.toMatch(/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  });

  it("still points the user at '/webhub status' on the host for full diagnostics", () => {
    const html = renderUnbuiltPage({ lang: "en", version: "1.2.3", mode: "password", rejected: REJECTED });
    expect(html).toContain("/webhub status");
  });

  it("both languages' password-mode copy pass the same leak checks", () => {
    for (const lang of ["zh", "en"] as const) {
      const html = renderUnbuiltPage({
        lang,
        version: "1.2.3",
        mode: "password",
        pkgDir: "/opt/pi-toolkit",
        rejected: REJECTED,
      });
      expect(html).not.toContain("/opt/pi-toolkit");
      expect(html.toLowerCase()).not.toContain("enoent");
    }
  });
});
