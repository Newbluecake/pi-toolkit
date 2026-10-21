import { describe, expect, it } from "vitest";
import {
  ByteBudgetLru,
  MAX_AREA_PX,
  MAX_FLOW_EDGES,
  MAX_FLOW_EDGES_COARSE,
  MAX_FLOW_VERTICES,
  MAX_FLOW_VERTICES_COARSE,
  MAX_LINES,
  MAX_LINES_COARSE,
  MAX_SIDE_PX,
  MAX_SRC_CHARS,
  MAX_TEXT_CHARS,
  MERMAID_ALLOWED_TYPES,
  MERMAID_SECURE_KEYS,
  MermaidAuthorConfigError,
  checkAuthorConfig,
  checkDiagramDb,
  classifyMermaidError,
  hasCssResourceFunction,
  isMermaidFence,
  mermaidConfig,
  normalizeFontFamily,
  precheckMermaid,
  shortMermaidError,
  svgOutputBreaches,
  svgToImage,
} from "../../../src/web-hub/ui/src/logic/mermaid.js";

describe("isMermaidFence", () => {
  it("matches the first info-string token, case-insensitively", () => {
    for (const lang of ["mermaid", "Mermaid", "MERMAID", "  mermaid", "mermaid title=x", "mermaid{theme}"]) {
      expect(isMermaidFence(lang), lang).toBe(true);
    }
    for (const lang of ["", "js", "mermaidx", "xmermaid", "not mermaid", null, undefined]) {
      expect(isMermaidFence(lang as string | null | undefined), String(lang)).toBe(false);
    }
  });
});

