# Liquid Studio

Liquid Studio is a designer workspace for little interactive React tools on a
living projector page. Every component uses the same liquid-glass UI kit, with
Outfit typography and locally served KaTeX mathematical fonts.

## Start designing

Run these commands from the Hubble repository root:

```bash
npm install
npm run dev:studio
```

- Workspace: **http://localhost:5173/studio**
- Control-free projector page: **http://localhost:5173/studio/projector**
- Standalone API: **http://localhost:8787/api/studio**

The wave laboratory, focus timer and room-atmosphere palette load immediately.
Examples, their controls and the source editor work without API keys. Start the
timer, change the wave sliders, or add another example from **Start with a sketch**.
The room-atmosphere example is a mock lighting palette: it has no physical-light
or IoT hooks.

`dev:studio` starts `apps/server/studioServer.ts` and Vite's studio-only entry.
This lets design work proceed without loading the
brain/room modules of the full app. The regular backend in `apps/server/index.ts` also mounts the same
studio API; the standalone entry shares its configuration and session API.
Use one backend at a time on port 8787. Vite automatically rewrites the two
studio paths in studio development mode and proxies `/api` to that backend.

## Ask Hubble for a component

For text generation, set `HUBBLE_LLM_API_KEY` in the root `.env` and restart the
studio. The server reads the same provider/model configuration as the main server:

| Setting | Default / purpose |
|---|---|
| `HUBBLE_LLM_API_KEY` | Direct server-side model credential; needed for generation |
| `HUBBLE_LLM_BASE_URL` | `https://llm.aiqu.ai/v1` |
| `HUBBLE_LLM_MODEL` | `aixia-labs` |

Describe an interactive tool in the composer, then press Enter or the generate
arrow. Shift+Enter adds a newline. For example: “Make an interactive Pythagorean
theorem explorer with sliders and a diagram.” The stop button cancels generation.
Select a component's **Refine with Hubble** control to send its current source
with the next instruction; clear that selection to create something new.

This uses a new code-generation prompt from `contract.ts`, not Julius's
restricted catalog-JSX brain or its layout-verification/repair loop. The server
requests complete TSX, compiles it, and publishes the component document to both
pages over server-sent events. A compilation failure leaves the previous working
document intact; a runtime error is reported on the affected component.

### Hubble's voice (output only)

#### Puppet master (2026-10-07)

Studio and `/hubble` now use one local **Vercel AI SDK `ToolLoopAgent`** for
conversation and canvas operations. Type to the same agent (there is no speech input since 7 Oct 2026: the event is too loud); it can
inspect, add, revise, remove, clear and reset the actual demo canvas, and choose
to speak before, between or after edits. This is mounted by `mountStudio` in
both the standalone Studio backend and the full backend.

Configure the root `.env` and restart `npm run dev:studio`:

- `HUBBLE_LLM_API_KEY`: the local agent's Aiqu model credential.
- `ELEVENLABS_API_KEY`: text-to-speech access (Text to Speech, plus Voices read for the voice select). Speech to Text is not used.
- `ELEVENLABS_AGENT_ID`: optional existing Hubble agent whose **voice** is reused.
  Its hosted LLM is not called and its settings are not changed.
- `ELEVENLABS_TTS_VOICE_ID`: voice used if no existing agent id is configured.

The flow is typed text → Vercel tool loop → ElevenLabs speech.
The `say` tool is the agent's only way to talk to the person: its text is spoken
(ElevenLabs TTS, default `eleven_flash_v2_5`, override `ELEVENLABS_TTS_MODEL`) and
waits for actual playback before later tools run. Plain final model text goes
through the same path. Every typed turn requests audio (`audio: true`), so Hubble always talks when
`ELEVENLABS_API_KEY` is set; without it the turn is text only.

A turn is never interrupted: the agent runs to completion on our own
model, and a second typed turn request while one runs is refused with `409 { error: 'busy' }`.
The explicit Stop (`POST /api/puppet/sessions/:id/cancel`) is an emergency stop only.

Every `say` (and each turn start/end) is also published to
`GET /api/puppet/speech/events` (SSE, all sessions, last 5 lines replayed) for the
TV speech bubble. The TV rig that consumes it is not built yet.

With the full Julius server (not `dev:studio`) the agent also gets table tools:
`inspect_table`, `show_answer` (asks the table brain; the model never writes stage
JSX), `open_asset`, `open_web` (allow-listed hosts only), `move_surface`,
`raise_surface`, `close_surface`, `open_keyboard`, `close_keyboard`, `start_lesson`,
`stop_lesson`, `clear_table`. They go through `apps/server/puppetTable.ts`, which
reuses the routes' own validation and the operator's clear/lesson functions.

Model: any OpenAI-compatible endpoint (`HUBBLE_LLM_BASE_URL`/`MODEL`/`API_KEY`,
`HUBBLE_PUPPET_MODEL` for the puppet only). `chat_template_kwargs.thinking` is sent
only for the Aiqu URL (off) or when `HUBBLE_LLM_THINKING` is `off`/`on`.
Transcript and canvas state live in server memory; reconnecting to a new session
starts a new conversation. No live provider session has been verified without keys.

The typed `ai` tools are the extension point for MCP-backed tools; no MCP server
is configured yet.

#### Legacy hosted-agent flow

