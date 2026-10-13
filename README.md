# Hubble

A smart-lamp projector that turns an ordinary table into an AI workspace: ask a question and the answer is projected onto the table in front of you.

Built at the CAIS × Aixia Innovation Day hackathon (7 Oct 2026, Svenska Mässan, Gothenburg).

## How it works

**Spatial sensing.** A top-down room camera and a lidar watch the table. Each is mapped into one table coordinate frame in millimetres (`apps/server/spatial`). Projected ArUco markers (`js-aruco2`) and a dot calibration tie the camera to the projector. The lidar learns the empty table as a baseline, so a finger shows up as a cluster that is tracked into a touch. MediaPipe tracks hands in the browser, from the room camera or from an iPad on a stand, for pinch typing. A Python/OpenCV sidecar (`apps/keybed`) finds the MiniLab's 25 keys in the camera image.

**Projection.** The projector's Pi shows the `/table` page. Answers are laid out around what is already on the table (the iPad, the keyboard) at real size. Maths is drawn in pen-written style with KaTeX, and graphs are plotted. The same runtime puts surfaces on the table: a projected keyboard, web pages, assets and drawings.

**Agent layer.** The model never draws. It writes restricted JSX against a fixed catalog (`packages/stage`). The brain (`packages/brain`) drafts an answer, parses it, measures the layout, and repairs problems with small find/replace edits (up to three rounds) before any of it reaches the table. A puppet-master agent (`apps/server/puppetMaster.ts`, Vercel AI SDK, any OpenAI-compatible model) drives the table through tools. Its only way to talk is a `say` tool.

**Voice and keyboard input.** People type: on the operator page, on a keyboard projected onto the table (swipe or pinch), or by playing the physical MiniLab, which is read over Web MIDI. In the keyboard act, the projector lights the next note of a song, flashes a wrong key red and moves on when the right note is played. Hubble answers out loud: `say` goes to ElevenLabs text-to-speech and appears as a speech bubble beside a WebGL orb on the room's TVs. There is no speech input.

### Repository layout

| Path | What |
|---|---|
| `packages/stage` | the contract: catalog, streaming parser, prompt, scene, layout report, surfaces, swipe keyboard |
| `packages/stage-react` | the renderer: director, StageView, surfaces, pen-written maths |
| `packages/brain` | the model layer: draft → verify → `edit_answer` repairs |
| `packages/room` | the hardware: one `Room` interface, slots, lights, lidar, camera, calibration |
| `apps/server` | the API, runtime, puppet master, spatial engine |
| `apps/web` | every page (operator, `/table`, `/tv`, `/studio`, `/spatial`, …) |
| `apps/keybed` | Python/OpenCV sidecar that finds the keyboard's keys in the camera |
| `apps/worksheet` | the iPad worksheet server |
| `apps/room-emulator` | an emulator of the room's device API, for working offline |

## Setup and run

```bash
npm install
pip install -r apps/keybed/requirements.txt   # Python 3 + OpenCV for the keybed sidecar
npm run hands:assets     # optional: serve MediaPipe from this machine instead of a CDN
cp .env.example .env     # fill in HUBBLE_LLM_API_KEY (any OpenAI-compatible endpoint)
npm run dev              # server :8787, web :5173, keybed :8792
```

Nothing is required to boot. Without the LLM key, `/api/render` answers 503 and everything else works.

Without the room's hardware, run against the emulator: set `ROOM=emulator` in `.env` and run `npm run dev:emulator` alongside `npm run dev`.

### Environment (`.env`, gitignored; `.env.example` explains each)

| Variable | What |
|---|---|
| `HUBBLE_LLM_API_KEY` | the model key: the brain's model calls for table answers |
| `HUBBLE_LLM_BASE_URL`, `HUBBLE_LLM_MODEL` | any OpenAI-compatible gateway, and the default model for requests that name none: the projected keyboard's SEND and the follow-ups. The bench always names its own model (its picker) |
| `TYPESAFE_API_KEY` | optional: Jev placement scoring in verify (needs internet; 2.5 s per call, and a repair is scored again, so one answer can cost several calls) |
| `HUBBLE_WEB_ALLOW` | optional: comma-separated hostnames web surfaces may open, replacing the default (`*`: any public site; local and private addresses are always refused) |
| `PORT` | server port (8787) |
| `WORKSHEET_PORT` | the iPad worksheet server's internal port (8793, loopback). The iPad opens `:5173/worksheet/` |
| `ROOM` | `none` (default), `emulator`, `live`, `legacy` |
| `ROOM_URL`, `ROOM_TOKEN`, `ROOM_TEAM`, `PUBLIC_BASE`, `KEYBED_URL` | room wiring; leave unset for defaults (an empty value is not the default) |
| `ELEVENLABS_API_KEY` | optional: Hubble's spoken voice (text-to-speech) for the puppet master. Without it Hubble answers in text only |
| `HUBBLE_PUPPET_MODEL`, `HUBBLE_LLM_THINKING` | optional: a model for the puppet master only; `off`/`on` sends the `thinking` template field |

