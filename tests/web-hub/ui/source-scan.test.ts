import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static CSP/XSS guard over the whole Vue UI (vue-plan.md v2.1 §4.3, §5.2 — P0, extended
 * without modification by every later package that adds files under these globs). Supersedes
 * the legacy `tests/web-hub/web/no-innerhtml.test.ts` (deleted in P5b along with the rest of
 * `src/web-hub/web/**` — the pure-logic modules that test used to also cover moved under
 * `src/web-hub/ui/src/logic/**`, which this file's UI_DIR glob already includes, so nothing
 * in that coverage was lost).
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const UI_DIR = "src/web-hub/ui";

const files = [
  ...globSync(`${UI_DIR}/index.html`, { cwd: ROOT }),
  ...globSync(`${UI_DIR}/public/**/*`, { cwd: ROOT, withFileTypes: false }),
  ...globSync(`${UI_DIR}/csp-probe/**/*.{html,ts,vue}`, { cwd: ROOT }),
  ...globSync(`${UI_DIR}/src/**/*.{vue,ts,js}`, { cwd: ROOT }),
].map((f) => resolve(ROOT, f));

function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Only `<script>`/`<template>` regions are template markup; `<style>` blocks are separately banned outright. */
function scriptRegionsOf(vueSource: string): string {
  return [...vueSource.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? "").join("\n");
}

/** Strip `<!-- ... -->` HTML comments so prose that merely *mentions* `<style>`/`style=` (this file's own doc comments, for instance) can't trip the scan. */
function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, "");
}

