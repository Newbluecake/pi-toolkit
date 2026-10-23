import { useListDensity } from "../../../../src/web-hub/ui/src/composables/useListDensity.js";

/** Pre-feature (detailed) card/list rendering for legacy tests: the default is now compact. */
export function setDetailedListForTests(): void {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  useListDensity({ storage }).setDensity("detailed");
}
