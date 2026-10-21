/**
 * KaTeX stub (web-hub-mermaid plan §2.3, user ruling D2: math is NOT bundled). vite.config.ts aliases
 * `katex` to this file so mermaid's lazy `import("katex")` resolves to something that throws a
 * recognizable error — the runtime maps it to the `unsupported` outcome (`classifyMermaidError`).
 *
 * Deliberately NOT a Proxy: a catch-all Proxy makes ordinary flowcharts fail as well (r1 measurement).
 */
const noMath = (): never => {
  throw new Error("pwh-mermaid: KaTeX math is not bundled");
};

export const render = noMath;
export const renderToString = noMath;
export default { render: noMath, renderToString: noMath };
