// P2 stub — P1 owns this file (web-hub-mermaid plan §4.1: the frozen runtime lifecycle
// contract). This minimal stub exists ONLY so P2's `MermaidBlock.vue` type-checks and the
// non-mocked component tests stay deterministic while P1 is implemented in parallel; every
// request resolves fail-closed (`engine-unavailable`), so a P2-only checkout renders mermaid
// fences as source code with the load-failed line — never loads an engine, never touches the
// DOM. When P1 lands, this whole file is replaced by the real implementation (same exported
// surface — the interface below is the frozen §4.1 contract, byte-for-byte).
export type MermaidTheme = "light" | "dark";
export type MermaidErrorReason =
  | "parse"
  | "render"
  | "too-large"
  | "unsupported"
  | "timeout"
  | "busy"
  | "load-failed"
  | "engine-unavailable"
  | "output-invalid";
export type MermaidOutcome =
  | { kind: "ok"; src: string; width: number; height: number; diagramType: string; title: string | null }
  | { kind: "error"; reason: MermaidErrorReason; message: string } // message ≤160 chars, single line, no source text
  | { kind: "cancelled" };
export interface MermaidRequest {
  text: string;
  theme: MermaidTheme;
  signal?: AbortSignal;
}

const STUB_OUTCOME: MermaidOutcome = {
  kind: "error",
  reason: "engine-unavailable",
  message: "mermaid runtime stub (P1 pending)",
};

/** Contract: never rejects; resolves exactly once per call. The stub resolves immediately. */
export function requestMermaid(req: MermaidRequest): Promise<MermaidOutcome> {
  void req;
  return Promise.resolve(STUB_OUTCOME);
}

/** Synchronous cache probe; the stub never caches anything. */
export function peekMermaidCache(text: string, theme: MermaidTheme): MermaidOutcome | undefined {
  void text;
  void theme;
  return undefined;
}

export function mermaidEngineState(): "idle" | "loading" | "ready" | "load-failed" | "broken" {
  return "load-failed";
}

/** Test-only reset; the stub has no state. */
export function __resetMermaidRuntimeForTests(): void {
  /* no-op */
}
