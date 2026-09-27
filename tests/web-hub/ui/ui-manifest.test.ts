import { describe, expect, it } from "vitest";
import {
  isAllowedUiPath,
  parseUiBuildInfo,
  UI_MAX_FILES,
  UI_MAX_TOTAL_BYTES,
} from "../../../src/web-hub/protocol/ui-manifest.js";

const SHA = "a".repeat(64);

function validInfo(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    version: "0.2.1",
    proto: { major: 1 },
    builtAt: "2026-09-27T00:00:00.000Z",
    commit: "0123456789ab",
    files: [{ path: "index.html", bytes: 10, sha256: SHA }],
    ...overrides,
  };
}

describe("isAllowedUiPath", () => {
  it.each([
    "index.html",
    "theme-init.js",
    "favicon.svg",
    "assets/index-abcd1234.js",
    "assets/index-ABCDEF12.css",
    "assets/icon-12345678.svg",
  ])("allows %s", (p) => expect(isAllowedUiPath(p)).toBe(true));
  it.each(["../etc/passwd", "assets/../index.html", "assets/x.map", "notallowed.txt", "assets/x.js/../y"])(
    "rejects %s",
    (p) => expect(isAllowedUiPath(p)).toBe(false),
  );
});

describe("parseUiBuildInfo", () => {
  it("accepts a well-formed manifest", () => {
    const r = parseUiBuildInfo(validInfo());
    expect(r.ok).toBe(true);
  });

  it("accepts a dirty commit suffix and the unknown sentinel", () => {
    expect(parseUiBuildInfo(validInfo({ commit: "0123456789ab-dirty" })).ok).toBe(true);
    expect(parseUiBuildInfo(validInfo({ commit: "unknown" })).ok).toBe(true);
  });

  it.each([
    [null, "not-an-object"],
    [[], "not-an-object"],
    [{ ...validInfo(), v: 2 }, "bad-version-field"],
    [{ ...validInfo(), version: "" }, "bad-version"],
    [{ ...validInfo(), proto: { major: -1 } }, "bad-proto"],
    [{ ...validInfo(), proto: "1" }, "bad-proto"],
    [{ ...validInfo(), builtAt: "" }, "bad-builtAt"],
    [{ ...validInfo(), commit: "not-hex!!" }, "bad-commit"],
    [{ ...validInfo(), files: "nope" }, "bad-files"],
    [{ ...validInfo(), files: [{ path: "../x", bytes: 1, sha256: SHA }] }, "bad-file-path"],
    [{ ...validInfo(), files: [{ path: "index.html", bytes: -1, sha256: SHA }] }, "bad-file-bytes"],
    [{ ...validInfo(), files: [{ path: "index.html", bytes: 1, sha256: "short" }] }, "bad-file-sha256"],
    [{ ...validInfo(), files: [{ path: "index.html", bytes: 1, sha256: SHA.toUpperCase() }] }, "bad-file-sha256"],
    [
      {
        ...validInfo(),
        files: [
          { path: "index.html", bytes: 1, sha256: SHA },
          { path: "index.html", bytes: 1, sha256: SHA },
        ],
      },
      "duplicate-file-path",
    ],
    [{ ...validInfo(), files: [{ path: "assets/index-abcd1234.js", bytes: 1, sha256: SHA }] }, "missing-index"],
  ] as const)("rejects %#: %s", (bad, expectedError) => {
    const r = parseUiBuildInfo(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(expectedError);
  });

  it("rejects more than UI_MAX_FILES entries", () => {
    const files = [{ path: "index.html", bytes: 1, sha256: SHA }];
    for (let i = 0; i < UI_MAX_FILES; i++) {
      files.push({ path: `assets/f${i}-abcdefgh.js`, bytes: 1, sha256: SHA });
    }
    const r = parseUiBuildInfo(validInfo({ files }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too-many-files");
  });

  it("rejects a manifest whose total bytes exceed UI_MAX_TOTAL_BYTES", () => {
    const r = parseUiBuildInfo(
      validInfo({
        files: [
          { path: "index.html", bytes: 10, sha256: SHA },
          { path: "assets/big-abcdefgh.js", bytes: UI_MAX_TOTAL_BYTES, sha256: SHA },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too-large");
  });

  it("returns a structurally-typed info object on success", () => {
    const r = parseUiBuildInfo(validInfo());
    if (!r.ok) throw new Error("expected ok");
    expect(r.info.v).toBe(1);
    expect(r.info.files).toHaveLength(1);
    expect(r.info.files[0]).toEqual({ path: "index.html", bytes: 10, sha256: SHA });
  });
});
