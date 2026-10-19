const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Obfuscation Engine ───────────────────────────────────────────────────────

function obfuscateLuau(source) {
  const bytes = Buffer.from(source, 'utf8');

  // Split into chunks of 40 bytes → string.char(...)
  const CHUNK = 40;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = Array.from(bytes.slice(i, i + CHUNK));
    parts.push(`string.char(${slice.join(',')})`);
  }

  // Build the concatenated string expression
  const strExpr = parts.join('..');

  // Wrap with variable name obfuscation
  const varNames = generateVarNames(6);

  const output = [
    `-- // OBF by luau-obf`,
    `local ${varNames[0]} = load`,
    `local ${varNames[1]} = string.char`,
    `local ${varNames[2]} = ${strExpr.replace(/string\.char/g, varNames[1])}`,
    `${varNames[0]}(${varNames[2]})()`
  ].join('\n');

  return output;
}

function generateVarNames(count) {
  // Unicode-looking but valid Luau identifiers
  const pool = [
    'lI', 'Il', 'II', 'lIl', 'IlI', 'lII', 'IIl', 'IllI',
    'lIIl', 'IlIl', 'llI', 'Ill', 'IIll', 'lIlI', 'lllI'
  ];
  // Shuffle deterministically based on length
  const shuffled = [...pool].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/obfuscate', (req, res) => {
  try {
    const { source } = req.body;
    if (!source || typeof source !== 'string') {
      return res.status(400).json({ error: 'Missing source code' });
    }
    if (source.length > 500_000) {
      return res.status(413).json({ error: 'Source too large (max 500KB)' });
    }

    const result = obfuscateLuau(source);
    const ratio = ((1 - source.length / result.length) * -100).toFixed(1);

    res.json({
      result,
      stats: {
        originalSize: source.length,
        obfuscatedSize: result.length,
        ratio: `+${Math.abs(ratio)}%`
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`OBF running on :${PORT}`));