The repository holds no keys or tokens: secrets live only in `.env`, which is gitignored.

## Team

| | GitHub | LinkedIn |
|---|---|---|
| Julius Olsson | [@Juliusolsson05](https://github.com/Juliusolsson05) | [julius-olsson](https://www.linkedin.com/in/julius-olsson-5432b3269/) |
| Truls Borgvall | [@truls27a](https://github.com/truls27a) | [truls-borgvall](https://www.linkedin.com/in/truls-borgvall-752355273/) |
| Alexander Wahlström | [@Al-ex-W](https://github.com/Al-ex-W) | [alexander-e-wahlstrom](https://www.linkedin.com/in/alexander-e-wahlstrom) |

## Feedback for Aixia

- **What worked:** we got a working demo together in the room: spatial sensing, projection, an agent, voice and keyboard. The room and the mentors were available when we needed them.
- **Test bench time:** we would have liked more time on the real hardware. Most of the work happened against simulators and short time slots.
- **Hardware:** some of it didn't fully come through. The headset was never resolved and the depth sensor/lidar was swapped during the event.
- **Pitch format:** clearer instructions on the format, ahead of time, would help.
- **Attendance:** fewer of the decision-makers we expected came by, so there were fewer chances to show the demo to them.

## Reference

### Pages: open only :5173

People and the room's devices open one port, **:5173**. Everything else is internal, behind the web app's proxy.

| Page | Who opens it | What |
|---|---|---|
| `/` | the operator, on the laptop | the one control screen: chat, a to-scale table simulator, and the **show** column (acts, reset, recorded fallback answers, the iPad worksheet, the virtual MiniLab); hand, room and debug panels underneath |
| `/table` | the projector's Pi | the bare projector page |
| `/worksheet/` | the iPad | the worksheet task, read-only (`apps/web/worksheetProxy.ts`) |
| `/ipad-camera` | an iPad on a stand, over **https** | the iPad as a second camera: hands and reference markers detected on the iPad (#91) |
| `/operator` | nobody now | redirects to `/` |

| Port | Who listens | Reached by |
|---|---|---|
| 5173 | the web app (Vite), **http and https on the same port** (`apps/web/tls.ts`) | people and the room's devices |
| 8787 | the server | Vite's `/api` proxy |
| 8792 | the keybed sidecar (127.0.0.1) | the server |
| 8793 | the worksheet server (127.0.0.1, only when its box is ticked) | Vite's read-only `/worksheet` proxy and the server |
| 8790 | the room emulator (development) | the server and Vite's `/emulator` proxy |

Anything else that listens (an agent's isolated preview, a lab such as `apps/keybed/lab.py` on :8799) is a temporary tool.

### iPad worksheet (the math act's task)

The room camera can't read a paper worksheet well enough, so the task is
shown on an iPad (A16) lying on the table instead, and Hubble is told
its exact text.

1. Open **http://localhost:5173** and, in the **show** column on the right,
   tick **host the worksheet for the iPad**. The server starts `apps/worksheet` and shows the address to
   open: `http://<laptop LAN IP>:5173/worksheet/`.
2. Open that address in Safari on the iPad. It must be on the same network as
   the laptop. Venue Wi-Fi that isolates clients won't work; use the laptop's
   hotspot instead.
3. Pick the task and the text size in the show column. The iPad follows
   live.
4. Lay the iPad on its spot: portrait, left edge 30 cm in from the table's
   left, centred front to back (`apps/server/ipadPlacement.ts`). Every answer
   is laid out beside it.

The iPad page draws a true 10 cm ruler. Hold a real ruler against it to
check the size. **project the 10 cm check ruler** lights a matching one
beside the iPad, to check the projector's scale.

### iPad camera and reference points (#91)

The room camera reaches us at 2–5 fps over the shared Wi-Fi. An iPad on a
stand runs the hand tracker and the marker detector itself and sends only
landmarks and marker corners.

**Once per iPad: trust the laptop's certificate.** Safari only grants the
camera over https, and it refuses an untrusted certificate outright.
1. On the laptop, `npm run dev`. The web log prints
   `[tls] https on the same port: https://<laptop IP>:5173/ipad-camera`. The
   certificate's CA is made in `~/Library/Application Support/Hubble/tls/`
   (Linux: `~/.config/hubble/tls/`; `HUBBLE_TLS_DIR` overrides), never in the
   repo, where Vite could serve its private key. It lives 30 days and only
   signs for private IPs, `localhost` and `*.local`; keep it until then (the
   iPad trusts that one). The server certificate is re-made at every start
   for the laptop's current IPs.
2. On the iPad, in **Safari** (not Chrome; only Safari, Mail or AirDrop may
   install a profile), open `http://<laptop IP>:5173/hubble-ca.crt` → Allow.
3. Settings → General → VPN & Device Management → "Hubble local CA" → Install.
4. Settings → General → About → Certificate Trust Settings → turn on full
   trust for "Hubble local CA".

**Each time:**
1. Mount the iPad on its stand, rear camera looking down at the table, the
   whole table (or at least the projected area) in view. Plug it in, and set
   Auto-Lock to Never if it is older than iPadOS 16.4 (no Wake Lock).
2. Open `https://<laptop IP>:5173/ipad-camera` → **start camera** → allow the
   camera. The status line shows fps, hands and markers seen.
3. On the laptop, press **reference points** (Show: beside the room arm;
   Setup: under "camera ↔ projector"). It needs the room output armed on the
   real room: it projects 12 markers for ~12 s. The iPad page shows
   "map: rms … installed" once its map is in. Pinch typing can then be
   started from the iPad page itself (**pinch typing**) or from the bench.
4. Printed markers (optional, for localization without projecting): open
   **print the table markers** in Setup, print at 100 % (60 mm squares), cut
   with their white margin, and tape one near each table edge, OUTSIDE the
   projected grid's markers. Run **reference points** once with them in view
   of a camera: their positions are learned (`.hubble/anchors.json`) and from
   then on any camera localizes from them continuously.

The dot calibration (**calibrate**) stays the room camera's fallback.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | server + web + keybed sidecar together |
| `npm start` | the server alone, without watch |
| `npm test` | the whole monorepo's tests (vitest) |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run demo:smoke` | both demo acts end to end on the room emulator, offline, ~3 s; must pass before every merge |
| `npm run os:smoke` | the projection OS from a recorded hand to the table, offline; must pass before every merge |
| `npm run build` | production web build |
| `npm run dev:emulator` | the room emulator (the room spec) on :8790 |
| `npm run room:check`, `npm run room:record` | probe and record a room over the spec client |
| `npm run record:stage`, `npm run census:stage` | record real model streams; count their shapes |
| `npm run hands:assets` | copy MediaPipe's wasm and model to `apps/web/public/mediapipe/` |
| `npm run -s hubble -- <cmd>` | the `hubble` CLI: drive every demo on the running server (below) |

### The `hubble` CLI

`scripts/hubble-cli/index.ts` is a thin client of the **running** server's HTTP API, so people and agents can drive every demo from a shell. It never opens a device: the server's pool, the hardware window and arming
stay the server's. `HUBBLE_URL` picks the server (default `http://localhost:8787`).

```sh
npm run -s hubble -- help                 # every command, generated from the one command table
npm run -s hubble -- status --pretty      # health, operator, spatial summary, devices, hardware window
npm run -s hubble -- ask "what is 3x+2=11?"
npm run -s hubble -- act lesson ode-to-joy
npm run -s hubble -- keyboard open && npm run -s hubble -- keyboard type "hello" && npm run -s hubble -- keyboard send
npm run -s hubble -- events --follow --seconds 10
npm run -s hubble -- raw GET /api/runtime
```

Output is JSON on stdout (`--pretty` for people). An HTTP error exits non-zero and prints the server's error text on
stderr. Commands marked `[room]` in help (and `arm on`) write to the shared room, inside the hardware window only. Streams (`events`, `spatial`, `lidar touches --follow`) run until Ctrl-C, or pass `--limit n` / `--seconds s`
so an agent's call returns.

### Verification boundary

The tests run offline, against recordings: real model streams and repair sessions, a real hand take, simulated camera frames, and the emulator. They cannot cover the real room: the projector's actual picture, the camera and lidar on site, the room's network, live MediaPipe.
