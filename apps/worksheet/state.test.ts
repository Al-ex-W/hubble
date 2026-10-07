import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createWorksheetState, MAX_PICKS } from './state.ts'
import { loadWorksheetTasks, MANIFEST, taskText } from './tasks.ts'

// Fixture: the committed notebooks manifest (labelled synthetic in the file
// itself), the same one the bench's photos come from.
const tasks = loadWorksheetTasks()

describe('worksheet tasks', () => {
  it('serves every manifest task, exactly ten', () => {
    // Catches: a moved or emptied manifest leaving the iPad with nothing (or
    // a silently shrunk set) to show. Pinned, so shrinking fails loudly.
    const ids = Object.keys(JSON.parse(readFileSync(MANIFEST, 'utf8')))
    expect(tasks.map((t) => t.id)).toEqual(ids)
    expect(tasks).toHaveLength(10)
  })

  it('keeps every line exactly as the generator wrote it', () => {
    // Catches: the brain being told a different text than the iPad shows. The
    // oracle is the raw manifest, not the loader.
    const raw = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, { lines: string[] }>
    for (const t of tasks) {
      expect(t.lines).toEqual(raw[t.id]!.lines)
      for (const l of raw[t.id]!.lines) expect(taskText(t)).toContain(l)
    }
  })

  it('keeps the limit task\'s division on its line', () => {
    // Review round 1: splitting the flat "task" on " / " broke
    // "lim (x→0) sin(3x) / x" into "...sin(3x)" and a lone "x".
    const limit = tasks.find((t) => t.id === 'limit')!
    expect(limit.lines).toHaveLength(2)
    expect(limit.lines[1]).toMatch(/sin\(3x\) \/ x$/)
  })
})

describe('worksheet state', () => {
  it('switches task and size, and tells every listener', () => {
    const s = createWorksheetState(tasks)
    const seen: string[] = []
    s.onChange((v) => seen.push(`${v.taskId}@${v.textMm}`))
    expect(s.set({ taskId: 'system' }).ok).toBe(true)
    expect(s.set({ textMm: 12 }).ok).toBe(true)
    expect(seen).toEqual(['system@8', 'system@12'])
  })

  it('refuses a bad patch whole, changing nothing', () => {
    // Catches: an unknown task (the brain would have no text for it) or a
    // half-applied patch (the task changed, the size error shown, the
    // operator thinks nothing happened).
    const s = createWorksheetState(tasks)
    const before = s.get()
    expect(s.set({ taskId: 'limit', textMm: 99 }).ok).toBe(false)
    expect(s.set({ taskId: 'constructor' }).ok).toBe(false)
    expect(s.set({ textMm: '12' }).ok).toBe(false)
    expect(s.set({ textMm: 3.9 }).ok).toBe(false)
    expect(s.get()).toBe(before)
  })
})

describe('a few problems on one sheet (#88)', () => {
  it('numbers new problems in the order sent, and sorts the sheet by number', () => {
    // Catches: sorting the picks into manifest order. The default sheet
    // shows linear as problem 1, so it keeps 1 and the others follow.
    const s = createWorksheetState(tasks)
    expect(s.set({ taskIds: ['linear', 'limit', 'system'] }).ok).toBe(true)
    expect(s.get().taskIds).toEqual(['linear', 'limit', 'system'])
    expect(s.get().numbers).toEqual([1, 2, 3])
    expect(s.get().tasks.map((t) => t.id)).toEqual(['linear', 'limit', 'system'])
    // The pre-#88 fields follow problem 1, so an older reader sees it.
    expect(s.get().taskId).toBe('linear')
    expect(s.get().task.id).toBe('linear')
  })

  it('keeps every shown problem\'s number when another is unticked or ticked (review #93)', () => {
    // Catches: renumbering after an untick. Someone said "problem 2" out
    // loud; unticking problem 1 must not make "problem 2" another problem.
    // A new tick takes the lowest free number (the gap), not the end.
    const s = createWorksheetState(tasks)
    s.set({ taskIds: ['linear', 'projectile', 'system', 'inequality'] })
    expect(s.get().numbers).toEqual([1, 2, 3, 4])
    s.set({ taskIds: ['projectile', 'system', 'inequality'] })
    expect(s.get().taskIds).toEqual(['projectile', 'system', 'inequality'])
    expect(s.get().numbers).toEqual([2, 3, 4])
    s.set({ taskIds: ['projectile', 'system', 'inequality', 'limit'] })
    expect(s.get().taskIds).toEqual(['limit', 'projectile', 'system', 'inequality'])
    expect(s.get().numbers).toEqual([1, 2, 3, 4])
  })

  it('bumps the revision on every change and only then (review #93)', () => {
    // Catches: a revision that stands still, which would let the main
    // server keep an older answer that arrived late.
    const s = createWorksheetState(tasks)
    const r0 = s.get().rev
    s.set({ taskIds: ['limit'] })
    s.set({ textMm: 9 })
    expect(s.get().rev).toBe(r0 + 2)
    s.set({ taskIds: ['nope'] })
    expect(s.get().rev).toBe(r0 + 2)
  })

  it('takes up to four, and still takes a single taskId as one problem', () => {
    // Catches: an off-by-one at the cap, and Setup's picker (taskId) breaking.
    expect(MAX_PICKS).toBe(4)
    const s = createWorksheetState(tasks)
    expect(s.set({ taskIds: ['linear', 'quadratic', 'system', 'projectile'] }).ok).toBe(true)
    expect(s.get().taskIds).toHaveLength(4)
    expect(s.set({ taskId: 'integral' }).ok).toBe(true)
    expect(s.get().taskIds).toEqual(['integral'])
  })

  it('refuses a bad list whole, changing nothing', () => {
    // Catches, one each: a fifth problem (off the iPad's screen), a problem
    // numbered twice, an empty sheet, a task the brain has no text for, a
    // non-list, and taskId + taskIds disagreeing about what is shown.
    const s = createWorksheetState(tasks)
    s.set({ taskIds: ['linear', 'limit'] })
    const before = s.get()
    const bad: unknown[] = [
      { taskIds: ['linear', 'quadratic', 'system', 'projectile', 'limit'] },
      { taskIds: ['linear', 'linear'] },
      { taskIds: [] },
      { taskIds: ['linear', 'nope'] },
      { taskIds: 'linear' },
      { taskId: 'system', taskIds: ['system'] },
      { taskIds: ['system'], textMm: 99 },
    ]
    for (const p of bad) expect(s.set(p as object).ok, JSON.stringify(p)).toBe(false)
    expect(s.get()).toBe(before)
  })
})
