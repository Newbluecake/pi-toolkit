// P2 stub — P1 owns this file (web-hub-mermaid plan §6.1: `logic/mermaid.ts` carries
// `isMermaidFence`, the G1 precheck, config constants, `svgToImage`, …). P2 (components &
// wiring) only needs `isMermaidFence` at import time; when P1 lands this file is replaced
// wholesale — merge keeps P1's version. The stub semantic below matches the plan's fence
// routing (markdown.js keeps only the first info-string token as `lang`): the fence is a
// mermaid fence iff that token is exactly `mermaid` (case-insensitive after trim).
export function isMermaidFence(lang: string): boolean {
  return lang.trim().toLowerCase() === "mermaid";
}
