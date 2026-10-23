/**
 * Mermaid probe page (web-hub-mermaid plan §10.4, S0). Runs the REAL `mermaid-runtime` → `mermaid-impl`
 * pipeline under the production CSP and exposes a tiny driver API on `window.__pwh`; the Node side
 * (`scripts/web-hub/csp-probe.ts --suite mermaid`) feeds it the corpus and judges the results with
 * Playwright's own request log (the authority on "zero requests"). Depends only on P1 artifacts.
 */
import "../src/styles/tokens.css";
import { requestMermaid, mermaidEngineState, type MermaidOutcome } from "../src/components/shared/mermaid-runtime";
import { svgToImage } from "../src/logic/mermaid";

interface DomLog {
  bad: string[];
  bodyAdds: string[];
}

const BAD_TAGS = new Set(["IMG", "IMAGE", "VIDEO", "AUDIO", "SOURCE", "IFRAME", "OBJECT", "EMBED"]);
const dom: DomLog = { bad: [], bodyAdds: [] };

function describe(node: Node): string {
  if (node.nodeType !== 1) return node.nodeName;
  const el = node as Element;
  return `${el.nodeName.toLowerCase()}${el.id ? `#${el.id}` : ""}`;
}

function inspect(node: Node): void {
  if (node.nodeType !== 1) return;
  const el = node as Element;
  if (BAD_TAGS.has(el.nodeName.toUpperCase())) dom.bad.push(describe(el));
  if (el.nodeName.toLowerCase() === "use") {
    const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
    if (!href.startsWith("#")) dom.bad.push("use[href]");
  }
  for (const child of Array.from(el.querySelectorAll("img,image,video,audio,source,iframe,object,embed,use"))) {
    inspect(child);
  }
}

const out = document.createElement("div");
out.id = "out";
document.body.append(out);

// `sequence details` reads a main-document node by id: provide the bait so a missed gate is visible.
const bait = document.createElement("div");
bait.id = "pwh-details-target";
bait.hidden = true;
bait.textContent = JSON.stringify({ properties: { icon: "/probe-sink/details.png" } });
document.body.append(bait);

const observer = new MutationObserver((records) => {
  for (const r of records) {
    if (out.contains(r.target)) continue;
    if (r.target === document.body) for (const n of Array.from(r.addedNodes)) dom.bodyAdds.push(describe(n));
    for (const n of Array.from(r.addedNodes)) inspect(n);
  }
});
observer.observe(document, { childList: true, subtree: true });

const violations: Array<{ directive: string; uri: string }> = [];
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push({ directive: e.violatedDirective, uri: e.blockedURI });
});

function fontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-sans").replace(/\s+/g, " ").trim();
}

export interface RenderReport {
  outcome: "ok" | "error" | "cancelled";
  reason?: string;
  message?: string;
  diagramType?: string;
  width?: number;
  height?: number;
  decoded?: boolean;
  naturalWidth?: number;
  ms: number;
  svg?: string;
  srcLength?: number;
}

async function render(text: string, theme: "light" | "dark", wantSvg = false): Promise<RenderReport> {
  const t0 = performance.now();
  const o: MermaidOutcome = await requestMermaid({ text, theme });
  const ms = Math.round(performance.now() - t0);
  if (o.kind !== "ok") {
    return o.kind === "error"
      ? { outcome: "error", reason: o.reason, message: o.message, ms }
      : { outcome: "cancelled", ms };
  }
  const img = document.createElement("img");
  img.alt = "";
  img.width = o.width;
  img.height = o.height;
  img.src = o.src;
  out.append(img);
  let decoded = true;
  try {
    await img.decode();
  } catch {
    decoded = false;
  }
  const report: RenderReport = {
    outcome: "ok",
    diagramType: o.diagramType,
    width: o.width,
    height: o.height,
    decoded,
    naturalWidth: img.naturalWidth,
    srcLength: o.src.length,
    ms,
  };
  if (wantSvg) report.svg = decodeURIComponent(o.src.slice(o.src.indexOf(",") + 1));
  img.remove();
  return report;
}

async function sinkControl(): Promise<boolean> {
  const img = new Image();
  img.src = "/probe-sink/control.png";
  await new Promise<void>((resolve) => {
    img.addEventListener("load", () => resolve());
    img.addEventListener("error", () => resolve());
  });
  return true;
}

const api = {
  render,
  sinkControl,
  fontFamily,
  engineState: () => mermaidEngineState(),
  dom: () => ({ bad: [...dom.bad], bodyAdds: [...dom.bodyAdds] }),
  resetDom: () => {
    dom.bad.length = 0;
    dom.bodyAdds.length = 0;
  },
  violations: () => [...violations],
  bodyChildren: () => Array.from(document.body.children).map(describe),
  svgToImageHuge: () => {
    const huge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 99999 99999"><g/></svg>';
    return svgToImage(huge) === null;
  },
  async effectiveConfig(text: string, theme: "light" | "dark") {
    const impl = await import("../src/components/shared/mermaid-impl");
    return impl.pwhProbeEffectiveConfig({ text, theme, fontFamily: fontFamily() });
  },
  async parseCostMs(text: string, rounds: number) {
    const impl = await import("../src/components/shared/mermaid-impl");
    return impl.pwhProbeParseCostMs({ text, theme: "light", fontFamily: fontFamily(), rounds });
  },
};

(window as unknown as { __pwh: typeof api }).__pwh = api;
(window as unknown as { __PWH_PROBE_READY__?: boolean }).__PWH_PROBE_READY__ = true;
