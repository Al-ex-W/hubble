"""
Simulated overhead camera for the keyboard act.

The real MiniLab (cut out of a product shot) lies on black cloth seen from
above. It gets moved and rotated, hand-shaped blobs hover over it and play
on it, the projector washes everything in light and lights one key green, and
the camera adds keystone, blur, noise and JPEG. The keyboard's size in the
frame varies widely, because the camera's distance and resolution are not
known in advance: nothing in the detector or tracker may assume a pixel scale.

Ground truth: the detector's result on the clean source image (checked by eye
on the overlays in out/), carried through the exact transform used to place
the keyboard. Label: mechanical mutation of a product shot, not a recording.
Errors are reported in white-key widths, so they are scale-free.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from detect import WHITE_KEYS, detect, draw
from track import Tracker

HERE = Path(__file__).parent
BODY_MM = 355.0  # MiniLab 3 body width (assumed from Arturia's spec), only to size hands

# --------------------------------------------------------------- the sprite


@dataclass
class Sprite:
    img: np.ndarray
    alpha: np.ndarray
    keys: list[np.ndarray]  # 25 quads in sprite px (ground truth)
    black: list[bool]
    names: list[str]
    body_w: float  # body width in sprite px
    center: np.ndarray


_SPRITES: dict[str, Sprite] = {}


def load_sprite(name: str) -> Sprite:
    if name in _SPRITES:
        return _SPRITES[name]
    path = HERE / "reference" / f"white-topdown-{name}.jpg"
    img = cv2.imread(str(path))
    h, w = img.shape[:2]
    # The product background is pure white; flood it from the border. The body
    # (226-245) and its edge shading stop the fill.
    mask = np.zeros((h + 2, w + 2), np.uint8)
    work = img.copy()
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        cv2.floodFill(work, mask, seed, (0, 0, 0), (3, 3, 3), (3, 3, 3), cv2.FLOODFILL_FIXED_RANGE | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    bg = mask[1:-1, 1:-1] > 0
    alpha = (~bg).astype(np.float32)
    alpha = cv2.erode(alpha, np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    ys, xs = np.where(alpha > 0.5)
    res = detect(img)
    sp = Sprite(
        img=img,
        alpha=alpha,
        keys=[np.array(k["corners"]) for k in res.keys],
        black=[k["black"] for k in res.keys],
        names=[k["name"] for k in res.keys],
        body_w=float(xs.max() - xs.min()),
        center=np.array([(xs.max() + xs.min()) / 2, (ys.max() + ys.min()) / 2]),
    )
    _SPRITES[name] = sp
    return sp


# ------------------------------------------------------------------ geometry


def place_matrix(sp: Sprite, cx: float, cy: float, angle: float, width_px: float) -> np.ndarray:
    """Sprite px -> canvas px: scale the body to width_px, rotate, translate."""
    s = width_px / sp.body_w
    a = math.radians(angle)
    c, si = math.cos(a), math.sin(a)
    T0 = np.array([[1, 0, -sp.center[0]], [0, 1, -sp.center[1]], [0, 0, 1]])
    RS = np.array([[s * c, -s * si, 0], [s * si, s * c, 0], [0, 0, 1]])
    T1 = np.array([[1, 0, cx], [0, 1, cy], [0, 0, 1]])
    return T1 @ RS @ T0


def keystone(W: int, H: int, k: float, seed: int) -> np.ndarray:
    """A mild camera homography: corners pulled in by up to k of the frame.
    The room camera sits beside the projector lens, "close to top view but not
    exact" (organisers' spec)."""
    rng = np.random.default_rng(seed)
    src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    d = rng.uniform(-k, k, (4, 2)) * [W, H]
    return cv2.getPerspectiveTransform(src, (src + d).astype(np.float32))


