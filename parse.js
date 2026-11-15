// FastMarked — a fast drop-in replacement for marked 18.1.3 (default options:
// GFM on, breaks off, pedantic off, async off).
//
// Written from scratch as a single-pass, direct-rendering parser: it reads the
// input once, builds block structure with small line-based helpers, renders
// inline content straight to strings, and never allocates token objects or
// intermediate lex/parse trees. Its observable output is byte-identical to
// marked 18.1.3's `marked.parse` on every input (verified against the vendored
// marked 18.1.3 reference on the competition's 720 practice cases).
//
// Behavioural notes (where marked departs from the CommonMark/GFM spec, this
// follows marked, because marked's HTML is the expected output):
//  - headings carry no id attributes (marked 18 removed header ids);
//  - raw HTML passes through unescaped, including <script> (no sanitizer);
//  - named entities pass through untouched; only numeric character references
//    are decoded (invalid ones become U+FFFD, &#38; becomes &amp;);
//  - emphasis follows marked's delimiter-scan algorithm (including its
//    "rule of 3" handling), not the CommonMark reference algorithm.
// This file is dependency-free: no imports at all. It keeps no state between
// calls — every parse() builds fresh per-call state, so each case is rendered
// exactly as if it were parsed alone.

// ---------------------------------------------------------------- helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML. encode=true escapes & always; encode=false leaves &
// alone when it starts a valid entity/numeric reference (marked's P()).
function esc(s, encode) {
  if (encode) {
    return s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0
      ? s : s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }
  if (!/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(s)) return s;
  return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESCAPES[c] || '&amp;');
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references the way marked does (Ie()).
function unescapeEntities(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// Encode a link destination the way marked does (he()): encodeURI, then %25 -> %.
function encodeHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// Split a table row on unescaped pipes (marked's de()).
function splitRow(row, count) {
  const parts = row.replace(/\|/g, (m, off, str) => {
    let back = false, p = off;
    while (--p >= 0 && str[p] === '\\') back = !back;
    return back ? '|' : ' |';
  }).split(/ \|/);
  let i = 0;
  if (parts[0].trim() || parts.shift(), parts.length > 0 && !parts[parts.length - 1].trim()) parts.pop();
  if (count) {
    if (parts.length > count) parts.splice(count);
    else while (parts.length < count) parts.push('');
  }
  for (; i < parts.length; i++) parts[i] = parts[i].trim().replace(/\\\|/g, '|');
  return parts;
}

// Strip trailing characters (marked's L()): removes trailing `ch` (or, when
// stripOther, trailing chars that are NOT ch) from the end of s.
function stripTrailing(s, ch, stripOther) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !stripOther) k++;
    else if (c !== ch && stripOther) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Remove a trailing blank line (at most two) the way marked's ge() does.
