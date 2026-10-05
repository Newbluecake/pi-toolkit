/**
 * web-hub-preview plan v3 §3.2 (package PV4): the App-level preview state machine.
 *
 * `closed ⇄ loading → image | text | unsupported | tooLarge | error`, with the three interrupt
 * rules from the plan all folding into one seq guard + one AbortController:
 *
 * - a NEW `open()` supersedes the in-flight one (abort + drop by seq);
 * - `close()` does the same and returns to `closed`;
 * - **作用域失效**: a watcher on `scopeKeyOf(scope)` (v3-2: `agentKey|sessionId|cwd` — a cwd
 *   change is treated exactly like a session switch) closes immediately, aborting the fetch.
 *
 * `scope` itself is the §4.6 derivation (`previewScopeOf`): transport has `preview` ∧ hub caps
 * carry `preview.v1` (token) / `preview.lan.v1` (password — under the default mode "on" both
 * caps are declared, so LAN gets a scope, U1) ∧ the selected agent has a live session.
 *
 * The image phase never sees a `blob:` URL (D1: CSP is not relaxed — `createObjectURL` is
 * source-scan banned): the transport's `Blob` converts through FileReader's `readAsDataURL`
 * and the `data:<mime>;base64,` prefix is verified before the phase flips (§3.2 image row).
 * The 40s client timeout lives in the TRANSPORT (`PREVIEW_CLIENT_TIMEOUT_MS`, spanning
 * headers+body, surfaced as a retryable `E_DEADLINE`) — this layer's controller exists for
 * open/close/scope interrupts, so there is exactly one deadline source on both adapters.
 */
import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { classifyPreviewError, clientImageBudget, previewScopeOf, scopeKeyOf } from "@logic/preview.js";
import type { PreviewOutcome, PreviewTransport } from "../transport/types.js";
import type { HubState, PreviewHandle, PreviewPathScope, PreviewView } from "../types.js";

/** The structural slice of the DOM `FileReader` this composable needs (injectable for tests —
 * node has no `FileReader`; the real wiring (PV6, App.vue) simply doesn't pass
 * `createFileReader` and the default below reaches the browser global). Listeners go through
 * `addEventListener`, never the `onload`/`onerror` properties — source-scan bans `.on*=`
 * assignments across the whole UI. */
export interface FileReaderLike {
  readonly result: unknown;
  addEventListener(type: "load" | "error", listener: () => void): void;
  readAsDataURL(blob: Blob): void;
}

export interface UsePreviewOptions {
  /** `HubHandle.preview` — `undefined` ⇒ the scope is always `null` (nothing clickable). */
  readonly preview: PreviewTransport | undefined;
  /** Transport auth mode — the scope cap rule differs (password requires `preview.lan.v1`). */
  readonly mode: "token" | "password";
  /** The hub handle's render-gated state (caps + selected agent's session feed the scope). */
  readonly state: Readonly<Ref<HubState>>;
  /** `(pointer: coarse)` — touch devices preview against the 20MP budget (plan §0/P2-13). */
  readonly coarse: Readonly<Ref<boolean>>;
  readonly createFileReader?: () => FileReaderLike;
}

function defaultFileReader(): FileReaderLike {
  return new FileReader() as unknown as FileReaderLike;
}

function readDataUrl(create: () => FileReaderLike, blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = create();
    fr.addEventListener("load", () =>
      typeof fr.result === "string" ? resolve(fr.result) : reject(new Error("E_BAD_DATA_URL")),
    );
    fr.addEventListener("error", () => reject(new Error("E_READ")));
    fr.readAsDataURL(blob);
  });
}