def tf(M: np.ndarray, pts) -> np.ndarray:
    p = np.asarray(pts, np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(p, M).reshape(-1, 2)


# --------------------------------------------------------------------- hands


SKIN = [(120, 150, 200), (95, 125, 175), (70, 95, 140), (150, 175, 215)]


@dataclass
class Hand:
    tips: np.ndarray  # 4 fingertip points (index..pinky), canvas px
    direction: np.ndarray  # unit vector the fingers point to
    px_per_mm: float
    height: float = 0.0  # 0 = on the keys, 1 = hovering high (bigger, shadow further)
    skin: int = 0
    thumb_side: float = -1.0  # -1: thumb on the left of the hand (right hand seen from above)


def _capsule(img, a, b, r, color):
    a, b = np.round(a).astype(int), np.round(b).astype(int)
    cv2.line(img, tuple(a), tuple(b), color, max(1, int(round(2 * r))), cv2.LINE_AA)
    cv2.circle(img, tuple(a), max(1, int(round(r))), color, -1, cv2.LINE_AA)
    cv2.circle(img, tuple(b), max(1, int(round(r))), color, -1, cv2.LINE_AA)


def draw_hand(canvas: np.ndarray, h: Hand) -> None:
    """A top-down hand: forearm, palm, four fingers, thumb, and its shadow.
    Shapes in millimetres so a hand is always hand-sized next to the keyboard."""
    g = h.px_per_mm * (1 + 0.25 * h.height)  # hovering = closer to camera = bigger
    d = h.direction / np.linalg.norm(h.direction)
    side = np.array([-d[1], d[0]])
    tips = h.tips
    knuckles = tips - d * 62 * g
    palm_c = knuckles.mean(0) - d * 45 * g
    wrist = palm_c - d * 55 * g
    elbow = wrist - d * 400 * g
    color = SKIN[h.skin % len(SKIN)]

    layer = np.zeros_like(canvas)
    mask = np.zeros(canvas.shape[:2], np.uint8)

    def shape(target, col):
        _capsule(target, wrist, elbow, 32 * g, col)
        cv2.ellipse(target, tuple(np.round(palm_c).astype(int)), (int(46 * g), int(52 * g)), math.degrees(math.atan2(side[1], side[0])), 0, 360, col, -1, cv2.LINE_AA)
        for k, t in zip(knuckles, tips):
            _capsule(target, k, t, 8.5 * g, col)
        th0 = palm_c + side * h.thumb_side * 38 * g
        th1 = th0 + (d * 0.6 + side * h.thumb_side * 0.8) * 55 * g
        _capsule(target, th0, th1, 10 * g, col)

    # Shadow: projector light from above, slightly offset; further when hovering.
    sh = np.zeros(canvas.shape[:2], np.uint8)
    shape(sh, 255)
    off = (6 + 30 * h.height) * h.px_per_mm
    M = np.float32([[1, 0, off * 0.6], [0, 1, off]])
    sh = cv2.warpAffine(sh, M, (canvas.shape[1], canvas.shape[0]))
    sh = cv2.GaussianBlur(sh, (0, 0), max(1.0, (3 + 10 * h.height) * h.px_per_mm))
    canvas[:] = (canvas * (1 - 0.45 * sh[..., None] / 255.0)).astype(np.uint8)

    shape(layer, color)
    shape(mask, 255)
    # Soft shading so a hand isn't a flat cut-out.
    yy, xx = np.mgrid[0 : canvas.shape[0], 0 : canvas.shape[1]]
    shade = 0.85 + 0.15 * np.cos((xx * side[0] + yy * side[1]) / (40 * g))
    layer = np.clip(layer * shade[..., None], 0, 255).astype(np.uint8)
    m = cv2.GaussianBlur(mask, (3, 3), 0)[..., None] / 255.0
    canvas[:] = (canvas * (1 - m) + layer * m).astype(np.uint8)


def hand_on_keys(truth_keys, black, white_from: int, px_per_mm: float, along: float = 0.35, **kw) -> Hand:
    """Fingertips on four neighbouring white keys, `along` of the way from the
    near edge, fingers pointing away from the player (how you'd really play)."""
    whites = [q for q, b in zip(truth_keys, black) if not b]
    tips = []
    for i in range(white_from, white_from + 4):
        q = whites[max(0, min(len(whites) - 1, i))]
        near = (q[0] + q[1]) / 2
        far = (q[2] + q[3]) / 2
        tips.append(near + (far - near) * along)
    tips = np.array(tips)
    q = whites[min(len(whites) - 1, white_from)]
    d = (q[2] + q[3]) / 2 - (q[0] + q[1]) / 2
    return Hand(tips=tips, direction=d, px_per_mm=px_per_mm, **kw)


# --------------------------------------------------------------- the frames


@dataclass
class FrameSpec:
    cx: float
    cy: float
    angle: float
    width_px: float
    hands: list[dict] = field(default_factory=list)  # {white_from, along, height, skin, dx, dy}
    lit: int | None = None  # key index lit green by the projector
    moving: bool = False


def render(spec: FrameSpec, opts: dict) -> tuple[np.ndarray, list[np.ndarray]]:
    W, H = opts["W"], opts["H"]
    sp = load_sprite(opts.get("source", "photo"))
    rng = np.random.default_rng(opts["seed"] * 7919 + int(spec.cx * 13 + spec.cy * 7 + spec.angle * 101))
    # Black cloth with a little weave.
    cloth = np.full((H, W, 3), opts.get("cloth", 22), np.uint8)
    cloth = np.clip(cloth.astype(np.int16) + rng.normal(0, 3, (H, W, 1)).astype(np.int16), 0, 255).astype(np.uint8)

    M = place_matrix(sp, spec.cx, spec.cy, spec.angle, spec.width_px)
    s = spec.width_px / sp.body_w
    src, alpha = sp.img, sp.alpha
    if s < 1:
        # Area-average first: warpPerspective alone aliases badly when shrinking
        # a lot, which would make small keyboards look worse than a real camera.
        nw, nh = max(1, int(round(src.shape[1] * s))), max(1, int(round(src.shape[0] * s)))
        sx, sy = nw / src.shape[1], nh / src.shape[0]
        src = cv2.resize(src, (nw, nh), interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(alpha, (nw, nh), interpolation=cv2.INTER_AREA)
        P = np.array([[sx, 0, 0.5 * sx - 0.5], [0, sy, 0.5 * sy - 0.5], [0, 0, 1]])
        Mw = M @ np.linalg.inv(P)
    else:
        Mw = M
    kb = cv2.warpPerspective(src, Mw, (W, H), flags=cv2.INTER_LINEAR)
    ka = cv2.warpPerspective(alpha, Mw, (W, H), flags=cv2.INTER_LINEAR)[..., None]
    frame = (cloth * (1 - ka) + kb * ka).astype(np.uint8)
    truth = [tf(M, q) for q in sp.keys]

    px_per_mm = spec.width_px / BODY_MM
    # Our own projection: one key lit green (light adds, so a lit black key
    # turns grey-green, which can hide it from the black-key finder).
    if spec.lit is not None:
        lay = np.zeros_like(frame)
        cv2.fillConvexPoly(lay, np.round(truth[spec.lit]).astype(np.int32), (40, 200, 40), cv2.LINE_AA)
        frame = cv2.add(frame, (lay * 0.6).astype(np.uint8))
    for hd in spec.hands:
        h = hand_on_keys(truth, sp.black, hd.get("white_from", 4), px_per_mm, hd.get("along", 0.35), height=hd.get("height", 0.0), skin=hd.get("skin", 0), thumb_side=hd.get("thumb_side", -1.0))
        h.tips = h.tips + np.array([hd.get("dx", 0.0), hd.get("dy", 0.0)]) * px_per_mm
        draw_hand(frame, h)

    # Projector wash and exposure.
    wash = np.array(opts.get("tint", [1.0, 1.0, 1.0]), np.float32) * opts.get("brightness", 1.0)
    frame = np.clip(frame.astype(np.float32) * wash + opts.get("ambient", 6), 0, 255).astype(np.uint8)

    # Camera: keystone, blur, noise, JPEG.
    K = keystone(W, H, opts.get("keystone", 0.03), opts["seed"])
    frame = cv2.warpPerspective(frame, K, (W, H), borderValue=(opts.get("cloth", 22),) * 3)
    truth = [tf(K, q) for q in truth]
    if opts.get("blur", 0.6) > 0:
        frame = cv2.GaussianBlur(frame, (0, 0), opts.get("blur", 0.6))
    if opts.get("noise", 3) > 0:
        frame = np.clip(frame.astype(np.int16) + rng.normal(0, opts.get("noise", 3), frame.shape).astype(np.int16), 0, 255).astype(np.uint8)
    q = int(opts.get("jpeg", 80))
    if q < 100:
        frame = cv2.imdecode(cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, q])[1], cv2.IMREAD_COLOR)
    return frame, truth


