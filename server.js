const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Tokenizer ────────────────────────────────────────────────────────────────

const T = {
  COMMENT: 'comment', STRING: 'string', LONGSTR: 'longstr',
  NUMBER: 'number',   IDENT: 'ident',   KEYWORD: 'keyword',
  WS: 'ws',          OTHER: 'other'
};

const KW = new Set([
  'and','break','do','else','elseif','end','false','for',
  'function','if','in','local','nil','not','or','repeat',
  'return','then','true','until','while','continue'
]);

// Returns long-bracket level if src[i] starts [=*[, else -1
function longLevel(src, i) {
  if (src[i] !== '[') return -1;
  let j = i + 1, lvl = 0;
  while (j < src.length && src[j] === '=') { lvl++; j++; }
  return src[j] === '[' ? lvl : -1;
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    // ── Comment
    if (src[i] === '-' && src[i+1] === '-') {
      const lvl = longLevel(src, i + 2);
      if (lvl >= 0) {
        const close = ']' + '='.repeat(lvl) + ']';
        const end = src.indexOf(close, i + 4 + lvl);
        if (end !== -1) {
          toks.push({ type: T.COMMENT, value: src.slice(i, end + close.length) });
          i = end + close.length; continue;
        }
      }
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      toks.push({ type: T.COMMENT, value: src.slice(i, j) });
      i = j; continue;
    }

    // ── Long string
    const ls = longLevel(src, i);
    if (ls >= 0) {
      const close = ']' + '='.repeat(ls) + ']';
      const end = src.indexOf(close, i + 2 + ls);
      if (end !== -1) {
        toks.push({ type: T.LONGSTR, value: src.slice(i, end + close.length) });
        i = end + close.length; continue;
      }
    }

    // ── Quoted string
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i]; let j = i + 1;
      while (j < n && src[j] !== q && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      toks.push({ type: T.STRING, value: src.slice(i, j + 1) });
      i = j + 1; continue;
    }

    // ── Whitespace
    if (/\s/.test(src[i])) {
      let j = i;
      while (j < n && /\s/.test(src[j])) j++;
      toks.push({ type: T.WS, value: src.slice(i, j) });
      i = j; continue;
    }

    // ── Number
    if (/[0-9]/.test(src[i]) || (src[i] === '.' && /[0-9]/.test(src[i+1] || ''))) {
      let j = i;
      if (src[j] === '0' && /[xX]/.test(src[j+1] || '')) {
        j += 2;
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === '.') { j++; while (j < n && /[0-9_]/.test(src[j])) j++; }
        if (/[eE]/.test(src[j] || '')) {
          j++; if (/[+-]/.test(src[j] || '')) j++;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
      }
      toks.push({ type: T.NUMBER, value: src.slice(i, j) });
      i = j; continue;
    }

    // ── Identifier / keyword
    if (/[a-zA-Z_]/.test(src[i])) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      toks.push({ type: KW.has(w) ? T.KEYWORD : T.IDENT, value: w });
      i = j; continue;
    }

    toks.push({ type: T.OTHER, value: src[i++] });
  }
  return toks;
}

// ─── Obfuscation Engine ───────────────────────────────────────────────────────

// Generate confusing l/I variable names: ll, lI, Il, II, lll, llI, ...
function makeVarGen() {
  const names = [];
  for (let len = 2; len <= 7; len++) {
    for (let i = 0; i < Math.pow(2, len); i++) {
      let s = '';
      for (let b = len - 1; b >= 0; b--) s += (i >> b) & 1 ? 'I' : 'l';
      names.push(s);
    }
  }
  let idx = 0;
  return () => names[idx] !== undefined ? names[idx++] : `_obf${idx++}`;
}

// Parse a quoted Lua string token → byte array
function parseStringBytes(token) {
  const str = token.value;
  if (str.length < 2) return [];
  const inner = str.slice(1, str.length - 1);
  const bytes = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] !== '\\') { bytes.push(inner.charCodeAt(i++) & 0xff); continue; }
    i++;
    const c = inner[i];
    const ESC = { n:10, t:9, r:13, a:7, b:8, f:12, v:11, '\\':92, '"':34, "'":39, '0':0 };
    if (ESC[c] !== undefined) { bytes.push(ESC[c]); i++; }
    else if (c === 'x') { bytes.push(parseInt(inner.slice(i+1, i+3), 16) & 0xff); i += 3; }
    else if (c === 'z') { i++; while (i < inner.length && /\s/.test(inner[i])) i++; }
    else if (/[0-9]/.test(c)) {
      let d = '';
      while (i < inner.length && /[0-9]/.test(inner[i]) && d.length < 3) d += inner[i++];
      bytes.push(parseInt(d) & 0xff);
    } else { bytes.push(inner.charCodeAt(i++) & 0xff); }
  }
  return bytes;
}

function obfuscateLuau(source) {
  const toks = tokenize(source);
  const varGen = makeVarGen();
  const renamed = new Map();   // originalName → obfName
  const SAFE_SKIP = new Set(['_','self']); // never rename these

  // ── Pass 1: collect all `local` variable names ────────────────────────────
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== T.KEYWORD || toks[i].value !== 'local') continue;

    let j = i + 1;
    // skip ws
    while (j < toks.length && toks[j].type === T.WS) j++;

    // local function <name>
    if (toks[j]?.type === T.KEYWORD && toks[j].value === 'function') {
      j++; while (j < toks.length && toks[j].type === T.WS) j++;
      if (toks[j]?.type === T.IDENT && !SAFE_SKIP.has(toks[j].value) && !renamed.has(toks[j].value))
        renamed.set(toks[j].value, varGen());
      continue;
    }

    // local a, b, c [= ...]
    while (j < toks.length) {
      if (toks[j].type === T.IDENT && !SAFE_SKIP.has(toks[j].value) && !renamed.has(toks[j].value))
        renamed.set(toks[j].value, varGen());
      j++;
      while (j < toks.length && toks[j].type === T.WS) j++;
      if (toks[j]?.type === T.OTHER && toks[j].value === ',') { j++; continue; }
      break;
    }
  }

  // ── Pass 2: emit transformed code ─────────────────────────────────────────
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    // Drop comments
    if (t.type === T.COMMENT) continue;

    // Collapse whitespace
    if (t.type === T.WS) {
      out.push(t.value.includes('\n') ? '\n' : ' ');
      continue;
    }

    // Encode quoted strings → string.char(...)
    if (t.type === T.STRING) {
      try {
        const bytes = parseStringBytes(t);
        out.push(bytes.length ? `(string.char(${bytes.join(',')}))` : `""`);
      } catch { out.push(t.value); }
      continue;
    }

    // Long strings: keep as-is (rare, complex to encode safely)
    if (t.type === T.LONGSTR) { out.push(t.value); continue; }

    // Rename local identifiers
    if (t.type === T.IDENT && renamed.has(t.value)) {
      out.push(renamed.get(t.value));
      continue;
    }

    out.push(t.value);
  }

  return out.join('');
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/obfuscate', (req, res) => {
  try {
    const { source } = req.body;
    if (!source || typeof source !== 'string')
      return res.status(400).json({ error: 'Missing source code' });
    if (source.length > 500_000)
      return res.status(413).json({ error: 'Source too large (max 500KB)' });

    const result = obfuscateLuau(source);
    const pct = ((result.length / source.length - 1) * 100).toFixed(1);

    res.json({
      result,
      stats: {
        originalSize: source.length,
        obfuscatedSize: result.length,
        ratio: (pct >= 0 ? '+' : '') + pct + '%'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`OBF running on :${PORT}`));
