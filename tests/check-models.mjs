/**
 * Checks the presets against the live OpenRouter catalogue:
 *   npm run check:models
 * Verifies each id exists, supports JSON mode (world models) or audio input (STT
 * models), and that the hard-coded reasoning levels in src/llm/models.js still match.
 */
import { MODEL_PRESETS, STT_MODEL_PRESETS } from '../src/core/config.js';
import { KNOWN_CAPS, capsFromCatalogue } from '../src/llm/models.js';

const res = await fetch('https://openrouter.ai/api/v1/models');
const byId = Object.fromEntries((await res.json()).data.map((m) => [m.id, m]));
let problems = 0;
const report = (ok, msg) => { if (!ok) problems++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

for (const [kind, list] of [['world', MODEL_PRESETS], ['stt', STT_MODEL_PRESETS]]) {
  for (const { id } of list) {
    const m = byId[id];
    if (!m) { report(false, `${id}: not in catalogue`); continue; }
    if (m.expiration_date) report(false, `${id}: expires ${m.expiration_date}`);
    if (kind === 'world') report(m.supported_parameters?.includes('response_format'), `${id}: response_format`);
    else report(m.architecture?.input_modalities?.includes('audio'), `${id}: audio input`);
    const live = capsFromCatalogue(m);
    const known = KNOWN_CAPS[id];
    if (known) {
      const same = JSON.stringify(live.efforts) === JSON.stringify(known.efforts) && live.mandatory === known.mandatory;
      report(same, `${id}: reasoning levels ${same ? 'match' : `changed → ${live.efforts.join(',') || 'none'} (mandatory ${live.mandatory})`}`);
    }
  }
}
process.exit(problems ? 1 : 0);
