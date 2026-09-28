import type { CommandInfoWire } from "../protocol/messages.js";
export interface SlashCommand {
  name: string;
  args: string;
}
export function parseSlashCommand(text: string): SlashCommand | undefined {
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1]!, args: m[2] ?? "" } : undefined;
}
export function listSlashCommands(): CommandInfoWire[] {
  return [];
}
