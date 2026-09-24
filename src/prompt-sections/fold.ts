/** Byte-for-byte compatible folding used by the existing prompt appenders. */
export function foldSections(prompt: string, texts: readonly string[]): string {
  let result = prompt;
  for (const text of texts) if (text) result = `${result}\n\n${text}`;
  return result;
}
