/**
 * W1 copy of HUD's home abbreviation. W6 will deduplicate HUD by importing this
 * pi-free helper; keeping the copy here avoids changing HUD in the W1 package.
 */
export function abbreviateHome(path: string, home: string | undefined): string {
  if (home === undefined || home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
