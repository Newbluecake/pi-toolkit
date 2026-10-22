import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** channel-plan §9.4-3: the frozen v0.7.1 hub-side sources must never change. */
const ROOT = join(__dirname, "..", "fixtures", "legacy-xs-v071");
const PINNED: Record<string, string> = {
  "src/web-hub/hub/audit.ts": "2c24b3f83bcf8df2b66419242b5fdb756c5611453fc8f3b67cfbeb4d9e6efa68",
  "src/web-hub/hub/xs/limits.ts": "65f3abf2a9ac0ea72e777686ff985cd1c134972ef785e577f08c44925f2cab52",
  "src/web-hub/hub/xs/members.ts": "896f743a989e26c552cab8b9afd03fb1a00114715b5604856e27575f21d362b8",
  "src/web-hub/hub/xs/router.ts": "f3a5cdb8867828d4f29bacc4515b6cef03ba660b9b5572aae01bd24e55ed6e09",
  "src/web-hub/protocol/xs.ts": "95e76ff9a14829c11979d0f070f8331198fb652b70b2c24b67c194be3b09cdfe",
};
const sha = (rel: string): string =>
  createHash("sha256")
    .update(readFileSync(join(ROOT, rel)))
    .digest("hex");

describe("legacy-xs-v071 fixture (frozen)", () => {
  it("every file matches its pinned sha256", () => {
    for (const [rel, want] of Object.entries(PINNED)) expect(sha(rel), rel).toBe(want);
  });

  it("SHA256SUMS lists exactly the pinned set with the same digests", () => {
    const lines = readFileSync(join(ROOT, "SHA256SUMS"), "utf8").trim().split("\n");
    const listed = Object.fromEntries(
      lines.map((l) => {
        const [digest, rel] = l.split(/\s+/);
        return [rel!, digest!];
      }),
    );
    expect(listed).toEqual(PINNED);
  });

  it("is the v0.7.1 shape: frozen xs.ts has no channel surface at all", () => {
    const src = readFileSync(join(ROOT, "src/web-hub/protocol/xs.ts"), "utf8");
    expect(src).not.toMatch(/xs\.channel\.v1|broadcast|channels/);
  });

  it("README records the source tag/commit and the never-modify declaration", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("c89a37d4f1c3d2f77b1eb0e29b7dc415ffdd596c");
    expect(readme).toContain("v0.7.1");
    expect(readme).toMatch(/NEVER modify/);
    for (const d of Object.values(PINNED)) expect(readme).toContain(d);
  });
});
