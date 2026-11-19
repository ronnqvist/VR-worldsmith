# Worldsmith LLM model selection

*Research snapshot: 19 November 2026. Live OpenRouter catalogue (479 models), provider docs, Artificial
Analysis, Design Arena and WebDev Arena. Prices are USD per 1M tokens on OpenRouter.*

## What shipped

| Role | Model | Why |
|---|---|---|
| World model (default) | `anthropic/claude-sonnet-5.5` | Tested by you as good. Design Arena #12 overall; ~133 tok/s |
| World model | `x-ai/grok-4.7` | Newest Grok (2026-09-21); tested by you as good. Slow (~67 tok/s) |
| Speech-to-text (default) | `google/gemini-3.1-flash-lite` | 3.4 % WER, reasoning can be off, ~$0.00016 per 10 s clip |

The other STT presets are `google/gemini-3.5-flash-lite`, `google/gemini-2.5-flash-lite`,
`mistralai/voxtral-small-24b-2507` and `openai/gpt-audio-mini`.

The rest of this document lists candidates you can try later by typing their id into
**Settings → Model id**. The reasoning-effort dropdown then loads that model's own levels from the catalogue.

## How to judge a model for this task

**Wait ≈ time to first token + output tokens ÷ tokens per second.** A typical world is 2k–10k output tokens,
often ~6k. Reasoning tokens all arrive *before* the markup and are billed as output, so they add straight to
the wait. At 6k tokens:

| Output speed | Approximate wait (excluding thinking) |
|---|---|
| ~200 tok/s | ~30 s |
| ~130 tok/s | ~45 s |
| ~65 tok/s | ~95 s |

Your test result changes the default advice. With Haiku 5.5 and DeepSeek V4.1 Flash at their default/low
effort, the quality wasn't good enough. Raising effort (medium/high) may close the gap, at the cost of a
longer wait. That makes the cheap models below *retry candidates*, not recommendations.

## Candidates to try later

### Fast and cheap (tested by you at low/default effort: not good enough; worth one retry at medium or high)
| id | $ in / out | speed | reasoning levels (catalogue) | notes |
|---|---|---|---|---|
| `anthropic/claude-haiku-5.5` | 0.10 / 0.50 | ~214 tok/s, TTFT 5.7 s @low | none, low, medium, high, xhigh, max (default medium) | Fastest frontier model; try **medium** |
| `deepseek/deepseek-v4.1-flash-1017` | 0.15 / 0.60 | 108–228 tok/s by host | none, low, high, max (default high) | Newest DeepSeek Flash; try **high** |
| `deepseek/deepseek-v4.1-flash` | 0.05 / 0.20 | up to ~272 tok/s on Together | none, low, high, max | Cheapest fast option |

The old default `deepseek/deepseek-v4-flash` is retired on DeepSeek's own API. On OpenRouter it is served
only by third-party hosts of the April weights at ~54–128 tok/s. Don't use it.

### Quality and value
| id | $ in / out | speed | reasoning levels | notes |
|---|---|---|---|---|
| `google/gemini-4-hydrogen` | 1.5 / 7.5 | ~159 tok/s, TTFT 6.4 s @low / 14 s @medium | low, medium, high, xhigh (mandatory) | Design Arena #13, just behind Sonnet 5.5. Quality drops a lot at low effort: use **medium** |
| `z-ai/glm-5.3-flash` | 0.15 / 0.50 | 150–158 tok/s (third-party hosts; first-party ~46) | low, high, max (mandatory, default **max**) | Open-weight (MIT); trained on rendered front-end quality. Always set an effort, since the default max is very slow |
| `openai/gpt-6.1-terra` | 1 / 5 | ~91 tok/s | none … max (default medium) | OpenAI's best fit; Design Arena website #32 |
| `x-ai/grok-4.3` | 1.25 / 2.5 | 118–178 tok/s | none, low, medium, high (default low) | Older but much faster Grok |
| `moonshotai/kimi-k3.1-pro` | 0.25 / 8.80 | 82–100 tok/s | none, low, high, max (default max) | Highest open-weight quality; expensive output |

### Top quality but too slow or costly for VR (fine for a "take your time" build)
| id | $ in / out | notes |
|---|---|---|
| `anthropic/claude-fable-5.2` | 8 / 40 | #1 WebDev Arena |
| `anthropic/claude-opus-5.5` | 4 / 20 | #2 WebDev Arena, ~100 tok/s |
| `openai/gpt-6.2-astra` | 8 / 40 | #3 WebDev Arena |
| `openai/gpt-6.2-sol` | 2 / 10 | ~64 tok/s |
| `google/gemini-4-neon` | 3 / 15 | ~97 tok/s, 1 day old at time of research |

### Not recommended
- `minimax/minimax-m3.1-flash`: reported high hallucination rate; weights not released.
- `qwen/qwen3.8-flash` and `xiaomi/mimo-v2.6-*`: ~30–56 tok/s on OpenRouter.
- `qwen/qwen3-coder*`: single slow provider.
- `mistralai/mistral-small-2603`: weak.
- `deepseek/deepseek-chat`: V3; 16k output cap.
- `openai/gpt-4.1-mini` and `anthropic/claude-haiku-4.5`: superseded.
- Preview-only ids such as `gemini-3.1-pro-preview`.
- `:free` models: rate limits and logging, and some lack JSON mode. Experimental only.

