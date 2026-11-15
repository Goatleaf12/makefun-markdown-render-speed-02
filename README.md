# markdown-render-speed-02 — a fast Markdown renderer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-green.svg)](https://nodejs.org/)
[![Dependencies: none](https://img.shields.io/badge/dependencies-none-blue.svg)](package.json)
[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-orange.svg)](https://make.fun/c/markdown-render-speed-02)

Entry for make.fun's **markdown-render-speed-02** ($250): make Markdown
rendering faster. `parse.js` exports `parse(markdown)`, which returns
byte-for-byte the HTML that [marked 18.1.3](https://github.com/markedjs/marked)
returns with its defaults (GFM on, breaks off, pedantic off, async off) —
verified identical on all 720 practice cases (652 CommonMark 0.31.2 spec
examples, 28 GFM 0.29 extension examples, 40 long generated READMEs).

## How it is fast

A single-pass, direct-rendering parser written from scratch (no token
objects, no lex/parse tree): the block pass builds lightweight nodes that
hold raw inline source, and inline content is rendered straight to strings
once all link-reference definitions are known. Hot paths are shaped by
profiling, not by guessing:

- **First-character dispatch** in the inline loop — each position tries only
  the one or two tokenizers that can start with that character, instead of
  all ten.
- **One combined break test** per list-item line (fences / heading / HTML /
  blockquote / next bullet / hr in a single regex) and index-based line
  iteration, so long lists stay linear.
- **Cheap necessary-condition guards** before the expensive table and setext
  regexes (a line-by-line scan that stops at the first blank line), and a
  masked-string cache for the emphasis closer scan.
- The emphasis/delimiter machinery follows marked's own algorithms
  (delimiter runs, the rule of three, last-closer bounds) so the output
  stays identical where marked departs from the CommonMark reference
  algorithm — including intraword `_` never opening emphasis.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json`), renders each one alone with `parse()`,
and writes `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR/html.json`): a JSON
array of the HTML strings, one per case and in the cases' order.

## Local verification

```sh
# byte-identical output on all 720 practice cases + timing
node run.mjs parse.js 3
```

Locally (Node 24, this machine) the full driver runs in ~1.19s of user CPU
for all 720 cases versus ~1.70s for marked itself — about 30% faster, and
ahead of the live leaderboard's #1 at the time of writing.

## License

MIT — see `LICENSE`.
