import { MAX_RIPPLES, ORB_STATES, PROFILE_SIZE } from './dynamics.ts'

/**
 * The orb is drawn per-pixel in a fragment shader. Canvas2D could only stroke
 * a polyline and fill a radial gradient, which is exactly why the old orb read
 * as a flat blob. Per-pixel lets us layer what makes it read as an energy core:
 * a liquid noise-driven membrane, swirling plasma filaments inside, a hot
 * white core, a fresnel-bright rim, arc-reactor HUD segments, an additive halo
 * and eased ripple rings — all anti-aliased and tone-mapped so bright moments
 * bloom instead of clipping.
 *
 * Coordinates are in "orb radii": p = (pixel - centre) / uR, so the resting
 * membrane is the unit circle. Every input comes from OrbFrame (dynamics.ts).
 */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
// A single full-screen triangle generated from gl_VertexID: no buffers needed.
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;

#define PROFILE_SIZE ${PROFILE_SIZE}
#define MAX_RIPPLES ${MAX_RIPPLES}
#define STATES ${ORB_STATES.length}
#define TAU 6.28318530718
#define PI 3.14159265359

uniform vec2 uRes;      // drawing-buffer size, px
uniform float uR;       // resting orb radius, px
uniform float uTime;
uniform float uEnergy;
uniform float uRadius;
uniform float uPresence;
uniform float uSwirl;
uniform float uW[STATES];             // idle, connecting, listening, thinking, speaking
uniform float uProfile[PROFILE_SIZE];
uniform vec2 uRipples[MAX_RIPPLES];   // (age 0..1, strength)

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    sum += amp * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum;
}

// Linear interpolation around the circle of the CPU-computed displacement.
float profileAt(float angle) {
  float u = fract(angle / TAU) * float(PROFILE_SIZE);
  int i0 = int(floor(u)) % PROFILE_SIZE;
  int i1 = (i0 + 1) % PROFILE_SIZE;
  return mix(uProfile[i0], uProfile[i1], fract(u));
}

