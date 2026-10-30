// J1 (jev-plan §4 J1 / arch §7.1): every mask rule, $HOME, ANSI/C0, the 8KB
// window, and every field's truncation (incl. the error field's
// first-error-line-priority tail).

import { afterEach, describe, expect, it } from "vitest";
import { redactForJev } from "../../../src/memory/jev/redact.js";

const HOME = process.env["HOME"] ?? "";
afterEach(() => {
  process.env["HOME"] = HOME;
});

describe("mask rules (§7.1 step 3) — one example each", () => {
  it("SECRET_PATTERNS literals: sk-, AKIA, ghp_, xox-, private-key header", () => {
    for (const secret of [
      "sk-abcdefghijklmnopqrstuvwx",
      "AKIAABCDEFGHIJKLMNOP",
      "ghp_abcdefghijklmnopqrstuvwxyz012345",
    ]) {
      expect(redactForJev(`prefix ${secret} suffix`, "entry")).not.toContain(secret);
    }
    expect(redactForJev("-----BEGIN RSA PRIVATE KEY-----", "entry")).not.toContain("RSA PRIVATE KEY");
  });

  it("loose key/value: credential-like masked (same source as D13); the sensitive-key pass is broader by design", () => {
    expect(redactForJev("password: hunter2hunter2", "entry")).not.toContain("hunter2hunter2");
    expect(redactForJev("token=ghs_9f8e7d6c5b4a39281706", "entry")).not.toContain("ghs_9f8e7d6c5b4a39281706");
    // §7.1's sensitive-key-name rule masks values UNCONDITIONALLY — more
    // aggressive than D13 on purpose (outbound hygiene only).
    expect(redactForJev("password: supersecretvalue", "entry")).not.toContain("supersecretvalue");
    expect(redactForJev("JUDGE_BYTES_PER_TOKEN=4", "entry")).not.toContain("=4");
  });

  it("sensitive key names: auth/cookie/session/api-key/private-key values masked", () => {
    expect(redactForJev("session_id: abcdef123456", "entry")).not.toContain("abcdef123456");
    expect(redactForJev("api-key: ghs_9f8e7d6c5b4a39281706", "entry")).not.toContain("ghs_9f8e7d6c5b4a39281706");
    expect(redactForJev("cookie: SOMECOOKIEVALUE12345", "entry")).not.toContain("SOMECOOKIEVALUE12345");
  });

  it("bearer tokens and api-key query params", () => {
    expect(redactForJev("Authorization: Bearer eyJhbGciOi.very.long.token", "entry")).not.toContain(
      "eyJhbGciOi.very.long.token",
    );
    expect(redactForJev("GET /v1?api_key=supersecret12345", "entry")).not.toContain("supersecret12345");
  });

  it("URL userinfo", () => {
    expect(redactForJev("https://user:pass123@example.com/x", "entry")).not.toContain("pass123");
  });

  it("PEM blocks collapse to [PEM]", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    expect(redactForJev(pem, "entry")).toBe("[PEM]");
  });

  it("base64/hex runs ≥32 and email addresses", () => {
    expect(redactForJev("hash 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c3f9a8b7c", "entry")).not.toContain("3f9a8b7c6d5e4f3a");
    expect(redactForJev("aGVsbG8gd29ybGQgdGhpcyBpcyBsb25nIGJhc2U2NCBu", "entry")).not.toContain("aGVsbG8gd29ybGQ");
    expect(redactForJev("contact me@example.com please", "entry")).not.toContain("me@example.com");
  });

  it("process command line tokens are masked (D7 ①)", () => {
    const line = "job_42 bash scripts/release/release.sh --token ghp_abcdefghijklmnopqrstuvwxyz012345";
    const out = redactForJev(line, "running");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("release.sh");
  });
});

describe("ANSI / C0 / $HOME", () => {
  it("ANSI escapes and C0 controls (except \\n/\\t) are removed", () => {
    expect(redactForJev("\u001b[31mred\u001b[0m text", "entry")).toBe("red text");
    expect(redactForJev("a\u0000b", "entry")).toBe("ab");
    expect(redactForJev("a\tb", "entry")).toBe("a\tb");
  });

  it("$HOME is replaced with ~", () => {
    if (HOME === "") return;
    expect(redactForJev(`cat ${HOME}/.pi/agent/memory`, "entry")).toBe("cat ~/.pi/agent/memory");
  });
});

// Filler with spaces — long base64-ish runs would themselves be masked.
const filler = (n: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 10)).slice(0, n);

describe("truncation table (§7.1 step 5)", () => {
  it("user message 2000 / previous user message 600 — head", () => {
    expect(Array.from(redactForJev(filler(5_000), "user"))).toHaveLength(2_000);
    expect(Array.from(redactForJev(filler(5_000), "previousUser"))).toHaveLength(600);
    const cjk = "记忆条目内容测试".repeat(400);
    expect(Array.from(redactForJev(cjk, "previousUser"))).toHaveLength(600); // code points, not bytes
  });

  it("command 500 — head", () => {
    expect(Array.from(redactForJev(filler(900), "command"))).toHaveLength(500);
  });

  it("entry excerpt 400 — head", () => {
    expect(Array.from(redactForJev(filler(900), "entry"))).toHaveLength(400);
  });

  it("error 1500 — tail, with the first error line kept in view", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(i === 0 ? "Error: EACCES permission denied on first line" : `filler line ${i} with padding text here`);
    }
    const text = lines.join("\n");
    const out = redactForJev(text, "error");
    expect(Array.from(out).length).toBeLessThanOrEqual(1_500);
    expect(out).toContain("Error: EACCES permission denied");
    expect(out.endsWith(lines.at(-1)!)).toBe(true);
    // When the first error line is already inside the tail window, no prefix.
    const short = "Error: boom\ndetail";
    expect(redactForJev(short, "error")).toBe(short);
  });

  it("running 10 × 120 — per item, capped count", () => {
    const items = Array.from({ length: 14 }, (_, i) => `job_${i} bash scripts/release/release.sh 0.10.${i}`);
    const out = redactForJev(items.join("\n"), "running");
    const lines = out.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]!.length).toBeLessThanOrEqual(120);
  });

  it("staged 50 × 200", () => {
    const items = Array.from({ length: 80 }, (_, i) => `dir/sub/file-${i}.ts`);
    const lines = redactForJev(items.join("\n"), "staged").split("\n");
    expect(lines).toHaveLength(50);
    expect(lines.every((l) => l.length <= 200)).toBe(true);
  });
});

describe("8KB matching window (§7.1 step 1)", () => {
  it("content beyond the window is dropped before matching — a bound, not a promise", () => {
    const text = `${filler(9_000)}\ntoken=ghs_9f8e7d6c5b4a39281706`;
    const out = redactForJev(text, "user");
    expect(out).not.toContain("ghs_9f8e7d6c5b4a39281706");
  });

  it("secrets inside the window are masked even when the text is long", () => {
    const text = `token=ghs_9f8e7d6c5b4a39281706\n${filler(9_000)}`;
    expect(redactForJev(text, "user")).not.toContain("ghs_9f8e7d6c5b4a39281706");
  });
});