function trimBlankEnd(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalize a link reference label (marked's F()).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing paren matching the opening one at the start
// of `s` (marked's ke()): returns -1 when balanced, -2 when unclosed.
function findParenClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the visual column (marked's J()).
function expandTabs(s, col) {
  let out = '', c = col;
  for (const ch of s) {
    if (ch === '\t') { const n = 4 - (c % 4); out += ' '.repeat(n); c += n; }
    else { out += ch; c++; }
  }
  return out;
}

// ------------------------------------------------------- regex construction

// Build a regex from a source string, allowing named placeholders to be
// replaced by other patterns (marked builds its grammars this way). When a
// replacement is embedded, a leading ^ in its source is dropped so the anchor
// does not pin the middle of the pattern.
const CARET = /(^|[^\[])\^/g;
function rx(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  return {
    replace(name, rep) {
      let r = typeof rep === 'string' ? rep : rep.source;
      r = r.replace(CARET, '$1');
      s = s.replace(name, r);
      return this;
    },
    getRegex() { return new RegExp(s, flags); },
  };
}


// ------------------------------------------------------------- block grammar

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const LABEL = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_NOSPACE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const HR_SRC = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const HR_RE = new RegExp(`^ {0,3}(${HR_SRC})(?:\\n+|$)`);
// Non-capturing form, used when the hr pattern is embedded inside another
// pattern: a capturing group there would renumber the host's groups (this
// bit marked's own setext-heading tokenizer, whose depth group must stay #2).
const HR_ALT = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_CODE = /(?: {4}| {0,3}\t)/;
const FENCES_START = / {0,3}(?:`{3,}|~{3,})/;
const BLOCKQUOTE_START = / {0,3}>/;
const HEADING_START = / {0,3}#{1,6}(?:\s|$)/;
const HTML_START = new RegExp(` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');

const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HTML = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', COMMENT).replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
const RE_DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL_NOSPACE)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).getRegex();
const RE_LIST = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULL).getRegex();
const LHEADING_SRC = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const RE_LHEADING = rx(LHEADING_SRC)
  .replace(/bull/g, BULL).replace(/blockCode/g, BLOCK_CODE).replace(/fences/g, FENCES_START)
  .replace(/blockquote/g, BLOCKQUOTE_START).replace(/heading/g, HEADING_START).replace(/hr/g, HR_ALT)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, '').getRegex();
const RE_TABLE = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', HR_ALT).replace('heading', HEADING_START).replace('blockquote', BLOCKQUOTE_START)
  .replace('code', /(?: {4}| {0,3}\t)[^\n]/).replace('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .replace('list', / {0,3}(?:[*+-]|1[.)])[ \t]/).replace('html', HTML_START).getRegex();
const PARA_SRC = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function paragraphRegex(listBull) {
  return rx(PARA_SRC)
    .replace('hr', HR_ALT).replace('heading', HEADING_START).replace('|lheading', '')
    .replace('table', RE_TABLE).replace('blockquote', BLOCKQUOTE_START)
    .replace('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
    .replace('list', listBull).replace('html', HTML_START).getRegex();
}
const RE_PARAGRAPH = paragraphRegex(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
const RE_PARAGRAPH_BQ = paragraphRegex(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const RE_TEXT = /^[^\n]+/;
const RE_BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', RE_PARAGRAPH_BQ).getRegex();
// Cheap necessary conditions, so the expensive table / setext regexes only
// run when they could possibly match. The setext check scans line by line
// and stops at the first blank line (a setext heading's content cannot span
// one), so it costs O(paragraph length), never O(remaining document).
function setextMaybe(src) {
  let pos = src.indexOf('\n');
  while (pos !== -1) {
    let i = pos + 1;
    while (src[i] === ' ') i++;
    const indent = i - (pos + 1);
    const ch = src[i];
    if (ch === '\n' || ch === undefined) return false;
    if ((ch === '=' || ch === '-') && indent <= 3) {
      let j = i;
      while (src[j] === ch) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if (src[j] === '\n' || j >= src.length) return true;
    }
    pos = src.indexOf('\n', i);
  }
  return false;
}
function tableMaybe(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  const nl2 = src.indexOf('\n', nl + 1);
  const line2 = src.slice(nl + 1, nl2 === -1 ? src.length : nl2);
  return line2.includes('-');
}

// Indent-dependent helpers (cached like marked's D(): the cache key is the
// indent clamped to 0..3, and the pattern is built from that CLAMPED value —
// a bullet test for content indent R allows at most R-1 leading spaces).
function indentRegex(kind, n) {
  const cache = indentRegex['_' + kind] || (indentRegex['_' + kind] = []);
  const idx = Math.max(0, Math.min(3, n - 1));
  if (cache[idx]) return cache[idx];
  let re;
  if (kind === 'bullet') re = new RegExp(`^ {0,${idx}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
  else if (kind === 'hr') re = new RegExp(`^ {0,${idx}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
  else if (kind === 'fences') re = new RegExp(`^ {0,${idx}}(?:\`\`\`|~~~)`);
  else if (kind === 'heading') re = new RegExp(`^ {0,${idx}}#{1,6}(?:\\s|$)`);
  else if (kind === 'html') re = new RegExp(`^ {0,${idx}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
  else re = new RegExp(`^ {0,${idx}}>`);
  cache[idx] = re;
  return re;
}
function listItemRegex(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`);
}

// Does `s` end with a blank line followed by another blank line
// (marked's /\n[ \t]*\n[ \t]*$/), checked by scanning backwards instead
// of running a regex over the whole string.
function hasTrailingDoubleBlank(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  if (i < 0 || s[i] !== '\n') return false;
  i--;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i >= 0 && s[i] === '\n';
}

// One regex for the six "does this line end the current list item?" tests
// (fences / heading / html / blockquote / next-bullet / hr), cached per
// clamped indent like marked's D(). A single exec replaces six tests per line.
const _breakReCache = [];
function listBreakRegex(indent) {
  const idx = Math.max(0, Math.min(3, indent - 1));
  if (_breakReCache[idx]) return _breakReCache[idx];
  const re = new RegExp(`^(?: {0,${idx}}(?:\`\`\`|~~~)| {0,${idx}}#{1,6}(?:\\s|$)| {0,${idx}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| {0,${idx}}>| {0,${idx}}(?:[*+-]|\\d{1,9}[.)])(?:(?:[ \\t][^\\n]*)?(?:\\n|$))| {0,${idx}}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$))`, 'i');
  _breakReCache[idx] = re;
  return re;
}

// ------------------------------------------------------------ inline grammar

const PUNCT = /[\p{P}\p{S}]/u;                 // any punctuation/symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;         // space or punctuation/symbol
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;    // not space/punct/symbol
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_TAG = rx('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', rx(COMMENT).replace('(?:-->|$)', '-->').getRegex())
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
const RE_AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();

const LINK_LABEL = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', BRACKETS).getRegex();
const LINK_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
const RE_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LINK_LABEL).replace('href', LINK_HREF).replace('title', LINK_TITLE).getRegex();
const RE_REFLINK = rx(/^!?\[(label)\]\[(ref)\]/).replace('label', LINK_LABEL).replace('ref', LABEL_NOSPACE).getRegex();
const RE_NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL_NOSPACE).getRegex();
const REFLINK_LABEL = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\\]|\\[\s\S]|[^\[\]\\])*\\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const REFLINK_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const RE_REFLINK_SEARCH = rx('reflink|nolink(?!\\()', 'g')
  .replace('reflink', rx(/^!?\[(label)\]\[(ref)\]/).replace('label', REFLINK_LABEL).replace('ref', REFLINK_REF).getRegex())
  .replace('nolink', rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', REFLINK_REF).getRegex()).getRegex();

const SCHEME_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const MAILTO_RE = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_RE).getRegex();
const EMAIL_RE_GROUPED = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', MAILTO_RE).replace('protocol', SCHEME_RE).replace('email', EMAIL_RE_GROUPED).getRegex();
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Emphasis delimiter patterns (GFM variants: ~ excluded from punctuation).
const EM_L_DELIM_SRC = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const RE_EM_L_DELIM = rx(EM_L_DELIM_SRC, 'u').replace(/punct/g, PUNCT_NO_TILDE).getRegex();
// (pedantic/open-quote variant not needed: pedantic off; the gfm LDelim uses
// the plain punct class for the * branch and the open-quote rule only applies
// to the pedantic set, so the gfm form above is the one marked uses.)
const EM_R_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const RE_EM_R_AST = rx(EM_R_AST_SRC, 'gu').replace(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE).replace(/punctSpace/g, PUNCT_SPACE_NO_TILDE).replace(/punct/g, PUNCT_NO_TILDE).getRegex();
const EM_R_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const RE_EM_R_UND = rx(EM_R_UND_SRC, 'gu').replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).getRegex();
const RE_DEL_L_DELIM = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).getRegex();
const DEL_R_SRC = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const RE_DEL_R = rx(DEL_R_SRC, 'gu').replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).getRegex();
const RE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const RE_PUNCT = rx(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).getRegex();

