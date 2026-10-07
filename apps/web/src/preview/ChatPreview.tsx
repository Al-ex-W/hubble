import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SURFACE, type ObjectKind, type RenderRequest, type Scene, type StageEvent } from '@hubble/stage'
import { useRender, type RenderRun } from './useRender.ts'
import { TableSim, makeObject } from './TableSim.tsx'
import { useOverlays } from '../lesson/OverlayLayer.tsx'
import { OperatorPage } from '../operator/OperatorPage.tsx'
import { RoomPanel } from '../room/RoomPanel.tsx'
import { keybedFromBox, emulatorShapes } from '../lesson/simBridge.ts'
import { SwipeKeyboard } from '../swipe/SwipeKeyboard.tsx'
import { createTableKeyboardClient, keyboardAtMm } from '../swipe/tableKeyboard.ts'
import type { KeyboardSurfaceState } from '@hubble/stage/swipe'
import { BoxFrame } from '@hubble/stage-react'
import { useSurfaces } from '../table/surfaces.ts'
import { HandPanel } from '../hands/HandPanel.tsx'
import { keyboardToTable } from '../hands/calibration.ts'
import type { Pt as KbPt } from '@hubble/stage/swipe'
import './preview.css'

/**
 * The one screen on the laptop (#66): chat, table, show controls. The left
 * pane drives `POST /api/render`; the middle pane is the same StageView the
 * projector runs, so what you see here is what would land on the table; the
 * right column is the operator's controls (acts, fallbacks, the iPad
 * worksheet, the virtual MiniLab), which used to be a separate /operator
 * page. One page because the jobs are one job: the operator watches this
 * table while pressing those buttons, and two pages had already grown two
 * MiniLabs and two ways to start the keyboard act.
 */

