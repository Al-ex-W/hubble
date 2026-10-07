import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { DEFAULT_SURFACE, pxFromMm, type Box, type OverlayLine, type RenderRequest, type RenderStreamLine } from '@hubble/stage'
import { createWorksheetApp } from '../worksheet/server.ts'
import { MANIFEST } from '../worksheet/tasks.ts'
import type { ServerConfig } from './config.ts'
import { createApp } from './index.ts'
import { createRuntime } from './runtime.ts'
import { defaultIpadBox } from './ipadPlacement.ts'
import { createWorksheet, rulerShapes, spawnWorksheet, type WorksheetProcess } from './worksheet.ts'

/**
 * The iPad worksheet from the operator's checkbox to the brain's scene, over
 * real HTTP: the operator route, the real worksheet server (in-process for
 * speed, and once as a real spawned process), and renderToTable.
 *
 * Fixtures: task text from the committed notebooks manifest (synthetic, per
 * its own label); oracles are the raw manifest strings and plain rectangle
 * maths, never worksheet.ts's own helpers.
 */
const config: ServerConfig = { port: 0, llm: { baseUrl: 'https://llm.invalid/v1', apiKey: '', model: 'aixia-labs' }, jevApiKey: undefined }
const MANIFEST_TASKS = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, { lines: string[] }>
/** Every written line of the task is in the label, verbatim. */
const hasTask = (label: string | undefined, id: string) => MANIFEST_TASKS[id]!.lines.every((l) => (label ?? '').includes(l))

