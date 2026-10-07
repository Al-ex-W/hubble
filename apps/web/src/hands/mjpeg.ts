/**
 * The one MJPEG parser lives in apps/shared/hands/mjpeg.ts (#84), where the
 * server's camera manager and this browser reader share it. This file is only
 * the browser's import path so nothing here holds a second copy that could
 * drift from the server's.
 */
export { createMjpegParser } from '../../../shared/hands/mjpeg.ts'
