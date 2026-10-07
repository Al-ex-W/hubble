import { expect, it } from 'vitest'
import { runStep, type Io, type Res, type StepId } from './stepRuns.ts'

// Schema-derived: each step's Run must hit the routes the plan names
// (docs/plans/2026-10-07-show-steps.md), in order. Oracle: that list, typed
// here by hand, not read from showSteps.ts.
function recorder(missing: string[] = []) {
  const calls: string[] = []
  const res = (url: string): Res =>
    missing.includes(url) ? { ok: false, status: 404, body: {} } : { ok: true, status: 200, body: { tasks: [{ n: 1, text: 'x+2=5' }], source: 'worksheet' } }
  const io: Io = {
    post: async (url) => (calls.push(`POST ${url}`), res(url)),
    get: async (url) => (calls.push(`GET ${url}`), res(url)),
    ask: async (t) => calls.push(`ASK ${t.split('\n')[1]}`),
  }
  return { io, calls }
}

const expected: Record<StepId, string[]> = {
  math: ['POST /api/operator/act', 'POST /api/operator/close-all', 'POST /api/operator/worksheet', 'POST /api/solve-page'],
  // Piano detection's own switch is part of the step (7 Oct live: 0 keys without it).
  piano: ['POST /api/operator/act', 'POST /api/operator/close-all', 'POST /api/operator/piano', 'GET /api/scene/seen'],
  keyboard: ['POST /api/operator/act', 'POST /api/operator/close-all', 'POST /api/keyboard/open'],
}

// Catches: a step skipping the act switch/clear, or calling the wrong route.
for (const id of Object.keys(expected) as StepId[]) {
  it(`${id}: Run calls its routes in order`, async () => {
    const { io, calls } = recorder()
    expect((await runStep(id, io)).ok).toBe(true)
    expect(calls).toEqual(expected[id])
  })
}

// Catches: the math step dead-ending while /api/solve-page isn't on main yet.
it('math falls back to read-task + the puppet master when solve-page is missing', async () => {
  const { io, calls } = recorder(['/api/solve-page'])
  const r = await runStep('math', io)
  expect(r.ok).toBe(true)
  expect(calls.slice(3)).toEqual(['POST /api/solve-page', 'POST /api/read-task', 'ASK 1: x+2=5'])
})
