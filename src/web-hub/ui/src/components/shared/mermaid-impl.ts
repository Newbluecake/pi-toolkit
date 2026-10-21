/**
 * Lazily-loaded mermaid engine adapter (web-hub-mermaid plan §3, §4.1, r3 rulings). The ONLY module
 * that imports `mermaid`; everything before the DOM is touched happens here, in this order:
 *
 *  1. `mermaid.detectType` (no parse, no DOM) → G4 type allow-list → sequence `details` ban (R2-5);
 *  2. `mermaid.parse` → decoded author config → §2.2 / R2-3 / R2-4 checks (G2);
 *  3. `mermaidAPI.getDiagramFromText` → the three results must agree on the diagram type (R2-5) →
 *     DB audit (flowchart `@{img}` + limits, sequence icons);
 *  4. only then `mermaid.render(id, text, stage)`; the rendered root's `aria-roledescription` must
 *     still equal the pre-parsed type.
 *
 * All three parses run under the same site config (`mermaid.initialize` happens once per theme/font)
 * and the same author config (it travels inside the text). `bindFunctions` is never called.
 */
import mermaid from "mermaid";
import {
  MERMAID_ALLOWED_TYPES,
  MermaidAuthorConfigError,
  checkAuthorConfig,
  checkDiagramDb,
  hasSequenceDetails,
  mermaidConfig,
  type MermaidTheme,
} from "@logic/mermaid.js";

export type ImplResult =
  | { kind: "svg"; svg: string; diagramType: string }
  | { kind: "rejected"; reason: "unsupported" | "too-large"; detail: string };

let stage: HTMLElement | undefined;
let configured: { theme: MermaidTheme; fontFamily: string } | undefined;

function ensureStage(): HTMLElement {
  if (!stage || !stage.isConnected) {
    stage = document.createElement("div");
    stage.className = "pwh-mmd-stage";
    stage.setAttribute("aria-hidden", "true");
    document.body.append(stage);
  }
  return stage;
}

function configure(theme: MermaidTheme, fontFamily: string): void {
  if (configured && configured.theme === theme && configured.fontFamily === fontFamily) return;
  mermaid.initialize(mermaidConfig(theme, fontFamily) as Parameters<typeof mermaid.initialize>[0]);
  configured = { theme, fontFamily };
}

function reject(reason: "unsupported" | "too-large", detail: string): ImplResult {
  return { kind: "rejected", reason, detail };
}

function rootRoleDescription(svg: string): string | null {
  const end = svg.indexOf(">");
  const m = /\saria-roledescription="([^"]*)"/.exec(end < 0 ? svg : svg.slice(0, end));
  return m ? (m[1] ?? null) : null;
}

/** parse/render failures throw (the runtime classifies them); gate rejections are returned. */
export async function renderSvg(input: {
  id: string;
  text: string;
  theme: MermaidTheme;
  fontFamily: string;
  coarse: boolean;
}): Promise<ImplResult> {
  const { id, text, theme, fontFamily, coarse } = input;
  const host = ensureStage();
  configure(theme, fontFamily);
  try {
    // 1. type, before any parse touches the text.
    const detected = mermaid.detectType(text, mermaid.mermaidAPI.getConfig());
    if (!MERMAID_ALLOWED_TYPES.has(detected)) return reject("unsupported", "This diagram type is not supported yet.");
    if (detected === "sequence" && hasSequenceDetails(text)) {
      return reject("unsupported", "The sequence `details` directive is not supported.");
    }
    // 2. decoded author config.
    const parsed = await mermaid.parse(text);
    if (!parsed) throw new Error("Parse error: no result");
    if (parsed.diagramType !== detected) return reject("unsupported", "Diagram type is ambiguous.");
    const cfg = checkAuthorConfig(parsed.config);
    if (cfg) {
      if (cfg.reason === "parse") throw new MermaidAuthorConfigError(cfg.detail);
      return reject(cfg.reason, cfg.detail);
    }
    // 3. second parse → DB audit.
    const diag = await mermaid.mermaidAPI.getDiagramFromText(text);
    if (diag.type !== detected) return reject("unsupported", "Diagram type is ambiguous.");
    const dbCheck = checkDiagramDb(diag.type, diag.db, { coarse, text });
    if (dbCheck) {
      if (dbCheck.reason === "parse") throw new MermaidAuthorConfigError(dbCheck.detail);
      return reject(dbCheck.reason, dbCheck.detail);
    }
    // 4. render (third parse) in the off-screen stage.
    const { svg } = await mermaid.render(id, text, host);
    const role = rootRoleDescription(svg);
    if (role !== null && role !== detected) return reject("unsupported", "Diagram type changed during rendering.");
    return { kind: "svg", svg, diagramType: detected };
  } finally {
    host.replaceChildren();
  }
}

/* ------------------------------------------------------------------------------ probe hooks */
// Read-only diagnostics used ONLY by `npm run probe:mermaid` (csp-probe/mermaid.ts). They never run in
// the product path and expose no text. Kept here because this is the one module allowed to import mermaid.

/** Snapshot of the config mermaid would apply after the author's directives were sanitized. */
export async function pwhProbeEffectiveConfig(input: {
  text: string;
  theme: MermaidTheme;
  fontFamily: string;
}): Promise<Record<string, unknown>> {
  ensureStage();
  configure(input.theme, input.fontFamily);
  try {
    await mermaid.parse(input.text);
  } catch {
    // an unparsable probe text still leaves the site config observable
  }
  const c = mermaid.mermaidAPI.getConfig() as Record<string, unknown> & {
    flowchart?: Record<string, unknown>;
    themeVariables?: Record<string, unknown>;
    dompurifyConfig?: Record<string, unknown>;
  };
  return {
    htmlLabels: c["htmlLabels"],
    securityLevel: c["securityLevel"],
    hasThemeCSS: Boolean(c["themeCSS"]),
    dompurifyTags: c.dompurifyConfig?.["ALLOWED_TAGS"],
    fontFamily: c["fontFamily"],
    fontSize: c["fontSize"],
    flowchartHtmlLabels: c.flowchart?.["htmlLabels"],
    themeVariablesFontSize: c.themeVariables?.["fontSize"],
    theme: c["theme"],
    layout: c["layout"],
  };
}

/** Average cost (ms) of the pre-render checks: detectType + parse + getDiagramFromText. */
export async function pwhProbeParseCostMs(input: {
  text: string;
  theme: MermaidTheme;
  fontFamily: string;
  rounds: number;
}): Promise<number> {
  configure(input.theme, input.fontFamily);
  const t0 = performance.now();
  for (let i = 0; i < input.rounds; i++) {
    mermaid.detectType(input.text, mermaid.mermaidAPI.getConfig());
    await mermaid.parse(input.text);
    await mermaid.mermaidAPI.getDiagramFromText(input.text);
  }
  return (performance.now() - t0) / input.rounds;
}
