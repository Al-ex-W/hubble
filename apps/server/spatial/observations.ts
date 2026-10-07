import { z } from 'zod'
import { CAMERA_SOURCES } from './calibration.ts'

/** Source and frame identity survive the network. Receipt is timed only by the
 * server; browser performance.now is retained as source progress, never compared
 * to Pi epoch time. Without clock bounds these frames are diagnostic evidence. */
const coordinate = z.number().finite().min(-100000).max(100000)
const point = z.object({ x: coordinate, y: coordinate }).strict()
export const Observation = z
  .object({
    session: z.string().min(1).max(100),
    seq: z.number().int().nonnegative(),
    capturedAt: z.number().finite().nonnegative(),
    geometry: z.string().min(1).max(100),
    width: z.number().int().positive().max(8000),
    height: z.number().int().positive().max(8000),
    // Optional for compatibility with index-only diagnostics. These are raw
    // image joints, not a browser's decision that a pinch or touch happened.
    hands: z.array(z.object({ index: point, pinch: z.object({ thumb: point, wrist: point, middle: point }).strict().optional() }).strict()).max(2),
    input: z.object({ token: z.string().min(1).max(100), revision: z.number().int().nonnegative() }).strict().optional(),
    // Which camera (#91). Absent = the room camera: every producer written
    // before the iPad existed (HandPanel, recordings) means that one.
    source: z.enum(CAMERA_SOURCES).optional(),
  })
  .strict()
export type HandObservation = z.infer<typeof Observation>

/**
 * One frame's reference markers from one camera (#91): corners only, in that
 * camera's px. Bounded like observations: ids are the layout's, at most 32
 * markers, finite coordinates, so a client can't make the fit loop huge.
 */
const corners = z.array(point).length(4)
export const MarkerObservation = z
  .object({
    source: z.enum(CAMERA_SOURCES),
    session: z.string().min(1).max(100),
    seq: z.number().int().nonnegative(),
    geometry: z.string().min(1).max(100),
    width: z.number().int().positive().max(8000),
    height: z.number().int().positive().max(8000),
    // Unique ids (Codex review of #95, finding 4): one physical marker can't
    // be in two places in one frame, and `[11, 0, 11]` must not count as
    // three markers toward the fit's minimum of three.
    markers: z
      .array(z.object({ id: z.number().int().min(0).max(999), corners }).strict())
      .max(32)
      .refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, 'duplicate marker id'),
  })
  .strict()
export type MarkerObservationT = z.infer<typeof MarkerObservation>
