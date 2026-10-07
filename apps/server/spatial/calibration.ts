import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { H, Pair } from '@hubble/room'
import { fit, inverse, map, validTransform, type Point } from './coordinates.ts'

export interface Registration {
  sourceIdentity: string
  /** Physical table mm -> projector page px. Measured, never DEFAULT_SURFACE's assumed scale. */
  tableToProjector: H
  /** Cartesian lidar mm -> physical table mm; optical tilt is NOT corrected by a plane map. */
  lidarToTable: H
  rmsProjectorPx: number
  rmsTableMm: number
  measuredAt: string
}
export interface CameraRegistration {
  h: H
  width: number
  height: number
  geometry: string
}

/**
 * Camera sources (#91). A closed list, not any string a client sends: each
 * source holds a camera map here forever, so an open key would let any
 * client on the room Wi-Fi grow this registry without bound.
 * - room: the overhead Brio on pi-projector (dot calibration, or markers);
 * - ipad: the iPad on a stand, running /ipad-camera (markers only).
 */
export const CAMERA_SOURCES = ['room', 'ipad'] as const
export type CameraSource = (typeof CAMERA_SOURCES)[number]

/** One owner for all coordinate transforms. Camera acquisition/calibration keeps
 * its proven H28 algorithm; it installs the result here. A 180° camera rotation
 * is already in that H: applying another flip would restore the original bug.
 * Table registration is persisted separately so installing it cannot overwrite
 * the room's existing camera calibration file. Both share one revision in RAM.
 */
export function createCalibration(file?: string, sourceIdentity = 'unspecified') {
  // One camera map per source (#91). The room's is what the dot calibration
  // and every room-only reader (look(), the camera crop) use; the iPad's
  // comes only from markers. One revision for all: any map change
  // invalidates input from every source, which is the safe direction.
  const cameras = new Map<CameraSource, CameraRegistration>()
  let registration: Registration | null = null
  let revision = 0
  let loadError: string | null = null
  // A SIMULATED lidar's registration (the overall view's touch simulation) is
  // measured against a virtual pose that exists only in this process. It must
  // never reach the registration file: that file may hold the REAL room's
  // measurement (kept across restarts on purpose), and a sim run's
  // clearRegistration would delete it and its register() would overwrite it.
  // While volatile, the file is neither written nor removed.
  let volatileRegistration = false
  const observers = new Set<() => void>()
  const changed = () => {
    revision++
    for (const observer of observers) observer()
  }
  if (file && existsSync(file)) {
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as Registration
      if (r.sourceIdentity !== sourceIdentity || !validTransform(r.tableToProjector) || !validTransform(r.lidarToTable)) throw new Error('Invalid registration')
      registration = r
    } catch {
      loadError = 'Saved spatial registration is invalid; re-register measured targets'
    }
  }
  return {
    // A changed map invalidates input immediately, even if the camera has
    // stopped. Polling the revision on the next hand packet misses that edge.
    subscribe(observer: () => void) {
      observers.add(observer)
      return () => { observers.delete(observer) }
    },
    // `camera` stays the room's map for the readers written before sources
    // existed; `cameras` is every source's.
    snapshot: () => ({
      revision,
      camera: cameras.has('room') ? structuredClone(cameras.get('room')!) : null,
      cameras: Object.fromEntries([...cameras].map(([k, v]) => [k, structuredClone(v)])) as Partial<Record<CameraSource, CameraRegistration>>,
      registration: registration ? structuredClone(registration) : null,
      loadError,
    }),
    setCamera(value: CameraRegistration, source: CameraSource = 'room') {
      if (!validTransform(value.h) || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0)
        throw new Error('Invalid camera registration')
      if (JSON.stringify(cameras.get(source) ?? null) === JSON.stringify(value)) return
      cameras.set(source, structuredClone(value))
      changed()
    },
    cameraFor: (source: CameraSource) => (cameras.has(source) ? structuredClone(cameras.get(source)!) : null),
    /** Keep registrations in memory only (the simulated lidar is the source). Entering or leaving drops nothing by itself: the caller clears. */
    setVolatile(on: boolean) { volatileRegistration = on },
    clearRegistration() {
      if (file && !volatileRegistration) rmSync(file, { force: true })
      registration = null
      changed()
    },
    cameraTransform: () => (cameras.has('room') ? [...cameras.get('room')!.h] : null),
    register(input: { table: Pair[]; tableCheck: Pair[]; lidar: Pair[]; lidarCheck: Pair[]; maxProjectorErrorPx: number; maxTableErrorMm: number }) {
      const table = fit(input.table, input.tableCheck, input.maxProjectorErrorPx)
      const lidar = fit(input.lidar, input.lidarCheck, input.maxTableErrorMm)
      const next: Registration = {
        sourceIdentity,
        tableToProjector: table.h,
        lidarToTable: lidar.h,
        rmsProjectorPx: table.rms,
        rmsTableMm: lidar.rms,
        measuredAt: new Date().toISOString(),
      }
      // Persist before publishing: a failed disk write must not leave callers
      // believing a registration was saved. Rename keeps interrupted writes
      // from destroying the previous usable measurement.
      if (file && !volatileRegistration) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2))
        renameSync(`${file}.tmp`, file)
      }
      registration = next
      loadError = null
      changed()
      return this.snapshot()
    },
    cameraPoint(p: Point, width: number, height: number, geometry: string, source: CameraSource = 'room') {
      const camera = cameras.get(source)
      if (!camera || geometry !== camera.geometry || width !== camera.width || height !== camera.height) return null
      // Refuse resolution/crop changes until explicitly registered. Equal FOV
      // across room modes was observed, but arbitrary producers may crop.
      return map(camera.h, p)
    },
    /**
     * Projector page px -> camera px, the inverse of the installed camera
     * map, for the camera crop (#84): which camera pixels show a surface.
     * null without a camera calibration. Only for choosing what to look at;
     * observations still come back through cameraPoint() on the full frame.
     */
    projectorToCamera: (p: Point) => map(cameras.has('room') ? inverse(cameras.get('room')!.h) : null, p),
    /** The frame the room camera map was measured on, which every room observation must match. */
    cameraFrame: () => {
      const camera = cameras.get('room')
      return camera ? { width: camera.width, height: camera.height, geometry: camera.geometry } : null
    },
    projectorToTable: (p: Point) => map(registration ? inverse(registration.tableToProjector) : null, p),
    tableToProjector: (p: Point) => map(registration?.tableToProjector ?? null, p),
    lidarToTable: (p: Point) => map(registration?.lidarToTable ?? null, p),
  }
}
