import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
describe("release total archive", () => {
  it("contains the pi source entrypoint, skills, and built UI", { timeout: 280_000 }, () => {
    const out = mkdtempSync(join(tmpdir(), "pwh-release-"));
    const version = JSON.parse(require("node:fs").readFileSync(join(root, "package.json"), "utf8")).version;
    execFileSync("bash", [join(root, "scripts/release/package.sh"), version, out], { cwd: root, stdio: "pipe" });
    const zip = join(out, `pi-toolkit-${version}.zip`);
    const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" });
    for (const path of [
      "index.ts",
      "index.js",
      "src/",
      "skills/",
      "package.json",
      "THIRD_PARTY_NOTICES.md", // prismjs MIT attribution rides every distributable
      "dist/web-hub-ui/build-info.json",
    ]) {
      expect(entries).toContain(`pi-toolkit/${path}`);
    }
    expect(existsSync(join(out, `pi-toolkit-web-ui-${version}.zip`))).toBe(true);
    expect(existsSync(join(out, `pi-toolkit-${version}.zip.sha256`))).toBe(true);
    expect(existsSync(join(out, `pi-toolkit-web-ui-${version}.zip.sha256`))).toBe(true);
    rmSync(out, { recursive: true, force: true });
  });
});