// The synthetic notebook photos live with the engine's fixtures; Vite serves
// them because server.fs.allow includes the repo root.
// Eager URLs mean the thumbnails cost no extra request at selection time.
const NOTEBOOK_URLS = import.meta.glob('../../../../packages/stage/fixtures/notebooks/*.jpg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

interface Notebook {
  name: string
  src: string
}

interface SystemLine {
  id: number
  text: string
}

const NOTEBOOKS: Notebook[] = Object.entries(NOTEBOOK_URLS)
  .map(([path, src]) => ({ name: fileName(path), src }))
  .sort((a, b) => a.name.localeCompare(b.name))

const SUGGESTIONS: { label: string; intent: string; notebook?: string; objects?: ObjectKind[] }[] = [
  { label: 'Solve the task in my notebook', intent: 'Solve the task in my notebook', notebook: 'linear', objects: ['notebook'] },
  { label: 'Integral, step by step', intent: 'Show me how to solve the integral in my notebook', notebook: 'integral', objects: ['notebook'] },
  { label: 'Optimization problem', intent: 'Help me solve this optimization problem', notebook: 'optimize', objects: ['notebook'] },
  { label: 'Explain the Pythagorean theorem', intent: 'Explain the Pythagorean theorem', objects: [] },
]

// Where each object starts on the table, in mm from the top-left of the lit
// area: roughly where a person would put it, sitting at the front edge.
const PLACES: Record<ObjectKind, { xMm: number; yMm: number }> = {
  notebook: { xMm: 230, yMm: 300 },
  book: { xMm: 230, yMm: 300 },
  paper: { xMm: 230, yMm: 300 },
  // In front of the user, as for the lesson: the near edge of the lit area.
  keyboard: { xMm: 560, yMm: 560 },
  cup: { xMm: 1300, yMm: 640 },
  phone: { xMm: 1200, yMm: 120 },
  // The iPad worksheet (#60): the same fixed spot the server assumes when
  // nothing places it (apps/server/ipadPlacement.ts defaultIpadBox), so the
  // simulated table shows where the real iPad gets taped down. Drag it here
  // to try other spots; the server takes the bench's box over its default.
  tablet: { xMm: 300, yMm: 298 },
  other: { xMm: 700, yMm: 300 },
}
const TOGGLES: ObjectKind[] = ['notebook', 'tablet', 'keyboard', 'cup']
const BASE: Scene = { surface: DEFAULT_SURFACE, objects: [] }
const withObjects = (kinds: ObjectKind[], prev: Scene = BASE): Scene => ({
  ...prev,
  objects: kinds.map((k) => prev.objects.find((o) => o.kind === k) ?? makeObject(k, prev, PLACES[k])),
})

const MODELS = ['aixia-labs', 'aixia-code'] as const
const SPEEDS = [0.25, 0.5, 1, 2] as const

export function ChatPreview() {
  const { run, cancel, current, runs } = useRender()

  const [text, setText] = useState('')
  const [notebook, setNotebook] = useState<Notebook | null>(null)
  const [scene, setScene] = useState<Scene>(() => withObjects(['notebook']))
  const overlays = useOverlays()

  // The simulator is the room's ground truth in development: tell the lesson
  // where the MiniLab's keys are (on site the camera does this), and give the
  // emulator's lidar the same objects to see. Failures are fine: with no
  // emulator running, the bench still works.
  const keyboardBox = scene.objects.find((o) => o.kind === 'keyboard')?.box
  useEffect(() => {
    const body = keyboardBox ? { corners: keybedFromBox(keyboardBox), lowestNote: 48 } : null
    if (body) void fetch('/api/lesson/keybed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined)
  }, [keyboardBox?.x, keyboardBox?.y, keyboardBox?.w, keyboardBox?.h])
  useEffect(() => {
    void fetch('/emulator/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shapes: emulatorShapes(scene) }) }).catch(() => undefined)
  }, [scene])
  const [outlines, setOutlines] = useState(false)
  // The swipe keyboard is the runtime's surface (#29), not the bench's: it
  // is open when the surface set says so, wherever it was opened from.
  const surfaces = useSurfaces()
  const kbSurface = surfaces?.find((s) => s.kind === 'keyboard') ?? null
  const kbBox = useRef(kbSurface?.box ?? null)
  kbBox.current = kbSurface?.box ?? null
  const [handTrail, setHandTrail] = useState<KbPt[]>([])
  const [model, setModel] = useState<(typeof MODELS)[number]>('aixia-labs')
  const [thinking, setThinking] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const [system, setSystem] = useState<SystemLine[]>([])
  const [pinned, setPinned] = useState<{ renderId: string; key: string } | null>(null)
  const [tab, setTab] = useState<'agent' | 'raw' | 'events' | 'timing'>('agent')
  const [drawerOpen, setDrawerOpen] = useState(true)
  const replayCount = useRef(0)
  const logEnd = useRef<HTMLDivElement | null>(null)
  const plusLine = useRef(0)

  // A new render takes over the stage; a pinned replay is only for inspecting
  // an old run and must not shadow the live one.
  useEffect(() => {
    if (current?.renderId) setPinned(null)
  }, [current?.renderId])

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [runs.length, system.length])

  const shown = pinned ? runs.find((r) => r.renderId === pinned.renderId) ?? current : current
  const renderKey = pinned?.key ?? current?.renderId ?? 'empty'
  // A pinned (shown or replayed) run is drawn on the table it was rendered
  // for: its marks are relative to those objects, and the live scene may
  // have been rearranged since. The live answer keeps the editable scene.
  // The asset library is the server's (every render's scene carries it), so
  // the live answer is drawn on the editable table plus the run's library:
  // without it an <Asset> in a live answer drew nothing until the run was
  // pinned (review #43).
  const runAssets = shown?.scene?.assets
  const tableScene = (pinned && shown?.scene) || (runAssets ? { ...scene, assets: runAssets } : scene)
  // Moving an object while looking at an old run starts from that run's
  // table and makes it the live one again, rather than editing the past.
  const editScene = useCallback((next: Scene) => {
    setPinned(null)
    // Only what lies on the table is editable; the library stays the server's.
    setScene({ surface: next.surface, objects: next.objects })
  }, [])

  const addSystem = useCallback((line: string) => {
    setSystem((prev) => [...prev, { id: plusLine.current++, text: line }])
  }, [])

  const send = useCallback(
    // `attach` is passed explicitly by callers that choose the image in the
    // same click (suggestion chips): state set in that click is not visible to
    // this closure yet, and the request would silently go without the photo.
    async (intent: string, attach: typeof notebook = notebook, onTable: Scene = scene) => {
      const trimmed = intent.trim()
      if (!trimmed) return
      setText('')
      let image: string | undefined
      // The photo is only "seen" if a notebook is actually on the table.
      if (attach && onTable.objects.some((o) => o.kind === 'notebook')) {
        try {
          image = await toDataUrl(attach.src)
        } catch {
          addSystem(`could not read ${attach.name}`)
        }
      }
      const req: RenderRequest = { intent: trimmed, model, thinking, scene: onTable }
      if (image) req.image = image
      run(req)
    },
    [addSystem, model, notebook, run, thinking, scene],
  )

  // Mouse and hand strokes both go to the runtime's keyboard through this one
  // client. SEND comes back here and becomes the bench's own chat turn (the
  // notebook photo, the chosen model, the log and simulator).
  const sendRef = useRef(send)
  sendRef.current = send
  const tableKeyboard = useMemo(
    () =>
      createTableKeyboardClient({
        box: () => kbBox.current,
        // The keyboard is added to every render's scene by the server (the
        // runtime's box is the truth), so the bench's turn is just a turn.
        onSent: (text) => void sendRef.current(text),
        onError: (m) => addSystem(`keyboard: ${m}`),
      }),
    [addSystem],
  )
  const toggleKeyboard = (open: boolean) =>
    void fetch(open ? '/api/keyboard/open' : '/api/keyboard/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => addSystem('keyboard: server unreachable'))

  const onAction = useCallback(
    (action: string) => {
      addSystem(`tapped: ${action}`)
      if (action === 'next') void send('next')
    },
    [addSystem, send],
  )

  const suggestion = (s: (typeof SUGGESTIONS)[number]) => {
    const match = s.notebook ? NOTEBOOKS.find((n) => n.name === s.notebook) ?? null : notebook
    if (match) setNotebook(match)
    const next = s.objects ? withObjects(s.objects, scene) : scene
    setScene(next)
    void send(s.intent, match, next)
  }

  const streaming = current?.status === 'streaming'

  return (
    <div className="chat">
      <div className="chat-left">
        <div className="chat-title">
          hubble · render bench
          <small>POST /api/render · NDJSON → StageView</small>
        </div>

        <div className="chat-log">
          {runs.length === 0 && system.length === 0 ? (
            <div className="empty-hint">
              Ask for something to project on the table.
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s.label} onClick={() => suggestion(s)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {runs.map((r) => (
                <RunCard
                  key={r.renderId}
                  run={r}
                  onShow={() => setPinned({ renderId: r.renderId, key: r.renderId })}
                  onReplay={() =>
                    setPinned({ renderId: r.renderId, key: `${r.renderId}-replay-${replayCount.current++}` })
                  }
                />
              ))}
              {system.map((s) => (
                <div className="system-line" key={s.id}>
                  {s.text}
                </div>
              ))}
            </>
          )}
          <div ref={logEnd} />
        </div>

        <Composer
          text={text}
          setText={setText}
          notebook={notebook}
          setNotebook={setNotebook}
          model={model}
          setModel={setModel}
          thinking={thinking}
          setThinking={setThinking}
          speed={speed}
          setSpeed={setSpeed}
          streaming={streaming}
          onSend={() => void send(text)}
          onCancel={cancel}
          onUploadError={(msg) => addSystem(msg)}
        />
      </div>

      <div className="chat-right">
        <div className="table-pane">
          <div className="table-label">
            room table · 150 × 150 cm · projector {scene.surface.widthPx}×{scene.surface.heightPx} at{' '}
            {scene.surface.mmPerPx.toFixed(2)} mm/px
          </div>
          <div className="sim-tools">
            on the table:
            {TOGGLES.map((k) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={scene.objects.some((o) => o.kind === k)}
                  onChange={(e) => {
                    const kinds = scene.objects.map((o) => o.kind).filter((x) => x !== k)
                    setScene(withObjects(e.target.checked ? [...kinds, k] : kinds, scene))
                  }}
                />
                {k}
              </label>
            ))}
            <label>
              <input type="checkbox" checked={Boolean(kbSurface)} onChange={(e) => toggleKeyboard(e.target.checked)} />
              swipe keyboard
            </label>
            <label>
              <input type="checkbox" checked={outlines} onChange={(e) => setOutlines(e.target.checked)} />
              outlines
            </label>
            <span>drag objects to move them; the model is told where they are</span>
          </div>
          <div className="sim-area">
            <TableSim
              scene={tableScene}
              setScene={editScene}
              visuals={{ notebook: { photo: notebook?.src } }}
              events={shown?.events ?? []}
              renderKey={renderKey}
              renderId={shown?.renderId}
              speed={speed}
              onAction={onAction}
              showOutlines={outlines}
              overlays={overlays}
              // The runtime's keyboard, drawn like /table draws it, plus the
              // bench's pointer and the hand's live trail.
              keyboard={(s) => (
                <BoxFrame box={s.box} surface={tableScene.surface}>
                  <SwipeKeyboard state={s.state as KeyboardSurfaceState} onStroke={(p) => void tableKeyboard.stroke(p)} handTrail={handTrail} />
                </BoxFrame>
              )}
            />
          </div>
        </div>
        <HandPanel
          // Where the keyboard is on the table: the surface's box (the room
          // path composes the camera map with it). Before it is open, where
          // the runtime opens it: bottom-centre, 40 mm off the near edge.
          kbToTable={keyboardToTable(keyboardAtMm(kbSurface?.box ?? null, tableScene.surface), tableScene.surface.mmPerPx)}
          // A press goes straight to the runtime's keyboard (opening it if
          // needed), the same client the mouse uses.
          onPress={(points) => void tableKeyboard.stroke(points)}
          onTrail={(t) => setHandTrail((prev) => (prev.length === 0 && t.length === 0 ? prev : t))}
        />
        {/* No LessonPanel here: the show column owns the only one. Each
            LessonPanel forwards every real MIDI key to the server, so a second
            one on this page would send each press twice, and this one started
            songs by /api/lesson/start, skipping the operator's act switch. */}
        <RoomPanel />
        <DebugDrawer
          run={shown}
          tab={tab}
          setTab={setTab}
          open={drawerOpen}
          setOpen={setDrawerOpen}
        />
      </div>

      <aside className="chat-ops">
        <OperatorPage embedded />
      </aside>
    </div>
  )
}

/* ---- run card ---- */

function RunCard({ run, onShow, onReplay }: { run: RenderRun; onShow: () => void; onReplay: () => void }) {
  return (
    <div className="run-card">
      <div className="row">
        <span className={`status ${run.status}`}>{run.status}</span>
        <span className="meta">
          {run.totalMs !== null ? `${Math.round(run.totalMs)}ms` : '…'}
          {run.drops.length > 0 && (
            <>
              {' · '}
              <span className="drop">{run.drops.length} drop{run.drops.length === 1 ? '' : 's'}</span>
            </>
          )}
        </span>
      </div>
      {run.answer && <div className="answer">{run.answer}</div>}
      {run.error && <div className="answer">{run.error}</div>}
      <div className="row">
        <button onClick={onShow}>show</button>
        <button onClick={onReplay}>replay</button>
      </div>
    </div>
  )
}

/* ---- composer ---- */

interface ComposerProps {
  text: string
  setText: (v: string) => void
  notebook: Notebook | null
  setNotebook: (n: Notebook | null) => void
  model: string
  setModel: (m: (typeof MODELS)[number]) => void
  thinking: boolean
  setThinking: (v: boolean) => void
  speed: number
  setSpeed: (v: number) => void
  streaming: boolean
  onSend: () => void
  onCancel: () => void
  onUploadError: (message: string) => void
}

function Composer(props: ComposerProps) {
  const fileRef = useRef<HTMLInputElement | null>(null)

  const pick = (name: string) => {
    const match = NOTEBOOKS.find((n) => n.name === name)
    if (match) props.setNotebook(match)
  }

  const upload = async (file: File) => {
    try {
      props.setNotebook({ name: 'camera photo', src: await downscaleToJpeg(file) })
    } catch {
      props.onUploadError('could not process that image')
    }
  }

  return (
    <div className="composer">
      {props.notebook && (
        <div className="chip-row">
          <span className="chip">
            <img src={props.notebook.src} alt="" />
            {props.notebook.name}
            <button onClick={() => props.setNotebook(null)} aria-label="remove image">
              ×
            </button>
          </span>
        </div>
      )}

      <div className="notebook-strip">
        {NOTEBOOKS.map((n) => (
          <button
            key={n.name}
            className={`thumb ${props.notebook?.name === n.name ? 'selected' : ''}`}
            onClick={() => pick(n.name)}
            title={n.name}
          >
            <img src={n.src} alt={n.name} />
          </button>
        ))}
        <button className="upload" onClick={() => fileRef.current?.click()}>
          upload / camera
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
            e.target.value = ''
          }}
        />
      </div>

      <textarea
        value={props.text}
        placeholder="Ask for something to show on the table…"
        onChange={(e) => props.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            props.onSend()
          }
        }}
      />

      <div className="controls-row">
        <label>
          model
          <select value={props.model} onChange={(e) => props.setModel(e.target.value as (typeof MODELS)[number])}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={props.thinking}
            onChange={(e) => props.setThinking(e.target.checked)}
          />
          thinking
        </label>
        <label>
          speed
          <select value={props.speed} onChange={(e) => props.setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <button className={`send ${props.streaming ? 'stop' : ''}`} onClick={props.streaming ? props.onCancel : props.onSend}>
          {props.streaming ? 'stop' : 'send'}
        </button>
      </div>
    </div>
  )
}

