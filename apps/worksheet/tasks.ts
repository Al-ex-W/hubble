import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The tasks the iPad can show: the notebook tasks the bench already uses
 * (packages/stage/fixtures/notebooks/manifest.json), read here and nowhere
 * else.
 *
 * Why one reader for two servers: the worksheet server draws the task on the
 * iPad, and apps/server tells the brain what it says (it imports this file).
 * If each read the manifest its own way, a task's text could differ between
 * what the person sees and what the model answers. That is the bug this
 * feature exists to remove: the camera reading paper got the text wrong.
 */

export interface WorksheetTask {
  id: string
  /** One entry per written line, top to bottom: the manifest's `lines`, from the generator itself. */
  lines: string[]
}

export const MANIFEST = fileURLToPath(new URL('../../packages/stage/fixtures/notebooks/manifest.json', import.meta.url))

export function loadWorksheetTasks(path = MANIFEST): WorksheetTask[] {
  // `lines`, never `task` split on " / ": the limit task has a division in it
  // ("sin(3x) / x"), and splitting broke it into a line that ended at "sin(3x)"
  // and a lone "x" (review round 1). Only the generator knows where lines break.
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { lines?: unknown }>
  return Object.entries(raw).flatMap(([id, v]) => (Array.isArray(v?.lines) && v.lines.every((l) => typeof l === 'string') ? [{ id, lines: v.lines as string[] }] : []))
}

/**
 * The task as one line, for the model. Not a newline: it goes inside one line
 * of the scene list in the prompt, where a newline would start a line of its
 * own. Not " / " either: that reads as division ("sin(3x) / x"). " | " never
 * appears in a task.
 */
export const taskText = (t: WorksheetTask) => t.lines.join(' | ')
