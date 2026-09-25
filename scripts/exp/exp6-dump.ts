// Experiment 6: dump a session context as readable text + mark which toolResults T1 would elide (for writing E-code questions).
import { writeFileSync } from "node:fs";
import { calibrate, loadContext, planTrim } from "./exp6-lib.js";
const [file, out] = process.argv.slice(2) as [string, string];
const { messages } = loadContext(file);
const cal = calibrate(messages);
const plan = planTrim(messages, "T1", cal.r);
const parts: string[] = [
  `# r=${cal.r.toFixed(3)} overhead=${Math.round(cal.overhead)} elided=${plan.elidedToolResults} kept=${plan.keptToolResults}`,
];
messages.forEach((m, i) => {
  if (m.role === "assistant") {
    for (const b of m.content ?? []) {
      if (b.type === "text") parts.push(`\n### [${i}] ASSISTANT TEXT\n${b.text}`);
      if (b.type === "toolCall") parts.push(`\n### [${i}] CALL ${b.id} ${b.name} ${JSON.stringify(b.arguments)}`);
    }
  } else if (m.role === "toolResult") {
    const t = (m.content ?? []).map((b: any) => b.text ?? "").join("");
    parts.push(
      `\n### [${i}] RESULT ${m.toolCallId} ${plan.elide.has(m.toolCallId) ? "**T1-ELIDED**" : "kept"} (${t.length} chars)\n${t}`,
    );
  } else {
    const t = typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join("");
    parts.push(`\n### [${i}] ${m.role.toUpperCase()}\n${t}`);
  }
});
writeFileSync(out, parts.join("\n"));
console.log(out, parts.length);
