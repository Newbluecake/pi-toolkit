import {
  TERMINAL_V2_HTTP_PATHS,
  TERMINAL_V2_LIMITS,
  type TerminalFailureV2,
  type TerminalHttpRequestsV2,
  type TerminalHttpResponseV2,
  type TerminalViewFrameV2,
} from "../components/terminal/protocol-v2.js";
import {
  terminalRequestV2Ok,
  terminalResponseV2Ok,
  terminalViewFrameValueV2Ok,
  type TerminalJsonOpV2,
} from "../logic/terminal-v2.js";

export type TerminalFetchV2 = (url: string, init?: RequestInit) => Promise<Response>;

export class TerminalViewErrorV2 extends Error {
  constructor(
    readonly code: TerminalFailureV2["code"],
    readonly effect: "none" | "unknown",
  ) {
    super(effect === "unknown" ? `${code} · effect unknown` : code);
    this.name = "TerminalViewErrorV2";
  }
}

export interface TerminalTransportV2 {
  request<K extends TerminalJsonOpV2>(
    op: K,
    body: TerminalHttpRequestsV2[K],
    signal?: AbortSignal,
  ): Promise<TerminalHttpResponseV2<K>>;
  /** Exactly one independent NDJSON response. It never attaches to or aborts public SSE. */
  view(
    body: TerminalHttpRequestsV2["view"],
    onFrame: (frame: TerminalViewFrameV2) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

const failed = <K extends TerminalJsonOpV2>(
  code: TerminalFailureV2["code"],
  effect: "none" | "unknown",
): TerminalHttpResponseV2<K> => ({ ok: false, code, effect }) as TerminalHttpResponseV2<K>;

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new Error("cancelled");
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error("cancelled");
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > TERMINAL_V2_LIMITS.frameBytes) throw new Error("body");
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const result: unknown = await response.json();
  const encoded = JSON.stringify(result);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > TERMINAL_V2_LIMITS.frameBytes)
    throw new Error("body");
  return result;
}

/** JSON POSTs have one body-inclusive 5s budget and no automatic retries. */
export function createTerminalTransportV2(deps: {
  fetch: TerminalFetchV2;
  onConn(state: "auth"): void;
}): TerminalTransportV2 {
  async function request<K extends TerminalJsonOpV2>(
    op: K,
    body: TerminalHttpRequestsV2[K],
    signal?: AbortSignal,
  ): Promise<TerminalHttpResponseV2<K>> {
    if (!terminalRequestV2Ok(op, body)) return failed("E_BAD_REQUEST", "none");
    const abort = new AbortController();
    let rejectCancelled: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const cancel = () => {
      abort.abort();
      rejectCancelled(new Error("cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      if (signal?.aborted) throw new Error("cancelled");
      const response = await deps.fetch(TERMINAL_V2_HTTP_PATHS[op], {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-PWH": "1" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (response.status === 401) {
        deps.onConn("auth");
        return { ok: false, code: "E_AUTH", effect: "none" } as const;
      }
      return readJson(response, abort.signal);
    };
    try {
      const result = await Promise.race([
        work(),
        cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("deadline"));
          }, TERMINAL_V2_LIMITS.httpMs);
        }),
      ]);
      if (!terminalResponseV2Ok(op, result)) return failed("E_UNAVAILABLE", "unknown");
      return result;
    } catch {
      // Cancellation or a lost response is not proof of no server-side effect.
      return failed("E_DEADLINE", "unknown");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  async function view(
    body: TerminalHttpRequestsV2["view"],
    onFrame: (frame: TerminalViewFrameV2) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!terminalRequestV2Ok("view", body)) throw new TerminalViewErrorV2("E_BAD_REQUEST", "none");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (signal?.aborted) throw new TerminalViewErrorV2("E_DEADLINE", "unknown");
      const response = await Promise.race([
        deps.fetch(TERMINAL_V2_HTTP_PATHS.view, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify(body),
          signal: abort.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new TerminalViewErrorV2("E_DEADLINE", "unknown"));
          }, TERMINAL_V2_LIMITS.httpMs);
        }),
      ]);
      clearTimeout(timer);
      if (response.status === 401) deps.onConn("auth");
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      const encoding = response.headers.get("Content-Encoding")?.trim().toLowerCase();
      if (!response.ok || contentType !== "application/x-ndjson" || (encoding !== null && encoding !== "identity")) {
        let code: TerminalFailureV2["code"] = response.status === 401 ? "E_AUTH" : "E_UNAVAILABLE";
        let effect: "none" | "unknown" = response.status === 401 ? "none" : "unknown";
        try {
          const raw = await readJson(response, abort.signal);
          if (terminalResponseV2Ok("ack", raw) && !raw.ok) {
            code = raw.code;
            effect = raw.effect;
          }
        } catch {
          // A pre-header JSON error is optional; never turn its failure into a retry.
        }
        throw new TerminalViewErrorV2(code, effect);
      }
      reader = response.body?.getReader();
      if (!reader) throw new TerminalViewErrorV2("E_UNAVAILABLE", "unknown");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let parts: Uint8Array[] = [];
      let lineBytes = 0;
      const emit = () => {
        if (lineBytes === 0) return;
        const bytes = new Uint8Array(lineBytes);
        let at = 0;
        for (const part of parts) {
          bytes.set(part, at);
          at += part.byteLength;
        }
        parts = [];
        lineBytes = 0;
        const text = decoder.decode(bytes);
        const raw: unknown = JSON.parse(text.endsWith("\r") ? text.slice(0, -1) : text);
        if (!terminalViewFrameValueV2Ok(raw)) throw new TerminalViewErrorV2("E_UNAVAILABLE", "unknown");
        onFrame(raw);
      };
      const append = (part: Uint8Array) => {
        if (part.byteLength === 0) return;
        lineBytes += part.byteLength;
        if (lineBytes > TERMINAL_V2_LIMITS.frameBytes) throw new TerminalViewErrorV2("E_UNAVAILABLE", "unknown");
        parts.push(part);
      };
      while (true) {
        if (signal?.aborted) throw new TerminalViewErrorV2("E_DEADLINE", "unknown");
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value;
        let start = 0;
        for (let at = 0; at < chunk.length; at++) {
          if (chunk[at] !== 10) continue;
          append(chunk.slice(start, at));
          emit();
          start = at + 1;
        }
        append(chunk.slice(start));
      }
      append(new Uint8Array());
      emit();
    } catch (error) {
      if (error instanceof TerminalViewErrorV2) throw error;
      throw new TerminalViewErrorV2("E_DEADLINE", "unknown");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      // Only this private view is cancelled; no shared transport/SSE abort is reachable here.
      abort.abort();
    }
  }

  return { request, view };
}
