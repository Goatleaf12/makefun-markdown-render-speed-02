// Driver for this markdown-render-speed entry.
//
// The harness runs `node /bot/main.ts` (Node 22+). It reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one alone
// with parse() from parse.js, and writes /output/html.json: a JSON array of
// the HTML strings, one per case and in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input
// and /output.
//
// This driver is deliberately boring: all the speed lives in parse.js. The
// only choices here are a preallocated output array and an indexed loop, so
// no per-case push or iterator overhead is paid.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as Array<{
  id: string;
  markdown: string;
}>;

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
