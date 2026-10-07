/**
 * What each Show step's Run does, as plain calls (owner, 7 Oct: "make show be
 * a like 5 step thing"). Kept out of the component so one test can pin the
 * routes each step hits, without rendering the page or a server.
 *
 * Why every Run starts with the act switch and close-all: the presenter walks
 * the steps in order on a table that still shows the last step's answer or
 * lit keys. Clearing first means Run always starts from an empty table, so a
 * step never inherits a leftover surface from the previous one.
 */

export type StepId = 'math' | 'piano' | 'keyboard'

export interface Res {
  ok: boolean
  status: number
  body: any
}
/** post(url, body) and get(url): the two transports, injected so the test records calls. */
export interface Io {
  post: (url: string, body?: unknown) => Promise<Res>
  get: (url: string) => Promise<Res>
  /** The puppet master's send (the owner's assistant). Only the math fallback uses it. */
  ask: (text: string) => Promise<unknown>
}

export interface RunResult {
  ok: boolean
  /** One short line for the step's status. */
  text: string
  /** Step 1: what the page said, shown under the step. */
  read?: string
}

const fail = (what: string, r: Res): RunResult => ({ ok: false, text: `${what} failed (${r.status}${r.body?.error ? `: ${r.body.error}` : ''})` })

/** Act switch + clear: the shared start of every Run. */
async function begin(io: Io, act: 'math' | 'lesson', song?: string): Promise<Res> {
  const a = await io.post('/api/operator/act', song ? { act, song } : { act })
  if (!a.ok) return a
  return io.post('/api/operator/close-all')
}

/** Joined problem text from a read-task or solve-page answer. Both carry `tasks: {n, text}[]` (readTask.ts TaskRead). */
const readText = (body: any): string => (Array.isArray(body?.tasks) ? body.tasks.map((t: { n: number; text: string }) => `${t.n}: ${t.text}`).join('\n') : '')

export async function runStep(id: StepId, io: Io, opts: { song?: string } = {}): Promise<RunResult> {
  if (id === 'math') {
    const b = await begin(io, 'math')
    if (!b.ok) return fail('act switch', b)
    // The iPad is the page's fallback source, so it must be on before the read.
    const w = await io.post('/api/operator/worksheet', { on: true })
    if (!w.ok && w.status !== 404) return fail('iPad worksheet', w)
    // /api/solve-page is feat/solve-page's route (reads the page, falls back
    // to the iPad, renders). Until it is on main it 404s, and the step does
    // the same thing by hand: read the task, hand its text to the puppet
    // master (owner: every input goes to HIS assistant, never brain direct).
    const s = await io.post('/api/solve-page')
    if (s.ok) return { ok: true, text: 'solved: the answer is on the table', read: readText(s.body) || readText(s.body?.read) }
    if (s.status !== 404) return fail('solve page', s)
    const r = await io.post('/api/read-task')
    const read = readText(r.body)
    if (!r.ok || !read) return { ok: false, text: `could not read the page${r.body?.error ? `: ${r.body.error}` : ''}`, read }
    await io.ask(`Solve this problem from the page, worked step by step beside it:\n${read}`)
    return { ok: true, text: `solved (${r.body.source})`, read }
  }
  if (id === 'piano') {
    const song = opts.song ?? 'twinkle'
    const b = await begin(io, 'lesson', song)
    if (!b.ok) return fail('lesson', b)
    // Piano detection has its own switch (operator.ts /api/operator/piano);
    // without it look() never asks the keybed for keys (7 Oct, live: 0 keys
    // until it was switched on by hand, then 25/25 at once).
    const p = await io.post('/api/operator/piano', { enabled: true })
    if (!p.ok) return fail('piano detection', p)
    // GET /api/scene/seen runs runtime.look(): the camera's measured keys
    // (keybed sidecar), which the lesson's lit keys are drawn on.
    const seen = await io.get('/api/scene/seen')
    if (!seen.ok) return fail('camera look', seen)
    return { ok: true, text: `identified, playing ${song}` }
  }
  const b = await begin(io, 'math')
  if (!b.ok) return fail('act switch', b)
  const k = await io.post('/api/keyboard/open')
  if (!k.ok) return fail('keyboard', k)
  return { ok: true, text: 'keyboard on the table: swipe or pinch to type, SEND asks' }
}