# ------------------------------------------------------------------ scenarios


def _lerp(a, b, u):
    return a + (b - a) * u


def scenario(name: str, opts: dict) -> list[FrameSpec]:
    W, H = opts["W"], opts["H"]
    wpx = opts.get("width_px", 0.45 * W)
    cx, cy, ang = W * 0.5, H * 0.5, opts.get("angle", 0.0)
    n = opts.get("frames", 40)
    out: list[FrameSpec] = []
    if name == "static":
        out = [FrameSpec(cx, cy, ang, wpx) for _ in range(n)]
    elif name == "hover":
        # A hand sweeps across above the keys, high and low.
        for i in range(n):
            u = i / max(1, n - 1)
            out.append(FrameSpec(cx, cy, ang, wpx, hands=[dict(white_from=int(_lerp(-3, 14, u)), along=0.6, height=0.6 + 0.4 * math.sin(u * 6))]))
    elif name == "play":
        # A right hand plays around the middle, fingers shifting, a key lit green.
        for i in range(n):
            wf = 5 + int(2 * math.sin(i / 5))
            out.append(FrameSpec(cx, cy, ang, wpx, hands=[dict(white_from=wf, along=0.3 + 0.05 * math.sin(i / 2), dy=2 * math.sin(i))], lit=(i // 4) % 25))
    elif name == "two_hands":
        for i in range(n):
            out.append(
                FrameSpec(
                    cx, cy, ang, wpx,
                    hands=[dict(white_from=1 + int(math.sin(i / 6)), along=0.3, skin=1, thumb_side=1.0), dict(white_from=8 + int(math.cos(i / 5)), along=0.3, skin=1)],
                    lit=(i // 3) % 25,
                )
            )
    elif name == "move":
        # The keyboard is slid and turned to a new place, with pauses.
        poses = [(cx, cy, ang), (cx - 0.15 * W, cy + 0.1 * H, ang + 25), (cx + 0.12 * W, cy - 0.08 * H, ang - 40), (cx, cy, ang + 180)]
        per = max(4, n // (2 * (len(poses) - 1)))
        for (x0, y0, a0), (x1, y1, a1) in zip(poses, poses[1:]):
            for i in range(per):
                u = (1 - math.cos(math.pi * i / per)) / 2
                out.append(FrameSpec(_lerp(x0, x1, u), _lerp(y0, y1, u), _lerp(a0, a1, u), wpx, moving=True))
            out += [FrameSpec(x1, y1, a1, wpx) for _ in range(per)]
    elif name == "hand_moves_it":
        # A hand rests on the keys while it drags the keyboard sideways.
        for i in range(n):
            u = min(1.0, max(0.0, (i - n * 0.2) / (n * 0.5)))
            x = _lerp(cx - 0.12 * W, cx + 0.12 * W, (1 - math.cos(math.pi * u)) / 2)
            out.append(FrameSpec(x, cy, ang + 10 * u, wpx, hands=[dict(white_from=10, along=0.25, skin=2)], moving=0 < u < 1))
    elif name == "scale_sweep":
        # Camera distance unknown: the keyboard goes from tiny to frame-filling.
        # Largest size that still fits the frame at this rotation (the real
        # keyboard is always fully on the table, so fully in view).
        sp = load_sprite(opts.get("source", "photo"))
        aspect = sp.alpha.shape[0] / sp.alpha.shape[1]
        fit = min(
            min(0.97 * W / (abs(math.cos(a)) + aspect * abs(math.sin(a))), 0.97 * H / (abs(math.sin(a)) + aspect * abs(math.cos(a))))
            for a in np.radians(ang + np.linspace(-15, 15, 7))
        ) / W
        lo, hi = opts.get("scale_lo", 0.12), min(opts.get("scale_hi", 0.92), fit)
        for i in range(n):
            u = i / max(1, n - 1)
            w = W * lo * (hi / lo) ** u
            out.append(FrameSpec(cx, cy, ang + 15 * math.sin(u * 3), w))
    elif name == "story":
        # The demo, start to end: placed, played, nudged, played with two hands.
        out = scenario("static", {**opts, "frames": 6}) + scenario("play", {**opts, "frames": 16})
        out += scenario("hand_moves_it", {**opts, "frames": 20})
        last = out[-1]
        out += [FrameSpec(last.cx, last.cy, last.angle, wpx, hands=[dict(white_from=1, along=0.3, thumb_side=1.0), dict(white_from=8, along=0.3)], lit=(i // 3) % 25) for i in range(16)]
    else:
        raise ValueError(f"unknown scenario {name}")
    return out


SCENARIOS = {
    "static": "Keyboard lies still, nothing on it",
    "hover": "A hand sweeps over the keys, hovering high and low",
    "play": "A right hand plays mid-keyboard, a key lit green by the projector",
    "two_hands": "Two hands on the keys, most black keys hidden",
    "move": "The keyboard is slid and rotated to new places, including upside down",
    "hand_moves_it": "A hand on the keys drags the keyboard sideways",
    "scale_sweep": "Unknown camera distance: keyboard from tiny to frame-filling",
    "story": "Demo story: placed, played, nudged, two hands",
}


# ------------------------------------------------------------------- running


def key_errors(pred: list[dict], truth: list[np.ndarray], white_px: float) -> tuple[float, bool]:
    """(max corner error in white-key widths, every key's centre inside its
    true quad). The second is what the demo needs: the right key lights."""
    worst, inside = 0.0, True
    for k, t in zip(pred, truth):
        p = np.array(k["corners"])
        worst = max(worst, float(np.linalg.norm(p - t, axis=1).max()))
        c = p.mean(0)
        if cv2.pointPolygonTest(t.astype(np.float32), (float(c[0]), float(c[1])), False) < 0:
            inside = False
    return worst / max(white_px, 1e-6), inside


def run(name: str, opts: dict, out_dir: Path | None = None) -> dict:
    opts = {"W": 1280, "H": 720, "seed": 1, **opts}
    specs = scenario(name, opts)
    tr = Tracker()
    frames = []
    t0 = time.time()
    for i, spec in enumerate(specs):
        img, truth = render(spec, opts)
        t1 = time.time()
        st = tr.step(img)
        dt = time.time() - t1
        white_true = float(np.linalg.norm(truth[0][1] - truth[0][0]))  # C3 width
        row = dict(i=i, status=st.status, check=round(st.check, 3), detected=st.detected, visible=st.visible, moving=spec.moving, ms=round(dt * 1000), key_px=round(white_true, 1), hands=len(spec.hands))
        if st.res is not None:
            err, inside = key_errors(st.res.keys, truth, white_true)
            row.update(err=round(err, 3), correct=inside)
        else:
            row.update(err=None, correct=False)
        if out_dir is not None:
            vis = draw(img, st.res, labels=False) if st.res is not None else img.copy()
            color = (0, 200, 0) if row["correct"] else (0, 0, 255)
            txt = f"#{i} {st.status} check={st.check:.2f} err={row['err']} key={white_true:.0f}px {'MOVING' if spec.moving else ''}"
            cv2.rectangle(vis, (0, 0), (vis.shape[1], 26), (0, 0, 0), -1)
            cv2.putText(vis, txt, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv2.LINE_AA)
            cv2.imwrite(str(out_dir / f"f{i:03d}.jpg"), vis, [cv2.IMWRITE_JPEG_QUALITY, 82])
            cv2.imwrite(str(out_dir / f"raw{i:03d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 82])
        frames.append(row)
    still = [f for f in frames if not f["moving"]]
    summary = dict(
        scenario=name,
        frames=len(frames),
        still_frames=len(still),
        still_correct=round(sum(f["correct"] for f in still) / max(1, len(still)), 3),
        still_max_err=max((f["err"] for f in still if f["err"] is not None), default=None),
        still_median_err=float(np.median([f["err"] for f in still if f["err"] is not None])) if any(f["err"] is not None for f in still) else None,
        all_correct=round(sum(f["correct"] for f in frames) / max(1, len(frames)), 3),
        detect_calls=sum(f["detected"] for f in frames),
        mean_detect_ms=round(float(np.mean([f["ms"] for f in frames if f["detected"]])) if any(f["detected"] for f in frames) else 0.0),
        seconds=round(time.time() - t0, 1),
    )
    return dict(summary=summary, frames=frames, opts=opts)


if __name__ == "__main__":
    import sys

    names = sys.argv[1:] or list(SCENARIOS)
    for nm in names:
        d = HERE / "out" / "cli" / nm
        d.mkdir(parents=True, exist_ok=True)
        r = run(nm, {}, d)
        print(json.dumps(r["summary"]))