## Reasoning effort: how it works and what to pick

The app sends OpenRouter's `reasoning: { effort, exclude: true }`. The levels a model accepts differ:

| Model | Levels | Can switch reasoning off? |
|---|---|---|
| Sonnet 5.5 | low → max | no |
| Grok 4.7 | low → xhigh | no |
| Haiku 5.5 | none → max | yes |

Settings shows only the selected model's levels, plus **Auto** (the app's recommendation) and **Provider
default** (no parameter sent). A level the model doesn't offer is snapped to the nearest one it does.

For budget-based providers (Anthropic, Gemini 2.5, Qwen), OpenRouter turns effort into a thinking budget
taken from `max_tokens`:

| Effort | Share of `max_tokens` |
|---|---|
| minimal | ~10 % |
| low | ~20 % |
| medium | ~50 % |
| high | ~80 % |
| xhigh / max | ~95 % |

Worldsmith scales `max_tokens` up so the world JSON keeps its own budget (12k by default). For
Anthropic xhigh/max it sends an explicit thinking budget instead, within the 128k limit. If thinking still
uses up everything, the app retries once at the model's lowest level and tells you.

**Suggested effort for this task**

| Model | Suggested effort |
|---|---|
| Sonnet 5.5 | **medium** (Auto). Try high if worlds lack detail; expect a wait of about a minute |
| Grok 4.7 | **medium** (Auto). High is noticeably slower (TTFT ~36 s at high vs 13 s at low) |
| Haiku 5.5, DeepSeek V4.1 Flash, Gemini 4 Hydrogen | medium–high, if you retry them |
| All models | avoid xhigh/max in VR: waits of several minutes |

## Speech-to-text ranking (1–30 s clips)

| # | id | price | accuracy | notes |
|---|---|---|---|---|
| 1 | `google/gemini-3.1-flash-lite` | $0.50/M audio tokens | 3.4 % WER | **Default.** Reasoning off |
| 2 | `x-ai/grok-stt-2.0` | ~$0.00028 per 10 s | 2.3 % WER, very fast | Needs OpenRouter's `/audio/transcriptions` endpoint (not implemented yet) |
| 3 | `mistralai/voxtral-mini-transcribe-3-0` | ~$0.00058 per 10 s | 2.2 % WER | Same endpoint |
| 4 | `openai/whisper-large-v3-turbo` | ~$0.00003 per 10 s | 4.6 % WER | Same endpoint |
| 5 | `google/gemini-3.5-flash-lite` | $0.30/M | user-reported WER regression | Previous default |
| 6 | `google/gemini-2.5-flash-lite` | $0.30/M | 5.2 % WER | Cheapest chat-path option |
| 7 | `mistralai/voxtral-small-24b-2507` | ~$0.0001 / unit | 2.8 % WER | Chat path |
| 8 | `openai/gpt-audio-mini` | $0.60/M | not benchmarked | Chat path |

A possible upgrade is to support OpenRouter's dedicated `POST /api/v1/audio/transcriptions` endpoint (browser
CORS works). That would unlock Grok STT 2.0 and Voxtral Mini Transcribe.

## Caveats
- No paid test calls were made. Speeds are Artificial Analysis or OpenRouter p50 figures and vary by host
  and hour.
- Arena ranks are snapshots from 18–19 Nov 2026; some came from secondary reports.
- Re-check ids and levels with `npm run check:models`.

## Sources
- OpenRouter: [model catalogue](https://openrouter.ai/api/v1/models),
  [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
  [parameters](https://openrouter.ai/docs/api/reference/parameters),
  [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
  [audio input](https://openrouter.ai/docs/guides/overview/multimodal/audio),
  [speech-to-text](https://openrouter.ai/docs/guides/overview/multimodal/stt).
- xAI: [Grok 4.7 announcement](https://x.ai/news/grok-4-7), [Grok 4.7 docs](https://docs.x.ai/developers/models/grok-4.7).
- Artificial Analysis: [Grok 4.7](https://artificialanalysis.ai/models/grok-4-7),
  [Claude Haiku 5.5](https://artificialanalysis.ai/models/claude-haiku-5-5),
  [Claude Sonnet 5.5](https://artificialanalysis.ai/models/claude-sonnet-5-5),
  [Gemini 4 Hydrogen](https://artificialanalysis.ai/models/gemini-4-hydrogen),
  [GLM-5.3 Flash](https://artificialanalysis.ai/models/glm-5-3-flash),
  [speech-to-text leaderboard](https://artificialanalysis.ai/speech-to-text).
- Leaderboards: [Design Arena](https://www.designarena.ai/leaderboard/code), [WebDev Arena](https://arena.ai/leaderboard/code/webdev).
- DeepSeek: [pricing](https://api-docs.deepseek.com/quick_start/pricing), [V4.1 Flash](https://deepseek.com/en/news/deepseek-v4-1-flash/).
- Z.ai: [GLM-5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash).
- STT regression report: [Google AI forum](https://discuss.ai.google.dev/t/audio-transcription-regression-gemini-3-5-flash-lite-has-3-55x-higher-wer-than-3-1-flash-lite-on-a-french-radiology-test-dataset/180033).
