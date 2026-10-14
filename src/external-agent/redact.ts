/**
 * 脱敏（external-agent plan §4.1）：`secretEnvKeys` 所列 env 键的精确值 ⇒ `***`，外加通用
 * `(api[_-]?key|token|authorization)["'=: ]+\S+` 卫生规则。卫生措施，非安全边界。
 * pi-free、provider 无关：默认键保持 P2 冻结行为（["FACTORY_API_KEY"]），其它 provider 自行传入键名。
 * 签名扩展（相对 plan 冻结的单参 `(env)`）：可选第二参数 secretEnvKeys。
 */
const GENERIC_RE = /((?:api[_-]?key|token|authorization)["'=: ]+)(?:(?:bearer|basic)\s+)?\S+/gi;

export function createRedactor(
  env: NodeJS.ProcessEnv,
  secretEnvKeys: readonly string[] = ["FACTORY_API_KEY"],
): (text: string) => string {
  return (text: string): string => {
    if (typeof text !== "string" || text.length === 0) return text;
    let out = text;
    for (const k of secretEnvKeys) {
      const v = env[k];
      // 过短的值（空/1-3 字符）会把无关文本打码，忽略。
      if (typeof v === "string" && v.length >= 4) out = out.split(v).join("***");
    }
    return out.replace(GENERIC_RE, (_m, prefix: string) => `${prefix}***`);
  };
}