The legacy `useAssistant` hook reuses the existing ElevenLabs conversation through
`POST /api/session`. Configure `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` for
an existing provisioned agent, as well as the model key for component generation.
If an agent needs provisioning, follow the [root setup instructions](../README.md#setup)
and run `npm run setup:agent` with the required credentials.

This hosted-agent path is retained for compatibility; the Studio and Hubble
screens now use the local puppet-master path described above. The legacy
`/api/studio/generate` source endpoint also remains available to existing clients.

## Edit source and the design system

Use a component's **Edit source** control, edit its title or TSX, then choose
**Compile & update**. Source must export one default React function component.
Do not add imports or `require`: the runtime injects `React` and `UI`.

```tsx
export default function Counter() {
  const [count, setCount] = React.useState(0);
  return <UI.Stack>
    <UI.Heading>A small experiment.</UI.Heading>
    <UI.Stat label="Steps taken" value={count} />
    <UI.Button onClick={() => setCount(value => value + 1)}>One more</UI.Button>
  </UI.Stack>;
}
```

Use this as replacement source in an existing example's editor. The shared kit
provides cards, stacks, rows, text, headings, badges, buttons, sliders, tabs,
stats, progress bars, inputs and `UI.Math`. Use `UI.Math` for LaTeX and escape
backslashes in JavaScript strings, for example `tex={'x^2 + y^2 = r^2'}`.
Use native SVG/canvas for custom diagrams and the shared color variables rather
than unrelated panel/control styling. Effects must clean up timers and listeners.
Components run in script-only sandboxed frames; network requests and external
assets are outside the component contract.

The editable design-system sources are:

| Source | Design responsibility |
|---|---|
| `apps/web/src/studio/liquid.css` | Shared tokens, Outfit weights, glass, control and equation treatments |
| `apps/web/src/studio/kit.tsx` | Reusable React controls and KaTeX rendering |
| `apps/web/src/studio/contract.ts` | UI API supplied to the model; keep it aligned with kit changes |
| `apps/web/src/studio/examples.ts` | Complete editable example TSX |
| `apps/web/src/studio/studio.css` | Workspace and projector layout |

Start visual changes with `--liquid-ink`, `--liquid-muted`, `--liquid-accent`,
`--liquid-line` and `--liquid-glass` in `liquid.css`. Outfit is the shared UI
face; mathematics retains KaTeX's proper mathematical glyphs, with coordinated
color, size and equation-panel treatment. These fonts and the frame runtime are
served locally. Restart the API after kit/style changes so its cached frame
runtime bundle is rebuilt, then reload the pages.

## Lifecycle and persistence

- Adding a component preserves existing components' state in each open page.
- Revising/recompiling a component resets that component's state. Removing it
  unmounts it; the other components keep running.
- The surface holds **up to 12 components**, including examples.
- The workspace and projector share documents, not live hook state. Each page
  runs its own timers, sliders and other interaction state.
- Documents live in server-process memory only. Refreshing a page reloads those
  documents but resets that page's React state. Restarting the API discards edits,
  additions and removals and restores the three examples. There is no disk persistence.

## Build and verify

```bash
npx vitest run apps/server/studio.test.ts
npm run build:studio
```

The focused server suite passed **36 tests** on 2026-10-06. It covers compiled
examples, allowed exports, import/invalid-source rejection, document mutations,
configured model requests, sanitized failures, stale-generation conflicts and
the duplicate-mount state-preservation regression.
Its model responses are synthetic; it does not prove live model, voice or browser
behavior.

With `npm run dev:studio` already running, run the real-browser smoke in a second
terminal from the repository root:

```bash
node scripts/studio-browser-smoke.mjs
```

The smoke expects the three seeded examples, temporarily adds/edits/removes an
example, and checks that the original documents are restored. Set `STUDIO_URL`
if the web server is at a different address. The final stable rerun passed **12 real
browser checks**: initial rendering, a ticking timer, slider-driven SVG changes,
add preserving iframe identity/timer/slider state, source revision, invalid-source
rejection, projector document mirroring, removal, error-free runtime and cleanup.
Both workspace and projector had no horizontal overflow at desktop (1440px) and
mobile (390px) widths. The inputs are bundled examples and mechanical source
edits; live generation and voice are not exercised.

An intermediate rerun failed on a timer reset after adding a component while
edits/HMR overlapped the run. The final rerun, with no edits active, passed all
12 checks again; HMR is a suspected explanation, not a confirmed cause.

`build:studio` emits `apps/web/dist/studio.html` and frontend assets. Production
hosting must rewrite `/studio` and `/studio/projector` to that file while
preserving the requested browser path, and proxy `/api` to a running studio API.
A static build alone does not supply documents, generation, sessions or the
component-frame runtime. The development rewrites/proxy are automatic; production
hosting must provide them.

`npm run build:studio` passed (101 modules, about 4 seconds). Strict focused
TypeScript checking passed for `apps/server/studio.ts`,
`apps/server/studioServer.ts`, `apps/web/src/studio/studioMain.tsx`,
`apps/web/src/studio/frameRuntime.tsx` and `apps/web/vite.config.ts`.
The final focused server suite passed all 36 tests.
Live model generation and voice were not run because no credentials were
available. Room-simulator projection was not tested because the Docker daemon
was stopped; physical projection was not tested either. See the
[plan](plans/2026-10-06-liquid-studio.md) for recorded results.

Full `npm run -s typecheck` was attempted and failed on missing `@hubble/brain`
and `@hubble/room` modules, plus pre-existing stage/stage-react missing exports
and the swipe integration mismatch. The focused Studio strict TypeScript check
and build passed; the full repository typecheck did not. Repository-wide checks
are `npx vitest run` and `npm run -s typecheck`.
