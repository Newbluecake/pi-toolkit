import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("avatar filesystem boundary", () => {
  it("keeps node:fs imports in fs.ts only", () => {
    const root = new URL("../../../../src/web-hub/hub/avatar/", import.meta.url);
    for (const name of readdirSync(root).filter((n) => n.endsWith(".ts"))) {
      const source = readFileSync(new URL(name, root), "utf8");
      if (name === "fs.ts") continue;
      expect(source).not.toMatch(/from\s+["']node:fs(?:\/|["'])/);
    }
  });

  it("keeps chmod out of request-path store code", () => {
    const store = readFileSync(new URL("../../../../src/web-hub/hub/avatar/store.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../../../../src/web-hub/hub/avatar/routes.ts", import.meta.url), "utf8");
    expect(store).not.toMatch(/chmod/);
    expect(routes).not.toMatch(/chmod/);
  });
});
