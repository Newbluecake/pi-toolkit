import { computed, getCurrentInstance, onUnmounted, ref, watch, type Ref } from "vue";
import { validateAvatarPng } from "@protocol/avatar-png.js";
import type { AvatarDeleteOutcome, AvatarWriteOutcome } from "@protocol/avatar.js";
import type { AvatarTransport } from "../transport/types.js";

export interface AvatarHubIdentity {
  readonly pid: number;
  readonly startedAt: number;
}
export interface AvatarObservation {
  readonly hub: AvatarHubIdentity;
  readonly avatar: { readonly gen: number; readonly v?: string };
}
export interface AvatarBest {
  readonly id: string;
  readonly gen: number;
  readonly v: string | null;
}
export interface AvatarFileReader {
  result: string | ArrayBuffer | null;
  addEventListener(type: "load" | "error", listener: () => void): void;
  readAsDataURL(blob: Blob): void;
}
export interface UseAvatarOptions {
  readonly transport?: AvatarTransport;
  /** App passes useHub().state here. `hub` is accepted as an alias for small embedders/tests. */
  readonly state?: Readonly<Ref<{ readonly hub?: unknown } | null | undefined>>;
  readonly hub?: Readonly<Ref<{ readonly hub?: unknown } | null | undefined>>;
  readonly createFileReader?: () => AvatarFileReader;
}
export interface AvatarHandle {
  readonly best: Readonly<Ref<AvatarBest | null>>;
  readonly src: Readonly<Ref<string | null>>;
  readonly preview: Readonly<Ref<string | null>>;
  readonly busy: Readonly<Ref<boolean>>;
  readonly error: Readonly<Ref<string | null>>;
  readonly errorReason?: Readonly<Ref<string | null>>;
  readonly errorEffect?: Readonly<Ref<"none" | "unknown" | null>>;
  readonly retryAfterS?: Readonly<Ref<number | null>>;
  readonly hasAvatar: Readonly<Ref<boolean>>;
  observe(observation: AvatarObservation): void;
  upload(bytes: Uint8Array, previewDataUrl?: string): Promise<AvatarWriteOutcome>;
  remove(): Promise<AvatarDeleteOutcome>;
  refresh(): Promise<void>;
  dispose(): void;
}

function identityOf(hub: unknown): AvatarHubIdentity | null {
  if (hub === null || typeof hub !== "object") return null;
  const o = hub as { pid?: unknown; startedAt?: unknown };
  return typeof o.pid === "number" &&
    Number.isFinite(o.pid) &&
    typeof o.startedAt === "number" &&
    Number.isFinite(o.startedAt)
    ? { pid: o.pid, startedAt: o.startedAt }
    : null;
}
function observationOf(hub: unknown): AvatarObservation | null {
  if (hub === null || typeof hub !== "object") return null;
  const o = hub as { avatar?: unknown };
  const identity = identityOf(hub);
  if (identity === null || o.avatar === null || typeof o.avatar !== "object") return null;
  const a = o.avatar as { gen?: unknown; v?: unknown };
  if (typeof a.gen !== "number" || !Number.isInteger(a.gen) || a.gen < 0) return null;
  return {
    hub: identity,
    avatar: { gen: a.gen, ...(typeof a.v === "string" ? { v: a.v } : {}) },
  };
}
function idOf(hub: AvatarHubIdentity): string {
  return `${hub.pid}:${hub.startedAt}`;
}
function validVersion(v: string | undefined): v is string {
  return v === undefined || /^[0-9a-f]{64}$/i.test(v);
}
function defaultReader(): AvatarFileReader {
  return new FileReader() as unknown as AvatarFileReader;
}
function readDataUrl(create: () => AvatarFileReader, blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = create();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("E_BAD_DATA_URL"));
    });
    reader.addEventListener("error", () => reject(new Error("E_READ")));
    reader.readAsDataURL(blob);
  });
}

