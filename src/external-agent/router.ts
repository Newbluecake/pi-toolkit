/**
 * RoutingSessionDriver（external-agent arch §4.5）：按 `spec.external` 把 create/resume 分派给外部 provider，
 * 其余原样委托 pi 驱动。pi-free：对 runtime 只 `import type`。
 */
import { ClassifiedError } from "../core/errors.js";
import type { DriverEvent } from "../core/types.js";
import type { SessionDriver, SessionHandle } from "../runtime/session-driver.js";
import type { SessionSpec } from "../core/types.js";
import type { ExternalAgentProvider, ExternalSessionHandle, ExternalSessionSpec } from "./types.js";

function config(message: string): ClassifiedError {
  return new ClassifiedError({ kind: "config", message, retryable: false });
}

export class RoutingSessionDriver implements SessionDriver {
  /** 句柄识别：create/resume 时登记，不靠鸭子类型。 */
  private readonly external = new WeakSet<object>();

  constructor(
    private readonly pi: SessionDriver,
    private readonly providers: ReadonlyMap<string, ExternalAgentProvider>,
  ) {}

  private providerFor(spec: SessionSpec): ExternalAgentProvider | undefined {
    const ext = spec.external;
    if (ext === undefined) return undefined;
    const p = this.providers.get(ext.provider);
    if (p === undefined) throw config(`external agent provider "${ext.provider}" is not available`);
    return p;
  }

  async create(spec: SessionSpec): Promise<SessionHandle> {
    const p = this.providerFor(spec);
    if (p === undefined) return this.pi.create(spec);
    const h = await p.create(spec as ExternalSessionSpec);
    this.external.add(h);
    return h;
  }

  async resume(sessionFile: string, spec: SessionSpec): Promise<SessionHandle> {
    let owner: ExternalAgentProvider | undefined;
    for (const p of this.providers.values()) {
      let owns = false;
      try {
        owns = p.ownsSessionFile(sessionFile);
      } catch {
        owns = false;
      }
      if (owns) {
        owner = p;
        break;
      }
    }
    const want = spec.external?.provider;
    if (spec.external !== undefined && owner !== undefined && owner.id === want) {
      const h = await owner.resume(sessionFile, spec as ExternalSessionSpec);
      this.external.add(h);
      return h;
    }
    if (spec.external === undefined && owner === undefined) {
      if (this.pi.resume === undefined) throw config("session driver does not support resume");
      return this.pi.resume(sessionFile, spec);
    }
    const sessionKind = owner?.id ?? "pi";
    const modelKind = want ?? "pi";
    throw config(`cannot resume a ${sessionKind} session with a ${modelKind} model`);
  }

  bind(h: SessionHandle, onEvent: (e: DriverEvent) => void): Promise<void> {
    if (this.external.has(h)) {
      try {
        (h as ExternalSessionHandle).attach(onEvent);
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve();
    }
    return this.pi.bind(h, onEvent);
  }

  onLateArrival(p: Promise<SessionHandle>, cb: (h: SessionHandle) => void): void {
    // 外部句柄 dispose 即组杀；晚到句柄交给回调（与 pi 驱动一致），拒绝一律吞掉。
    p.then(cb, () => undefined).catch(() => undefined);
  }

  resolveModelRef(provider: string, id: string): unknown | undefined {
    if (this.providers.has(provider)) return undefined;
    return this.pi.resolveModelRef?.(provider, id);
  }
}
