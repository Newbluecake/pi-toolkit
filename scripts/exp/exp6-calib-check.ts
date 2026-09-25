// Experiment 6: per-turn ΔP vs predicted chars×r audit for one session (calibration self-check).
import { loadContext, promptTokens, sumChars, calibrate } from "./exp6-lib.js";
const f = process.argv[2]!;
const { messages } = loadContext(f);
const cal = calibrate(messages);
console.log(JSON.stringify(cal));
let prevI = -1;
messages.forEach((m, i) => {
  if (m.role !== "assistant") return;
  const p = promptTokens(m);
  if (prevI >= 0 && p !== undefined) {
    const dC = sumChars(messages.slice(prevI, i), cal.withThinking);
    const dP = p - promptTokens(messages[prevI])!;
    console.log(i, "P", p, "dP", dP, "pred", Math.round(dC * cal.r), JSON.stringify(m.usage).slice(0, 120));
  }
  prevI = i;
});
