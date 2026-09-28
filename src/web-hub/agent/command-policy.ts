export type CommandPolicy = "allow" | "confirm" | "deny";
export function commandPolicy(_name: string, _overrides: Record<string, CommandPolicy> = {}): CommandPolicy {
  return "deny";
}
