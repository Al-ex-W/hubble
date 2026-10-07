import type { Express } from 'express'
import jpeg from 'jpeg-js'
import { apply, type H } from '@hubble/room'
import type { Box, RenderRequest, Scene, Surface } from '@hubble/stage'
import { inverse } from './spatial/coordinates.ts'
import { IPAD_ID } from './ipadPlacement.ts'

/**
 * Reads the real math task off the table through the room camera (#86).
 *
 * The owner's rule is "no faked tasks": what Hubble answers must be the task
 * really lying on the table. The iPad worksheet (#60) answers from our own
 * manifest, which is right only while the iPad shows what we think it shows.
 * This file asks the camera instead, and keeps the manifest as the fallback.
 *
 * Shaped by the #86 research (measured on recorded frames, temp/math-read/):
 * - a full frame always fails, so we read a tight crop of the page only;
 * - an upscaled crop beats a native one, and thresholding HURTS, so the crop
 *   is only grey with its contrast stretched;
 * - a Swedish hint is essential, or the models "translate" into German;
 * - the two gateway models agree on 44% of pairs, but when they agree they
 *   are right 30/32 times. Agreement is the only confidence we have, so a
 *   read is trusted only when both agree;
 * - about 10% of gateway calls stall, so each model is hedged after 4 s;
 * - errors land on the characters that change the answer (x→3 vs x→5), which
 *   is why a disagreeing read is never shown to the brain.
 *
 * Why the vision call is a plain fetch here and not in @hubble/brain (the
 * usual owner of model calls): demo day, and a submodule round-trip costs an
 * hour. Ruling in docs/plans/2026-10-07-camera-task.md; move it later.
 */

/** One problem read off the page. `bbox` is the page box in table px (the models can't place lines reliably). */
export interface ReadTaskItem {
  n: number
  text: string
  bbox: Box
}

export interface TaskRead {
  tasks: ReadTaskItem[]
  /** camera: both models agreed on this page; worksheet: the fallback, the iPad's shown problems; none: neither. */
  source: 'camera' | 'worksheet' | 'none'
  agreed: boolean
  /** Each model's raw answer, for Setup's "what did it read" view. Never sent to the brain unless agreed. */
  raw: Record<string, string>
  ms: number
  at: number
  error?: string
}

// ---------------------------------------------------------------- the crop

/**
 * Sampling density of the crop. The camera gives about 0.9 px/mm at 1080p
 * and 1.67 at 4K (research's pxpermm.json); the research's best input was
 * the native crop upscaled ×3, which is about 3-5 px/mm. 4 px/mm keeps an
 * A4 page under 900×1200, well within what the gateway accepts.
 */
const CROP_PX_PER_MM = 4

export interface CameraCalibration {
  /** Camera px → table px, in the calibration's own camera geometry. */
  h: H
  width: number
  height: number
}

/**
 * The page region, warped upright from a camera still.
 *
 * Why a warp and not a rectangle crop plus rotate: the calibration already
 * knows the camera's perspective and that it looks at the table upside down
 * (table x runs against camera x). Sampling every crop pixel at its table
 * position through the inverse map deskews and turns the page in one step,
 * the same map the projector's keys stand on, so there's nothing second to
 * drift.
 *
 * The frame may be bigger than the calibration's geometry (a 4K still
 * against a 1080p calibration), so the camera position is scaled by the
 * ratio. Pure TS (jpeg-js) on purpose: no native image dependency on demo
 * day, and one decode is ~0.3 s for 4K, nothing next to the model call.
 */
