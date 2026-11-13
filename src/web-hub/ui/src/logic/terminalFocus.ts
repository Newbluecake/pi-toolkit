/** Only the terminal input surface owns TTY keys; chrome and higher modal focus do not. */
export function terminalOwnsKey(event: Event): boolean {
  const active = document.activeElement;
  if (!(active instanceof Element) || !active.closest("[data-terminal-input]")) return false;
  return event.composedPath().some((node) => node instanceof Element && node.hasAttribute("data-terminal-input"));
}
