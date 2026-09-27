// §7.1/§7.3 tidy prompt construction — STUB (todo #22 P0-b's frozen-surface
// commit; real implementation lands in package P4, §14.1).

export interface TidyPromptInput {
  cwd: string;
  files: readonly { name: string; body: string }[];
  migrationMode: boolean;
}

/** Not implemented yet (P4). Pure function. */
export function buildTidyPrompt(_input: TidyPromptInput): string {
  throw new Error("buildTidyPrompt: not implemented yet (todo #22 P4)");
}
