// J1 (jev-plan §4 J1): secret-patterns — the moved doctor D13 detection and
// the new `looksSecret` stay SAME-SOURCE: the exact sample sets doctor.test.ts
// pins for D13 must agree with `looksSecret` verdicts.

import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS, findSecrets, looksSecret } from "../../src/memory/secret-patterns.js";

const D13_POSITIVE = [
  "sk-abcdefghijklmnopqrstuvwx",
  "AKIAABCDEFGHIJKLMNOP",
  "ghp_abcdefghijklmnopqrstuvwxyz012345",
  "xoxb-1234567890-abcdefghij",
  "-----BEGIN RSA PRIVATE KEY-----",
  "password: hunter2hunter2",
  "token=ghs_9f8e7d6c5b4a39281706",
  "secret: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
  "api_token=hunter2hunter2",
  "x-auth-token: ghs_9f8e7d6c5b4a39281706",
  "TOKEN=hunter2hunter2",
  '"token": "hunter2hunter2"',
];

const D13_NEGATIVE = [
  "hasUsableAccessToken=true",
  "JUDGE_BYTES_PER_TOKEN=4",
  "x-cluster-internal-token: $CLUSTER_INTERNAL_TOKEN",
  "POST /sign?token=<uuid>",
  "token=(octet-stream)",
  "token = 19,115",
  "token: ${API_TOKEN}",
  "password: ********",
  "TOKEN=%API_TOKEN%",
  "tokenizer: hunter2hunter2",
  "secret_value: hunter2hunter2",
  "'secret': 'true'",
  "`JUDGE_TOKEN=4`XYZ_2abcdef7k`",
  "password: supersecretvalue",
  "token: 1234567890",
  "secret: short1val",
  "token=12345678901234567890",
  "just some prose",
];

describe("same-source with doctor D13 (tests/memory/doctor.test.ts “D13”)", () => {
  it("every D13-positive sample is flagged by findSecrets AND looksSecret", () => {
    for (const sample of D13_POSITIVE) {
      const content = `line1\n${sample}\nline3\n`;
      const found = findSecrets(content);
      expect(found.length, sample).toBeGreaterThan(0);
      expect(found[0]).toMatchObject({ line: 2 });
      expect(found[0]!.snippet).not.toContain(sample.replace(/^\w+[=:] ?/, ""));
      expect(looksSecret(content)).toBe(true);
    }
  });

  it("every D13-negative sample stays silent in both", () => {
    const content = D13_NEGATIVE.join("\n");
    expect(findSecrets(content)).toEqual([]);
    expect(looksSecret(content)).toBe(false);
  });

  it("looksSecret is findSecrets>0 by construction; masks keep the D13 shape", () => {
    const masked = findSecrets("password: hunter2hunter2\n")[0]!;
    expect(masked.snippet).toBe("pass…");
    expect(looksSecret("clean")).toBe(false);
    expect(looksSecret("token=ghs_9f8e7d6c5b4a39281706")).toBe(true);
  });

  it("SECRET_PATTERNS re-export carries the five literal shapes with /g", () => {
    expect(SECRET_PATTERNS).toHaveLength(5);
    for (const re of SECRET_PATTERNS) expect(re.flags).toContain("g");
  });
});
