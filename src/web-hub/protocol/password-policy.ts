/** #66 P4: matching only is normalized; callers must hash/store the original string.
 * D5 overrides the draft's variety rule: no composition or entropy/character-count threshold.
 * Only protocol-local imports (I8); no I/O, timers, pi or runtime dependencies.
 */
import { COMMON_PASSWORDS } from "./common-passwords.js";
import { MAX_LAN_PASSWORD_LENGTH, MIN_LAN_PASSWORD_LENGTH } from "./lan.js";

export const LAN_PASSWORD_POLICY_VERSION = 1;
export type LanPasswordReject = "length" | "common" | "pattern" | "variety" | "username";
export type LanPasswordVerdict = { ok: true } | { ok: false; reason: LanPasswordReject };

// I4: one immutable lookup closure per policy version, shared across /reload via Symbol.for.
// Capacity: one corpus Set + one base-word regex; lifetime: process (static versioned data,
// no user input retained, no TTL needed). Both are captured and never exposed or mutated.
const CACHE_KEY = Symbol.for("pi-subagent:lan-password-policy:v1");
type Lookup = (password: string) => boolean;
type CacheHost = typeof globalThis & { [CACHE_KEY]?: Lookup };

// Curated high-frequency credential/service/name bases (165), not a substring dictionary.
const BASE_WORDS = `password passwd passphrase passcode secret admin administrator root login welcome
letmein changeme default guest user test testing demo master superuser access system manager
qwerty qwertz azerty asdfgh zxcvbn qazwsx abcdef abcdefgh abcdefghij iloveyou love loveyou
sunshine princess dragon monkey football baseball basketball soccer hockey tennis cricket
superman batman spiderman ironman starwars matrix pokemon pikachu naruto ninja shadow
trustnoone whatever freedom mustang ferrari porsche mercedes bmw toyota honda chevrolet
harley davidson motorcycle computer internet windows microsoft google apple samsung android
iphone ipad macbook linux ubuntu debian oracle database server network security public
private development developer devops production staging backup docker kubernetes jenkins
github gitlab bitbucket wordpress drupal joomla magento tomcat apache nginx mysql postgres
redis elasticsearch rabbitmq mongodb letmeinplease welcomehome helloworld hello goodbye
thankyou beautiful happiness wonderful forever friends family michael jennifer jessica
ashley nicole daniel andrew matthew joshua robert william charles thomas george john
james david richard joseph anthony christopher elizabeth sarah amanda melissa samantha
michelle stephanie lauren victoria alexander alexis patrick pepper cookie chocolate`;

function commonLookup(): Lookup {
  const host = globalThis as CacheHost;
  if (host[CACHE_KEY] === undefined) {
    const corpus = new Set(COMMON_PASSWORDS.split("\n"));
    const words = BASE_WORDS.split(/\s+/);
    const maxBaseLength = Math.max(...words.map((word) => word.length));
    // Each 1 independently means i OR l, including mixed readings (m1ch3113).
    const bases = new RegExp(`^(?:${words.map((word) => word.replace(/[il]/g, "[il1]")).join("|")})$`);
    host[CACHE_KEY] = (password) => {
      if (corpus.has(password)) return true;
      // Edge leet characters may be letters OR wrappers: try each bounded cut so
      // W3lc0m32024! preserves its final leet e, and @dmin preserves its initial a.
      const leading = password.match(/^[\d\W_]+/)?.[0].length ?? 0;
      const trailing = password.match(/[\d\W_]+$/)?.[0].length ?? 0;
      for (let start = 0; start <= leading; start++) {
        for (let end = 0; end <= trailing; end++) {
          const candidate = password.slice(start, password.length - end);
          // All base words are ASCII; avoid pointless decoding of oversized wrappers.
          if (candidate.length < 3 || candidate.length > maxBaseLength) continue;
          const decoded = candidate
            .replace(/[@4]/g, "a")
            .replace(/0/g, "o")
            .replace(/3/g, "e")
            .replace(/[5$]/g, "s")
            .replace(/7/g, "t");
          if (bases.test(decoded)) return true;
        }
      }
      return false;
    };
  }
  return host[CACHE_KEY]!;
}

function predictable(password: string): boolean {
  const chars = Array.from(password);
  for (let width = 1; width <= 3; width++) {
    // Also rejects truncated repetitions (abcabcabca).
    if (chars.every((ch, i) => ch === chars[i % width])) return true;
  }
  const step = chars[1]!.codePointAt(0)! - chars[0]!.codePointAt(0)!;
  if (chars.every((ch, i) => i < 2 || ch.codePointAt(0)! - chars[i - 1]!.codePointAt(0)! === step)) return true;
  for (const row of ["1234567890", "qwertyuiop", "asdfghjkl;", "zxcvbnm,./", "!@#$%^&*()"]) {
    if (row.includes(password) || Array.from(row).reverse().join("").includes(password)) return true;
  }
  return false;
}

export function checkLanPassword(password: string, ctx: { username: string }): LanPasswordVerdict {
  if (password.length < MIN_LAN_PASSWORD_LENGTH || password.length > MAX_LAN_PASSWORD_LENGTH) {
    return { ok: false, reason: "length" };
  }
  const normalized = password.normalize("NFKC").toLowerCase();
  const username = ctx.username.normalize("NFKC").toLowerCase();
  if ((username.length >= 3 && normalized.includes(username)) || normalized.includes("webhub")) {
    return { ok: false, reason: "username" };
  }
  // Normalization can contract below two code points; a single point is repetition.
  if (Array.from(normalized).length < 2 || predictable(normalized)) return { ok: false, reason: "pattern" };
  if (commonLookup()(normalized)) return { ok: false, reason: "common" };
  return { ok: true };
}
