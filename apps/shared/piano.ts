/** Camera-space only: the operator inspects what OpenCV saw, while the
 * runtime alone maps it onto the projector. Importing this contract never
 * pulls room clients, credentials or Node modules into the browser. */
export type CameraPoint = { x: number; y: number }
export type CameraQuad = [CameraPoint, CameraPoint, CameraPoint, CameraPoint]
export interface PianoKey {
  note: number
  black: boolean
  corners: CameraQuad
}
export interface PianoSnapshot {
  id: number
  capturedAt: number
  image: string
  width: number
  height: number
  keys: PianoKey[]
  keybed: CameraQuad | null
  trackerStatus: string | null
}
export interface PianoState {
  enabled: boolean
  available: boolean
  calibrated: boolean
  status: 'off' | 'no-camera' | 'searching' | 'tracking' | 'last-known' | 'detector-unavailable' | 'camera-unavailable'
  ageMs: number | null
  snapshot: PianoSnapshot | null
}
