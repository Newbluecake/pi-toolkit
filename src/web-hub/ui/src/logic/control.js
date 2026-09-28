/** Pure control-plane helpers (C0 frozen surface; behavior is filled by C4). */
export function newCmdId(getRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)) {
  if (typeof getRandomValues !== "function") return "AAAAAAAAAAAAAAAAAAAAAA";
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function parseSlash(text) {
  if (typeof text !== "string" || !text.startsWith("/") || text.startsWith("//")) return undefined;
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1], args: m[2] || "" } : undefined;
}
export function mergeQueue(serverQueue = [], optimistic = [], dropped = []) {
  const droppedSet = new Set(dropped);
  return [...optimistic, ...serverQueue].filter((item) => !droppedSet.has(item.id));
}
export function composerKeyAction(event, { coarse = false, busy = false } = {}) {
  if (coarse || event?.isComposing || event?.keyCode === 229) return "newline";
  if (event?.key === "Enter" && event?.altKey) return "followUp";
  if (event?.key === "Enter" && !event?.shiftKey) return busy ? "steer" : "prompt";
  return "newline";
}
export function commandPolicyFor(commands = [], name, busy = false) {
  const found = commands.find((c) => c.name === name);
  return found ? (busy && found.policyBusy ? found.policyBusy : found.policy) : "deny";
}
export function pendingTransition(item, event) {
  return { ...item, ...event };
}
export function buildDialogAnswers(_questions, selections) {
  return selections;
}
export function dialogComplete(questions, answers) {
  return Array.isArray(questions) && Array.isArray(answers) && questions.length === answers.length;
}