const open: Server[] = []
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})
const listen = async (app: { listen: (port: number, host: string) => Server }) => {
  const s = app.listen(0, '127.0.0.1')
  open.push(s)
  await new Promise((r) => s.once('listening', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

/** The worksheet server as a "process" the controller starts in-process: same app, same HTTP. */
function inProcess() {
  let server: Server | null = null
  let base = ''
  const proc: WorksheetProcess = {
    async start() {
      base = await listen(createWorksheetApp())
      server = open[open.length - 1]!
    },
    async stop() {
      server?.closeAllConnections()
      server?.close()
      server = null
    },
  }
  return { proc, base: () => base }
}

/** A brain that records what it was asked and answers nothing. */
function recordingBrain() {
  const asked: RenderRequest[] = []
  return {
    asked,
    brain: {
      async render(request: RenderRequest, emit: (l: RenderStreamLine) => void) {
        asked.push(request)
        emit({ kind: 'start', renderId: 'r1', intent: request.intent, model: 'test', t: 0, scene: request.scene })
        emit({ kind: 'done', renderId: 'r1', t: 0, answer: '', firstContentMs: null })
      },
    },
  }
}

describe('the worksheet in every render', () => {
  it('gives the brain the exact task on the iPad, and where the iPad lies', async () => {
    // Catches: the brain answering a different task than the person sees (the
    // bug the camera had), or not knowing to keep its answer off the iPad.
    const ws = inProcess()
    const ctl = createWorksheet({
      get base() {
        return ws.base()
      },
      publicUrl: () => null,
      process: ws.proc,
      setRuler: () => {},
    })
    expect((await ctl.setOn(true)).on).toBe(true)
    expect((await ctl.show({ taskId: 'system' })).ok).toBe(true)
    const r = ctl.withIpad({ intent: 'solve the task on my iPad' })
    const ipad = r.scene!.objects.find((o) => o.id === 'ipad')!
    expect(ipad.kind).toBe('tablet')
    expect(hasTask(ipad.label, 'system')).toBe(true)
    // Rectangle maths, not ipadPlacement's helper: 179.5 x 248.6 mm, left edge 300 mm in.
    expect(ipad.box.x).toBeCloseTo(300 / DEFAULT_SURFACE.mmPerPx, 3)
    expect(ipad.box.w).toBeCloseTo(179.5 / DEFAULT_SURFACE.mmPerPx, 3)
    expect(ipad.box.h).toBeCloseTo(248.6 / DEFAULT_SURFACE.mmPerPx, 3)
  })

  it('through the operator checkbox: tick, pick a task, ask; untick, ask again', async () => {
    // The real wiring: /api/operator/worksheet → controller → worksheet
    // server → renderToTable → brain. Catches: a render path that skips the
    // merge, or an unticked worksheet still steering answers.
    const { post, render } = await serverWith()
    let st = await (await post('/api/operator/worksheet', { on: true, taskId: 'inequality', textMm: 10 })).json()
    expect(st).toMatchObject({ on: true, url: 'http://192.168.42.18:8793/', shown: { taskId: 'inequality', textMm: 10 } })

    const withIpad = await render({ intent: 'solve the task on my iPad' })
    const ipad = withIpad.scene!.objects.find((o) => o.kind === 'tablet')!
    // Inequalities carry a literal "<" (recorded parser hazard): it must reach
    // the brain intact, which a client label (plainLabel) would strip.
    expect(hasTask(ipad.label, 'inequality')).toBe(true)
    expect(ipad.label).toContain('<')

    st = await (await post('/api/operator/worksheet', { on: false })).json()
    expect(st.on).toBe(false)
    const without = await render({ intent: 'solve the task on my iPad' })
    expect(without.scene?.objects.some((o) => o.kind === 'tablet') ?? false).toBe(false)
  })

  it("keeps the bench's iPad box but never its label", async () => {
    // Catches: a client steering which task the brain answers by sending its
    // own "tablet" label, and losing the simulator's placement.
    const { post, render } = await serverWith()
    await post('/api/operator/worksheet', { on: true, taskId: 'limit' })
    const box: Box = { x: 900, y: 200, w: 230, h: 318 }
    const r = await render({ intent: 'help', scene: { objects: [{ id: 'tablet', kind: 'tablet', label: 'solve 1 plus 1', box }] } })
    const tablets = r.scene!.objects.filter((o) => o.kind === 'tablet')
    expect(tablets).toHaveLength(1)
    expect(tablets[0]!.box).toEqual(box)
    expect(hasTask(tablets[0]!.label, 'limit')).toBe(true)
  })

  it('leaves the scene alone when the worksheet is off', async () => {
    const { render } = await serverWith()
    const scene = { objects: [{ id: 'notebook', kind: 'notebook', box: { x: 100, y: 100, w: 269, h: 380 } }] }
    const r = await render({ intent: 'solve the task in my notebook', scene })
    expect(r.scene!.objects.map((o) => o.id)).toEqual(['notebook'])
  })

  it('tells the brain every problem on the sheet, numbered as the iPad numbers them (#88)', async () => {
    // Catches: the brain told only the first pick (the pre-#88 label), or
    // numbered in another order than the iPad's, so "solve problem 2"
    // answers a problem the person isn't looking at. Oracle: a regex built
    // from the raw manifest lines, in the order the operator ticked.
    const { post, render } = await serverWith()
    const ids = ['projectile', 'inequality', 'system']
    const st = await (await post('/api/operator/worksheet', { on: true, taskIds: ids })).json()
    expect(st.shown).toMatchObject({ taskId: 'projectile', taskIds: ids })
    const r = await render({ intent: 'solve problem 2' })
    const label = r.scene!.objects.find((o) => o.kind === 'tablet')!.label!
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ids.forEach((id, i) => {
      for (const l of MANIFEST_TASKS[id]!.lines) expect(label).toMatch(new RegExp(`problem ${i + 1}: [^;]*${esc(l)}`))
    })
    expect(label).toContain('3 numbered problems')
    expect(label).not.toContain('problem 4')
  })

  it('a single taskId still means one problem, and a bad list changes nothing (#88)', async () => {
    // Catches: Setup's picker (taskId) breaking, and the route letting a
    // fifth problem or a duplicate through past the state owner.
    const { post, render } = await serverWith()
    await post('/api/operator/worksheet', { on: true, taskIds: ['linear', 'limit'] })
    for (const taskIds of [['linear', 'quadratic', 'system', 'projectile', 'limit'], ['limit', 'limit']]) {
      const r = await post('/api/operator/worksheet', { taskIds })
      expect(r.status).toBe(400)
      expect((await r.json()).shown.taskIds).toEqual(['linear', 'limit'])
    }
    await post('/api/operator/worksheet', { taskId: 'integral' })
    const label = (await render({ intent: 'help' })).scene!.objects.find((o) => o.kind === 'tablet')!.label!
    expect(label.startsWith('iPad worksheet showing the task: ')).toBe(true)
    expect(hasTask(label, 'integral')).toBe(true)
    expect(label).not.toMatch(/problem 1|Evaluate/)
  })

  it('refuses an unknown task with 400 and keeps showing the old one', async () => {
    const { post } = await serverWith()
    await post('/api/operator/worksheet', { on: true, taskId: 'quadratic' })
    const r = await post('/api/operator/worksheet', { taskId: 'nope' })
    expect(r.status).toBe(400)
    expect((await r.json()).shown.taskId).toBe('quadratic')
  })

  it('says why, within its deadline, when the worksheet server has died', async () => {
    // Catches: an operator click hanging (or the server throwing) because the
    // child process went away under it.
    const { post, ws } = await serverWith()
    await post('/api/operator/worksheet', { on: true })
    await ws.proc.stop()
    const t0 = Date.now()
    const r = await post('/api/operator/worksheet', { taskId: 'linear' })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/unreachable|did not answer/)
    expect(Date.now() - t0).toBeLessThan(1500)
  })
})

describe('the check ruler', () => {
  it('lights a 10 cm bar beside the iPad, never on it, and turns off', async () => {
    const { post, overlays } = await serverWith()
    await post('/api/operator/worksheet', { on: true, ruler: true })
    const line = overlays.filter((o) => o.layer === 'ruler').at(-1)!
    const ipad = defaultIpadBox(DEFAULT_SURFACE)
    const ys = line.shapes.flatMap((s) => s.points.map((p) => p.y))
    // The bar's length is 10 real cm on this surface (oracle: mm / mm-per-px).
    const bar = line.shapes[0]!.points
    expect(Math.max(...bar.map((p) => p.y)) - Math.min(...bar.map((p) => p.y))).toBeCloseTo(100 / DEFAULT_SURFACE.mmPerPx, 3)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(ipad.y)
    // Every shape lies wholly outside the iPad's box.
    for (const s of line.shapes) {
      const xs = s.points.map((p) => p.x)
      expect(Math.max(...xs) <= ipad.x || Math.min(...xs) >= ipad.x + ipad.w).toBe(true)
    }
    await post('/api/operator/worksheet', { ruler: false })
    expect(overlays.filter((o) => o.layer === 'ruler').at(-1)!.shapes).toEqual([])
  })

  it('moves to the right side when the iPad is against the left edge', () => {
    const box = { x: 5, y: 300, w: 230, h: 318 }
    for (const s of rulerShapes(box, DEFAULT_SURFACE)) for (const p of s.points) expect(p.x).toBeGreaterThanOrEqual(box.x + box.w)
    expect(pxFromMm(DEFAULT_SURFACE, 100)).toBeGreaterThan(0)
  })
})

describe('the real worksheet process', () => {
  it('starts on the checkbox, answers, and is gone after unticking', async () => {
    // The spawn path itself: tsx resolved from node_modules, the child bound
    // to the port. Catches: a checkbox that "works" in tests but can't start
    // the real server (wrong entry path, tsx not found, wrong env name).
    const port = await freePort()
    const proc = spawnWorksheet(port)
    const sheet = createWorksheet({ base: `http://127.0.0.1:${port}`, publicUrl: () => null, process: proc, setRuler: () => {} })
    const st = await sheet.setOn(true)
    expect(st.error).toBeUndefined()
    expect(st.shown).toMatchObject({ taskId: 'linear', taskIds: ['linear'], numbers: [1], textMm: 8 })
    expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true)
    await sheet.setOn(false)
    await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow()
  }, 20_000)
})

async function freePort() {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return port
}

/** The full server with the in-process worksheet behind the operator route. */
async function serverWith() {
  const ws = inProcess()
  const { asked, brain } = recordingBrain()
  const overlays: OverlayLine[] = []
  let ctl: ReturnType<typeof createWorksheet> | null = null
  const app = createApp(config, {
    brain: brain as never,
    runtime: (ch) => createRuntime({ ...ch, overlay: (l) => (overlays.push(l), ch.overlay(l)) }),
    worksheet: (setRuler) => {
      // The worksheet server's port is only known once it starts, so the
      // controller is told its base through a getter-backed object.
      ctl = createWorksheet({
        get base() {
          return ws.base()
        },
        publicUrl: () => 'http://192.168.42.18:8793/',
        process: ws.proc,
        setRuler,
      })
      return ctl
    },
  })
  const base = await listen(app)
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const render = async (body: unknown) => {
    await (await post('/api/render', body)).text()
    return asked[asked.length - 1]!
  }
  return { base, post, render, overlays, ws }
}

describe('the worksheet process never outlives its purpose (review round 1)', () => {
  const up = async (port: number) => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) })).ok
    } catch {
      return false
    }
  }
  const waitFor = async (cond: () => Promise<boolean>, ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await cond()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  it('dies with a main server that is killed outright (tsx watch restarts, crashes)', async () => {
    // The leak: every save restarted the main server and left a worksheet
    // server holding the port and the iPad. SIGKILL is the harshest case:
    // no handler in the parent runs at all, only the pipe closing tells.
    const port = await freePort()
    const parentSrc = `import { spawnWorksheet } from ${JSON.stringify(new URL('./worksheet.ts', import.meta.url).pathname)}
await spawnWorksheet(${port}).start(); console.log('up')`
    // One process, tsx as a loader: the tsx CLI would run the code in a child
    // of its own, and SIGKILL on the CLI would leave that child (the real
    // parent of the worksheet) alive.
    const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', parentSrc], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((r) => parent.stdout!.on('data', (b: Buffer) => b.toString().includes('up') && r()))
    expect(await up(port)).toBe(true)
    parent.kill('SIGKILL')
    expect(await waitFor(async () => !(await up(port)), 5000)).toBe(true)
  }, 20_000)

  it('quits at once on /api/quit even while the iPad holds its stream open', async () => {
    // The adopted case: a server this main server didn't spawn is stopped by
    // /api/quit. server.close() waited for the iPad's never-ending SSE, so it
    // never exited, and the next tick's new server left the iPad on the old one.
    const port = await freePort()
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
    const ws = spawn(process.execPath, [tsx, fileURLToPath(new URL('../worksheet/server.ts', import.meta.url))], { env: { ...process.env, WORKSHEET_PORT: String(port) }, stdio: 'ignore' })
    try {
      expect(await waitFor(() => up(port), 8000)).toBe(true)
      const ipad = new AbortController()
      const stream = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ipad.signal })
      // Read the first event, so the stream is really open on the server's side.
      const reader = stream.body!.getReader()
      await reader.read()
      await spawnWorksheet(port).stop() // adopted: no handle, so it asks the server to quit
      // The oracle is the iPad's own stream ending. "The port stops answering"
      // is true at once even when the process lingers (a closing server
      // refuses new connections but keeps serving open ones), which is
      // exactly the bug: the iPad stayed on the old server.
      const ended = await Promise.race([
        (async () => {
          for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return true
        })(),
        new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
      ])
      expect(ended).toBe(true)
      ipad.abort()
    } finally {
      ws.kill('SIGKILL')
    }
  }, 20_000)

  it('stops steering answers the moment its server dies on its own', async () => {
    // A crashed worksheet server kept the box ticked and every answer
    // describing a task the iPad no longer showed.
    let die = () => {}
    const ws = inProcess()
    await ws.proc.start()
    const live = createWorksheet({
      get base() {
        return ws.base()
      },
      publicUrl: () => null,
      process: { ...ws.proc, onDeath: (cb) => (die = cb) },
      setRuler: () => {},
    })
    await live.setOn(true)
    expect(live.withIpad({ intent: 'x' }).scene?.objects.some((o) => o.kind === 'tablet')).toBe(true)
    die()
    expect(live.status()).toMatchObject({ on: false, shown: null })
    expect(live.status().error).toMatch(/stopped/)
    expect(live.withIpad({ intent: 'x' }).scene).toBeUndefined()
  })

  it('an untick during a slow start leaves it off, and stopped', async () => {
    let release = () => {}
    const calls: string[] = []
    const proc: WorksheetProcess = {
      start: () => new Promise<void>((r) => (release = () => (calls.push('started'), r()))),
      stop: async () => void calls.push('stopped'),
    }
    const sheet = createWorksheet({ base: 'http://127.0.0.1:1', publicUrl: () => null, process: proc, setRuler: () => {} })
    const ticking = sheet.setOn(true)
    const unticking = sheet.setOn(false)
    release()
    await Promise.all([ticking, unticking])
    expect(sheet.status().on).toBe(false)
    expect(calls).toEqual(['started', 'stopped'])
  })
})