describe("precheckMermaid (G1 + size limits)", () => {
  it("accepts an ordinary diagram", () => {
    expect(precheckMermaid("flowchart LR\n  A --> B")).toEqual({ ok: true });
  });

  it("rejects blank input as parse", () => {
    expect(precheckMermaid("   \n ")).toMatchObject({ ok: false, reason: "parse" });
  });

  it("character limit boundary", () => {
    expect(precheckMermaid("x".repeat(MAX_TEXT_CHARS)).ok).toBe(true);
    expect(precheckMermaid("x".repeat(MAX_TEXT_CHARS + 1))).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("line limit boundary, tighter on touch devices", () => {
    const lines = (n: number): string => Array.from({ length: n }, () => "a").join("\n");
    expect(precheckMermaid(lines(MAX_LINES)).ok).toBe(true);
    expect(precheckMermaid(lines(MAX_LINES + 1))).toMatchObject({ ok: false, reason: "too-large" });
    expect(precheckMermaid(lines(MAX_LINES_COARSE), { coarse: true }).ok).toBe(true);
    expect(precheckMermaid(lines(MAX_LINES_COARSE + 1), { coarse: true })).toMatchObject({
      ok: false,
      reason: "too-large",
    });
    expect(precheckMermaid(lines(MAX_LINES_COARSE + 1), { coarse: false }).ok).toBe(true);
  });

  it("size is judged before the resource scan (no scan cost for oversized input)", () => {
    expect(precheckMermaid(`url(${"x".repeat(MAX_TEXT_CHARS)}`)).toMatchObject({ reason: "too-large" });
  });
});

describe("hasCssResourceFunction (G1 normalization, over-approximating)", () => {
  const rejected: Array<[string, string]> = [
    ["plain url(", "style A fill:url(/x.svg#g)"],
    ["upper case", "style A fill:URL(/x.svg)"],
    ["css hex escape with terminator space", "style A fill:u\\72 l(/x)"],
    ["css single-char escape", "style A fill:u\\rl(/x)"],
    ["css hex escape of the first letter", "style A fill:\\75rl(/x)"],
    ["css 6-digit escape", "style A fill:\\000075rl(/x)"],
    ["js \\xHH", 'fill: "\\x75rl(/x)"'],
    ["js \\uHHHH", 'fill: "\\u0075rl(/x)"'],
    ["js \\u{…}", 'fill: "\\u{75}rl(/x)"'],
    ["js \\UHHHHHHHH", 'fill: "\\U00000075rl(/x)"'],
    ["html decimal entity", "style A fill:&#117;rl(/x)"],
    ["html hex entity", "style A fill:&#x75;rl(/x)"],
    ["mermaid #N; entity", "style A fill:#117;rl(/x)"],
    ["mermaid #xN; entity", "style A fill:#x75;rl(/x)"],
    ["named entity wildcard", "style A fill:url&lpar;/x)"],
    ["comment inside the token", "style A fill:url/**/(/x)"],
    ["image-set", 'style A fill:image-set("/x.png" 1x)'],
    ["-webkit-image-set", 'style A fill:-webkit-image-set("/x.png" 1x)'],
    ["cross-fade", "style A fill:cross-fade(/a.png, /b.png, 50%)"],
    ["-webkit-cross-fade", "style A fill:-webkit-cross-fade(/a.png, /b.png, 50%)"],
    ["double encoding (entity of an escape)", "style A fill:&#92;75rl(/x)"],
  ];
  for (const [name, text] of rejected) {
    it(`rejects: ${name}`, () => expect(hasCssResourceFunction(text), text).toBe(true));
  }

  const accepted: Array<[string, string]> = [
    ["getUrl( prefix", 'A["getUrl(x)"] --> B'],
    ["plain words", "flowchart LR\n  A --> B"],
    ["the word url without a paren", "A[the url is here] --> B"],
    ["hyphenated prefix word", "A[my-url(x)] --> B"],
  ];
  for (const [name, text] of accepted) {
    it(`accepts: ${name}`, () => expect(hasCssResourceFunction(text), text).toBe(false));
  }
});

describe("mermaidConfig / secure list", () => {
  it("snapshot of the site config (no layout key, strict, htmlLabels off)", () => {
    const c = mermaidConfig("light", "Inter, sans-serif");
    expect(c).toMatchInlineSnapshot(`
      {
        "dompurifyConfig": {
          "ALLOWED_ATTR": [
            "class",
          ],
          "ALLOWED_TAGS": [
            "b",
            "strong",
            "i",
            "em",
            "u",
            "s",
            "del",
            "sub",
            "sup",
            "small",
            "mark",
            "code",
            "br",
            "span",
            "p",
            "div",
          ],
          "ALLOW_DATA_ATTR": false,
          "FORBID_TAGS": [
            "style",
          ],
        },
        "fontFamily": "Inter, sans-serif",
        "fontSize": 16,
        "htmlLabels": false,
        "maxEdges": 500,
        "maxTextSize": 20000,
        "secure": [
          "secure",
          "securityLevel",
          "startOnLoad",
          "maxTextSize",
          "suppressErrorRendering",
          "maxEdges",
          "htmlLabels",
          "themeCSS",
          "dompurifyConfig",
          "fontFamily",
          "fontSize",
        ],
        "securityLevel": "strict",
        "startOnLoad": false,
        "suppressErrorRendering": true,
        "theme": "default",
        "themeVariables": {
          "fontFamily": "Inter, sans-serif",
        },
      }
    `);
    expect("layout" in c).toBe(false); // r3: a global layout:"elk" crashes mindmap
  });

  it("follows the theme and keeps the six mermaid default secure keys", () => {
    expect(mermaidConfig("dark", "x")["theme"]).toBe("dark");
    for (const k of ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges"]) {
      expect(MERMAID_SECURE_KEYS).toContain(k);
    }
  });

  it("normalizeFontFamily squeezes whitespace and falls back safely", () => {
    expect(normalizeFontFamily("  a,\n  b  ")).toBe("a, b");
    expect(normalizeFontFamily("   ")).toBe("sans-serif");
    expect(normalizeFontFamily(null)).toBe("sans-serif");
  });

  it("allow-list is the 21 first-version families (no architecture, no eventmodeling)", () => {
    for (const bad of ["architecture", "eventmodeling", "info", "swimlane", "cynefin", "usecase", "venn"]) {
      expect(MERMAID_ALLOWED_TYPES.has(bad), bad).toBe(false);
    }
    for (const good of ["flowchart-v2", "sequence", "classDiagram", "stateDiagram", "er", "gantt", "mindmap", "c4"]) {
      expect(MERMAID_ALLOWED_TYPES.has(good), good).toBe(true);
    }
  });
});

describe("checkAuthorConfig (§2.2 + r3 R2-3/R2-4)", () => {
  it("accepts ordinary configuration", () => {
    expect(
      checkAuthorConfig({
        theme: "forest",
        look: "classic",
        layout: "dagre",
        themeVariables: { primaryColor: "#ff0000", fontFamily: "ignored-by-secure" },
        flowchart: { curve: "basis", nodeSpacing: 40, rankSpacing: 60 },
        sequence: { actorFontSize: 14, noteFontWeight: "bold", messageFontWeight: 400 },
        fontSize: 99, // secure-deleted by mermaid, never judged here
      }),
    ).toBeNull();
    expect(checkAuthorConfig(undefined)).toBeNull();
    expect(checkAuthorConfig({})).toBeNull();
  });

  it("rejects CSS resource functions in any nested string, including arrays", () => {
    expect(checkAuthorConfig({ themeVariables: { x: "url(/a)" } })).toMatchObject({ reason: "unsupported" });
    expect(checkAuthorConfig({ a: { b: [{ c: "image-set(x)" }] } })).toMatchObject({ reason: "unsupported" });
    expect(checkAuthorConfig({ a: "-webkit-cross-fade(x)" })).toMatchObject({ reason: "unsupported" });
  });

  it("rejects strings containing a backslash", () => {
    expect(checkAuthorConfig({ a: "x\\y" })).toMatchObject({ reason: "unsupported" });
  });

  it("rejects font-family variants but not the plain fontFamily key", () => {
    for (const key of ["altFontFamily", "actorFontFamily", "messageFontFamily", "noteFontFamily", "FONTFAMILY2"]) {
      expect(checkAuthorConfig({ sequence: { [key]: "x" } }), key).toMatchObject({ reason: "unsupported" });
    }
    expect(checkAuthorConfig({ fontFamily: "x" })).toBeNull();
    expect(checkAuthorConfig({ themeVariables: { fontFamily: "x" } })).toBeNull();
  });

  it("font-size variants: numeric 8–40 (or ^\\d+(px)?$ in range) only", () => {
    for (const ok of [8, 40, 14.5, "12", "12px"]) {
      expect(checkAuthorConfig({ sequence: { messageFontSize: ok } }), String(ok)).toBeNull();
    }
    for (const bad of [7, 41, -1, "99px", "1e2", "12em", "calc(1px)", "", null, {}, 0]) {
      expect(checkAuthorConfig({ sequence: { messageFontSize: bad } }), String(bad)).toMatchObject({
        reason: "unsupported",
      });
    }
    expect(checkAuthorConfig({ fontSize: 99 })).toBeNull(); // plain fontSize is secure-deleted
  });

  it("font-weight variants: normal, bold, 100–900", () => {
    for (const ok of ["normal", "bold", 100, 900, "400"]) {
      expect(checkAuthorConfig({ s: { noteFontWeight: ok } }), String(ok)).toBeNull();
    }
    for (const bad of ["bolder", "expression(1)", 950, 50, "", null]) {
      expect(checkAuthorConfig({ s: { noteFontWeight: bad } }), String(bad)).toMatchObject({ reason: "unsupported" });
    }
  });

  it("R2-3: only elk and dagre may be selected as `layout`, at any depth; rejection classifies as parse", () => {
    for (const ok of ["elk", "dagre"]) {
      expect(checkAuthorConfig({ layout: ok }), ok).toBeNull();
      expect(checkAuthorConfig({ flowchart: { layout: ok } }), ok).toBeNull();
    }
    for (const bad of ["swimlane", "cose-bilkent", "elk.stress", "ELK", "", 1, null, {}]) {
      expect(checkAuthorConfig({ layout: bad }), String(bad)).toMatchObject({ reason: "parse" });
      expect(checkAuthorConfig({ state: { layout: bad } }), String(bad)).toMatchObject({ reason: "parse" });
    }
  });

  it("mindmap layoutAlgorithm: cose-bilkent (its own default), elk, dagre", () => {
    for (const ok of ["cose-bilkent", "elk", "dagre"])
      expect(checkAuthorConfig({ mindmap: { layoutAlgorithm: ok } })).toBeNull();
    expect(checkAuthorConfig({ mindmap: { layoutAlgorithm: "swimlane" } })).toMatchObject({ reason: "parse" });
  });

  it("R2-4: layout computation parameters are rejected wherever they appear", () => {
    for (const key of [
      "numIter",
      "layeringLayerBound",
      "nodeSeparation",
      "idealEdgeLengthMultiplier",
      "edgeElasticity",
    ]) {
      expect(checkAuthorConfig({ architecture: { [key]: 1 } }), key).toMatchObject({ reason: "unsupported" });
      expect(checkAuthorConfig({ [key]: 1 }), key).toMatchObject({ reason: "unsupported" });
    }
    // any number inside an `elk` subtree
    expect(checkAuthorConfig({ elk: { mergeEdges: true } })).toBeNull();
    expect(checkAuthorConfig({ flowchart: { elk: { somethingNew: 5 } } })).toMatchObject({ reason: "unsupported" });
  });

  it("spacing keys are bounded to [0, 200]", () => {
    expect(checkAuthorConfig({ flowchart: { nodeSpacing: 0, rankSpacing: 200 } })).toBeNull();
    for (const bad of [201, -1, 99999, "50", null, Number.NaN]) {
      expect(checkAuthorConfig({ flowchart: { nodeSpacing: bad } }), String(bad)).toMatchObject({
        reason: "unsupported",
      });
    }
  });

  it("rejects prototype-pollution keys and absurdly deep / large configs", () => {
    expect(checkAuthorConfig(JSON.parse('{"__proto__": {"x": 1}}'))).toMatchObject({ reason: "unsupported" });
    expect(checkAuthorConfig({ constructor: {} })).toMatchObject({ reason: "unsupported" });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i++) deep = { n: deep };
    expect(checkAuthorConfig(deep)).toMatchObject({ reason: "unsupported" });
    expect(checkAuthorConfig(Array.from({ length: 6000 }, () => 1))).toMatchObject({ reason: "unsupported" });
  });

  it("rejection details are fixed phrases, never author text", () => {
    const r = checkAuthorConfig({ layout: "SECRET-LAYOUT-NAME" });
    expect(r?.detail).not.toContain("SECRET");
  });
});

describe("checkDiagramDb (G2 DB audit, R2-4/R2-5)", () => {
  const flowDb = (vertices: unknown, edges: unknown) => ({ getVertices: () => vertices, getEdges: () => edges });
  const opts = { coarse: false, text: "" };

  it("flowchart: images are refused; plain vertices pass", () => {
    const ok = new Map([["A", { id: "A", text: "a" }]]);
    expect(checkDiagramDb("flowchart-v2", flowDb(ok, []), opts)).toBeNull();
    const img = new Map([["A", { id: "A", img: "/x.png" }]]);
    expect(checkDiagramDb("flowchart-v2", flowDb(img, []), opts)).toMatchObject({ reason: "unsupported" });
    expect(checkDiagramDb("flowchart-elk", flowDb({ A: { img: "x" } }, []), opts)).toMatchObject({
      reason: "unsupported",
    });
    expect(checkDiagramDb("flowchart", flowDb(new Map([["A", { img: "" }]]), []), opts)).toBeNull();
  });

  it("flowchart: edge and vertex ceilings (desktop vs touch)", () => {
    const edges = (n: number) => Array.from({ length: n }, () => ({}));
    const verts = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`v${i}`, {}]));
    expect(checkDiagramDb("flowchart-v2", flowDb(verts(1), edges(MAX_FLOW_EDGES)), opts)).toBeNull();
    expect(checkDiagramDb("flowchart-v2", flowDb(verts(1), edges(MAX_FLOW_EDGES + 1)), opts)).toMatchObject({
      reason: "too-large",
    });
    expect(checkDiagramDb("flowchart-v2", flowDb(verts(MAX_FLOW_VERTICES), []), opts)).toBeNull();
    expect(checkDiagramDb("flowchart-v2", flowDb(verts(MAX_FLOW_VERTICES + 1), []), opts)).toMatchObject({
      reason: "too-large",
    });
    const coarse = { coarse: true, text: "" };
    expect(checkDiagramDb("flowchart-v2", flowDb(verts(1), edges(MAX_FLOW_EDGES_COARSE + 1)), coarse)).toMatchObject({
      reason: "too-large",
    });
    expect(checkDiagramDb("flowchart-v2", flowDb(verts(MAX_FLOW_VERTICES_COARSE + 1), []), coarse)).toMatchObject({
      reason: "too-large",
    });
    expect(
      checkDiagramDb("flowchart-v2", flowDb(verts(MAX_FLOW_VERTICES_COARSE), edges(MAX_FLOW_EDGES_COARSE)), coarse),
    ).toBeNull();
  });

  it("flowchart / sequence: an unexpected DB shape fails closed", () => {
    expect(checkDiagramDb("flowchart-v2", {}, opts)).toMatchObject({ reason: "unsupported" });
    expect(checkDiagramDb("flowchart-v2", null, opts)).toMatchObject({ reason: "unsupported" });
    expect(checkDiagramDb("flowchart-v2", flowDb(5, []), opts)).toMatchObject({ reason: "unsupported" });
    expect(checkDiagramDb("sequence", {}, opts)).toMatchObject({ reason: "unsupported" });
    expect(checkDiagramDb("sequence", { getActors: () => 5 }, opts)).toMatchObject({ reason: "unsupported" });
  });

  it("sequence: actor icons are refused", () => {
    const seq = (actors: unknown) => ({ getActors: () => actors });
    expect(checkDiagramDb("sequence", seq(new Map([["A", { name: "A" }]])), opts)).toBeNull();
    expect(checkDiagramDb("sequence", seq(new Map([["A", { properties: { other: 1 } }]])), opts)).toBeNull();
    expect(checkDiagramDb("sequence", seq(new Map([["A", { properties: { icon: "/x.png" } }]])), opts)).toMatchObject({
      reason: "unsupported",
    });
  });

  it("sequence: the `details` directive (reads main-document nodes) is refused lexically (R2-5)", () => {
    const db = { getActors: () => new Map() };
    for (const text of [
      "sequenceDiagram\n  participant A\n  details A: target",
      "sequenceDiagram\n  participant A; details A: target",
      "sequenceDiagram\n DETAILS A: target",
    ]) {
      expect(checkDiagramDb("sequence", db, { coarse: false, text }), text).toMatchObject({ reason: "unsupported" });
    }
    for (const text of [
      "sequenceDiagram\n  A->>B: see details here",
      "sequenceDiagram\n  participant details\n  details->>B: x",
      "sequenceDiagram\n  Note over A: details: none",
    ]) {
      expect(checkDiagramDb("sequence", db, { coarse: false, text }), text).toBeNull();
    }
  });

  it("other (audited) families are a no-op", () => {
    expect(checkDiagramDb("pie", null, opts)).toBeNull();
    expect(checkDiagramDb("classDiagram", {}, opts)).toBeNull();
  });
});

