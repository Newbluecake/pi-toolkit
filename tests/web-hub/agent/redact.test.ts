/**
 * bash-jobs-panel plan §3.9 (包 A): redaction hygiene tests — **卫生用例、非边界证明**
 * (D2a: redaction is best-effort hygiene, NOT a security boundary). Every rule family runs
 * through BOTH paths: the command pipeline (`redactCommand`) and the tail pipeline
 * (`sanitizeTail`), because both bottom out in `redactSecrets`.
 */
import { describe, expect, it } from "vitest";
import {
  capTailText,
  CMD_MAX_CHARS,
  redactCommand,
  redactSecrets,
  sanitizeTail,
  TAIL_READ_WINDOW_BYTES,
} from "../../../src/web-hub/agent/redact.js";

const GH_SHA = "e3b744a4a37d00b0d2f0e1a5c9ab8d7ef01a2b34"; // 40-char lowercase hex
const SHA256 = "a".repeat(64); // lowercase hex
const B64_64 = "Ab1cDe2f".repeat(8); // exactly 64 chars, mixes upper+lower+digit
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N1XgL0n3I9PlFUP0THsR8U`;

describe("redactSecrets — rule 1: assignments", () => {
  it.each([
    ["TOKEN=abc123", "TOKEN=***"],
    ['export GITHUB_TOKEN="ghp_abcdefghijklmnop"', "export GITHUB_TOKEN=***"],
    ['TOKEN="$(cat /run/secrets/token)"', "TOKEN=***"],
    ["TOKEN=$(cat token)", "TOKEN=***"],
    ["TOKEN='a b'", "TOKEN=***"],
    ["PASSWORD=hunter2 cmd --flag", "PASSWORD=*** cmd --flag"],
    ["API_KEY='sk-aaaa'", "API_KEY=***"],
    ["aws_secret_access_key=xyz", "aws_secret_access_key=***"],
    ["PRIVATE_KEY_PEM=xyz", "PRIVATE_KEY_PEM=***"],
    ["A=1 COOKIE=c1 B=2", "A=1 COOKIE=*** B=2"],
  ])("%s → %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("heredoc/newline bodies still match (redaction runs on the RAW multi-line text)", () => {
    expect(redactSecrets("cat <<EOF\nTOKEN=secret123\nEOF\n")).toBe("cat <<EOF\nTOKEN=***\nEOF\n");
    expect(redactSecrets("FOO=1 \\\n  SESSION_ID=sid123")).toBe("FOO=1 \\\n  SESSION_ID=***");
  });

  it("identifiers NOT in assignment position survive (plan's false-positive guard)", () => {
    expect(redactSecrets("the session_start hook ran")).not.toContain("***");
    expect(redactSecrets("session_start")).toBe("session_start");
    expect(redactSecrets("npm test")).toBe("npm test");
  });
});

describe("redactSecrets — rule 2: flag values", () => {
  it.each([
    ["deploy --token=abc123", "deploy --token=***"],
    ["deploy --token abc123", "deploy --token ***"],
    ['app --password "my pass"', "app --password ***"],
    ["app --api-key=k3y", "app --api-key=***"],
    ["app --secret s3cr3t", "app --secret ***"],
    ["app --auth=Bearer123", "app --auth=***"],
  ])("%s → %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("mysql/psql tight -p<password> form", () => {
    expect(redactSecrets("mysql -u root -pS3cretPw prod")).toBe("mysql -u root -p*** prod");
    expect(redactSecrets("pg_dump -U pg -phunter2 db")).toBe("pg_dump -U pg -p*** db");
  });

  it("-p<val> is inert outside the mysql/psql family (no `-print` false positives)", () => {
    expect(redactSecrets("find . -print")).toBe("find . -print");
    expect(redactSecrets("grep -pfoo file")).toBe("grep -pfoo file");
  });

  it("git log --author=x survives (the plan's named false positive)", () => {
    expect(redactSecrets(`git log --author=x@example.com`)).toBe(`git log --author=x@example.com`);
  });
});

describe("redactSecrets — rule 3: headers + Bearer/Basic", () => {
  it.each([
    ['curl -H "Authorization: Bearer x.y.z"', 'curl -H "Authorization: ***"'],
    ["curl -H 'X-Api-Key: k'", "curl -H 'X-Api-Key: ***'"],
    ["--header=Cookie: s=1", "--header=Cookie: ***"],
    ["-H 'Proxy-Authorization: Basic abc'", "-H 'Proxy-Authorization: ***'"],
    ["Set-Cookie: a=b; Path=/", "Set-Cookie: ***"],
    ["-H 'X-Session-Token: t'", "-H 'X-Session-Token: ***'"],
  ])("%s → %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("standalone Bearer / Basic credentials", () => {
    expect(redactSecrets(`echo Bearer ${JWT}`)).toBe("echo Bearer ***");
    expect(redactSecrets("Basic dXNlcjpwYXNzdw==")).toBe("Basic ***");
  });
});

describe("redactSecrets — rule 4: URLs", () => {
  it("userinfo", () => {
    expect(redactSecrets("curl https://user:pass@example.com/x")).toBe("curl https://***@example.com/x");
    expect(redactSecrets("redis://:pw@host:6379")).toBe("redis://***@host:6379");
  });
  it("query values (neighbouring params survive)", () => {
    expect(redactSecrets("curl 'https://x.io/cb?access_token=abc123&x=1'")).toBe(
      "curl 'https://x.io/cb?access_token=***&x=1'",
    );
    expect(redactSecrets("https://x.io?a=1&sig=hmac&b=2")).toBe("https://x.io?a=1&sig=***&b=2");
  });
});

describe("redactSecrets — rule 5: JSON fields", () => {
  it("curl -d body", () => {
    expect(redactSecrets(`-d '{"password":"p","api_key":"k"}'`)).toBe(`-d '{"password":"***","api_key":"***"}'`);
  });
  it("multi-line JSON tail", () => {
    const tail = [
      "{",
      '  "auth_token": "topsecret",',
      '  "ok": true,',
      '  "private_key_pem": "-----BEGIN-----",',
      "}",
    ].join("\n");
    const out = redactSecrets(tail);
    expect(out).toContain('"auth_token":"***"');
    expect(out).toContain('"private_key_pem":"***"');
    expect(out).toContain('"ok": true');
    expect(out).not.toContain("topsecret");
  });
});

describe("redactSecrets — rule 6: known prefixes", () => {
  it.each([
    ["sk-proj-Abc123xyz", "***"],
    ["ghp_AbCdEf123456", "***"],
    ["gho_AbCdEf123456", "***"],
    ["ghs_AbCdEf123456", "***"],
    ["github_pat_11ABCdef", "***"],
    ["xoxa-1234567890-abc", "***"],
    ["xoxb-123-456-xyz", "***"],
    ["xoxp-123-456-xyz", "***"],
    ["AKIAIOSFODNN7EXAMPLE", "***"],
    [JWT, "***"],
  ])("%s → %s", (input, expected) => {
    expect(redactSecrets(`echo ${input} done`)).toBe(`echo ${expected} done`);
  });

  it("`task-1` is not an sk- token (word-boundary guard)", () => {
    expect(redactSecrets("run task-1 now")).toBe("run task-1 now");
  });
});

describe("redactSecrets — rule 7: long base64", () => {
  it("≥64 chars mixing upper+lower+digit", () => {
    expect(redactSecrets(`echo ${B64_64}`)).toBe("echo ***");
  });
  it("40-hex sha and sha256 hex have no uppercase ⇒ untouched", () => {
    expect(redactSecrets(`at ${GH_SHA}`)).toBe(`at ${GH_SHA}`);
    expect(redactSecrets(`sha ${SHA256}`)).toBe(`sha ${SHA256}`);
  });
});

describe("redactCommand — pipeline order (match on raw 8 KiB, THEN truncate)", () => {
  it("whitespace collapses to one line and quotes survive visibly", () => {
    const out = redactCommand('curl -H "Authorization: Bearer x"\n  --header=Cookie: s=1');
    expect(out.text).toBe('curl -H "Authorization: ***" --header=Cookie: ***');
    expect(out.truncated).toBe(false);
  });

  it("heredoc bodies are redacted before the collapse", () => {
    const out = redactCommand("cat <<EOF\nTOKEN=secret123\nEOF");
    expect(out.text).toBe("cat <<EOF TOKEN=*** EOF");
  });

  it("a token starting before char 200 is fully matched even if it straddles the cut", () => {
    const cmd = `${"x".repeat(195)}sk-AbCdEf1234567890`;
    const out = redactCommand(cmd);
    expect(out.text).not.toContain("sk-AbCdEf1234567890");
    expect(out.text.endsWith("…")).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it("content past the 8 KiB window never surfaces", () => {
    const cmd = `${"y".repeat(8190)} TOKEN=zzz`;
    const out = redactCommand(cmd);
    expect(out.text).not.toContain("zzz");
    expect(out.truncated).toBe(true);
  });

  it("4-byte emoji command: char cap first, byte cap second (UTF-8 boundary safe)", () => {
    const out = redactCommand("😀".repeat(300));
    expect([...out.text].length).toBeLessThanOrEqual(CMD_MAX_CHARS);
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(600);
    expect(out.truncated).toBe(true);
  });

  it("empty/blank command", () => {
    expect(redactCommand("   ").text).toBe("");
    expect(redactCommand("").text).toBe("");
  });
});

describe("sanitizeTail", () => {
  it("strips ANSI CSI/OSC and C0 controls but keeps \\n and \\t", () => {
    expect(sanitizeTail("\x1b[32mok\x1b[0m done", 0)).toBe("ok done");
    expect(sanitizeTail("\x1b]0;title\x07after", 0)).toBe("after");
    expect(sanitizeTail("a\x00\x01\x7fb", 0)).toBe("ab");
    expect(sanitizeTail("a\tb\nc", 0)).toBe("a\tb\nc");
  });

  it("mid-file read (logBytes > 1 KiB window) drops the first, possibly half, line", () => {
    const text = "half-of-a-TOKEN-prefix\nsecond TOKEN=abc\nthird";
    const out = sanitizeTail(text, TAIL_READ_WINDOW_BYTES + 1);
    expect(out).toBe("second TOKEN=***\nthird");
  });

  it("in-window read keeps the first line", () => {
    const text = "first TOKEN=abc\nsecond";
    expect(sanitizeTail(text, TAIL_READ_WINDOW_BYTES)).toBe("first TOKEN=***\nsecond");
  });

  it("per-line redaction on multi-line tails", () => {
    const out = sanitizeTail("line1 sk-AbCdEf123456\nline2 npm test\nline3 Basic dXNlcjpwYXNz", 0);
    expect(out).toBe("line1 ***\nline2 npm test\nline3 Basic ***");
  });

  it("caps to ≤10 lines / ≤1024 B, dropping from the head (keeping the tail)", () => {
    const lines = Array.from({ length: 25 }, (_v, i) => `line-${String(i).padStart(2, "0")} TOKEN=x${i}`);
    const out = sanitizeTail(lines.join("\n"), 0);
    const outLines = out.split("\n");
    expect(outLines.length).toBeLessThanOrEqual(10);
    expect(outLines.at(-1)).toBe("line-24 TOKEN=***");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(TAIL_READ_WINDOW_BYTES);
  });
});

describe("capTailText", () => {
  it("single over-cap line falls back to a UTF-8-safe tail byte slice", () => {
    const text = `${"a".repeat(900)}😀😀😀${"b".repeat(200)}`;
    const out = capTailText(text, 10, 256);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(256);
    expect(out.endsWith("b".repeat(200))).toBe(true); // the tail is what survives
  });
});