// Thin ring at radius r0 broken into n segments, rotating with phase: the
// arc-reactor / HUD look.
float segmentedRing(float r, float a, float r0, float width, float n, float duty, float phase) {
  float ring = exp(-pow((r - r0) / width, 2.0));
  float seg = smoothstep(duty - 0.04, duty, fract(a / TAU * n + phase)) * (1.0 - smoothstep(0.96, 1.0, fract(a / TAU * n + phase)));
  return ring * seg;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uR;
  float r = length(p);
  float a = atan(p.y, p.x);
  float px = 1.0 / uR; // one pixel, in orb radii — for anti-aliasing

  float wIdle = uW[0], wConnect = uW[1], wListen = uW[2], wThink = uW[3], wSpeak = uW[4];
  float awake = 1.0 - wIdle;
  float e = uEnergy;

  // --- Membrane --------------------------------------------------------------
  // Slow organic wobble (angle-only noise, so it moves like a skin rather than
  // boiling), plus the audio-driven profile from dynamics.ts.
  float wob = (fbm(vec3(cos(a) * 1.4, sin(a) * 1.4, uTime * 0.23), 3) - 0.5) * (0.045 + 0.11 * e + 0.03 * wThink);
  // Entrance: the orb grows into place as presence rises from 0.
  float edge = uRadius * (0.82 + 0.18 * uPresence) * (1.0 + profileAt(a) + wob);
  float d = r - edge;
  float inside = smoothstep(px * 1.5, -px * 1.5, d);
  float rn = clamp(r / edge, 0.0, 1.0);

  // --- Palette ---------------------------------------------------------------
  // Match Liquid Studio's periwinkle accent (#becaff), including the fallback
  // orb. State still cross-fades toward violet or a lighter pearl so the shader
  // retains conversational feedback without introducing another cyan UI theme.
  vec3 periwinkle = vec3(0.745, 0.792, 1.00);
  vec3 violet = vec3(0.70, 0.58, 1.00);
  vec3 pearl = vec3(0.88, 0.92, 1.00);
  vec3 accent = periwinkle;
  accent = mix(accent, violet, wThink * 0.8 + wConnect * 0.35);
  accent = mix(accent, pearl, wSpeak * 0.45);
  vec3 deep = vec3(0.035, 0.04, 0.10);
  vec3 hot = vec3(0.92, 0.98, 1.00);

  vec3 col = vec3(0.0);

  // --- Interior ------------------------------------------------------------
  if (d < 0.05) {
    // Plasma: noise in a frame that rotates with the swirl phase and twists
    // with radius, so thinking reads as a vortex rather than a spin.
    float twist = uSwirl + r * (1.2 + 3.0 * wThink);
    mat2 rot = mat2(cos(twist), -sin(twist), sin(twist), cos(twist));
    vec2 q = rot * p;
    float n = fbm(vec3(q * 2.1, uTime * 0.28 + e * 0.6), 4);
    // Ridged noise → thin bright filaments, like current through the core.
    float filaments = pow(1.0 - abs(n * 2.0 - 1.0), 7.0);

    vec3 body = mix(deep, accent * 0.22, rn * rn);
    body += accent * filaments * (0.18 + 0.9 * e + 0.35 * wThink) * (0.35 + 0.65 * rn);
    // Fresnel: glass spheres are brightest at the limb.
    body += accent * pow(rn, 5.0) * (0.35 + 0.6 * e);
    // Hot core — the arc reactor. Breathes with energy; flares while speaking.
    float coreR = 0.16 + 0.10 * e + 0.05 * wSpeak;
    body += hot * exp(-pow(r / coreR, 2.0)) * (0.55 + 1.3 * e + 0.25 * wSpeak);
    body += accent * exp(-pow(r / (coreR * 2.6), 2.0)) * 0.35;
    // HUD rings inside the core, counter-rotating.
    body += accent * segmentedRing(r, a, 0.42 * edge, 0.010, 24.0, 0.35, uSwirl * 0.25) * 0.55 * awake;
    body += accent * segmentedRing(r, a, 0.68 * edge, 0.006, 60.0, 0.55, -uSwirl * 0.12) * 0.35 * awake;
    col += body * inside;
  }

  // --- Rim -------------------------------------------------------------------
  float rimWidth = 0.010 + 0.022 * e;
  col += mix(accent, hot, 0.35 + 0.4 * e) * exp(-abs(d) / rimWidth) * (0.75 + 1.6 * e);

  // --- Halo (additive bloom outside the membrane) ---------------------------
  float outside = max(d, 0.0);
  col += accent * exp(-outside * (5.0 - 2.2 * e)) * (0.18 + 0.75 * e) * (1.0 - inside * 0.6);

  // --- Thinking / connecting comets -----------------------------------------
  // Two highlights orbit the rim with fading tails: unmistakably "working".
  float cometAmt = wThink + wConnect * 0.7;
  if (cometAmt > 0.001) {
    for (int k = 0; k < 2; k++) {
      float head = uSwirl * 1.4 + float(k) * PI;
      float da = mod(a - head + PI, TAU) - PI; // signed angle to the head
      float tail = da < 0.0 ? exp(da * 1.6) : exp(-da * 30.0);
      float band = exp(-abs(d) / 0.03);
      col += mix(violet, hot, 0.6) * tail * band * cometAmt * 2.4;
    }
  }

  // --- Ripples ---------------------------------------------------------------
  for (int i = 0; i < MAX_RIPPLES; i++) {
    float age = uRipples[i].x;
    float strength = uRipples[i].y;
    if (strength <= 0.0) continue;
    // Ease-out: rings leave fast and decelerate, like a real wave.
    float travel = 1.0 - pow(1.0 - age, 3.0);
    float rr = uRadius * (1.03 + travel * 0.85);
    float width = 0.008 + 0.03 * age;
    float fade = pow(1.0 - age, 1.8);
    col += accent * exp(-pow((r - rr) / width, 2.0)) * fade * strength * 0.9 * (1.0 - inside);
  }

  // --- Outer HUD ring --------------------------------------------------------
  col += accent * segmentedRing(r, a, uRadius * 1.38, 0.004, 90.0, 0.6, uSwirl * 0.05) * 0.22 * awake * (1.0 - wSpeak * 0.5);

  // --- Finish ----------------------------------------------------------------
  col *= uPresence;
  col = 1.0 - exp(-col * 1.35);                              // soft tone map
  col += (hash(vec3(gl_FragCoord.xy, uTime)) - 0.5) / 255.0;  // dither out banding
  col = max(col, 0.0);
  // Premultiplied output with alpha = brightest channel: the orb composites
  // over the page like light, not like a painted disc.
  float alpha = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  outColor = vec4(min(col, vec3(alpha)), alpha);
}`
