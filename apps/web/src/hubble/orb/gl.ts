import type { OrbFrame } from './dynamics.ts'
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader.ts'

/**
 * Thin WebGL2 host for the orb shader: compile once, upload OrbFrame as
 * uniforms each frame, draw one triangle. Returns null when WebGL2 is not
 * available so the caller can show a fallback instead of a blank canvas.
 */
export interface OrbRenderer {
  /** Resizes the drawing buffer if needed and draws one frame. */
  render(frame: OrbFrame, cssWidth: number, cssHeight: number): void
  dispose(): void
}

// The canvas spans the whole stage so the halo and ripples are never clipped
// by a box. Rendering that at full retina resolution costs ~4× the pixels for
// a soft, glowing subject that does not need it, so cap the density.
const MAX_DPR = 1.5
/** Resting orb radius as a share of the shorter canvas side, capped in CSS px
 * so a huge window gets a bigger stage, not a monstrous orb. Ripples reach
 * ~1.9 radii, which must stay inside half the short side. */
const RADIUS_SHARE = 0.24
const MAX_RADIUS_CSS = 230

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`orb shader failed to compile: ${log}`)
  }
  return shader
}

export function orbRadiusCss(cssWidth: number, cssHeight: number): number {
  return Math.min(Math.min(cssWidth, cssHeight) * RADIUS_SHARE, MAX_RADIUS_CSS)
}

export function createOrbRenderer(canvas: HTMLCanvasElement): OrbRenderer | null {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true })
  if (!gl) return null

  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`orb shader failed to link: ${gl.getProgramInfoLog(program)}`)
  }
  gl.useProgram(program)
  // WebGL2 still wants a bound VAO for drawArrays even with no attributes.
  gl.bindVertexArray(gl.createVertexArray())

  const u = (name: string) => gl.getUniformLocation(program, name)
  const loc = {
    res: u('uRes'),
    r: u('uR'),
    time: u('uTime'),
    energy: u('uEnergy'),
    radius: u('uRadius'),
    presence: u('uPresence'),
    swirl: u('uSwirl'),
    weights: u('uW'),
    profile: u('uProfile'),
    ripples: u('uRipples'),
  }

  return {
    render(frame, cssWidth, cssHeight) {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const w = Math.max(1, Math.round(cssWidth * dpr))
      const h = Math.max(1, Math.round(cssHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(loc.res, w, h)
      gl.uniform1f(loc.r, orbRadiusCss(cssWidth, cssHeight) * dpr)
      gl.uniform1f(loc.time, frame.time)
      gl.uniform1f(loc.energy, frame.energy)
      gl.uniform1f(loc.radius, frame.radius)
      gl.uniform1f(loc.presence, frame.presence)
      gl.uniform1f(loc.swirl, frame.swirl)
      gl.uniform1fv(loc.weights, frame.weights)
      gl.uniform1fv(loc.profile, frame.profile)
      gl.uniform2fv(loc.ripples, frame.ripples)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      // Only free our program. Do NOT force-lose the context: a canvas hands
      // back the same context on the next getContext(), so a remount (React
      // StrictMode does one in dev) would get a dead context and fail to
      // compile.
      gl.deleteProgram(program)
    },
  }
}
