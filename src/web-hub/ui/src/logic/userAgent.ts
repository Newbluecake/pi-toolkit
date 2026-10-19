/**
 * LAN security r2 §3.2 (package D): best-effort User-Agent → short display label for the
 * settings 「登录会话」 cards ("Edge 155 · Windows" style, mirroring the approved 1B layout in
 * ~/pwh-preview/lan-security.html). Pure, DOM-free, never throws.
 *
 * This is a DISPLAY label only — it is never an authentication/authorization input (the
 * session binding lives in the sidHash + origin, server side). Order matters: Edge/OPR must be
 * checked before Chrome (their UAs contain "Chrome/"), Chrome before Safari.
 */

export interface UserAgentLabelParts {
  browser?: string;
  os?: string;
}

function browserOf(ua: string): string | undefined {
  let m = /\bEdg(?:e|A|iOS)?\/(\d+)/.exec(ua);
  if (m) return `Edge ${m[1]}`;
  m = /\bOPR\/(\d+)/.exec(ua);
  if (m) return `Opera ${m[1]}`;
  m = /\bFirefox\/(\d+)/.exec(ua);
  if (m) return `Firefox ${m[1]}`;
  m = /\bChrome\/(\d+)/.exec(ua);
  if (m) return `Chrome ${m[1]}`;
  m = /\bVersion\/(\d+)[^)]*\bSafari\//.exec(ua);
  if (m) return `Safari ${m[1]}`;
  if (/\bSafari\//.test(ua) && !/\bChrome\//.test(ua)) return "Safari";
  return undefined;
}

function osOf(ua: string): string | undefined {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

export function userAgentParts(ua: string | undefined): UserAgentLabelParts {
  if (typeof ua !== "string" || ua.trim() === "") return {};
  const browser = browserOf(ua);
  const os = osOf(ua);
  return { ...(browser === undefined ? {} : { browser }), ...(os === undefined ? {} : { os }) };
}

/** `ua` → `"<Browser> <major> · <OS>"`; either side may be absent; `""` when nothing is known
 * (the component then falls back to its i18n 「未知设备」 string). */
export function userAgentLabel(ua: string | undefined): string {
  const { browser, os } = userAgentParts(ua);
  if (browser === undefined && os === undefined) return "";
  if (browser === undefined) return os ?? "";
  if (os === undefined) return browser;
  return `${browser} · ${os}`;
}