describe('the worksheet server only takes changes from this laptop (review round 1)', () => {
  it('refuses a task change from the room network', async () => {
    // Anyone on the room LAN could switch the iPad's task behind the main
    // server's back, and the brain would answer the old one.
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    if (!lan) return console.warn('skipped: no LAN address on this machine')
    const s = createWorksheetApp().listen(0, '0.0.0.0')
    open.push(s)
    await new Promise((r) => s.once('listening', r))
    const port = (s.address() as AddressInfo).port
    const r = await fetch(`http://${lan}:${port}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'limit' }) })
    expect(r.status).toBe(403)
    // Reading stays open: the iPad itself reads from the LAN.
    expect((await fetch(`http://${lan}:${port}/api/state`)).ok).toBe(true)
  })
})

describe('overlapping changes (review of #93)', () => {
  // The reviewer's repros, kept as tests. Fixture: the real worksheet app
  // with one HTTP response held back (a mechanical timing mutation of its
  // real answer); oracle: the worksheet server's own GET /api/state.
  it('a late, older answer never replaces a newer one: the scene matches the iPad', async () => {
    const ws = createWorksheetApp()
    const proxy = express()
    let release: () => void = () => {}
    let entered!: () => void
    const held = new Promise<void>((r) => (entered = r))
    let count = 0
    proxy.use((req, res, next) => {
      if (req.method === 'POST' && ++count === 1) {
        const json = res.json.bind(res)
        res.json = ((body: unknown) => {
          release = () => void (!res.headersSent && json(body))
          entered()
          return res
        }) as typeof res.json
      }
      next()
    })
    proxy.use(ws)
    const url = await listen(proxy)
    const ctl = createWorksheet({ base: url, publicUrl: () => null, process: { start: async () => {}, stop: async () => {} }, setRuler: () => {} })
    await ctl.setOn(true)
    const first = ctl.show({ taskIds: ['linear', 'limit'] })
    await held
    await ctl.show({ taskIds: ['linear', 'limit', 'system'] })
    release()
    await first
    const ipad = ((await (await fetch(`${url}/api/state`)).json()) as { taskIds: string[] }).taskIds
    // Catches: remembering whichever answer arrived last (the bug: the brain
    // told [linear, limit] while the iPad showed three).
    expect(ipad).toEqual(['linear', 'limit', 'system'])
    expect(ctl.status().shown?.taskIds).toEqual(ipad)
    expect(hasTask(ctl.withIpad({ intent: 'x' }).scene!.objects.find((o) => o.kind === 'tablet')!.label, 'system')).toBe(true)
  })

  it('two ticks during one cold start both succeed', async () => {
    // Catches: the second tick's setOn cancelling the first (a 502), which
    // made the menu drop the operator's picks.
    const wsUrl = await listen(createWorksheetApp())
    let release!: () => void
    const starting = new Promise<void>((r) => (release = r))
    let entered!: () => void
    const enteredStart = new Promise<void>((r) => (entered = r))
    const app = createApp(config, {
      worksheet: (setRuler) => createWorksheet({ base: wsUrl, publicUrl: () => null, process: { start: () => (entered(), starting), stop: async () => {} }, setRuler }),
    })
    const base = await listen(app)
    const post = (taskIds: string[]) => fetch(`${base}/api/operator/worksheet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true, taskIds }) })
    const first = post(['limit'])
    await enteredStart
    const second = post(['limit', 'system'])
    await new Promise((r) => setTimeout(r, 40))
    release()
    expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([200, 200])
  })

  it('unticking problem 1 leaves problem 2 as "problem 2" for the brain', async () => {
    // Catches: renumbering by position after an untick: someone said
    // "problem 2" out loud, and it must still mean the same problem.
    const { post, render } = await serverWith()
    await post('/api/operator/worksheet', { on: true, taskIds: ['optimize', 'projectile', 'system'] })
    await post('/api/operator/worksheet', { taskIds: ['projectile', 'system'] })
    const label = (await render({ intent: 'solve problem 2' })).scene!.objects.find((o) => o.kind === 'tablet')!.label!
    expect(label).toMatch(new RegExp(`problem 2: ${MANIFEST_TASKS.projectile!.lines[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    expect(label).toMatch(/problem 3: Solve the system/)
    expect(label).not.toMatch(/problem 1:/)
  })
})
