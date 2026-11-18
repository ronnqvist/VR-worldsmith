import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, validateImport, combineImport, exportFilename } from '../src/storage/exportImport.js';

const settings = { model: 'deepseek/deepseek-v4-flash', apiKey: 'sk-or-v1-secret', ttsMuted: true };

test('export never contains the API key', () => {
  const ex = buildExport({ settings, savedWorlds: [{ name: 'A', markup: '<a-box id="a"></a-box>' }], history: [{ prompt: 'hi', at: 1 }] });
  assert.equal(JSON.stringify(ex).includes('secret'), false);
  assert.equal(ex.format, 'worldsmith');
  assert.equal(ex.savedWorlds.length, 1);
  assert.match(exportFilename(new Date(2026, 0, 2, 3, 4)), /^worlds-20260102-0304\.worldsmith\.json$/);
});

test('roundtrip validates', () => {
  const ex = JSON.parse(JSON.stringify(buildExport({ settings, savedWorlds: [{ name: 'A', markup: '<a-box id="a"></a-box>' }] })));
  const res = validateImport(ex);
  assert.equal(res.ok, true);
  assert.equal(res.data.savedWorlds[0].name, 'A');
});

test('schema errors', () => {
  assert.equal(validateImport(null).ok, false);
  assert.equal(validateImport({ format: 'other', version: 1 }).ok, false);
  assert.equal(validateImport({ format: 'worldsmith', version: 99 }).ok, false);
  assert.equal(validateImport({ format: 'worldsmith', version: 1, savedWorlds: {} }).ok, false);
});

test('imported apiKey ignored, bad worlds skipped by sanitize', () => {
  const res = validateImport({
    format: 'worldsmith', version: 1, settings: { apiKey: 'sk-or-v1-x', ttsMuted: true },
    savedWorlds: [{ name: 'Good', markup: 'ok' }, { name: 'Evil', markup: '<script>' }, { markup: 'noname' }]
  }, { sanitize: (m) => { if (m.includes('<script')) { const e = new Error('x'); e.reason = 'forbidden <script>'; throw e; } return m; } });
  assert.equal(res.ok, true);
  assert.equal('apiKey' in res.data.settings, false);
  assert.deepEqual(res.data.savedWorlds.map((w) => w.name), ['Good']);
  assert.ok(res.warnings.some((w) => /Evil/.test(w)));
  assert.ok(res.warnings.some((w) => /API key/.test(w)));
});

test('merge renames clashes, dedupes identical, merges history; replace overwrites', () => {
  const current = {
    settings: { a: 1 }, currentWorld: null,
    savedWorlds: [{ name: 'A', markup: 'x' }, { name: 'B', markup: 'y' }],
    history: [{ prompt: 'one', at: 1 }, { prompt: 'three', at: 3 }]
  };
  const incoming = {
    settings: { a: 2 }, currentWorld: { markup: 'z', fog: null },
    savedWorlds: [{ name: 'A', markup: 'x' }, { name: 'B', markup: 'different' }, { name: 'C', markup: 'c' }],
    history: [{ prompt: 'two', at: 2 }, { prompt: 'one', at: 1 }]
  };
  const m = combineImport(current, incoming, 'merge');
  assert.deepEqual(m.savedWorlds.map((w) => w.name), ['A', 'B', 'B (2)', 'C']);
  assert.deepEqual(m.history.map((h) => h.prompt), ['one', 'two', 'three']);
  assert.deepEqual(m.settings, { a: 1 });
  const r = combineImport(current, incoming, 'replace');
  assert.deepEqual(r.settings, { a: 2 });
  assert.equal(r.savedWorlds.length, 3);
  assert.deepEqual(r.currentWorld, { markup: 'z', fog: null });
});
