# README screenshots

Regenerates the images under `docs/images/` (hero web UI desktop zh/en, dark, mobile ×3, TUI agent tree) from
**synthetic data only** — nothing reads `~/.pi`, real sessions, tokens or the user's hub.

```sh
scripts/dev/readme-shots/regen.sh            # scratch + output: $README_SHOTS_DIR (default ~/readme-shots)
cp ~/readme-shots/final/*.png docs/images/
```

## How it works

| Step       | Script             | Notes                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fixtures   | `make-fixture.mjs` | writes `fixtures/demo-{zh,en}.json` (sessions, transcript, agent tree incl. consult row `t#2 warm·hit 96%`, quota) for `scripts/web-hub/dev-hub.ts`'s `fixturesDir`                                                                                                                                                                                         |
| web shots  | `shoot-web.mts`    | real built UI (`dist/web-hub-ui`, `npm run build:web`) + dev-hub + Playwright Chromium; freezes the build chip to `ui 0.6.0`, scrolls the transcript to the top                                                                                                                                                                                             |
| TUI        | `tui/capture.sh`   | `tui/setup.sh` builds an isolated fake `HOME` + agent dir + demo git project; real `pi` runs in tmux with a hand-written session (`tui/make-session.mjs`) and `tui/demo-ext.ts`, which feeds fake run snapshots to the real `buildFleetWidgetLines`; the ANSI dump is scrubbed (quota warnings removed, `toolkit` chip frozen to `v0.6.0 2026-10-18 10:30`) |
| ANSI → PNG | `tui/ansi2png.mts` | ANSI → HTML grid → Chromium screenshot (needs a colour-emoji font, auto-discovered or `EMOJI_FONT=…`)                                                                                                                                                                                                                                                       |
| optimize   | `optimize.py`      | PIL 256-colour quantize, crops the empty mobile drawer tail, warns above 150 KB                                                                                                                                                                                                                                                                             |

## Prerequisites

Node ≥ 22 and `npx tsx` (repo devDependency), a Playwright-cached Chromium (see `scripts/web-hub/lib/playwright.js`),
`tmux`, `pi` on `PATH` (the version the repo pins), `git`, Python 3 + Pillow, a Noto Color Emoji font.
Keep the scratch dir under `$HOME` — snap Chromium cannot read `/tmp`.

## Gotchas

- The TUI trust prompt is answered by key presses (Down Down Enter) — if pi changes that dialog, adjust `tui/capture.sh`.
- The footer model is `claude-sonnet-5-5`; it must exist in pi's built-in model list (`pi --list-models`).
- The fake `auth.json` key is never used (no request is sent).
