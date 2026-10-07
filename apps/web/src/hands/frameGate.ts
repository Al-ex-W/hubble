/**
 * True once per new camera frame. The live loop runs on animation frames,
 * which come at the display's rate; the camera's frames come at its own,
 * usually slower, rate. A video's currentTime only advances when a new frame
 * is presented, so an unchanged time means "the same picture again", and
 * feeding it to the gesture machine again would count one observation twice
 * (two copies of a noisy pinched sample = a confirmed pinch). Review #42.
 */
export function createFrameGate() {
  let last = Number.NaN
  return (currentTime: number): boolean => {
    if (currentTime === last) return false
    last = currentTime
    return true
  }
}
