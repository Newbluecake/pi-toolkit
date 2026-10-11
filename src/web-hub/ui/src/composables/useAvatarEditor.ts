import { ref, type Ref } from "vue";
import { validateAvatarPng } from "@protocol/avatar-png.js";
import { AVATAR_MAX_SIDE, AVATAR_MIN_SIDE, type AvatarRejectReason } from "@protocol/avatar.js";
import {
  AVATAR_SOURCE_HEADER_BYTES,
  AVATAR_SOURCE_MAX_FILE_BYTES,
  sourceDims,
  type AvatarSourceError,
  type AvatarSourceResult,
} from "../logic/avatarSource.js";

export type AvatarEditorError =
  "source-too-large" | "source-unknown" | "source-dims" | "decode" | "encode" | "unsupported";

export interface AvatarBitmap {
  readonly width: number;
  readonly height: number;
  close?(): void;
}
export interface AvatarCanvasContext {
  drawImage(
    image: AvatarBitmap,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}
export interface AvatarCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): AvatarCanvasContext | null;
  toDataURL(type?: string): string;
}
export interface AvatarEditorFile {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
export interface AvatarEditorOptions {
  readonly createBitmap?: (file: AvatarEditorFile) => Promise<AvatarBitmap>;
  readonly createCanvas?: (side: number) => AvatarCanvas;
  readonly readSlice?: (file: AvatarEditorFile, end: number) => Promise<Uint8Array>;
  readonly decodeBase64?: (value: string) => Uint8Array;
}

export interface AvatarEditorResult {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly dataUrl: string;
  readonly side: number;
}
export interface AvatarEditorFailure {
  readonly ok: false;
  readonly error: AvatarEditorError;
  readonly source?: AvatarSourceResult;
  readonly reason?: AvatarRejectReason;
}

function defaultCreateBitmap(file: AvatarEditorFile): Promise<AvatarBitmap> {
  if (typeof createImageBitmap !== "function") return Promise.reject(new Error("E_BITMAP_UNAVAILABLE"));
  return createImageBitmap(file as unknown as Blob) as Promise<AvatarBitmap>;
}
function defaultCanvas(side: number): AvatarCanvas {
  if (typeof document === "undefined") throw new Error("E_CANVAS_UNAVAILABLE");
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  return canvas as unknown as AvatarCanvas;
}
async function defaultReadSlice(file: AvatarEditorFile, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, end).arrayBuffer());
}
function decodeDataUrl(dataUrl: string, decode: (value: string) => Uint8Array): Uint8Array {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (match === null) throw new Error("E_DATA_URL");
  return decode(match[1] ?? "");
}
function defaultDecode(value: string): Uint8Array {
  if (typeof atob !== "function") throw new Error("E_BASE64_UNAVAILABLE");
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function errorForSource(source: AvatarSourceError): AvatarEditorError {
  if (source.reason === "dims") return "source-dims";
  return "source-unknown";
}

/**
 * Browser-only image preparation.  Header parsing happens before any decoder is
 * called, and the only accepted output is a self-validated PNG data URL.
 */
export function createAvatarEditor(opts: AvatarEditorOptions = {}): {
  process(file: AvatarEditorFile): Promise<AvatarEditorResult | AvatarEditorFailure>;
} {
  const createBitmap = opts.createBitmap ?? defaultCreateBitmap;
  const createCanvas = opts.createCanvas ?? defaultCanvas;
  const readSlice = opts.readSlice ?? defaultReadSlice;
  const decode = opts.decodeBase64 ?? defaultDecode;

  async function process(file: AvatarEditorFile): Promise<AvatarEditorResult | AvatarEditorFailure> {
    if (!Number.isFinite(file.size) || file.size > AVATAR_SOURCE_MAX_FILE_BYTES)
      return { ok: false, error: "source-too-large" };
    let source: AvatarSourceResult;
    try {
      source = sourceDims(await readSlice(file, AVATAR_SOURCE_HEADER_BYTES));
    } catch {
      return { ok: false, error: "source-unknown" };
    }
    if (!source.ok) return { ok: false, error: errorForSource(source), source };

    let bitmap: AvatarBitmap | undefined;
    try {
      bitmap = await createBitmap(file);
      if (bitmap.width !== source.width || bitmap.height !== source.height) {
        return { ok: false, error: "source-dims", source };
      }
      const square = Math.min(bitmap.width, bitmap.height);
      if (square < AVATAR_MIN_SIDE) return { ok: false, error: "source-dims", source };
      const side = Math.min(AVATAR_MAX_SIDE, square);
      const canvas = createCanvas(side);
      canvas.width = side;
      canvas.height = side;
      const context = canvas.getContext("2d");
      if (context === null) return { ok: false, error: "encode" };
      context.drawImage(
        bitmap,
        (bitmap.width - square) / 2,
        (bitmap.height - square) / 2,
        square,
        square,
        0,
        0,
        side,
        side,
      );
      const dataUrl = canvas.toDataURL("image/png");
      let bytes: Uint8Array;
      try {
        bytes = decodeDataUrl(dataUrl, decode);
      } catch {
        return { ok: false, error: "encode" };
      }
      const checked = validateAvatarPng(bytes);
      if (!checked.ok) return { ok: false, error: "unsupported", reason: checked.reason };
      return { ok: true, bytes, dataUrl, side: checked.side };
    } catch {
      return { ok: false, error: "decode" };
    } finally {
      bitmap?.close?.();
    }
  }
  return { process };
}

export interface AvatarEditorHandle {
  readonly phase: Readonly<Ref<"idle" | "processing" | "ready" | "error">>;
  readonly error: Readonly<Ref<AvatarEditorError | null>>;
  readonly reason: Readonly<Ref<AvatarRejectReason | null>>;
  readonly dataUrl: Readonly<Ref<string | null>>;
  readonly bytes: Readonly<Ref<Uint8Array | null>>;
  readonly side: Readonly<Ref<number | null>>;
  process(file: AvatarEditorFile): Promise<AvatarEditorResult | AvatarEditorFailure>;
  select(event: Event): Promise<AvatarEditorResult | AvatarEditorFailure | null>;
  reset(): void;
}

export function useAvatarEditor(opts: AvatarEditorOptions = {}): AvatarEditorHandle {
  const editor = createAvatarEditor(opts);
  const phase = ref<"idle" | "processing" | "ready" | "error">("idle");
  const error = ref<AvatarEditorError | null>(null);
  const reason = ref<AvatarRejectReason | null>(null);
  const dataUrl = ref<string | null>(null);
  const bytes = ref<Uint8Array | null>(null);
  const side = ref<number | null>(null);

  async function process(file: AvatarEditorFile): Promise<AvatarEditorResult | AvatarEditorFailure> {
    phase.value = "processing";
    error.value = null;
    reason.value = null;
    const result = await editor.process(file);
    if (result.ok) {
      phase.value = "ready";
      dataUrl.value = result.dataUrl;
      bytes.value = result.bytes;
      side.value = result.side;
    } else {
      phase.value = "error";
      error.value = result.error;
      reason.value = result.reason ?? null;
      dataUrl.value = null;
      bytes.value = null;
      side.value = null;
    }
    return result;
  }
  async function select(event: Event): Promise<AvatarEditorResult | AvatarEditorFailure | null> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (file === undefined) return null;
    return process(file as unknown as AvatarEditorFile);
  }
  function reset(): void {
    phase.value = "idle";
    error.value = null;
    reason.value = null;
    dataUrl.value = null;
    bytes.value = null;
    side.value = null;
  }
  return { phase, error, reason, dataUrl, bytes, side, process, select, reset };
}
