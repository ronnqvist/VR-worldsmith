import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio, cleanTranscript } from '../src/llm/openrouter.js';
import { downsample, toBase64, TARGET_RATE } from '../src/voice/recorder.js';
import { encodeWav } from '../src/audio/ambient.js';
import { normalizeSettings } from '../src/storage/store.js';
import { DEFAULT_STT_MODEL } from '../src/core/config.js';

const mock = (content, calls, status = 200) => async (url, init) => {
  calls.push({ url, init });
  return new Response(JSON.stringify(status === 200 ? { model: 'm', choices: [{ message: { content }, finish_reason: 'stop' }] } : { error: { message: 'audio not supported' } }), { status });
};

test('transcribeAudio sends a wav input_audio part to chat completions', async () => {
  const calls = [];
  const text = await transcribeAudio({ apiKey: 'sk-or-v1-abc', model: DEFAULT_STT_MODEL, wavBase64: 'UklGRgAA', fetchImpl: mock('Make a red cube.', calls) });
  assert.equal(text, 'Make a red cube.');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-v1-abc');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, DEFAULT_STT_MODEL);
  assert.equal('response_format' in body, false);
  assert.equal(body.temperature, 0);
  const part = body.messages[1].content.find((p) => p.type === 'input_audio');
  assert.deepEqual(part.input_audio, { data: 'UklGRgAA', format: 'wav' });
});

test('transcribeAudio maps unsupported-model errors and requires a key', async () => {
  await assert.rejects(transcribeAudio({ apiKey: 'k', model: 'x/text-only', wavBase64: 'A', fetchImpl: mock('', [], 400) }), /could not process audio/);
  await assert.rejects(transcribeAudio({ apiKey: '', model: 'm', wavBase64: 'A' }), /API key/);
});

test('cleanTranscript strips wrappers and no-speech markers', () => {
  assert.equal(cleanTranscript('"Add some birds."'), 'Add some birds.');
  assert.equal(cleanTranscript('Transcript: make it night'), 'make it night');
  assert.equal(cleanTranscript('```\nhello\n```'), 'hello');
  assert.equal(cleanTranscript('(no speech)'), '');
  assert.equal(cleanTranscript('[inaudible]'), '');
  assert.equal(cleanTranscript(''), '');
});

test('downsample 48k → 16k keeps duration and interpolates', () => {
  const input = new Float32Array(48000).map((_, i) => Math.sin(i / 50));
  const out = downsample(input, 48000, TARGET_RATE);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[100] - input[300]) < 1e-6);
  assert.equal(downsample(input, 16000, 16000), input);
});

test('WAV clip encodes to base64 starting with RIFF header', () => {
  const b64 = toBase64(encodeWav(new Float32Array(1600), TARGET_RATE));
  assert.ok(b64.startsWith('UklGR'));
  const bytes = Buffer.from(b64, 'base64');
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.length, 44 + 3200);
});

test('voice settings are normalised', () => {
  const d = normalizeSettings({});
  assert.equal(d.voiceEngine, 'auto');
  assert.equal(d.sttModel, DEFAULT_STT_MODEL);
  const s = normalizeSettings({ voiceEngine: 'telepathy', sttModel: 'bad id with spaces' });
  assert.equal(s.voiceEngine, 'auto');
  assert.equal(s.sttModel, DEFAULT_STT_MODEL);
  assert.equal(normalizeSettings({ voiceEngine: 'openrouter', sttModel: '~google/gemini-flash-latest' }).sttModel, '~google/gemini-flash-latest');
});
