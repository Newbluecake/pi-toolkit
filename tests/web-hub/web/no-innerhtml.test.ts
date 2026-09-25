import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

/**
 * Static XSS guard over the whole frontend (plan §包 E 安全): no HTML-string
 * sinks, no eval-likes, no inline event handlers, no inline script/style
 * (CSP `script-src 'self'; style-src 'self'`).
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const files = [
  ...globSync("src/web-hub/web/**/*.js", { cwd: ROOT }),
  ...globSync("src/web-hub/web/**/*.html", { cwd: ROOT }),
].map((f) => resolve(ROOT, f));

/** Strip `//` and `/* *\/` comments from JS so prose in doc comments cannot trip the scan. */
function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const JS_BANNED: Array<[string, RegExp]> = [
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
  ["inline style attribute", /setAttribute\(\s*["'`]style/i],
];

describe("frontend has no HTML-injection sinks", () => {
  it("scans the expected files", () => {
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        "src/web-hub/web/index.html",
        "src/web-hub/web/app.js",
        "src/web-hub/web/contract.js",
        "src/web-hub/web/state.js",
        "src/web-hub/web/render/agents.js",
        "src/web-hub/web/render/transcript.js",
        "src/web-hub/web/render/markdown.js",
        "src/web-hub/web/render/tools.js",
        "src/web-hub/web/render/fleet.js",
        "src/web-hub/web/render/banner.js",
      ]),
    );
  });

  it("JS: no innerHTML / outerHTML / insertAdjacentHTML / eval / new Function / inline handlers", () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      const src = stripJsComments(readFileSync(f, "utf8"));
      for (const [name, re] of JS_BANNED) if (re.test(src)) offenders.push(`${relative(ROOT, f)}: ${name}`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("HTML: no inline <script> body, no <style>, no on*= attributes, no style=, no javascript: URLs", () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".html"))) {
      const src = readFileSync(f, "utf8");
      const rel = relative(ROOT, f);
      for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (!/\bsrc\s*=/.test(m[1] ?? "")) offenders.push(`${rel}: script without src`);
        if ((m[2] ?? "").trim() !== "") offenders.push(`${rel}: inline script body`);
      }
      if (/<style\b/i.test(src)) offenders.push(`${rel}: <style>`);
      if (/<[^>]*\son[a-z]+\s*=/i.test(src)) offenders.push(`${rel}: on*= attribute`);
      if (/<[^>]*\sstyle\s*=/i.test(src)) offenders.push(`${rel}: style= attribute`);
      if (/javascript:/i.test(src)) offenders.push(`${rel}: javascript: URL`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("the scanner itself catches violations (self-test)", () => {
    const bad = 'el.innerHTML = x; node.onclick = f; eval("1"); new Function("x")';
    const hits = JS_BANNED.filter(([, re]) => re.test(bad)).map(([n]) => n);
    expect(hits).toEqual(expect.arrayContaining(["innerHTML", "eval(", "new Function", "on* property handler"]));
    expect(/<[^>]*\son[a-z]+\s*=/i.test('<div onclick="x">')).toBe(true);
  });

  it("frontend imports only relative .js modules (no npm, no CDN, no TS)", () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      const src = stripJsComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (!spec.startsWith("./") && !spec.startsWith("../")) offenders.push(`${relative(ROOT, f)} → ${spec}`);
        else if (!spec.endsWith(".js")) offenders.push(`${relative(ROOT, f)} → ${spec}`);
        else if (!resolve(f, "..", spec).startsWith(resolve(ROOT, "src/web-hub/web")))
          offenders.push(`${relative(ROOT, f)} → ${spec} (outside web/)`);
      }
      if (/\bimport\s*\(/.test(src)) offenders.push(`${relative(ROOT, f)}: dynamic import`);
    }
    const html = readFileSync(resolve(ROOT, "src/web-hub/web/index.html"), "utf8");
    if (/(src|href)\s*=\s*["']https?:/i.test(html)) offenders.push("index.html: external resource");
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});
