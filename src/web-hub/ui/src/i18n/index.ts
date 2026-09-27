/**
 * i18n namespace loader (vue-plan.md v2.1 §3.8, §5.2 — P0 frozen). Every namespace file
 * added by a later package (P1's `errors.ts`; P3's `shell`/`login`/`agents`/`detail`/`notices`/
 * `common`; P4's `fleet`/`transcript`) is picked up automatically by these two
 * `import.meta.glob(..., { eager: true })` calls — this file itself never changes to add one.
 *
 * Each `en/<ns>.ts` / `zh/<ns>.ts` pair default-exports a flat `Record<string, string>` for
 * that namespace (e.g. `en/shell.ts` → `{ signOut: "Sign out", ... }`); the zh file is expected
 * to write `satisfies Messages<typeof enNs>` against the matching en import so a missing/extra
 * key is a `vue-tsc` error at authoring time. `MESSAGES[lang][namespace][leafKey]` is the
 * runtime shape `useI18n.ts`'s `t("namespace.leafKey")` looks up.
 */

export type Dict = Record<string, string>;

const enModules = import.meta.glob<{ default: Dict }>("./en/*.ts", { eager: true });
const zhModules = import.meta.glob<{ default: Dict }>("./zh/*.ts", { eager: true });

function namespaceOf(globPath: string): string {
  const file = globPath.split("/").pop() ?? globPath;
  return file.replace(/\.ts$/, "");
}

function mergeNamespaced(modules: Record<string, { default: Dict }>): Record<string, Dict> {
  const out: Record<string, Dict> = {};
  for (const [path, mod] of Object.entries(modules)) out[namespaceOf(path)] = mod.default;
  return out;
}

export const MESSAGES: Readonly<Record<"en" | "zh", Record<string, Dict>>> = {
  en: mergeNamespaced(enModules),
  zh: mergeNamespaced(zhModules),
};