/** Browser-side ordering and fetch/cache state for the one hub avatar. */
export function useAvatar(opts: UseAvatarOptions): AvatarHandle {
  const best = ref<AvatarBest | null>(null);
  const src = ref<string | null>(null);
  const preview = ref<string | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const errorReason = ref<string | null>(null);
  const errorEffect = ref<"none" | "unknown" | null>(null);
  const retryAfterS = ref<number | null>(null);
  const transport = opts.transport;
  const reader = opts.createFileReader ?? defaultReader;
  const cache = new Map<string, string>();
  let fetchController: AbortController | null = null;
  let fetchSeq = 0;
  let disposed = false;

  function cachePut(v: string, dataUrl: string): void {
    cache.delete(v);
    cache.set(v, dataUrl);
    while (cache.size > 2) cache.delete(cache.keys().next().value as string);
  }
  function stopFetch(): void {
    fetchController?.abort();
    fetchController = null;
    fetchSeq += 1;
  }
  function setSourceFor(value: AvatarBest): void {
    stopFetch();
    if (value.v === null) {
      src.value = null;
      return;
    }
    const local = cache.get(value.v);
    if (local !== undefined) {
      src.value = local;
      return;
    }
    src.value = null;
    if (transport === undefined || disposed) return;
    const controller = new AbortController();
    fetchController = controller;
    const sequence = fetchSeq;
    const target = value.v;
    void transport
      .fetch({ signal: controller.signal })
      .then(async (outcome) => {
        if (disposed || sequence !== fetchSeq || controller.signal.aborted) return;
        if (!outcome.ok) {
          if (best.value?.v === target) {
            src.value = null;
            error.value = outcome.error;
          }
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await outcome.bytes.arrayBuffer());
        } catch {
          if (best.value?.v === target) {
            src.value = null;
            error.value = "E_READ";
          }
          return;
        }
        if (disposed || sequence !== fetchSeq || best.value?.v !== target) return;
        const check = validateAvatarPng(bytes);
        const expected = `"${target}"`;
        if (!check.ok || outcome.etag !== expected) {
          error.value = "E_BAD_RESPONSE";
          return;
        }
        try {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          const dataUrl = await readDataUrl(reader, new Blob([copy.buffer], { type: "image/png" }));
          if (
            disposed ||
            sequence !== fetchSeq ||
            best.value?.v !== target ||
            !/^data:image\/png;base64,/.test(dataUrl)
          )
            return;
          cachePut(target, dataUrl);
          src.value = dataUrl;
          error.value = null;
        } catch {
          if (best.value?.v === target) {
            src.value = null;
            error.value = "E_READ";
          }
        }
      })
      .catch(() => {
        if (!disposed && !controller.signal.aborted && best.value?.v === target) {
          src.value = null;
          error.value = "E_NETWORK";
        }
      });
  }
  function apply(observation: AvatarObservation, source: "frame" | "write"): void {
    if (disposed || !validVersion(observation.avatar.v)) return;
    const nextId = idOf(observation.hub);
    const current = best.value;
    if (current !== null) {
      if (source === "write" && nextId !== current.id) return;
      if (nextId === current.id && observation.avatar.gen <= current.gen) {
        // A repeated hub frame is not a newer observation, but it is also the
        // reconnect retry edge after a failed/mismatched GET (R4).
        if (source === "frame" && current.v !== null && src.value === null && fetchController === null) {
          setSourceFor(current);
        }
        return;
      }
    }
    const next: AvatarBest = { id: nextId, gen: observation.avatar.gen, v: observation.avatar.v ?? null };
    best.value = next;
    error.value = null;
    errorReason.value = null;
    errorEffect.value = null;
    retryAfterS.value = null;
    preview.value = null;
    setSourceFor(next);
  }
  function observe(observation: AvatarObservation): void {
    apply(observation, "frame");
  }
  async function upload(bytes: Uint8Array, previewDataUrl?: string): Promise<AvatarWriteOutcome> {
    if (transport === undefined) {
      error.value = "E_UNSUPPORTED";
      return { ok: false, error: "E_UNSUPPORTED" };
    }
    busy.value = true;
    error.value = null;
    errorReason.value = null;
    errorEffect.value = null;
    retryAfterS.value = null;
    if (previewDataUrl !== undefined) preview.value = previewDataUrl;
    try {
      const result = await transport.upload(bytes);
      if (!result.ok) {
        error.value = result.error;
        errorReason.value = result.reason ?? null;
        errorEffect.value = result.effect ?? null;
        retryAfterS.value = result.retryAfterS ?? null;
        return result;
      }
      if (previewDataUrl !== undefined && typeof result.data.avatar.v === "string")
        cachePut(result.data.avatar.v, previewDataUrl);
      apply({ hub: result.data.hub, avatar: result.data.avatar }, "write");
      return result;
    } finally {
      busy.value = false;
    }
  }
  async function remove(): Promise<AvatarDeleteOutcome> {
    if (transport === undefined) {
      error.value = "E_UNSUPPORTED";
      return { ok: false, error: "E_UNSUPPORTED" };
    }
    busy.value = true;
    error.value = null;
    errorReason.value = null;
    errorEffect.value = null;
    retryAfterS.value = null;
    try {
      const result = await transport.remove();
      if (!result.ok) {
        error.value = result.error;
        errorReason.value = result.reason ?? null;
        errorEffect.value = result.effect ?? null;
        retryAfterS.value = result.retryAfterS ?? null;
        return result;
      }
      apply({ hub: result.data.hub, avatar: result.data.avatar }, "write");
      return result;
    } finally {
      busy.value = false;
    }
  }
  async function refresh(): Promise<void> {
    const current = best.value;
    if (current?.v === null || current === null) return;
    setSourceFor(current);
  }
  function dispose(): void {
    disposed = true;
    stopFetch();
  }

  const state = opts.state ?? opts.hub;
  if (state !== undefined) {
    watch(
      () => state.value?.hub,
      (hub) => {
        const observation = observationOf(hub);
        if (observation !== null) observe(observation);
      },
      { immediate: true, deep: true },
    );
  }
  if (getCurrentInstance() !== null) onUnmounted(dispose);
  return {
    best,
    src,
    preview,
    busy,
    error,
    errorReason,
    errorEffect,
    retryAfterS,
    hasAvatar: computed(() => best.value?.v !== null && best.value?.v !== undefined),
    observe,
    upload,
    remove,
    refresh,
    dispose,
  };
}

export type AvatarStatus = AvatarHandle;