describe("svgToImage (§5)", () => {
  const svg = (rootAttrs: string, body = "<g></g>"): string => `<svg ${rootAttrs}>${body}</svg>`;
  const ns = 'xmlns="http://www.w3.org/2000/svg"';
  const decode = (src: string): string => decodeURIComponent(src.slice(src.indexOf(",") + 1));

  it("rewrites width=100% into px from the viewBox and keeps the other attributes in order", () => {
    const r = svg(`id="m" ${ns} width="100%" viewBox="0 0 120.2 80" aria-roledescription="flowchart-v2"`);
    const out = svgToImage(r);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({ width: 121, height: 80, diagramType: "flowchart-v2", title: null });
    const doc = decode(out!.src);
    expect(doc).toBe(
      `<svg id="m" ${ns} viewBox="0 0 120.2 80" aria-roledescription="flowchart-v2" width="121" height="80"><g></g></svg>`,
    );
    expect(out!.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  });

  it("does not duplicate an existing height (journey regression) and drops style", () => {
    const out = svgToImage(svg(`${ns} width="100%" height="55" style="max-width:5px" viewBox="0 0 10 20"`));
    const doc = decode(out!.src);
    expect(doc.match(/ height="/g)).toHaveLength(1);
    expect(doc.match(/ width="/g)).toHaveLength(1);
    expect(doc).not.toContain("style=");
    expect(out).toMatchObject({ width: 10, height: 20 });
  });

  it("accepts scientific notation and comma-separated viewBox numbers", () => {
    expect(svgToImage(svg(`${ns} viewBox="0 0 1.2e3 5E1"`))).toMatchObject({ width: 1200, height: 50 });
    expect(svgToImage(svg(`${ns} viewBox="0,0,30,40"`))).toMatchObject({ width: 30, height: 40 });
    expect(svgToImage(svg(`${ns} viewBox=" -5  -5\t30 40 "`))).toMatchObject({ width: 30, height: 40 });
  });

  it("rejects a missing or malformed viewBox", () => {
    expect(svgToImage(svg(ns))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 10"`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 10 20 30"`))).toBeNull();
    for (const vb of [
      "0 0 NaN 5",
      "0 0 Infinity 5",
      "0 0 1e400 5",
      "0 0 0 5",
      "0 0 -4 5",
      "0 0 5 0",
      "0 0 5 -1",
      "a b c d",
      "0 0 1_0 5",
      "0 0 0x10 5",
    ]) {
      expect(svgToImage(svg(`${ns} viewBox="${vb}"`)), vb).toBeNull();
    }
    expect(svgToImage(svg(`${ns} viewBox="-0 -0 5 5"`))).toMatchObject({ width: 5, height: 5 }); // -0 origin is fine
  });

  it("rejects oversize sides, area and absurd origins", () => {
    expect(svgToImage(svg(`${ns} viewBox="0 0 ${MAX_SIDE_PX} 10"`))).not.toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 ${MAX_SIDE_PX + 1} 10"`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 10 ${MAX_SIDE_PX + 0.5}"`))).toBeNull();
    const side = Math.floor(Math.sqrt(MAX_AREA_PX));
    expect(svgToImage(svg(`${ns} viewBox="0 0 ${side} ${side}"`))).not.toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 ${side + 1} ${side + 1}"`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="1000001 0 10 10"`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 -1000001 10 10"`))).toBeNull();
  });

  it("rejects non-svg start, self-closing, unquoted/duplicate/bare attributes, overlong and excessive roots", () => {
    expect(svgToImage(` ${svg(`${ns} viewBox="0 0 1 1"`)}`)).toBeNull();
    expect(svgToImage(`<?xml version="1.0"?>${svg(`${ns} viewBox="0 0 1 1"`)}`)).toBeNull();
    expect(svgToImage(`<svg ${ns} viewBox="0 0 1 1"/>`)).toBeNull();
    expect(svgToImage(`<svg ${ns} viewBox=0>`)).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1" viewBox="0 0 2 2"`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1" hidden`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1"id="x"`))).toBeNull(); // no whitespace between attributes
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1" data-x="a<b"`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1" 1bad="x"`))).toBeNull();
    const many = Array.from({ length: 65 }, (_, i) => `a${i}="1"`).join(" ");
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1" ${many}`))).toBeNull();
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1" data-pad="${"x".repeat(5000)}"`))).toBeNull();
  });

  it("a `>` inside a quoted attribute value does not end the root tag", () => {
    const out = svgToImage(svg(`${ns} viewBox="0 0 4 4" data-x="a>b"`));
    expect(out).not.toBeNull();
    expect(decode(out!.src)).toContain('data-x="a>b"');
  });

  it("requires the svg namespace", () => {
    expect(svgToImage(svg('viewBox="0 0 1 1"'))).toBeNull();
    expect(svgToImage(svg('xmlns="http://example.com/x" viewBox="0 0 1 1"'))).toBeNull();
  });

  it("single-quoted values containing a double quote stay well-formed after the rewrite", () => {
    const out = svgToImage(`<svg ${ns} viewBox="0 0 1 1" data-q='say "hi"'><g/></svg>`);
    expect(decode(out!.src)).toContain('data-q="say &quot;hi&quot;"');
  });

  it("G5: every dangerous element or external url() is an output-invalid breach", () => {
    const breaches: string[] = [];
    const base = `${ns} viewBox="0 0 10 10"`;
    for (const body of [
      "<image href='x.png'/>",
      "<IMG src=x>",
      "<script>1</script>",
      "<iframe></iframe>",
      "<object></object>",
      "<embed>",
      "<video></video>",
      "<audio></audio>",
      "<animate attributeName='x'/>",
      "<animateTransform/>",
      "<set attributeName='x'/>",
      '<rect fill="url(http://x/a.svg#g)"/>',
      '<rect style="fill:url(/x.svg)"/>',
      "<rect style=\"fill:url('/x.svg')\"/>",
      '<rect fill="URL( /x.svg )"/>',
      '<rect fill="u&#114;l(/x.svg)"/>',
      '<rect style="fill:image-set(x)"/>',
      '<rect style="fill:-webkit-cross-fade(a,b,50%)"/>',
      '<rect style="fill:u\\72 l(/x.svg)"/>',
    ]) {
      const r = svgToImage(svg(base, body), () => breaches.push(body));
      expect(r, body).toBeNull();
    }
    expect(breaches).toHaveLength(19);
  });

  it("G5: fragment-only url(#id) references (gradients, markers, filters) pass", () => {
    for (const ref of ["url(#g)", 'url("#g")', "url('#g')", "url( #g )"]) {
      const out = svgToImage(svg(`${ns} viewBox="0 0 10 10"`, `<rect fill="${ref.replace(/"/g, "&quot;")}"/>`));
      expect(out, ref).not.toBeNull();
    }
    expect(svgOutputBreaches("<g></g>")).toBe(false);
    expect(svgOutputBreaches("<settings/>")).toBe(false); // `<set` is a prefix, not an element name match
  });

  it("an onBreach callback is not called for non-G5 failures", () => {
    let calls = 0;
    svgToImage(svg(ns), () => calls++);
    expect(calls).toBe(0);
  });

  it("metadata: aria-roledescription must look like a type name; the first <title> is decoded and truncated", () => {
    const withRole = (role: string): ReturnType<typeof svgToImage> =>
      svgToImage(svg(`${ns} viewBox="0 0 1 1" aria-roledescription="${role}"`));
    expect(withRole("sequence")!.diagramType).toBe("sequence");
    expect(withRole("flowchart-v2")!.diagramType).toBe("flowchart-v2");
    expect(withRole('a"><script>')!).toBeNull(); // quote inside breaks the root tag → rejected outright
    expect(withRole("has space")!.diagramType).toBe("unknown");
    expect(withRole("x".repeat(33))!.diagramType).toBe("unknown");
    expect(withRole("")!.diagramType).toBe("unknown");

    const titled = svgToImage(
      svg(
        `${ns} viewBox="0 0 1 1"`,
        "<title id='t'>A &lt;b&gt; &amp;lt; &quot;q&quot; &#65; &#x42;</title><title>second</title>",
      ),
    );
    expect(titled!.title).toBe('A <b> &lt; "q" A B');
    const long = svgToImage(svg(`${ns} viewBox="0 0 1 1"`, `<title>${"é".repeat(300)}</title>`));
    expect(Array.from(long!.title!)).toHaveLength(200);
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1"`, "<g/>"))!.title).toBeNull();
    // out-of-range numeric entities degrade to U+FFFD, never throw
    expect(svgToImage(svg(`${ns} viewBox="0 0 1 1"`, "<title>&#1114112;</title>"))!.title).toBe("\ufffd");
  });

  it("encodes '#', '%' and CJK correctly (round-trips through encodeURIComponent)", () => {
    const body = "<text>中文 100% #fff &amp; done</text>";
    const out = svgToImage(svg(`${ns} viewBox="0 0 10 10"`, body));
    expect(out!.src).not.toContain("#");
    expect(out!.src).not.toContain(" ");
    expect(decode(out!.src)).toContain(body);
  });

  it("UTF-8 byte budget (2 MiB) and encoded-length budget", () => {
    const head = `<svg ${ns} viewBox="0 0 1 1">`;
    const mk = (bytes: number): string => `${head}<desc>${"a".repeat(bytes)}</desc></svg>`;
    // ASCII just under / over 2 MiB of UTF-8 (encodes to ≈ same length: under MAX_SRC_CHARS only after %-escaping of '<>' etc.)
    expect(svgToImage(mk(1_000_000))).not.toBeNull();
    expect(svgToImage(mk(2 * 1024 * 1024))).toBeNull();
    // CJK: 3 bytes/char → ~1.4 MiB of text passes the byte budget but its percent-encoding (×9) busts MAX_SRC_CHARS
    const cjk = `${head}<desc>${"中".repeat(600_000)}</desc></svg>`;
    expect(new TextEncoder().encode(cjk).length).toBeLessThan(2 * 1024 * 1024);
    expect(svgToImage(cjk)).toBeNull();
    expect(MAX_SRC_CHARS).toBe(4 * 1024 * 1024);
  });

  it("non-string / empty input is rejected without throwing", () => {
    expect(svgToImage("")).toBeNull();
    expect(svgToImage(undefined as unknown as string)).toBeNull();
    expect(svgToImage("<svg")).toBeNull();
    expect(svgToImage("<svg ")).toBeNull();
  });
});

describe("classifyMermaidError / shortMermaidError", () => {
  it("classifies parse, unsupported (KaTeX stub), too-large and render errors", () => {
    expect(classifyMermaidError(new Error("Parse error on line 2:\n...x\n-----^\nExpecting 'SEMI'"))).toBe("parse");
    expect(classifyMermaidError(new Error("Lexical error on line 1. Unrecognized text."))).toBe("parse");
    expect(classifyMermaidError(Object.assign(new Error("whatever"), { name: "UnknownDiagramError" }))).toBe("parse");
    expect(classifyMermaidError(new Error("No diagram type detected matching given configuration for text: x"))).toBe(
      "parse",
    );
    expect(classifyMermaidError(Object.assign(new Error("x"), { hash: { line: 1 } }))).toBe("parse");
    expect(classifyMermaidError(new MermaidAuthorConfigError("Layout is not supported"))).toBe("parse");
    expect(classifyMermaidError(new Error("pwh-mermaid: KaTeX math is not bundled"))).toBe("unsupported");
    expect(classifyMermaidError(new Error("Edge limit exceeded. 501 edges found, but the limit is 500."))).toBe(
      "too-large",
    );
    expect(classifyMermaidError(new Error("Cannot read properties of null (reading 're')"))).toBe("render");
    expect(classifyMermaidError("a string")).toBe("render");
    expect(classifyMermaidError(undefined)).toBe("render");
    expect(classifyMermaidError({ weird: true })).toBe("render");
  });

  it("messages are short, single-line and never echo the diagram text", () => {
    const secret = "TOP-SECRET-LABEL";
    const e = new Error(`Parse error on line 7:\n...${secret}...\nExpecting 'X'`);
    const msg = shortMermaidError("parse", e);
    expect(msg).toBe("Diagram syntax error near line 7.");
    expect(msg).not.toContain(secret);
    expect(shortMermaidError("parse", new Error(`Parse error: ${secret}`))).not.toContain(secret);
    expect(shortMermaidError("render", new Error(secret))).not.toContain(secret);
    expect(shortMermaidError("unsupported", new Error("pwh-mermaid: KaTeX math is not bundled"))).toContain("math");
    expect(
      shortMermaidError("parse", new MermaidAuthorConfigError("Layout is not supported (only elk and dagre).")),
    ).toBe("Layout is not supported (only elk and dagre).");
    for (const reason of [
      "parse",
      "render",
      "too-large",
      "unsupported",
      "timeout",
      "busy",
      "load-failed",
      "engine-unavailable",
      "output-invalid",
    ] as const) {
      const m = shortMermaidError(reason);
      expect(m.length).toBeLessThanOrEqual(160);
      expect(m).not.toMatch(/[\r\n]/);
    }
  });
});

describe("ByteBudgetLru", () => {
  it("evicts least-recently-used entries beyond the entry cap", () => {
    const c = new ByteBudgetLru<string>(3, 1_000_000);
    c.set("a", "A", 1);
    c.set("b", "B", 1);
    c.set("c", "C", 1);
    expect(c.get("a")).toBe("A"); // a becomes most-recent
    c.set("d", "D", 1);
    expect(c.get("b")).toBeUndefined();
    expect([c.get("a"), c.get("c"), c.get("d")]).toEqual(["A", "C", "D"]);
    expect(c.size).toBe(3);
  });

  it("evicts by the code-unit budget and tracks the running total", () => {
    const c = new ByteBudgetLru<string>(100, 10);
    c.set("a", "A", 4);
    c.set("b", "B", 4);
    expect(c.units).toBe(8);
    c.set("c", "C", 4);
    expect(c.get("a")).toBeUndefined();
    expect(c.units).toBe(8);
    c.set("b", "B2", 2); // replacing adjusts the total
    expect(c.units).toBe(6);
    expect(c.get("b")).toBe("B2");
  });

  it("never stores a single entry over the per-entry or total budget", () => {
    const c = new ByteBudgetLru<string>(10, 100, 50);
    expect(c.set("big", "x", 51)).toBe(false);
    expect(c.set("fits", "x", 50)).toBe(true);
    expect(new ByteBudgetLru<string>(10, 5).set("huge", "x", 6)).toBe(false);
    expect(c.get("big")).toBeUndefined();
    c.clear();
    expect(c.size).toBe(0);
    expect(c.units).toBe(0);
  });
});