const SOURCE_BANNED: Array<[string, RegExp]> = [
  ["v-html", /\bv-html\b/],
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\.write(ln)?\b/],
  ["eval(", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["string setTimeout", /\bsetTimeout\(\s*["'`]/],
  ["createContextualFragment", /createContextualFragment/],
  ["DOMParser", /\bDOMParser\b/],
  ["srcdoc", /\bsrcdoc\b/],
  ["on* property handler", /\.on[a-z]+\s*=[^=]/],
  ["on* via setAttribute", /setAttribute\(\s*["'`]on/i],
  ["style via setAttribute", /setAttribute\(\s*["'`]style/i],
  ["template: option (forces the full Vue build)", /\btemplate\s*:\s*["'`]/],
  ["requestAnimationFrame (banned — renderGate.ts owns scheduling, plan §3.5)", /\brequestAnimationFrame\b/],
  ["<Transition> (uses rAF internally, plan §3.5)", /<Transition\b/],
  // control-plan K18/§2.1 (C4): LAN plaintext HTTP has no crypto.randomUUID — ids come from
  // crypto.getRandomValues (@logic/control.js's newCmdId). The prose mentions above are
  // stripped with the comments, so this only ever fires on real usage.
  ["crypto.randomUUID (banned — K18: absent on LAN plaintext; use getRandomValues)", /\brandomUUID\s*\(/],
];

/** localStorage is only legitimate for the theme preference and the token-mode transport. */
const LOCALSTORAGE_ALLOWED = /theme|token-client/i;

describe("web-hub Vue UI has no HTML-injection / CSP-unsafe sinks", () => {
  it("scans the expected files (glob-failure canary)", () => {
    const rel = files.map((f) => relative(ROOT, f)).sort();
    expect(rel).toEqual(
      expect.arrayContaining([
        `${UI_DIR}/index.html`,
        `${UI_DIR}/public/theme-init.js`,
        `${UI_DIR}/src/main.ts`,
        `${UI_DIR}/src/App.vue`,
        `${UI_DIR}/src/types.ts`,
        `${UI_DIR}/src/contracts.ts`,
        `${UI_DIR}/src/components/body/DetailBody.vue`,
        `${UI_DIR}/csp-probe/Probe.vue`,
        // #32 C5 (control-plan §12.3): control-plane components must stay inside the scan.
        `${UI_DIR}/src/components/control/Composer.vue`,
        `${UI_DIR}/src/components/control/StopButton.vue`,
        `${UI_DIR}/src/components/control/QueueList.vue`,
        `${UI_DIR}/src/components/control/ControlNotice.vue`,
        `${UI_DIR}/src/components/control/CommandPalette.vue`,
        `${UI_DIR}/src/components/control/CommandConfirm.vue`,
        `${UI_DIR}/src/components/control/CommandResult.vue`,
        `${UI_DIR}/src/components/dialog/AskUserForm.vue`,
        `${UI_DIR}/src/components/dialog/AskUserQuestion.vue`,
        `${UI_DIR}/src/components/fleet/FleetActions.vue`,
        `${UI_DIR}/src/components/shell/HubStateBanner.vue`,
      ]),
    );
    expect(files.length).toBeGreaterThan(5);
  });

  it("no banned sinks/patterns in any .vue/.ts/.js source", () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => /\.(vue|ts|js)$/.test(x))) {
      const raw = readFileSync(f, "utf8");
      const scoped = f.endsWith(".vue") ? scriptRegionsOf(raw) : raw;
      const src = stripJsComments(scoped);
      for (const [name, re] of SOURCE_BANNED) if (re.test(src)) offenders.push(`${relative(ROOT, f)}: ${name}`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("no <style> blocks and no static style= attributes in any .vue template", () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".vue"))) {
      const raw = stripHtmlComments(readFileSync(f, "utf8"));
      const rel = relative(ROOT, f);
      if (/<style\b/i.test(raw)) offenders.push(`${rel}: <style> block`);
      const templateMatch = /<template\b[^>]*>([\s\S]*?)<\/template>/i.exec(raw);
      const template = templateMatch?.[1] ?? "";
      if (/<[^>]*\sstyle\s*=\s*["'][^"'{][^>]*>/i.test(template)) {
        offenders.push(`${rel}: static style= attribute in template`);
      }
      if (/<[^>]*\son[a-z]+\s*=\s*["']/i.test(template)) offenders.push(`${rel}: on*= HTML attribute in template`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("HTML entry points: no inline <script> body, no <style>, no on*=/style=, no javascript: URLs", () => {
    const offenders: string[] = [];
    // csp-probe/negative.html is a deliberate, documented exception: its whole purpose is one
    // forbidden inline `style=` attribute, used to prove the CSP probe's violation listener can
    // actually detect a real violation (plan §4.4.1's "反向对照"). Every other HTML entry is held
    // to the full rule.
    for (const f of files.filter((x) => x.endsWith(".html") && !x.endsWith("csp-probe/negative.html"))) {
      const src = readFileSync(f, "utf8");
      const rel = relative(ROOT, f);
      for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = m[1] ?? "";
        const body = m[2] ?? "";
        if (!/\bsrc\s*=/.test(attrs) && body.trim() !== "") offenders.push(`${rel}: inline script body`);
      }
      if (/<style\b/i.test(src)) offenders.push(`${rel}: <style>`);
      if (/<[^>]*\son[a-z]+\s*=/i.test(src)) offenders.push(`${rel}: on*= attribute`);
      if (/<[^>]*\sstyle\s*=/i.test(src)) offenders.push(`${rel}: style= attribute`);
      if (/javascript:/i.test(src)) offenders.push(`${rel}: javascript: URL`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("csp-probe/negative.html really does still carry its one deliberate style= violation (the exception above stays true)", () => {
    const src = readFileSync(resolve(ROOT, `${UI_DIR}/csp-probe/negative.html`), "utf8");
    expect(/<[^>]*\sstyle\s*=\s*["']color:\s*rgb\(1,\s*2,\s*3\)["']/i.test(src)).toBe(true);
  });

  it("no external (http/https) resource references outside the source itself", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
        offenders.push(`${relative(ROOT, f)} → ${m[1]}`);
      }
      for (const m of src.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi)) {
        offenders.push(`${relative(ROOT, f)} → ${m[1]}`);
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("localStorage is only used by the theme bootstrap / token transport", () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => /\.(vue|ts|js)$/.test(x))) {
      if (LOCALSTORAGE_ALLOWED.test(f)) continue;
      const src = stripJsComments(readFileSync(f, "utf8"));
      if (/\blocalStorage\b/.test(src)) offenders.push(relative(ROOT, f));
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("the scanner itself catches violations (self-test)", () => {
    const bad = 'el.innerHTML = x; node.onclick = f; eval("1"); new Function("x"); const t = { template: "<p/>" };';
    const hits = SOURCE_BANNED.filter(([, re]) => re.test(bad)).map(([n]) => n);
    expect(hits).toEqual(
      expect.arrayContaining([
        "innerHTML",
        "eval(",
        "new Function",
        "on* property handler",
        "template: option (forces the full Vue build)",
      ]),
    );
  });
});
