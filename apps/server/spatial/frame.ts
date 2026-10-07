import { hitTest, type Surface, type SurfaceSet, type TableSurface } from '@hubble/stage'
import type { LidarFrame, LidarSourceHealth } from '@hubble/room'
import type { CameraSource, createCalibration } from './calibration.ts'
import type { Point } from './coordinates.ts'
import type { HandObservation } from './observations.ts'

export type SpatialSurface = Pick<TableSurface, 'id' | 'kind' | 'instance' | 'box' | 'z'>
export interface LocalizedPoint {
  projector: Point | null
  table: Point | null
  surfaceId: string | null
  /** Coordinates within the topmost surface's drawn box. These are page pixels,
   * not a claim that the surface scale has been physically measured. */
  surface: { id: string; instance: number; localPx: Point; normalized: Point | null } | null
}
export interface LocalizedHand extends LocalizedPoint {
  index: number
  camera: Point
  pen: LocalizedPoint | null
  pinch: number | null
  heightMm: null
  contact: 'unknown'
}

/** The public contract for HTTP, stream and in-process features. A publication
 * reconciles the latest evidence under ONE map and surface geometry. It is NOT
 * a synchronized camera/lidar acquisition: receipt freshness and source progress
 * cannot bound acquisition time on the room's variable Wi-Fi.
 *
 * seq identifies a publication in this service session. Camera session/seq and
 * lidar sourceSession/seq identify measurements. Consumers must count those,
 * never publication seq, when confirming a gesture. Age is measured at atMonoMs;
 * frames publish on state changes, not on every millisecond of elapsed time.
 */
export interface SpatialFrame {
  schema: 'SpatialFrame/v2'
  session: string
  seq: number
  atMonoMs: number
  state: 'running' | 'stopped'
  mode: 'diagnostic'
  calibrated: boolean
  /** Lidar touch is live: registered, baselined, receiving. A beam crossing, not pressure (#89). */
  touchEnabled: boolean
  reason: string
  coordinates: { table: string; projector: string; height: string }
  surface: Surface
  surfaces: SpatialSurface[]
  calibration: ReturnType<ReturnType<typeof createCalibration>['snapshot']>
  camera: {
    state: 'unavailable' | 'stale' | 'uncalibrated' | 'geometry-mismatch' | 'receiving'
    /** Which camera this frame is from (#91): the live, calibrated source with the best measured rate. */
    source: CameraSource | null
    /** Every source that has sent a frame: fresh, its measured fps, whether it has a map. */
    sources: { id: CameraSource; fresh: boolean; fps: number | null; calibrated: boolean }[]
    frame: HandObservation | null
    calibrationRevision: number | null
    receivedAtMonoMs: number | null
    ageMs: number | null
    acquisitionAgeMs: null
    fingers: LocalizedHand[]
  }
  lidar: {
    health: LidarSourceHealth | null
    frame: LidarFrame | null
    calibrationRevision: number | null
    /** The empty-table baseline (#89): taken explicitly with hands clear, kept in memory only. */
    baseline: { state: 'none' | 'capturing' | 'ready'; rotations: number }
    /** Live lidar touches. `candidate` = seen once (the ripple fires); `down` = confirmed (keyboard semantics). */
    touches: SpatialTouch[]
    returns: (LocalizedPoint & { sensor: Point; quality: number })[]
  }
}

export interface SpatialTouch {
  id: number
  phase: 'candidate' | 'down'
  table: Point
  projector: Point | null
  spanMm: number
}

/** Runtime owns surfaces. The spatial service observes that owner; it never
 * creates a second editable registry or imports a feature's state reducer. */
export interface SpatialSurfaces {
  list(): SurfaceSet
  bounds(): Surface
  subscribe(observer: () => void): () => void
}

export function hitSpatialSurface(frame: Pick<SpatialFrame, 'surfaces'>, point: Point): string | null {
  // Reuse stage's stacking/edge semantics. Its full TableSurface type also
  // carries presentation state, deliberately absent from this geometry API.
  return hitTest(frame.surfaces.map(s => ({ ...s, state: {}, focused: false, pinned: false })), point)
}
