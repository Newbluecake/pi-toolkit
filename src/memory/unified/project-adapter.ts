/** Preserve the v3 execute port verbatim: text/usage results and thrown errors are not mapped. */
export function createProjectAdapter<Args extends unknown[], Result>(execute: (...args: Args) => Promise<Result>) {
  return { execute: (...args: Args): Promise<Result> => execute(...args) };
}