/* ---- debug drawer ---- */

interface DrawerProps {
  run: RenderRun | null
  tab: 'agent' | 'raw' | 'events' | 'timing'
  setTab: (t: 'agent' | 'raw' | 'events' | 'timing') => void
  open: boolean
  setOpen: (v: boolean) => void
}

function DebugDrawer({ run, tab, setTab, open, setOpen }: DrawerProps) {
  const drops = useMemo(() => run?.drops.length ?? 0, [run])
  return (
    <div className="drawer">
      <div className="drawer-head">
        {(['agent', 'raw', 'events', 'timing'] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'raw' ? 'raw stream' : t}
          </button>
        ))}
        <div className="spacer" />
        <button className="toggle" onClick={() => setOpen(!open)}>
          {open ? 'hide' : 'debug'}
        </button>
      </div>
      {open && (
        <div className="drawer-body">
          {!run ? (
            <div className="system-line">no render yet</div>
          ) : tab === 'agent' ? (
            <AgentTrace run={run} />
          ) : tab === 'raw' ? (
            <pre className="raw-stream">{run.raw || '(no raw deltas)'}</pre>
          ) : tab === 'events' ? (
            <EventList run={run} />
          ) : (
            <div className="timing">
              <div>
                <div className="k">first content</div>
                <div className="v">{run.firstContentMs !== null ? `${run.firstContentMs} ms` : '—'}</div>
              </div>
              <div>
                <div className="k">total</div>
                <div className="v">{run.totalMs !== null ? `${Math.round(run.totalMs)} ms` : '…'}</div>
              </div>
              <div>
                <div className="k">events</div>
                <div className="v">{run.events.length}</div>
              </div>
              <div>
                <div className="k">drops</div>
                <div className="v" style={{ color: drops > 0 ? '#ff8e8e' : undefined }}>
                  {drops}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The brain's loop for this answer: the draft, every verification with the
 * problems it found, and every repair edit. This is where a bad layout and
 * its fix are visible, instead of only the final table.
 */
function AgentTrace({ run }: { run: RenderRun }) {
  if (run.trace.length === 0) return <div className="system-line">no agent steps yet</div>
  return (
    <div className="agent-trace">
      {run.trace.map((t, i) => {
        const data = t.data as
          | { kind: 'verify'; problems: string[]; ok: boolean }
          | { kind: 'edit'; edits: { find: string; replace: string }[]; error?: string }
          | undefined
        return (
          <div key={i} className={`step step-${t.step}${data?.kind === 'verify' && !data.ok ? ' bad' : ''}`}>
            <div className="step-head">
              <span className="t">{t.t} ms</span>
              <span className="name">{t.step}</span>
              <span>{t.detail}</span>
            </div>
            {data?.kind === 'verify' && data.problems.length > 0 && (
              <ul>
                {data.problems.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            )}
            {data?.kind === 'edit' && (
              <div className="edits">
                {data.edits.map((e, j) => (
                  <div key={j} className="edit">
                    <code className="del">{e.find}</code>
                    <span>→</span>
                    <code className="ins">{e.replace}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function EventList({ run }: { run: RenderRun }) {
  if (run.events.length === 0) return <div className="system-line">no events yet</div>
  return (
    <div className="event-list">
      {run.events.map((event, i) => (
        <div className={`ev ${event.type === 'drop' ? 'drop' : ''}`} key={i}>
          <span>{run.eventTimeMs[i] ?? 0}ms</span>
          <span className="tag">{event.type}</span>
          <span className="body">{describe(event)}</span>
        </div>
      ))}
    </div>
  )
}

/** One short line per event, enough to spot a bad tag or a stray drop. */
function describe(event: StageEvent): string {
  switch (event.type) {
    case 'open':
      return `${event.tag} #${event.id}${event.parent ? ` in ${event.parent}` : ''}`
    case 'text':
      return JSON.stringify(event.text)
    case 'close':
      return `#${event.id}`
    case 'piece':
      return `${event.tag} #${event.id}: ${event.body}`
    case 'drop':
      return `${event.reason}: ${event.detail}`
    case 'end':
      return event.reason
  }
}

/* ---- helpers ---- */

function fileName(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.jpg$/i, '')
}

/** Fixture URLs and blob/data URLs are all fetchable; the wire wants a data URL. */
async function toDataUrl(src: string): Promise<string> {
  const res = await fetch(src)
  const blob = await res.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Phone photos are far larger than the model needs; cap the long side at 1280. */
async function downscaleToJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}