export function usePreview(opts: UsePreviewOptions): PreviewHandle {
  const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;

  const scope = computed<PreviewPathScope | null>(() => {
    const st = opts.state.value;
    const hub = st.hub;
    const selected = st.selected;
    const agent = selected === null ? undefined : st.agents.get(selected);
    const session =
      agent?.session ?? (agent?.card !== undefined ? (agent.card as { session?: unknown }).session : undefined);
    return previewScopeOf({
      mode: opts.mode,
      hubCaps: hub !== null && typeof hub === "object" ? (hub as { caps?: unknown }).caps : undefined,
      hasTransport: opts.preview !== undefined,
      agentKey: selected,
      session,
    });
  });

  let seq = 0;
  let ctl: AbortController | null = null;
  let lastPath: string | null = null;

  function abortInFlight(): void {
    seq++;
    if (ctl !== null) {
      ctl.abort();
      ctl = null;
    }
  }

  function close(): void {
    abortInFlight();
    lastPath = null;
    if (view.value.phase !== "closed") view.value = { phase: "closed" };
  }

  // 作用域失效 (§3.2): the scope KEY (agentKey|sessionId|cwd) changing — session switch,
  // cwd drift (v3-2), agent deselected, caps lost on reconnect — closes instantly.
  const stopWatch = watch(
    () => scopeKeyOf(scope.value),
    (next, prev) => {
      if (next !== prev) close();
    },
  );

  function settleError(outcome: Extract<PreviewOutcome, { ok: false }>, path: string): void {
    const c = classifyPreviewError(outcome.status, outcome);
    if (c.kind === "session-changed") {
      // §3.2: E_SESSION_CHANGED closes directly — the transcript itself is about to reload.
      close();
      return;
    }
    if (c.kind === "unsupported") {
      view.value = {
        phase: "unsupported",
        path,
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
        ...(c.size !== undefined ? { size: c.size } : {}),
      };
      return;
    }
    if (c.kind === "tooLarge") {
      view.value = {
        phase: "tooLarge",
        path,
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
        ...(c.size !== undefined ? { size: c.size } : {}),
        ...(c.max !== undefined ? { max: c.max } : {}),
        ...(c.dims !== undefined ? { dims: c.dims } : {}),
      };
      return;
    }
    view.value = {
      phase: "error",
      path,
      error: c.error,
      retryable: c.retryable,
      ...(c.retryAfterS !== undefined ? { retryAfterS: c.retryAfterS } : {}),
    };
  }

  function open(ref: { readonly path: string }): void {
    const sc = scope.value;
    const transport = opts.preview;
    if (sc === null || transport === undefined) return; // no scope ⇒ nothing is clickable
    abortInFlight();
    const mySeq = seq;
    const ac = new AbortController();
    ctl = ac;
    lastPath = ref.path;
    view.value = { phase: "loading", path: ref.path };
    const maxPixels = clientImageBudget({ coarse: opts.coarse.value });
    void transport
      .fetch({ agentKey: sc.agentKey, sessionId: sc.sessionId, path: ref.path }, { signal: ac.signal, maxPixels })
      .then((outcome) => {
        if (mySeq !== seq) return; // superseded / closed / scope invalidated — drop
        if (!outcome.ok) {
          settleError(outcome, ref.path);
          return;
        }
        if (outcome.kind === "text") {
          view.value = {
            phase: "text",
            path: ref.path,
            text: outcome.text,
            truncated: outcome.truncated,
            size: outcome.size,
          };
          return;
        }
        const mime = outcome.mime;
        void readDataUrl(opts.createFileReader ?? defaultFileReader, outcome.blob).then(
          (dataUrl) => {
            if (mySeq !== seq) return;
            if (!dataUrl.startsWith(`data:${mime};base64,`)) {
              view.value = { phase: "error", path: ref.path, error: "E_BAD_DATA_URL", retryable: false };
              return;
            }
            view.value = {
              phase: "image",
              path: ref.path,
              dataUrl,
              mime,
              dims: outcome.dims,
              size: outcome.size,
            };
          },
          () => {
            if (mySeq === seq) {
              view.value = { phase: "error", path: ref.path, error: "E_READ", retryable: false };
            }
          },
        );
      });
  }

  function retry(): void {
    if (view.value.phase !== "error" || lastPath === null) return;
    open({ path: lastPath });
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopWatch();
    abortInFlight();
  }
  onScopeDispose(dispose, true); // failSilently: safe to call outside a component/effect scope (unit tests)

  return { view: view as Readonly<Ref<PreviewView>>, scope, open, close, retry, dispose };
}
