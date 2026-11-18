import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryProvider, LocalStorageProvider } from '../src/storage/localProvider.js';
import { createStore, normalizeSettings } from '../src/storage/store.js';
import { DEFAULT_SETTINGS } from '../src/core/config.js';

test('settings defaults, coercion, unknown keys dropped', async () => {
  const store = createStore(new MemoryProvider());
  assert.deepEqual(await store.getSettings(), normalizeSettings({}));
  const s = await store.saveSettings({ ttsMuted: true, temperature: 9, evil: 'x', model: 'bad model id with spaces' });
  assert.equal(s.ttsMuted, true);
  assert.equal(s.temperature, 2);
  assert.equal(s.model, DEFAULT_SETTINGS.model);
  assert.equal('evil' in s, false);
});

test('api key stored separately and trimmed; empty removes', async () => {
  const p = new MemoryProvider();
  const store = createStore(p);
  await store.setApiKey('  sk-or-v1-abc  ');
  assert.equal(await store.getApiKey(), 'sk-or-v1-abc');
  await store.setApiKey('');
  assert.equal(await store.getApiKey(), '');
  assert.equal((await store.getSettings()).apiKey, undefined);
});

test('history capped at 20 and validated', async () => {
  const store = createStore(new MemoryProvider());
  for (let i = 0; i < 25; i++) await store.addHistory({ prompt: `p${i}`, narration: 'n' });
  const h = await store.getHistory();
  assert.equal(h.length, 20);
  assert.equal(h[0].prompt, 'p5');
  await store.addHistory({ prompt: '' });
  assert.equal((await store.getHistory()).length, 20);
});

test('named worlds save/overwrite/delete', async () => {
  const store = createStore(new MemoryProvider());
  await store.saveNamedWorld('Island', { markup: '<a-box id="a"></a-box>', fog: null });
  await store.saveNamedWorld('Cave', { markup: '<a-box id="c"></a-box>', fog: null });
  await store.saveNamedWorld('Island', { markup: '<a-box id="b"></a-box>', fog: null });
  let list = await store.listWorlds();
  assert.equal(list.length, 2);
  assert.equal(list.find((w) => w.name === 'Island').markup, '<a-box id="b"></a-box>');
  list = await store.deleteNamedWorld('Cave');
  assert.deepEqual(list.map((w) => w.name), ['Island']);
});

test('LocalStorageProvider namespaces keys and survives corrupt JSON', async () => {
  const data = new Map();
  const fake = {
    getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k), key: (i) => [...data.keys()][i], get length() { return data.size; }
  };
  const p = new LocalStorageProvider({ storage: fake });
  await p.set('a', { x: 1 });
  data.set('other', '1');
  data.set('worldsmith:v1:bad', '{not json');
  assert.deepEqual(await p.get('a'), { x: 1 });
  assert.equal(await p.get('bad'), undefined);
  assert.deepEqual((await p.keys()).sort(), ['a', 'bad']);
});

test('quota errors become user-facing', async () => {
  const p = new LocalStorageProvider({ storage: { setItem() { throw new Error('QuotaExceededError'); } } });
  await assert.rejects(p.set('x', 1), /storage is full/);
});
