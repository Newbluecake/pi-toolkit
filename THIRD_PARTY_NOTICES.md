# Third-Party Notices

This repository's distributable bundles contain code from the following third-party
projects. Each entry reproduces the project's copyright notice and license text, as
required by the license's redistribution terms.

---

## prismjs

- **Project**: Prism (https://github.com/PrismJS/prism)
- **Version**: see `package.json` devDependencies (`prismjs`)
- **Used in**: `src/web-hub/ui/` (web-hub browser UI) — the syntax-highlighting engine and
  a subset of its language components, bundled into the lazily-loaded
  `assets/highlight-impl-*.js` chunk of `dist/web-hub-ui/`. Bundle legal comments are
  stripped at build time (`esbuild.legalComments: "none"` in `src/web-hub/ui/vite.config.ts`),
  so this notice file is the attribution of record.
- **License**: MIT (reproduced verbatim from `node_modules/prismjs/LICENSE`)

```
MIT LICENSE

Copyright (c) 2012 Lea Verou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
