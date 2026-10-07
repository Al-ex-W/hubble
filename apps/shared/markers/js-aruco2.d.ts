// js-aruco2 ships no types. detect.ts declares the small surface it uses
// (ArucoNamespace) and casts once; these only let the imports resolve.
declare module 'js-aruco2' {
  const aruco: unknown
  export default aruco
}
declare module 'js-aruco2/src/dictionaries/aruco_4x4_1000.js'
