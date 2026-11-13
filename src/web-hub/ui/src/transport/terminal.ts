import type { TerminalHttpRequests, TerminalHttpResponse } from "@protocol/terminal.js";
export interface TerminalTransport {
  request<K extends keyof TerminalHttpRequests>(
    op: K,
    body: TerminalHttpRequests[K],
    signal?: AbortSignal,
  ): Promise<TerminalHttpResponse<K>>;
}
/** One body-inclusive budget. Never automatic login/replay after a possibly accepted write. */
export function createTerminalTransport(deps: {
  fetch: (url: string, init?: any) => Promise<any>;
  onConn(state: "auth"): void;
}): TerminalTransport {
  return {
    async request(op, body, signal) {
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
        const response = await deps.fetch(`/api/terminal/${op}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        if (response.status === 401) {
          deps.onConn("auth");
          return { ok: false, code: "E_AUTH", effect: "none" };
        }
        // A Response's streaming body is bounded BEFORE JSON parsing (including failed responses).
        const reader = response.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 16384) {
                abort.abort();
                throw new Error("body");
              }
              chunks.push(part.value);
            }
            const bytes = new Uint8Array(size);
            let at = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, at);
              at += chunk.byteLength;
            }
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        // Structural injected transports used by the shared adapter contract tests.
        const result = await response.json();
        if (new TextEncoder().encode(JSON.stringify(result)).length > 16384) throw new Error("body");
        return result;
      };
      try {
        return await Promise.race([
          work(),
          cancelled,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error("deadline"));
            }, 5000);
          }),
        ]);
      } catch {
        return { ok: false, code: "E_DEADLINE", effect: "unknown" };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
