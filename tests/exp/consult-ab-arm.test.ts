import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_SALT, DISPATCH_META_ID_RE, armFor } from "../../scripts/exp/consult-ab-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ARM_SCRIPT = `${HERE}../../scripts/exp/consult-ab-arm.mjs`;

/** Literal vectors lock the frozen rule: lowest bit of the FIRST byte of sha256(salt+"\0"+id), 1 ⇒ experts. */
const FIXED_VECTORS: Array<[string, "experts" | "control"]> = [
  ["pkg-alpha", "control"],
  ["pkg-beta", "experts"],
  ["exp-pkg-01", "experts"],
  ["exp-hash-01", "control"],
  ["feature#42", "control"],
  ["Pkg.XYZ", "experts"],
  ["consult-ab-v1-is-not-an-id", "control"],
];

describe("consult-ab armFor", () => {
  it("matches the fixed test vectors (default salt)", () => {
    for (const [id, expected] of FIXED_VECTORS) expect(armFor(id)).toBe(expected);
  });

  it("implements exactly sha256(salt + NUL + id) first-byte parity, recomputed independently", () => {
    const ids = [
      "pkg-alpha",
      "pkg-beta",
      "exp-pkg-01",
      "ctl-pkg-01",
      "ab-e-03",
      "ab-c-08",
      "x",
      "org/repo#123",
      "feature:lane2",
      "0123456789",
    ];
    for (const id of ids) {
      const digest = createHash("sha256").update(`${DEFAULT_SALT}\0${id}`, "utf8").digest();
      const expected = digest[0]! & 1 ? "experts" : "control";
      expect(armFor(id), id).toBe(expected);
    }
  });

  it("is deterministic and salt-sensitive", () => {
    expect(armFor("exp-pkg-01")).toBe(armFor("exp-pkg-01", DEFAULT_SALT));
    expect(armFor("exp-pkg-01")).toBe("experts");
    expect(armFor("exp-pkg-01", "consult-ab-v2-pilot")).toBe("control");
  });
});

describe("consult-ab-arm.mjs CLI", () => {
  const run = (args: string[]) => execFileSync("node", [ARM_SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });

  it("prints a single arm line for a packageId", () => {
    expect(run(["pkg-demo"])).toBe("control\n");
    expect(run(["exp-pkg-01"])).toBe("experts\n");
    expect(run(["exp-pkg-01", "--salt", "consult-ab-v2-pilot"])).toBe("control\n");
  });

  it("accepts every id shape the dispatch-meta layer accepts", () => {
    expect(DISPATCH_META_ID_RE.test("org/repo#123")).toBe(true);
    expect(run(["a.b:c/d#e-f_1"])).toMatch(/^(experts|control)\n$/);
  });

  it("refuses ids that could never be enrolled (exit 2)", () => {
    expect(() => run(["-bad-id"])).toThrow();
    expect(() => run([])).toThrow();
  });
});
