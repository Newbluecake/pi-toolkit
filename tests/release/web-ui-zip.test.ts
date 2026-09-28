import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const script = join(root, "scripts/release/package-web-ui.sh");

describe("release web UI archive", () => {
  it("creates a versioned, private-mode zip and checksum", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwh-ui-"));
    const dist = join(dir, "dist");
    const out = join(dir, "out");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(dist, "build-info.json"), JSON.stringify({ version: "1.2.3" }));
    execFileSync("bash", [script, "1.2.3", out], { env: { ...process.env, PWH_UI_DIST: dist } });
    const zip = join(out, "pi-toolkit-web-ui-1.2.3.zip");
    const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(
      entries.every(
        (entry) => entry === "web-hub-ui/" || entry === "web-hub-ui/1.2.3/" || entry.startsWith("web-hub-ui/1.2.3/"),
      ),
    ).toBe(true);
    expect(entries).toContain("web-hub-ui/1.2.3/build-info.json");
    const checksum = readFileSync(join(out, "pi-toolkit-web-ui-1.2.3.zip.sha256"), "utf8");
    expect(checksum).toMatch(/^[a-f0-9]{64}  pi-toolkit-web-ui-1\.2\.3\.zip\n$/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects version mismatches and symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwh-ui-reject-"));
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "build-info.json"), JSON.stringify({ version: "9.9.9" }));
    expect(() =>
      execFileSync("bash", [script, "1.2.3", join(dir, "out")], { env: { ...process.env, PWH_UI_DIST: dist } }),
    ).toThrow();
    writeFileSync(join(dist, "build-info.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dist, "link"));
    expect(() =>
      execFileSync("bash", [script, "1.2.3", join(dir, "out")], { env: { ...process.env, PWH_UI_DIST: dist } }),
    ).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