export function cropPage(frame: Uint8Array, cal: CameraCalibration, box: Box, surface: Surface): { jpeg: Uint8Array; width: number; height: number } {
  const img = jpeg.decode(frame, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
  const inv = inverse(cal.h)
  if (!inv) throw new Error('calibration is not invertible')
  const sx = img.width / cal.width
  const sy = img.height / cal.height
  const pxPerTable = CROP_PX_PER_MM * surface.mmPerPx
  const W = Math.max(8, Math.round(box.w * pxPerTable))
  const Hh = Math.max(8, Math.round(box.h * pxPerTable))
  const grey = new Float32Array(W * Hh)
  const at = (x: number, y: number) => {
    const xi = Math.min(img.width - 1, Math.max(0, x))
    const yi = Math.min(img.height - 1, Math.max(0, y))
    const i = (yi * img.width + xi) * 4
    return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!
  }
  for (let j = 0; j < Hh; j++) {
    for (let i = 0; i < W; i++) {
      const c = apply(inv, { x: box.x + (i + 0.5) / pxPerTable, y: box.y + (j + 0.5) / pxPerTable })
      const x = c.x * sx - 0.5
      const y = c.y * sy - 0.5
      // Bilinear: the crop is upscaled several times over the camera's
      // pixels, and nearest-neighbour blocks make letters look like digits.
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const fx = x - x0
      const fy = y - y0
      grey[j * W + i] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
    }
  }
  // Contrast stretch between the 1st and 99th percentile: the room's light
  // and the projector's spill make the page grey-on-grey. A hard threshold
  // was measured to hurt (research), so this stays a linear stretch.
  const sorted = Float32Array.from(grey).sort()
  const lo = sorted[Math.floor(sorted.length * 0.01)]!
  const hi = sorted[Math.floor(sorted.length * 0.99)]!
  const k = hi > lo ? 255 / (hi - lo) : 1
  const out = new Uint8Array(W * Hh * 4)
  for (let p = 0; p < grey.length; p++) {
    const v = Math.max(0, Math.min(255, (grey[p]! - lo) * k))
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v
    out[p * 4 + 3] = 255
  }
  const enc = jpeg.encode({ data: out, width: W, height: Hh }, 92)
  return { jpeg: new Uint8Array(enc.data), width: W, height: Hh }
}

// ------------------------------------------------------- reading the answer

/**
 * The research's prompt plus the Swedish hint (run3.py "sv"), and one change:
 * the page may hold several numbered problems since #88, so each problem is
 * asked for on one line with its number. Without the hint the models
 * produced German/Spanish "transcriptions" of Swedish instructions.
 */
export const READ_PROMPT =
  'This is a photo of a page lying on a table. It shows one or more Swedish school math problems. ' +
  'Transcribe each problem exactly, as plain text with Unicode math (², ³, ∫, ·, √, →, <, eˣ). ' +
  'The instructions are in Swedish: never translate, copy the words letter by letter. ' +
  'Write each problem on ONE line, starting with its number as printed and a colon, e.g. "2: Lös ekvationen: 3x + 1 = 7". ' +
  'If a problem has no printed number, start with "1:". Do not solve anything. ' +
  'Output only these lines. If you cannot read the page, output UNREADABLE.'

/**
 * Model text → problems. Tolerant on purpose: the recorded answers (fixture)
 * come as "n: text", as plain multi-line transcriptions with no numbers
 * (the research prompt), and with blank lines in between. Lines that don't
 * start with a number belong to the problem before them; with no number at
 * all, the whole page is problem 1.
 */
export function parseRead(text: string): { n: number; text: string }[] {
  if (!text || /^\s*UNREADABLE\s*$/i.test(text) || /^(ERR|HTTPError)\b/.test(text)) return []
  const out: { n: number; text: string }[] = []
  for (const raw of text.replace(/```[a-z]*|```/g, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(?:problem|uppgift)?\s*(\d{1,2})\s*[:.)]\s+(.*)$/i.exec(line)
    if (m) out.push({ n: Number(m[1]), text: m[2]!.trim() })
    else if (out.length) out[out.length - 1]!.text += ` | ${line}`
    else out.push({ n: 1, text: line })
  }
  return out.filter((t) => t.text && !/^UNREADABLE$/i.test(t.text))
}

/**
 * The maths of a problem, normalised so two models' spellings of the same
 * thing compare equal: "x·eˣ", "x eˣ" and "x e^x" are one integrand (all
 * three are in the recorded answers). Words are dropped: the models differ
 * on the instruction ("Förenkla" vs "Beräkna") far more often than on the
 * maths, and the maths is what changes the answer.
 */
export function mathKey(text: string): string {
  return text
    .replace(/\^\{?x\}?/g, 'ˣ')
    .replace(/\^\{?2\}?/g, '²')
    .replace(/\^\{?3\}?/g, '³')
    .replace(/[−–]/g, '-')
    .replace(/[×*]/g, '·')
    .replace(/\p{L}{2,}:?/gu, '') // words (Swedish instructions); single letters are variables
    .replace(/[\s·|:]/g, '')
    .toLowerCase()
}

/** Two reads agree when they found the same problem numbers with the same maths. */
export function agree(a: { n: number; text: string }[], b: { n: number; text: string }[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false
  return a.every((t, i) => t.n === b[i]!.n && mathKey(t.text) !== '' && mathKey(t.text) === mathKey(b[i]!.text))
}

// ---------------------------------------------------------------- the reader

export interface Llm {
  baseUrl: string
  apiKey: string
}

/** Both gateway models accept images (research, models.json). aixia-code is first: it read the math line 6/6. */
export const READ_MODELS = ['aixia-code', 'aixia-labs'] as const
const HEDGE_MS = 4000
const DEADLINE_MS = 15000

/** One vision call. The nonce defeats the gateway's identical-request cache (AGENTS.md), so a re-read really re-reads. */
async function ask(llm: Llm, model: string, image: Uint8Array, signal: AbortSignal): Promise<string> {
  const body = {
    model,
    temperature: 0,
    max_tokens: 500,
    chat_template_kwargs: { thinking: false },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${READ_PROMPT} (request ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)})` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}` } },
        ],
      },
    ],
  }
  const r = await fetch(`${llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok) throw new Error(`${model} answered ${r.status}`)
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] }
  return j.choices?.[0]?.message?.content ?? ''
}

/**
 * One model, hedged: if the first call hasn't answered in 4 s a second
 * identical (nonce'd) call starts and whichever answers first wins. The
 * research saw ~10% of calls hang for 60 s; a hedge turns that tail into
 * about 4 s more. Every failure is '' (an empty read never agrees).
 */
export async function askHedged(call: (signal: AbortSignal) => Promise<string>, hedgeMs = HEDGE_MS, deadlineMs = DEADLINE_MS): Promise<string> {
  const ctl = new AbortController()
  const deadline = setTimeout(() => ctl.abort(), deadlineMs)
  try {
    return await new Promise<string>((resolve) => {
      let pending = 1
      let done = false
      const settle = (v: string | null) => {
        if (done) return
        if (v !== null) {
          done = true
          return resolve(v)
        }
        if (--pending === 0) {
          done = true
          resolve('')
        }
      }
      const run = () => call(ctl.signal).then(settle, () => settle(null))
      run()
      const hedge = setTimeout(() => {
        if (done) return
        pending++
        run()
      }, hedgeMs)
      ctl.signal.addEventListener('abort', () => {
        clearTimeout(hedge)
        if (!done) {
          done = true
          resolve('')
        }
      })
    })
  } finally {
    clearTimeout(deadline)
    ctl.abort()
  }
}

/** How long a camera read keeps steering answers: the page can be swapped any time, and an old read must not outlive it. */
export const READ_FRESH_MS = 10 * 60 * 1000

export interface TaskReaderDeps {
  /** One full-resolution still from the room camera (through the device pool: refuses outside the hardware window). */
  frame: () => Promise<Uint8Array>
  /** The room camera's calibration now, or null when uncalibrated. */
  calibration: () => CameraCalibration | null
  /** Where the page lies, in table px, for this scene. */
  region: (scene: Scene | undefined) => Box
  surface: () => Surface
  llm: Llm | null
  /** The fallback: the iPad worksheet's shown problems as {n, text}, or [] when it's off. */
  worksheetTasks: () => { n: number; text: string }[]
  /** Test seam: the vision call. */
  ask?: (model: string, image: Uint8Array, signal: AbortSignal) => Promise<string>
  now?: () => number
}

export function createTaskReader(d: TaskReaderDeps) {
  const now = d.now ?? Date.now
  let last: TaskRead | null = null
  let lastCrop: Uint8Array | null = null
  let reading: Promise<TaskRead> | null = null

  const fallback = (base: Omit<TaskRead, 'tasks' | 'source'>, box: Box): TaskRead => {
    const ws = d.worksheetTasks()
    return ws.length ? { ...base, tasks: ws.map((t) => ({ ...t, bbox: box })), source: 'worksheet' } : { ...base, tasks: [], source: 'none' }
  }

  async function readOnce(scene?: Scene): Promise<TaskRead> {
    const t0 = now()
    const box = d.region(scene)
    const base = { agreed: false, raw: {} as Record<string, string>, at: t0 }
    const fail = (error: string) => fallback({ ...base, ms: now() - t0, error }, box)
    const cal = d.calibration()
    if (!cal) return fail('the room camera is not calibrated')
    if (!d.llm && !d.ask) return fail('no LLM key: set HUBBLE_LLM_API_KEY')
    let still: Uint8Array
    try {
      still = await d.frame()
    } catch (e) {
      return fail(`no camera frame: ${e instanceof Error ? e.message : String(e)}`)
    }
    let crop: Uint8Array
    try {
      crop = cropPage(still, cal, box, d.surface()).jpeg
    } catch (e) {
      return fail(`crop failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    lastCrop = crop
    const call = d.ask ?? ((m: string, img: Uint8Array, s: AbortSignal) => ask(d.llm!, m, img, s))
    const answers = await Promise.all(READ_MODELS.map((m) => askHedged((s) => call(m, crop, s))))
    READ_MODELS.forEach((m, i) => (base.raw[m] = answers[i]!))
    const reads = answers.map(parseRead)
    // One model reading and the other saying UNREADABLE is not a disagreement
    // about characters (7 Oct, live: aixia-code read the projectile problem
    // word for word, aixia-labs said UNREADABLE). Trust the one that read it;
    // two DIFFERENT reads still fall back, as the research requires.
    const only = reads.filter((r) => r.length > 0)
    if (only.length === 1) return { ...base, agreed: true, ms: now() - t0, source: 'camera', tasks: only[0]!.map((t) => ({ ...t, bbox: box })) }
    if (!agree(reads[0]!, reads[1]!)) return fail(reads.every((r) => r.length === 0) ? 'neither model could read the page' : 'the two models disagree, so the read is not trusted')
    // The literal reader's text (aixia-code first): agreement was checked on
    // the maths, and its wording of the Swedish instruction was the closer one.
    return { ...base, agreed: true, ms: now() - t0, source: 'camera', tasks: reads[0]!.map((t) => ({ ...t, bbox: box })) }
  }

  return {
    /** Reads the page now. Concurrent clicks share one read (one still, one pair of model calls). */
    read(scene?: Scene): Promise<TaskRead> {
      reading ??= readOnce(scene)
        .then((r) => (last = r))
        .finally(() => (reading = null))
      return reading
    },
    last: () => last,
    lastCrop: () => lastCrop,
    /**
     * The request as the brain should see it: the read page as a `paper`
     * object in the scene, labelled with its numbered problems, the same
     * shape `worksheet.withIpad` gives the iPad, so "solve problem 2" finds
     * problem 2 by its number. Only a fresh, agreed camera read is added: the
     * worksheet fallback is already in the scene through withIpad, and a
     * disagreeing read is exactly the "x→3 vs x→5" failure the research saw.
     *
     * When the read page IS the iPad (the region came from the iPad's box),
     * the iPad's own label is replaced, so the brain sees one page with the
     * camera's text and not two competing ones.
     */
    withPage(request: RenderRequest): RenderRequest {
      if (!last || last.source !== 'camera' || now() - last.at > READ_FRESH_MS || last.tasks.length === 0) return request
      const tasks = last.tasks
      const label =
        tasks.length === 1
          ? `page on the table, read by the camera, showing the task: ${tasks[0]!.text}`
          : `page on the table, read by the camera, showing ${tasks.length} numbered problems: ${tasks.map((t) => `problem ${t.n}: ${t.text}`).join(' ; ')}`
      const scene: Scene = request.scene ?? { surface: d.surface(), objects: [] }
      const ipad = scene.objects.find((o) => o.id === IPAD_ID)
      const box = tasks[0]!.bbox
      const sameAsIpad = ipad && Math.abs(ipad.box.x - box.x) < 1 && Math.abs(ipad.box.y - box.y) < 1
      const objects = sameAsIpad
        ? scene.objects.map((o) => (o.id === IPAD_ID ? { ...o, label: `iPad worksheet, read by the camera: ${label.replace(/^page on the table, read by the camera, /, '')}` } : o))
        : [...scene.objects.filter((o) => o.id !== 'page'), { id: 'page', kind: 'paper' as const, label, box }]
      return { ...request, scene: { ...scene, objects } }
    },
  }
}

