# Worldsmith

Speak (or type) a prompt inside VR and an LLM builds or edits the world around you.
The model outputs **pure A-Frame markup** (no JavaScript, no CSS). The client sanitizes it
with a whitelist, injects it into the scene and animates it in.

Live (static) build: <https://ronnqvist.github.io/VR-worldsmith/>

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 (desktop; localhost counts as a secure context)
npm test             # unit tests (node:test)
npm run build        # static site in dist/
npm run preview      # serve dist/ locally
```

Testing on a Quest from your LAN needs HTTPS (WebXR requires a secure context):

```bash
npm run dev:https    # self-signed cert; open https://<your-ip>:5173 and accept the warning
```

## OpenRouter key

1. Create an account at <https://openrouter.ai>, add a little credit, and create a key at
   <https://openrouter.ai/keys> (it looks like `sk-or-v1-...`).
2. Paste it in **Menu → Settings** on the 2D page, or in the in-VR wrist panel (Settings → Key).
3. Press **Validate key**. It checks the key and sends a tiny request to the selected model.

The key is stored only in `localStorage` and is sent only to `openrouter.ai`.
Presets: **Claude Sonnet 5.5** (default) and **Grok 4.7**. You can type any other OpenRouter model id;
[docs/model-selection.md](docs/model-selection.md) lists researched candidates worth trying.

**Reasoning effort** (Settings): the dropdown shows only the levels the selected model supports, plus
*Auto* (medium for both presets) and *Provider default*. Higher effort usually gives richer worlds but a
longer wait. `npm run check:models` re-checks the presets against the live OpenRouter catalogue.

## Controls

| Input | Action |
|---|---|
| Left trigger (hold) / mic button (2D page) | Talk (release to send) |
| Orb on the left controller | Status light (red = listening, purple = thinking, green = speaking); point the laser at it and pull the trigger to toggle listening |
| Left X | Open the VR keyboard |
| Left Y | Show/hide the wrist panel |
| Left stick / WASD | Move |
| Right stick / Q, E | 45° snap turn |
| Right trigger | Click UI, grab `.interactive` objects |
| Right stick Y while holding | Push/pull the object |
| Grip while holding | Delete it (3 s undo toast) |
| Right B | Close panels |

Wrist panel: Listen, Keyboard, Settings, History (last 20), Worlds, Undo, Export, Import, Reset, MR/VR toggle.
The 2D page mirrors all of this and works with mouse and keyboard only.

## Devices

- **Meta Quest 2 / 3 / Pro**: open the site in Meta Quest Browser and press **Enter VR**.
  Targets 72 fps: ≤ 200 entities, ≤ 8 dynamic lights, low-poly defaults, no shadows, pixel ratio capped at 1.5.
- **Mixed reality** (`immersive-ar`): the **Enter MR** button only appears when the browser reports support.
  Sky, ground and fog are suppressed. Quest 2 passthrough is **grayscale**; Quest 3/Pro have color.
  Switching VR ⇄ MR inside a session may ask for one extra tap.
- **Voice**: Meta Quest Browser has no `SpeechRecognition`, so Worldsmith records the mic itself
  (16 kHz WAV, max 30 s) and transcribes the clip with an audio-capable OpenRouter model
  (default `google/gemini-3.1-flash-lite`, roughly $0.0002 per 10 s clip, reasoning off), then sends the text as your prompt.
  The audio goes to that model's provider via OpenRouter. Browsers that do have working
  `SpeechRecognition` (desktop Chrome/Edge) use it instead. You can force either in
  **Settings → Voice engine**, or pick **Input: Keyboard** to always use the in-VR keyboard.
  **Tip:** press the mic button once on the 2D page before entering VR, so the microphone permission
  prompt is answered outside the headset view.
  Narration uses `speechSynthesis` when available, otherwise a floating caption.
- **Desktop**: plain Chrome/Edge works with mouse look; a headset also works.

## How it works

```
speech | VR keyboard | text box
  → src/llm/envelope.js      builds messages (system prompt + current world + recent prompts)
  → src/llm/openrouter.js    POST /chat/completions, response_format json_object, one retry on 429/5xx
  → parseEnvelope            { action, markup, removed_ids, narration }
  → src/world/sanitize.js    whitelist sanitizer (reject or clamp)
  → src/world/injector.js    merge by id into <a-entity id="generated-world">, transitions, undo
```

### Sanitizer (src/world/sanitize.js)

Parses into an inert document and rebuilds a fresh tree from whitelisted tags/attributes/component
properties only. **Whole response rejected** (world kept) on: `script/style/link/iframe/img/svg…`, any `on*`
attribute, `javascript:`/`data:`/`url()` or network URLs in any value, `src`/`gltf-model`/`obj-model`,
`sound.src` other than `#generated-ambient`, texture/font references, `isRawProperty`, camera/cursor/link components.
**Clamped or dropped with a warning**: unknown tags/attributes, positions beyond ±100 m, scale > 50, oversized
geometry or segment counts, more than 200 entities or 8 lights, duplicate/reserved ids. The production
build also ships a Content-Security-Policy limiting network access to the site itself and `openrouter.ai`.

### Files

`index.html` scene shell · `src/main.js` boot + pipeline · `src/xr/` session, locomotion, grab ·
`src/world/` sanitizer, injector, dream swirl · `src/llm/` OpenRouter client, envelope, **editable system prompt**
(`systemPrompt.js`) · `src/voice/` speech, VR keyboard, TTS · `src/ui/` canvas VR panels and 2D DOM UI ·
`src/storage/` async `StorageProvider` (swap point for a future backend such as Convex), store, export/import ·
`src/audio/ambient.js` procedural ambient loop (the only audio LLM markup may reference).

## Persistence

`localStorage` holds the key, settings, current world, history and named worlds. **Export** downloads a
`.worldsmith.json` (settings without the key, saved worlds, history); **Import** validates the schema,
re-sanitizes every world and lets you merge or replace. In VR, Import leaves the immersive session because
browsers cannot show a file picker inside it.

> localStorage is shared by every page on `ronnqvist.github.io`. Other projects hosted there can read
> the saved key. Use a restricted, low-limit OpenRouter key, or host this on its own (sub)domain.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs on every push to `main` (or the current dev branch): tests, build,
then force-pushes `dist/` to the **`gh-pages`** branch. Pages serves that branch
(**Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` / `(root)`**).

The build uses relative paths, so it works under `/VR-worldsmith/` without configuration.

## Not in v1

Plane detection, anchors and hit-test for MR placement. The extension point is documented at the top of
`src/xr/session.js`.

## Diagnostics

Settings → Diagnostics shows FPS, draw calls, entity count and a log; a low-FPS warning appears in VR.