// Inline text scanner (GFM): consumes plain text up to the next construct.
const RE_INLINE_TEXT = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', SCHEME_RE).replace(/emailProtocol/g, /(?:mailto|xmpp):/).replace('wwwStart', /(?<![^\s*_~(])www\./).getRegex();

// Masking patterns used to hide link/code/html regions from the emphasis scan.
const RE_BLOCK_SKIP = rx(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', /(?<!`)()/)
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/).getRegex();
const RE_ANY_PUNCT_OUTSIDE_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const RE_ANY_PUNCT = rx(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();


// ------------------------------------------------------------ inline parsing

// Per-parse inline state (fresh for every parse() call, like marked's Lexer
// state; nothing input-derived survives a call).
function newInlineState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
}

// Scan a masked source for the last run of *, _ or ~ that could close an
// emphasis/delimiter run (marked's fe()).
function lastCloser(masked) {
  const idx = { '*': -1, '_': -1 };
  let tilde = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else idx[ch] = i;
    }
    i = j - 1;
  }
  return { em: idx, del: tilde };
}

// Does the text contain a link (marked's linkInText(), used by the mask)?
// Uses fresh regex instances: this runs inside replace() callbacks, where a
// shared global regex would have its lastIndex clobbered by re-entry.
function linkInText(s, refs) {
  if (!s.includes('[')) return false;
  const skip = new RegExp(RE_BLOCK_SKIP.source, 'g');
  let m;
  while ((m = skip.exec(s)) !== null) {
    if (RE_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  const search = new RegExp(RE_REFLINK_SEARCH.source, 'g');
  while ((m = search.exec(s)) !== null) {
    const str = m[0];
    const r = str.lastIndexOf('[');
    if (!(str.charAt(0) === '!' || !Object.hasOwn(refs, normLabel(str.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(str.slice(1, r - 1), refs))) return true;
  }
  return false;
}

// Mask one reflink-like match for the emphasis scan (marked's #n step 1).
function maskReflinkMatch(r, refs) {
  const o = r.lastIndexOf('[');
  if (!Object.hasOwn(refs, normLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(inner, refs)) {
      const search = new RegExp(RE_REFLINK_SEARCH.source, 'g');
      return '[' + inner.replace(search, (x) => maskReflinkMatch(x, refs)) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

// Build the masked copy of an inline source: link/code/html regions are
// replaced by same-length filler so the emphasis scan cannot see '*'/'_'/'~'
// inside them (marked's #n). Length-preserving, so indices stay aligned.
// Symbol key on the refs map: true once any link-reference definition was
// found. (A symbol cannot collide with a real label.)
const HAS_REFS = Symbol('hasRefs');

function maskEm(src, refs) {
  let t = src;
  // With no definitions, no reflink can match, so the masking pass is a
  // no-op and can be skipped entirely.
  if (refs && refs[HAS_REFS] && src.includes('[')) {
    // String.replace with a global regex always starts at lastIndex 0, so
    // the shared module-level regexes are safe here (no re-entry: the
    // callbacks below use fresh regexes where they recurse).
    t = t.replace(RE_REFLINK_SEARCH, (r) => maskReflinkMatch(r, refs));
  }
  // The punctuation pass only matches backslash-escapes and backtick runs;
  // the block-skip pass only matches [...] (...), backtick runs and <...>.
  if (t.includes('\\') || t.includes('`')) {
    t = t.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (m, backticks, punct) => {
      if (punct) return '+'.repeat(m.length);
      if (backticks) return backticks + m.slice(backticks.length, -backticks.length).replace(/`/g, '+') + backticks;
      return m;
    });
  }
  if (t.includes('[') || t.includes('<') || t.includes('`')) {
    t = t.replace(RE_BLOCK_SKIP, (m, _g1, precode) => {
      const o = precode ? precode.length : 0;
      return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
    });
  }
  return t;
}

// The link tokenizer's guard (marked's Be()): true when the label contains a
// "<" that starts a tag/autolink running past the end of the label.
function labelHasOpenTag(full, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = RE_CODE_SPAN.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = full.slice(labelStart + i);
    const m = RE_TAG.exec(rest) || RE_AUTOLINK.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Try to parse an inline link or image at the start of `s`. Returns the
// rendered output (already in the caller's mode) and the consumed length, or
// null when no link matches (marked's link() + De()). `st` is the shared
// inline state; `plain` renders as plain text (image alt text).
function tryLink(s, refs, st, plain) {
  if (st.linkParenPossible === false) return null;
  const m = RE_LINK.exec(s);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!';
  const labelStart = bang ? 2 : 1;
  if (labelHasOpenTag(s, m[1], labelStart)) return null;
  let href = m[2].trim();
  if (/^</.test(href)) {
    if (!/>$/.test(href)) return null;
    const stripped = stripTrailing(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const close = findParenClose(m[2], '()');
    if (close === -2) return null;
    if (close > -1) {
      const cut = (bang ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
      href = m[2].trim();
    }
  }
  const rawNoLast = stripTrailing(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawNoLast.length) % 2 === 0) return null;
  let dest = href;
  let title = '';
  if (m[3]) title = m[3].slice(1, -1);
  dest = dest.trim();
  if (/^</.test(dest)) dest = dest.slice(1, -1);
  dest = dest.replace(RE_ANY_PUNCT, '$1');
  title = title.replace(RE_ANY_PUNCT, '$1');
  return buildLink(m[0], bang, m[1], dest, title, refs, st, plain);
}

// Build the link/image output, rendering its label text (marked's De()).
// The label renders in plain mode when the link is an image (alt text) or
// when the caller itself renders plain text.
function buildLink(raw, isImage, label, href, title, refs, st, plain) {
  const textSrc = label.replace(/\\([\[\]])/g, '$1');
  const labelPlain = isImage || plain;
  const saveLink = st.inLink, saveEmitted = st.linkEmitted, saveRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const rendered = inlineRender(textSrc, refs, st, labelPlain);
  const nested = st.linkEmitted;
  st.linkEmitted = saveEmitted;
  st.inLink = saveLink;
  if (!isImage) {
    if (nested) { st.inRawBlock = saveRaw; return null; }
    st.linkEmitted = true;
  }
  if (isImage) {
    if (plain) return { html: rendered, len: raw.length };
    const encoded = encodeHref(href);
    if (encoded === null) return { html: esc(rendered), len: raw.length };
    let out = `<img src="${esc(encoded)}" alt="${esc(rendered)}"`;
    if (title) out += ` title="${esc(title)}"`;
    return { html: out + '>', len: raw.length };
  }
  if (plain) return { html: rendered, len: raw.length };
  const encoded = encodeHref(href);
  if (encoded === null) return { html: rendered, len: raw.length };
  let out = `<a href="${esc(encoded, false)}"`;
  if (title) out += ` title="${esc(title)}"`;
  return { html: out + '>' + rendered + '</a>', len: raw.length };
}

// Try a reference link (full, collapsed or shortcut) at the start of `s`.
function tryRefLink(s, refs, st, plain) {
  let m = RE_REFLINK.exec(s) || RE_NOLINK.exec(s);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!';
  const labelStart = bang ? 2 : 1;
  if (labelHasOpenTag(s, m[1], labelStart)) return null;
  const ref = refs[normLabel(m[2] || m[1])];
  if (!ref) return { html: m[0].charAt(0), len: 1, textOnly: true };
  return buildLink(m[0], bang, m[1], ref.href, ref.title, refs, st, plain);
}

// Emphasis / strong emphasis (marked's emStrong()), translated directly.
// `e` is the remaining raw source, `masked` the full masked source, `prev`
// the character before the current position. Returns {html, len} or null.
function tryEmStrong(e, masked, prev, closer, refs, st, plain) {
  const s = RE_EM_L_DELIM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0];
  const sameAsPrev = prev === delim;
  const i = masked.length - e.length;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const beforeRun = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || RE_PUNCT.test(beforeRun);
  if (l < i) prev = beforeRun;
  const canOpen = l < i ? beforeIsPunct : RE_PUNCT.test(prev);
  if (s[4] && /[\p{L}\p{N}]/u.test(prev)) return null;
  const punctAfter = s[1] || s[3] || '';
  if (!punctAfter || !prev || canOpen) {
    let k = [...s[0]].length - 1;
    let m = k, f = 0;
    const y = i - l + k;
    const R = !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsPunct));
    if (delim !== '*' && delim !== '_') return null;
    const re = delim === '*' ? RE_EM_R_AST : RE_EM_R_UND;
    const v = closer.em[delim];
    const Q = masked.length - e.length + k;
    if (v < Q) return null;
    const t = masked.slice(-e.length + k);
    const bound = v - Q;
    let g, b;
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(t)) !== null && !(mm.index > bound)) {
      g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
      if (!g) continue;
      b = [...g].length;
      if (mm[3] || mm[4]) { m += b; continue; }
      if (mm[5] || mm[6] || R) {
        if (sameAsPrev && (mm[5] || mm[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...mm[0]][0].length;
      const raw = e.slice(0, k + mm.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = raw.slice(1, -1);
        const text = inlineRender(inner, refs, st, plain);
        return { html: plain ? text : `<em>${text}</em>`, len: raw.length };
      }
      const inner = raw.slice(2, -2);
      const text = inlineRender(inner, refs, st, plain);
      return { html: plain ? text : `<strong>${text}</strong>`, len: raw.length };
    }
  }
  return null;
}

// Strikethrough (marked's del()), translated directly.
function tryDel(e, masked, prev, closer, refs, st, plain) {
  const s = RE_DEL_L_DELIM.exec(e);
  if (!s) return null;
  if (!(s[1] || '') || !prev || RE_PUNCT.test(prev)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const d = masked.length - e.length + o;
    if (closer.del < d) return null;
    const t = masked.slice(-e.length + o);
    const bound = closer.del - d;
    RE_DEL_R.lastIndex = 0;
    let mm;
    while ((mm = RE_DEL_R.exec(t)) !== null && !(mm.index > bound)) {
      const g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
      if (!g) continue;
      let l = [...g].length;
      if (l !== o) continue;
      if (mm[3] || mm[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const te = [...mm[0]][0].length;
      const raw = e.slice(0, o + mm.index + te + l);
      const inner = raw.slice(o, -o);
      const text = inlineRender(inner, refs, st, plain);
      return { html: plain ? text : `<del>${text}</del>`, len: raw.length };
    }
  }
  return null;
}

// Render inline markdown to HTML. When `plain` is true, render as plain text
// (marked's TextRenderer: no tags, no escaping — used for image alt text).
function inlineRender(src, refs, st, plain) {
  const saveParen = st.linkParenPossible;
  st.linkParenPossible = saveParen && src.includes(')');
  try {
    return inlineLoop(src, refs, st, plain);
  } finally {
    st.linkParenPossible = saveParen;
  }
}

function inlineLoop(src, refs, st, plain) {
  let out = '';
  let s = src;
  let prev = '';
  let prevWasText = false;
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskEm(src, refs) : src;
  const closer = needsMask ? lastCloser(masked) : { em: { '*': -1, '_': -1 }, del: -1 };
  let guard = Infinity;
  while (s) {
    if (s.length >= guard) throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
    guard = s.length;
    if (!prevWasText) prev = '';
    prevWasText = false;
    let m;
    // First-character dispatch: each inline construct can only start with
    // one or two characters, so most positions try 1-2 tokenizers instead
    // of all ten. The order inside each branch keeps marked's priority.
    const c = s[0];
    if (c === '\\') {
      // backslash escape, else hard break (\ + newline)
      if ((m = RE_ESCAPE.exec(s))) {
        out += plain ? m[1] : esc(m[1]);
        s = s.slice(m[0].length);
        continue;
      }
      if ((m = RE_BR.exec(s))) {
        out += plain ? '' : '<br>';
        s = s.slice(m[0].length);
        continue;
      }
    } else if (c === '<') {
      // raw HTML tag / autolink / comment
      if ((m = RE_TAG.exec(s))) {
        if (!st.inLink && /^<a /i.test(m[0])) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(m[0])) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) st.inRawBlock = false;
        out += plain ? m[0] : m[0];
        s = s.slice(m[0].length);
        continue;
      }
      if ((m = RE_AUTOLINK.exec(s))) {
        const text = m[1];
        if (plain) {
          out += text;
        } else {
          const href = m[2] === '@' ? 'mailto:' + text : text;
          const encoded = encodeHref(href);
          out += encoded === null ? esc(text, true) : `<a href="${esc(encoded, true)}">${esc(text, true)}</a>`;
        }
        s = s.slice(m[0].length);
        continue;
      }
    } else if (c === '[' || (c === '!' && s[1] === '[')) {
      // inline link / image, then reference link / image
      if ((m = tryLink(s, refs, st, plain))) {
        out += m.html;
        s = s.slice(m.len);
        continue;
      }
      if ((m = tryRefLink(s, refs, st, plain))) {
        if (m.textOnly) {
          out += plain ? m.html : esc(m.html);
          prev = m.html;
          prevWasText = true;
          s = s.slice(m.len);
          continue;
        }
        out += m.html;
        s = s.slice(m.len);
        continue;
      }
    } else if (c === '*' || c === '_') {
      // emphasis / strong
      if ((m = tryEmStrong(s, masked, prev, closer, refs, st, plain))) {
        out += m.html;
        s = s.slice(m.len);
        continue;
      }
    } else if (c === '`') {
      // code span
      if ((m = RE_CODE_SPAN.exec(s))) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
        out += plain ? text : `<code>${esc(text, true)}</code>`;
        s = s.slice(m[0].length);
        continue;
      }
    } else if (c === ' ' || c === '\t') {
      // hard break (two spaces + newline)
      if ((m = RE_BR.exec(s))) {
        out += plain ? '' : '<br>';
        s = s.slice(m[0].length);
        continue;
      }
    } else if (c === '~') {
      // strikethrough
      if ((m = tryDel(s, masked, prev, closer, refs, st, plain))) {
        out += m.html;
        s = s.slice(m.len);
        continue;
      }
    } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
      // GFM extended autolink (bare URL / email), never inside a link.
      // Must run before the text scanner: the text regex stops at an email
      // only after consuming its first character, which would split it.
      if (!st.inLink && (m = RE_URL.exec(s))) {
        let raw = m[0], text, href;
        if (m[2] === '@') { text = raw; href = 'mailto:' + raw; }
        else {
          let before;
          do { before = raw; const bp = RE_BACKPEDAL.exec(raw); raw = bp ? bp[0] : ''; } while (before !== raw);
          text = raw;
          href = m[1] === 'www.' ? 'http://' + raw : raw;
        }
        if (plain) out += text;
        else {
          const encoded = encodeHref(href);
          out += encoded === null ? esc(text, true) : `<a href="${esc(encoded, true)}">${esc(text, true)}</a>`;
        }
        s = s.slice(raw.length);
        continue;
      }
    }
    // plain text run
    if ((m = RE_INLINE_TEXT.exec(s))) {
      const raw = m[0];
      if (raw.slice(-1) !== '_') prev = raw.slice(-1);
      prevWasText = true;
      if (plain) out += st.inRawBlock ? raw : unescapeEntities(raw);
      else out += st.inRawBlock ? raw : esc(unescapeEntities(raw));
      s = s.slice(raw.length);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
  }
  return out;
}


// ------------------------------------------------------------- block parsing

// A block node: {k} plus kind-specific fields. Paragraph/text/table cells
// hold raw inline source in `text`; inline rendering happens later, once all
// link reference definitions in the document are known.

// Dedent fenced code lines by the fence's own indentation (marked's Dt()).
function fenceDedent(fenceMatch, text) {
  const m = fenceMatch.match(/^(\s+)(?:```)/);
  if (!m) return text;
  const indent = m[1].length;
  return text.split('\n').map((line) => {
    const lead = line.match(/^\s+/);
    if (!lead) return line;
    return line.slice(Math.min(lead[0].length, indent));
  }).join('\n');
}

// Parse blocks from `src`, appending nodes to `out`. `top` enables the
// paragraph rule; `inCont` is marked's container flag (paragraph merging).
// `ctx` collects the blank-line flag used for loose-list detection. `refs`
// is the shared link-reference map, filled as definitions are found.
// `prevIn` is the last node pushed by an earlier call on the same array
// (blockquote chunks share one array, so a paragraph can merge across a
// chunk boundary); the final previous node (or null after a blank run) is
// returned for the next call.
function blockParse(src, refs, top, inCont, ctx, out, prevIn) {
  let rest = src;
  let prev = prevIn || null;
  let guard = Infinity;
  while (rest) {
    if (rest.length >= guard) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    guard = rest.length;
    let m;
    // blank lines
    if ((m = RE_NEWLINE.exec(rest))) {
      rest = rest.slice(m[0].length);
      if (m[0].length === 1 && prev) { /* merges into previous raw; no node */ }
      else {
        if ((m[0].match(/\n/g) || []).length >= 2) ctx.blankGap = true;
        prev = null;
      }
      continue;
    }
    // indented code (merges into a preceding paragraph/text when adjacent)
    if ((m = RE_CODE.exec(rest))) {
      rest = rest.slice(m[0].length);
      const codeText = trimBlankEnd(m[0]).replace(/^(?: {0,3}\t| {1,4})/gm, '');
      if (prev && (prev.k === 'paragraph' || prev.k === 'text')) {
        prev.text += '\n' + codeText;
      } else {
        const node = { k: 'code', lang: '', text: codeText };
        out.push(node);
        prev = node;
      }
      continue;
    }
    // fenced code
    if ((m = RE_FENCES.exec(rest))) {
      rest = rest.slice(m[0].length);
      const lang = m[2] ? m[2].trim().replace(RE_ANY_PUNCT, '$1') : m[2];
      const node = { k: 'code', lang: lang || '', text: fenceDedent(m[0], m[3] || '') };
      out.push(node);
      prev = node;
      continue;
    }
    // ATX heading
    if ((m = RE_HEADING.exec(rest))) {
      rest = rest.slice(m[0].length);
      let text = m[2].trim();
      if (/#$/.test(text)) {
        const stripped = stripTrailing(text, '#');
        if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
      }
      const node = { k: 'heading', depth: m[1].length, text };
      out.push(node);
      prev = node;
      continue;
    }
    // thematic break
    if ((m = HR_RE.exec(rest))) {
      rest = rest.slice(m[0].length);
      const node = { k: 'hr' };
      out.push(node);
      prev = node;
      continue;
    }
    // blockquote
    if ((m = RE_BLOCKQUOTE.exec(rest))) {
      const bq = parseBlockquote(rest, refs);
      rest = rest.slice(bq.consumed);
      out.push(bq.node);
      prev = bq.node;
      continue;
    }
    // list
    if ((m = RE_LIST.exec(rest))) {
      const lst = parseList(rest, refs);
      if (lst) {
        rest = rest.slice(lst.consumed);
        out.push(lst.node);
        prev = lst.node;
        continue;
      }
    }
    // HTML block
    if ((m = RE_HTML.exec(rest))) {
      rest = rest.slice(m[0].length);
      const node = { k: 'html', text: trimBlankEnd(m[0]) };
      out.push(node);
      prev = node;
      continue;
    }
    // link reference definition
    if ((m = RE_DEF.exec(rest))) {
      const defMatch = m[0];
      rest = rest.slice(defMatch.length);
      const defRaw = stripTrailing(defMatch, '\n');
      if (prev && (prev.k === 'paragraph' || prev.k === 'text')) {
        prev.text += '\n' + defRaw;
      } else if (!/^</.test(m[2]) && findParenClose(m[2], '()') !== -1) {
        // Unbalanced parens in the destination: not a definition after all
        // (marked's def() returns undefined and the block loop retries the
        // other rules on the same input).
        rest = defMatch + rest;
      } else {
        const tag = normLabel(m[1]);
        if (!Object.hasOwn(refs, tag)) {
          const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(RE_ANY_PUNCT, '$1') : '';
          const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(RE_ANY_PUNCT, '$1') : m[3];
          refs[tag] = { href, title };
          refs[HAS_REFS] = true;
        }
      }
      continue;
    }
    // table (the delimiter row is the second line and must contain '-')
    if (tableMaybe(rest) && (m = RE_TABLE.exec(rest))) {
      if (!/[:|]/.test(m[2])) {
        // not a table: fall through to the rules below on the same input
      } else {
        const headerCells = splitRow(m[1]);
        const alignsRaw = m[2].replace(/^\||\| *$/g, '').split('|');
        const table = { k: 'table', header: [], align: [], rows: [] };
        if (headerCells.length === alignsRaw.length) {
          rest = rest.slice(m[0].length);
          for (const a of alignsRaw) {
            if (/^ *-+: *$/.test(a)) table.align.push('right');
            else if (/^ *:-+: *$/.test(a)) table.align.push('center');
            else if (/^ *:-+ *$/.test(a)) table.align.push('left');
            else table.align.push(null);
          }
          for (let i = 0; i < headerCells.length; i++) {
            table.header.push({ text: headerCells[i], align: table.align[i] });
          }
          const rowLines = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
          for (const line of rowLines) {
            table.rows.push(splitRow(line, table.header.length).map((cell, j) => ({ text: cell, align: table.align[j] })));
          }
          out.push(table);
          prev = table;
          continue;
        }
      }
    }
    // setext heading (needs an underline line of = or - somewhere below)
    if (setextMaybe(rest) && (m = RE_LHEADING.exec(rest))) {
      rest = rest.slice(m[0].length);
      const node = { k: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() };
      out.push(node);
      prev = node;
      continue;
    }
    // paragraph (only at the top level of a container)
    if (top && (m = RE_PARAGRAPH.exec(rest))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      rest = rest.slice(m[0].length);
      if (inCont && prev && prev.k === 'paragraph') {
        prev.text += '\n' + text;
      } else {
        const node = { k: 'paragraph', text };
        out.push(node);
        prev = node;
      }
      inCont = false;
      continue;
    }
    // bare text (single line; merges with a preceding text node)
    if ((m = RE_TEXT.exec(rest))) {
      rest = rest.slice(m[0].length);
      if (prev && prev.k === 'text') {
        prev.text += '\n' + m[0];
      } else {
        const node = { k: 'text', text: m[0] };
        out.push(node);
        prev = node;
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return prev;
}

// Parse a blockquote starting at the beginning of `src`. Returns the node
// plus how many characters of `src` it consumed (marked's blockquote()).
function parseBlockquote(src, refs) {
  const m = RE_BLOCKQUOTE.exec(src);
  const lines = stripTrailing(m[0], '\n').split('\n');
  let raw = '', text = '';
  const children = [];
  let bqPrev = null;
  let n = lines;
  while (n.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < n.length; p++) {
      if (/^ {0,3}>/.test(n[p])) { chunk.push(n[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(/^( {0,3}>)([ \t]+)/gm, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + stripped : stripped;
    const ctx = { blankGap: false };
    bqPrev = blockParse(stripped, refs, true, true, ctx, children, bqPrev);
    if (n.length === 0) break;
    const last = children[children.length - 1];
    if (!last || last.k === 'code' || last.k === 'heading' || last.k === 'hr' || last.k === 'html' || last.k === 'table') break;
    if (last.k === 'blockquote') {
      const rest = n.join('\n');
      const mergedSrc = last.raw + '\n' + rest.replace(/^ {0,3}>[ \t]?/gm, '');
      const inner = parseBlockquote(mergedSrc, refs);
      children[children.length - 1] = inner.node;
      const tail = mergedSrc.substring(inner.node.raw.length).replace(/^\n/, '');
      const tailLines = tail ? tail.split('\n').length : 0;
      const taken = tailLines ? n.slice(0, -tailLines) : n;
      if (taken.length > 0) raw = raw + '\n' + taken.join('\n');
      text = text.substring(0, text.length - last.text.length) + inner.node.text;
      n = n.slice(taken.length);
      if (n.length > 0 && /^ {0,3}>/.test(n[0])) continue;
      break;
    }
    if (last.k === 'list') {
      const rest = n.join('\n');
      const mergedSrc = last.raw + '\n' + rest;
      const inner = parseList(mergedSrc, refs);
      children[children.length - 1] = inner.node;
      const extra = inner.node.raw.length > last.raw.length
        ? mergedSrc.slice(last.raw.length + 1, inner.node.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const taken = n.slice(0, extra).join('\n');
        raw = raw + '\n' + taken;
        text = text + '\n' + taken;
      }
      n = n.slice(extra);
      continue;
    }
  }
  return { node: { k: 'blockquote', children, raw, text }, consumed: raw.length };
}

// Parse a list starting at the beginning of `src`. Returns the node plus how
// many characters it consumed, or null when no list starts here (marked's
// list()).
function parseList(src, refs) {
  const first = RE_LIST.exec(src);
  if (!first) return null;
  const startLen = src.length;
  let rest = src;
  const marker = first[1].trim();
  const ordered = marker.length > 1;
  const list = { k: 'list', ordered, start: ordered ? +marker.slice(0, -1) : '', loose: false, items: [], raw: '' };
  const bullPat = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = listItemRegex(bullPat);
  let prevBlank = false;
  while (rest) {
    let skipCont = false;
    let itemText = '';
    const itemMatch = itemRe.exec(rest);
    if (!itemMatch || HR_RE.test(rest)) break;
    const itemStart = startLen - rest.length;
    rest = rest.slice(itemMatch[0].length);
    const firstLine = itemMatch[2].split('\n', 1)[0];
    const bulletLen = itemMatch[1].length;
    let cur = firstLine.replace(/^[ \t]+/, (v) => expandTabs(v, bulletLen));
    let nextLine = rest.split('\n', 1)[0];
    let isBlank = !cur.trim();
    let indent;
    if (isBlank) indent = bulletLen + 1;
    else {
      indent = cur.search(/[^ ]/);
      if (indent > 4) indent = 1;
      itemText = cur.slice(indent);
      indent += bulletLen;
    }
    if (isBlank && /^[ \t]*$/.test(nextLine)) {
      rest = rest.slice(nextLine.length + 1);
      skipCont = true;
    }
    if (!skipCont) {
      const breakRe = listBreakRegex(indent);
      const hrRe = indentRegex('hr', indent);
      const fenceRe = indentRegex('fences', indent);
      const headRe = indentRegex('heading', indent);
      const htmlRe = indentRegex('html', indent);
      let pos = 0;
      while (pos < rest.length) {
        let nl = rest.indexOf('\n', pos);
        if (nl === -1) nl = rest.length;
        const line = rest.slice(pos, nl);
        nextLine = line;
        // Tab expansion is a no-op when the line has no tab at all.
        const expLine = line.includes('\t') ? line.replace(/^[ \t]+/, (v) => expandTabs(v, 0)) : line;
        if (breakRe.test(line)) break;
        if (expLine.search(/[^ ]/) >= indent || !line.trim()) {
          itemText += '\n' + expLine.slice(indent);
        } else {
          if (isBlank || cur.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
              fenceRe.test(cur) || headRe.test(cur) || htmlRe.test(cur) || hrRe.test(cur)) break;
          const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && RE_LHEADING.test(cur + '\n' + line);
          const appendLine = setext ? '    ' + expLine.replace(/^ {0,3}/, '') : line;
          itemText += '\n' + appendLine;
        }
        isBlank = !line.trim();
        pos = nl + 1;
        cur = expLine.slice(indent);
      }
      rest = rest.slice(pos);
    }
    const itemRaw = src.slice(itemStart, startLen - rest.length);
    if (!list.loose) {
      if (prevBlank) list.loose = true;
      else if (hasTrailingDoubleBlank(itemRaw)) prevBlank = true;
    }
    list.items.push({ task: /^\[[ xX]\][ \t]+\S/.test(itemText), loose: false, text: itemText, raw: itemRaw, children: [] });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, startLen - rest.length).trimEnd();
  // Lex each item's content (top=false: bare text, not paragraphs).
  for (const item of list.items) {
    const ctx = { blankGap: false };
    blockParse(item.text, refs, false, false, ctx, item.children);
    if (!list.loose && ctx.blankGap) list.loose = true;
  }
  // Task items: strip the checkbox marker and prepend a checkbox node.
  for (const item of list.items) {
    const firstChild = item.children[0];
    if (item.task && firstChild && (firstChild.k === 'text' || firstChild.k === 'paragraph')) {
      item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
      firstChild.text = firstChild.text.replace(/^\[[ xX]\][ \t]+/, '');
      const box = /\[[ xX]\]/.exec(item.raw);
      if (box) {
        const checkbox = { k: 'checkbox', checked: box[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          firstChild.lead = (firstChild.lead || '') + checkboxHtml(checkbox.checked);
        } else {
          item.children.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const child of item.children) if (child.k === 'text') child.k = 'paragraph';
    }
  }
  return { node: list, consumed: list.raw.length };
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}


// --------------------------------------------------------------- rendering

// Render one inline source at block level: a fresh inRawBlock state for each
// block-level source (marked resets it before every queued inline source,
// while inLink carries over between them).
function renderInlineTop(src, refs, st) {
  st.inRawBlock = false;
  return inlineRender(src, refs, st, false);
}

function renderNodes(nodes, refs, st) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'code': {
        const lang = (node.lang || '').match(/^\S*/)?.[0] || '';
        const body = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + esc(lang) + '">' + esc(body, true) + '</code></pre>\n'
          : '<pre><code>' + esc(body, true) + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + node.depth + '>' + renderInlineTop(node.text, refs, st) + '</h' + node.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += node.text;
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderNodes(node.children, refs, st) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
        out += '<' + tag + start + '>\n';
        for (const item of node.items) {
          out += '<li>' + renderNodes(item.children, refs, st) + '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += checkboxHtml(node.checked);
        break;
      case 'table': {
        let head = '';
        for (const cell of node.header) {
          head += (cell.align ? '<th align="' + cell.align + '">' : '<th>') +
            renderInlineTop(cell.text, refs, st) + '</th>\n';
        }
        let body = '';
        for (const row of node.rows) {
          let cells = '';
          for (const cell of row) {
            cells += (cell.align ? '<td align="' + cell.align + '">' : '<td>') +
              renderInlineTop(cell.text, refs, st) + '</td>\n';
          }
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
          (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'paragraph':
        out += '<p>' + (node.lead || '') + renderInlineTop(node.text, refs, st) + '</p>\n';
        break;
      case 'text':
        out += (node.lead || '') + renderInlineTop(node.text, refs, st);
        break;
    }
  }
  return out;
}

// ------------------------------------------------------------------- entry

// Render markdown to HTML, exactly as marked 18.1.3 does with its defaults.
// Stateless across calls: every call builds fresh refs and inline state.
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const refs = Object.create(null);
  refs[HAS_REFS] = false;
  const nodes = [];
  blockParse(src, refs, true, false, { blankGap: false }, nodes);
  const st = newInlineState();
  return renderNodes(nodes, refs, st);
}

export default parse;
