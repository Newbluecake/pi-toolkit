import { createHash } from "node:crypto";
export function computeRev(version: number, raw: string): string {
  return `${version}-${createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 6)}`;
}
