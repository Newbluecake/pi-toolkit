import { describe, expect, it } from "vitest";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";

/**
 * i18n key/placeholder parity (vue-plan.md v2.1 §3.8, §5.2 — P0). `i18n/index.ts` merges every
 * `en/*.ts` / `zh/*.ts` namespace file via `import.meta.glob` — none exist yet in P0, so
 * today's real assertions are trivially satisfied (both dictionaries are empty namespace
 * maps). The comparison logic itself is exercised against synthetic fixtures below so a
 * future namespace file that drifts (missing key, extra key, or a `{placeholder}` that
 * doesn't match between languages) fails loudly once P1/P3/P4 add real namespace files —
 * this file does not need to change when they do.
 */

function placeholdersOf(s: string): Set<string> {
  return new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
}

function diffNamespaces(en: Record<string, Record<string, string>>, zh: Record<string, Record<string, string>>) {
  const problems: string[] = [];
  const namespaces = new Set([...Object.keys(en), ...Object.keys(zh)]);
  for (const ns of namespaces) {
    const enDict = en[ns];
    const zhDict = zh[ns];
    if (!enDict) {
      problems.push(`namespace "${ns}" exists in zh but not en`);
      continue;
    }
    if (!zhDict) {
      problems.push(`namespace "${ns}" exists in en but not zh`);
      continue;
    }
    const keys = new Set([...Object.keys(enDict), ...Object.keys(zhDict)]);
    for (const key of keys) {
      if (!(key in enDict)) problems.push(`${ns}.${key}: missing in en`);
      else if (!(key in zhDict)) problems.push(`${ns}.${key}: missing in zh`);
      else {
        const enP = placeholdersOf(enDict[key]!);
        const zhP = placeholdersOf(zhDict[key]!);
        if (enP.size !== zhP.size || [...enP].some((p) => !zhP.has(p))) {
          problems.push(`${ns}.${key}: placeholder set mismatch (en={${[...enP]}} zh={${[...zhP]}})`);
        }
      }
    }
  }
  return problems;
}

describe("i18n namespace parity", () => {
  it("MESSAGES.en and MESSAGES.zh have identical namespace/key/placeholder sets today", () => {
    expect(diffNamespaces(MESSAGES.en, MESSAGES.zh)).toEqual([]);
  });

  it("MESSAGES is a namespace map for both languages (possibly empty until P1/P3/P4 add files)", () => {
    expect(typeof MESSAGES.en).toBe("object");
    expect(typeof MESSAGES.zh).toBe("object");
    expect(Array.isArray(MESSAGES.en)).toBe(false);
  });

  it("self-test: the diff logic catches a missing key", () => {
    const en = { shell: { signOut: "Sign out" } };
    const zh = { shell: {} };
    expect(diffNamespaces(en, zh)).toContain("shell.signOut: missing in zh");
  });

  it("self-test: the diff logic catches an extra key", () => {
    const en = { shell: { signOut: "Sign out" } };
    const zh = { shell: { signOut: "退出", extra: "多余" } };
    expect(diffNamespaces(en, zh)).toContain("shell.extra: missing in en");
  });

  it("self-test: the diff logic catches a placeholder mismatch", () => {
    const en = { detail: { greet: "Hello {name}" } };
    const zh = { detail: { greet: "你好" } };
    const problems = diffNamespaces(en, zh);
    expect(problems.some((p) => p.includes("placeholder set mismatch"))).toBe(true);
  });

  it("self-test: the diff logic catches a missing namespace", () => {
    expect(diffNamespaces({ shell: {} }, {})).toContain('namespace "shell" exists in en but not zh');
  });

  it("self-test: identical dictionaries produce no problems", () => {
    const en = { shell: { signOut: "Sign out {n}" } };
    const zh = { shell: { signOut: "退出 {n}" } };
    expect(diffNamespaces(en, zh)).toEqual([]);
  });
});
