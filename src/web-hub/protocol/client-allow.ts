/** LAN security r2 §2.1. Pure, browser-safe CIDR grammar; no DNS/URL coercion. */
export const CLIENT_ALLOW_MAX = 64;
export const IMPLICIT_ALLOWED = ["127.0.0.0/8", "::1"] as const;
export interface InvalidClientCidr {
  token: string;
  reason: "syntax" | "limit";
}

type Address = { bits: 32 | 128; value: bigint };
function ipv4(raw: string): Address | undefined {
  const parts = raw.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) return undefined;
  return { bits: 32, value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n) };
}
function address(raw: string): Address | undefined {
  if (!raw.includes(":")) return ipv4(raw);
  if (!/^[0-9a-f:.]+$/i.test(raw) || raw.split("::").length > 2) return undefined;
  let text = raw.toLowerCase();
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const v4 = ipv4(text.slice(colon + 1));
    if (!v4) return undefined;
    text = text.slice(0, colon + 1) + (v4.value >> 16n).toString(16) + ":" + (v4.value & 65535n).toString(16);
  }
  const halves = text.split("::");
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves[1] === undefined || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const words = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (words.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return undefined;
  return { bits: 128, value: words.reduce((n, w) => (n << 16n) | BigInt("0x" + w), 0n) };
}
function mapped(a: Address): boolean {
  return a.bits === 128 && a.value >> 32n === 65535n;
}
function format(a: Address): string {
  if (a.bits === 32) return [24n, 16n, 8n, 0n].map((s) => Number((a.value >> s) & 255n)).join(".");
  const words = Array.from({ length: 8 }, (_, i) => ((a.value >> BigInt((7 - i) * 16)) & 65535n).toString(16));
  let best = -1,
    len = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== "0") {
      i++;
      continue;
    }
    let end = i;
    while (end < 8 && words[end] === "0") end++;
    if (end - i > len && end - i >= 2) {
      best = i;
      len = end - i;
    }
    i = end;
  }
  return best < 0 ? words.join(":") : words.slice(0, best).join(":") + "::" + words.slice(best + len).join(":");
}
function mask(a: Address, prefix: number): Address {
  const shift = BigInt(a.bits - prefix);
  return { bits: a.bits, value: (a.value >> shift) << shift };
}
/** Canonical network/prefix, or undefined. Mapped IPv6 prefixes <96 remain IPv6. */
export function parseClientCidr(raw: string): string | undefined {
  const parts = raw.trim().split("/");
  if (parts.length > 2) return undefined;
  let a = address(parts[0]!);
  if (!a) return undefined;
  let prefix = a.bits as number;
  if (parts[1] !== undefined) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[1])) return undefined;
    prefix = Number(parts[1]);
    if (prefix > a.bits) return undefined;
  }
  if (mapped(a) && prefix >= 96) {
    a = { bits: 32, value: a.value & 0xffffffffn };
    prefix -= 96;
  }
  return `${format(mask(a, prefix))}/${prefix}`;
}
/** Bare IP only; mapped dotted/hex IPv6 resolves to IPv4. Zones/brackets are refused. */
export function normalizeClientIp(raw: string): string | undefined {
  let a = address(raw);
  if (!a) return undefined;
  if (mapped(a)) a = { bits: 32, value: a.value & 0xffffffffn };
  return format(a);
}
/** Explicit entries only (guard owns implicit loopback/inactive policy). Invalid entries throw. */
export function createClientMatcher(entries: readonly string[]): (ip: string) => boolean {
  const networks = entries.map((raw) => {
    const canonical = parseClientCidr(raw);
    if (canonical === undefined) throw new TypeError("Invalid client CIDR");
    const [ip, p] = canonical.split("/");
    return { a: address(ip!)!, prefix: Number(p) };
  });
  return (raw) => {
    const ip = normalizeClientIp(raw);
    if (ip === undefined) return false;
    const a = address(ip)!;
    return networks.some((n) => n.a.bits === a.bits && mask(a, n.prefix).value === n.a.value);
  };
}
