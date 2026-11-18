/**
 * End-to-end checks against a built site with OpenRouter mocked.
 *   npm run build && npx vite preview --port 4173 &   then   npm run test:e2e
 * Requires Playwright + Chromium (not a project dependency; see README).
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE_URL || 'http://localhost:4173/';
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })).newPage();
  const pageErrors = [];
  const external = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const origin = new URL(BASE).origin;
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !/^(blob:|data:)/.test(u) && !u.startsWith('https://openrouter.ai')) external.push(u);
  });

  let mode = 'ok';
  let attempts = 0;
  const envelopes = {
    create: { action: 'create_world', markup: '<a-sky id="sky" color="#223"></a-sky><a-box id="cube" class="interactive" position="0 1 -3" color="red"/><a-sphere id="ball" position="2 1 -3"/>', removed_ids: [], narration: 'Created.' },
    update: { action: 'update_world', markup: '<a-box id="cube" color="green" position="0 2 -3"></a-box>', removed_ids: ['ball'], narration: 'Updated.' },
    evil: { action: 'update_world', markup: '<a-box id="x" onclick="alert(1)"></a-box>', removed_ids: [], narration: 'x' }
  };
  await page.route('https://openrouter.ai/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/key')) return route.fulfill({ json: { data: { label: 'e2e', limit_remaining: 1 } } });
    attempts++;
    if (mode === '401') return route.fulfill({ status: 401, json: { error: { message: 'No auth' } } });
    if (mode === '429-once' && attempts === 1) return route.fulfill({ status: 429, headers: { 'retry-after': '0' }, json: {} });
    if (mode === 'malformed') return route.fulfill({ json: { choices: [{ message: { content: 'sorry, no JSON here' }, finish_reason: 'stop' }] } });
    const env = envelopes[mode.startsWith('env:') ? mode.slice(4) : 'create'];
    return route.fulfill({ json: { model: 'm', choices: [{ message: { content: JSON.stringify(env) }, finish_reason: 'stop' }] } });
  });

  await page.goto(BASE);
  await page.waitForFunction(() => window.worldsmith, null, { timeout: 30000 });
  const ws = (fn, arg) => page.evaluate(fn, arg);
  const ids = () => ws(() => window.worldsmith.injector.topLevelIds());
  const submit = (p) => ws((t) => window.worldsmith.app.submitPrompt(t), p);
  await ws(() => window.worldsmith.app.setApiKey('sk-or-v1-e2e-e2e-e2e-e2e'));

  await check('boots with no loading screen and A-Frame default UI removed', async () => {
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#ws-loading').count(), 0);
    assert.equal(await page.locator('.a-enter-vr').count(), 0);
  });

  await check('sanitizer rejects attack markup', async () => {
    const cases = ['<script>1</script>', '<a-box id="a" onclick="x"></a-box>', '<a-entity id="a" gltf-model="https://e/x.glb"></a-entity>',
      '<a-entity id="a" sound="src: https://e/a.mp3"></a-entity>', '<a-box id="a" material="src: url(https://e/t.png)"></a-box>',
      '<img src=x onerror=alert(1)>', '<svg></svg>', '<a-entity id="a" camera></a-entity>', '<a-box id="a" animation="property: scale; isRawProperty: true"></a-box>'];
    const res = await ws((c) => c.map((m) => { try { window.worldsmith.sanitizeMarkup(m); return 'accepted'; } catch { return 'rejected'; } }), cases);
    assert.deepEqual(res, cases.map(() => 'rejected'));
  });

  await check('sanitizer clamps, de-duplicates and keeps self-closing siblings flat', async () => {
    const r = await ws(() => window.worldsmith.sanitizeMarkup('<a-box id="d" position="999 0 0" scale="500"/><a-box id="d"/>'));
    assert.match(r.markup, /position="100 0 0"/);
    assert.match(r.markup, /scale="50 50 50"/);
    assert.deepEqual(r.topIds, ['d', 'd-2']);
  });

  await check('entity budget capped at 200', async () => {
    const r = await ws(() => window.worldsmith.sanitizeMarkup(Array.from({ length: 300 }, (_, i) => `<a-box id="b${i}"></a-box>`).join('')));
    assert.equal(r.stats.entities, 200);
  });

  await check('create → update (merge by id, removal) → undo', async () => {
    mode = 'env:create';
    assert.equal(await submit('make a world'), true);
    assert.deepEqual(await ids(), ['sky', 'cube', 'ball']);
    mode = 'env:update';
    assert.equal(await submit('change things'), true);
    assert.deepEqual(await ids(), ['sky', 'cube']);
    assert.equal(await ws(() => document.getElementById('cube').getAttribute('material').color), 'green');
    await ws(() => window.worldsmith.app.undo());
    assert.deepEqual(await ids(), ['sky', 'cube', 'ball']);
  });

  await check('hostile response is rejected and world kept', async () => {
    mode = 'env:evil';
    assert.equal(await submit('evil'), false);
    assert.deepEqual(await ids(), ['sky', 'cube', 'ball']);
    assert.match(await page.locator('#ws-caption').textContent(), /rejected for safety/);
  });

  await check('401 shows key error and keeps world', async () => {
    mode = '401';
    assert.equal(await submit('anything'), false);
    assert.match(await page.locator('#ws-caption').textContent(), /rejected your key/);
    assert.deepEqual(await ids(), ['sky', 'cube', 'ball']);
  });

  await check('429 is retried once then succeeds', async () => {
    mode = '429-once';
    attempts = 0;
    assert.equal(await submit('retry me'), true);
    assert.equal(attempts, 2);
  });

  await check('malformed JSON keeps world and reports', async () => {
    mode = 'malformed';
    assert.equal(await submit('garbage'), false);
    assert.match(await page.locator('#ws-caption').textContent(), /not valid JSON/);
  });

  await check('grab-delete shows undo toast and undo restores', async () => {
    await ws(() => window.worldsmith.bus.emit('world:delete', { id: 'cube' }));
    assert.ok(!(await ids()).includes('cube'));
    await page.locator('.ws-toast button', { hasText: 'Undo' }).click();
    assert.ok((await ids()).includes('cube'));
  });

  await check('world, key and history persist across reload', async () => {
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForFunction(() => window.worldsmith, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    assert.deepEqual(await ids(), ['sky', 'cube', 'ball']);
    assert.equal(await ws(() => window.worldsmith.app.state.hasKey), true);
    assert.ok((await ws(() => window.worldsmith.app.state.history.length)) >= 2);
  });

  await check('validate key reports success', async () => {
    assert.match(await ws(() => window.worldsmith.app.validateKey()), /Key valid/);
  });

  await check('export excludes API key; import merge and replace work', async () => {
    await ws(() => window.worldsmith.app.saveWorld('Alpha'));
    const [dl] = await Promise.all([page.waitForEvent('download'), ws(() => window.worldsmith.app.exportData())]);
    const text = require('node:fs').readFileSync(await dl.path(), 'utf8');
    assert.ok(!text.includes('e2e-e2e'));
    assert.match(dl.suggestedFilename(), /\.worldsmith\.json$/);
    const obj = JSON.parse(text);
    assert.equal(obj.savedWorlds[0].name, 'Alpha');
    const preview = await ws(async (o) => window.worldsmith.app.previewImport(new File([JSON.stringify(o)], 'x.json')), obj);
    assert.equal(preview.ok, true);
    await ws((p) => window.worldsmith.app.commitImport(p, 'merge'), preview);
    assert.equal(await ws(() => window.worldsmith.app.state.worlds.length), 1); // identical content deduped
    await ws((p) => window.worldsmith.app.commitImport(p, 'replace'), preview);
    assert.equal(await ws(() => window.worldsmith.app.state.worlds.length), 1);
    const bad = await ws(async () => window.worldsmith.app.previewImport(new File(['{"format":"nope"}'], 'x.json')));
    assert.equal(bad.ok, false);
  });

  await check('MR mode hides generated sky', async () => {
    await ws(() => { window.worldsmith.injector.setMode('ar'); });
    await page.waitForTimeout(200);
    assert.equal(await ws(() => document.getElementById('sky').getAttribute('visible')), false);
    await ws(() => { window.worldsmith.injector.setMode('vr'); });
  });

  await check('no external requests and no uncaught page errors', async () => {
    assert.deepEqual(external, []);
    assert.deepEqual(pageErrors, []);
  });

  await page.screenshot({ path: process.env.SHOT || 'e2e.png' });
  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall e2e checks passed');
  process.exit(failures ? 1 : 0);
})();