export type TaskReader = ReturnType<typeof createTaskReader>

/** The page region: a paper or notebook the scene places, else the iPad (where the task lives today). */
export function pageRegion(scene: Scene | undefined, ipad: (scene: Scene | undefined) => Box): Box {
  return scene?.objects.find((o) => o.kind === 'paper' || o.kind === 'notebook')?.box ?? ipad(scene)
}

/**
 * POST /api/read-task → read the page now; GET /api/read-task → the last read;
 * GET /api/read-task/crop.jpg → the crop the models saw (Setup shows it, so
 * the operator can tell "wrong spot" from "unreadable" at a glance).
 *
 * A read never throws to the client: a closed hardware window, a missing
 * calibration or a stalled gateway all come back as a TaskRead with `error`
 * and the worksheet fallback, which is what Setup shows.
 */
export function mountReadTask(app: Express, reader: TaskReader) {
  app.post('/api/read-task', async (_req, res) => res.json(await reader.read()))
  app.get('/api/read-task', (_req, res) => res.json(reader.last()))
  app.get('/api/read-task/crop.jpg', (_req, res) => {
    const c = reader.lastCrop()
    if (!c) return void res.status(404).json({ error: 'no crop yet' })
    res.type('image/jpeg').set('Cache-Control', 'no-store').send(Buffer.from(c))
  })
}
