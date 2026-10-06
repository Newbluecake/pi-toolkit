/**
 * Lazily-loaded syntax-highlight implementation (syntax-highlight package, 2026-10): Prism
 * core + the user-ruled language set in ONE statically-linked module, so the whole pack
 * lands in a SINGLE code-split chunk that `HighlightedCode.vue` pulls via dynamic
 * `import()` — the first screen never pays for it.
 *
 * Language set (user ruling): ts/tsx/js/jsx/json/python/go/rust/bash(sh/zsh)/yaml/toml/
 * markdown/css/scss/html(markup)/vue(按 markup)/sql/diff/java/c/cpp/docker/ini. Prism core
 * already ships markup/css/clike/javascript, so those need no component import. Import order
 * matters (components read sibling grammars off the global at load time): c before cpp,
 * javascript (core) before typescript, jsx + typescript before tsx, css (core) before scss.
 *
 * `prism-global.ts` MUST stay the first import — it publishes `globalThis.Prism` before any
 * `prismjs/components/*` script evaluates (they reference the bare global `Prism`).
 */
import Prism from "./prism-global.js";
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-scss.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-docker.js";
import "prismjs/components/prism-ini.js";

export default Prism;
