/**
 * jev-reflex · #25 B0 port defaults & signatures (BA §4.4/§4.5), DERIVED from `BUILTIN_SCRIPTS`
 * — never hand-listed. A draft's `requires`/`agreement`/`render` must equal `PORT_DEFAULTS[port]`
 * field by field (K3: a draft cannot sweeten its own agreement vocabulary), so the port table is
 * the single source both `draft-schema.ts` (validation) and `backtest/draft-gen.ts` (generation)
 * read. Deterministic one-shot derivation at module load (like the catalog self-check, I4-safe):
 * two builtin scripts sharing a port with different defaults/signatures is a CONTRACT BREAK and
 * throws here, refusing to load the whole module.
 */

import { BUILTIN_SCRIPTS } from "./catalog.js";
import type { Capability, PortId, RScriptV1 } from "./types.js";

/** The per-port fields a draft must copy verbatim (BA §4.5 rule ④). */
export interface PortDefaults {
  requires: readonly Capability[];
  agreement: { tools: readonly string[]; bashShapes: readonly string[] };
  render: { title: string; emptyText: string; maxLines: number };
}

/** The port's tool vocabulary = union of its builtin scripts' `agreement` (tools + bashShapes). */
export interface PortSignature {
  readonly tools: ReadonlySet<string>;
  readonly empty: boolean;
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const sameCapabilities = sameStrings as (a: readonly Capability[], b: readonly Capability[]) => boolean;

function defaultsOf(s: RScriptV1): PortDefaults {
  return { requires: s.requires, agreement: s.agreement, render: s.render };
}

function sameDefaults(a: PortDefaults, b: PortDefaults): boolean {
  return (
    sameCapabilities(a.requires, b.requires) &&
    sameStrings(a.agreement.tools, b.agreement.tools) &&
    sameStrings(a.agreement.bashShapes, b.agreement.bashShapes) &&
    a.render.title === b.render.title &&
    a.render.emptyText === b.render.emptyText &&
    a.render.maxLines === b.render.maxLines
  );
}

/** Derivation over an arbitrary script list: the module constants below run it on
 *  `BUILTIN_SCRIPTS`; tests exercise the disagreement throws on synthetic catalogs. */
export function derivePortTable(scripts: readonly RScriptV1[]): {
  mvpPorts: readonly PortId[];
  defaults: ReadonlyMap<PortId, PortDefaults>;
  signatures: ReadonlyMap<PortId, PortSignature>;
  portOf: ReadonlyMap<string, PortId>;
} {
  const defaults = new Map<PortId, PortDefaults>();
  const signatures = new Map<PortId, Set<string>>();
  const portOf = new Map<string, PortId>();
  const mvpPorts: PortId[] = [];
  for (const s of scripts) {
    const port = s.port.id;
    if (!defaults.has(port)) {
      defaults.set(port, defaultsOf(s));
      signatures.set(port, new Set([...s.agreement.tools, ...s.agreement.bashShapes]));
      mvpPorts.push(port);
    } else {
      // Two builtin scripts on one port must agree on EVERY default field — otherwise a draft
      // validated against PORT_DEFAULTS could differ from what the runtime actually does.
      const prev = defaults.get(port)!;
      if (!sameDefaults(prev, defaultsOf(s)))
        throw new Error(
          `port-defaults: builtin scripts disagree on port "${port}" (${prev.render.title} vs ${s.id}) — #25 contract break`,
        );
      for (const t of [...s.agreement.tools, ...s.agreement.bashShapes]) signatures.get(port)!.add(t);
    }
    const prevPort = portOf.get(s.id);
    if (prevPort !== undefined && prevPort !== port)
      throw new Error(`port-defaults: script id "${s.id}" maps to two ports — #25 contract break`);
    portOf.set(s.id, port);
  }
  const frozenSigs = new Map<PortId, PortSignature>();
  for (const [port, tools] of signatures) frozenSigs.set(port, { tools, empty: tools.size === 0 });
  return { mvpPorts, defaults, signatures: frozenSigs, portOf };
}

const TABLE = derivePortTable(BUILTIN_SCRIPTS);

/** Ports with at least one builtin script — the only ports a draft may bind (BA §4.5 rule ④). */
export const MVP_PORTS: readonly PortId[] = Object.freeze([...TABLE.mvpPorts]);
export type MvpPort = (typeof MVP_PORTS)[number];

/** Per-port defaults, derived; indexed via `portDefaultsOf`. */
const PORT_DEFAULTS: ReadonlyMap<PortId, PortDefaults> = TABLE.defaults;

/** Per-port tool signature, derived; an EMPTY signature (today `quota.summary`) cannot be
 *  auto-labeled from tool shapes and only binds a draft via explicit `--assign` (BA §4.4, K10). */
const PORT_SIGNATURES: ReadonlyMap<PortId, PortSignature> = TABLE.signatures;

export function portDefaultsOf(port: PortId): PortDefaults | undefined {
  return PORT_DEFAULTS.get(port);
}

export function portSignatureOf(port: PortId): PortSignature | undefined {
  return PORT_SIGNATURES.get(port);
}

/** Ports whose signature is empty — exactly the ones `draft-gen` must NOT auto-assign. */
export const TOOLLESS_PORTS: readonly PortId[] = Object.freeze(
  MVP_PORTS.filter((p) => PORT_SIGNATURES.get(p)?.empty === true),
);

/** catalog 反查 (BD11): script id → port id. Builtin records never store portId; the promotion
 *  fold resolves it through here. Unknown id ⇒ undefined. */
export function portOfScript(scriptId: string): PortId | undefined {
  return TABLE.portOf.get(scriptId);
}
