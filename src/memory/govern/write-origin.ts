/** Origin is the ONLY self-write suppression mechanism. Unknown means external. */
const INTERNAL_WRITE_ORIGINS: ReadonlySet<string> = new Set(["sweep", "revision", "p50-auto"]);
export function isExternalWriteOrigin(origin: string | undefined): boolean {
  return origin === undefined || !INTERNAL_WRITE_ORIGINS.has(origin);
}
