"""
Throwaway experiment: find every key of an Arturia MiniLab 3 in a top-down image.

Why the black keys anchor everything
------------------------------------
The white body, white keys and (in product shots) white background are all
nearly the same brightness, so "find the white rectangle" is unreliable: on
the room's black cloth it finds the whole body, on a white background it finds
nothing. The 10 black keys are the opposite: dark, elongated, all the same
size, and laid out in the piano's 2-3-2-3 pattern. That pattern also tells us
which way is "low notes" and which end of a key is the player's end, so
rotation and orientation fall out for free.

Pipeline
--------
1. Black keys: threshold dark blobs, keep elongated rectangles of one size,
   and fit them to the 2-3-2-3 pattern with RANSAC, so a hand hiding some of
   them still leaves a valid fit (needs 5 visible, spanning both octaves).
2. Canonical frame: x in white-key widths (0 = left edge of the lowest C,
   15 = right edge of the top C), y in black-key lengths (0 = black keys' far
   end, 1 = their near end). A homography maps it onto the image, fitted
   from the visible black keys' far and near midpoints.
3. Rectify the keybed into that frame and measure what the black keys can't
   tell us: where the white keys end at the front (near edge) and back (far
   edge), and the exact white-key pitch from the dark gaps between them.
4. Emit 25 quads in image pixels, in the KeyQuad corner order used by
   packages/room/src/devices/minilab3.ts (near-left, near-right, far-right,
   far-left). Hidden black keys are filled in from the visible ones and
   flagged `inferred`.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path

import cv2
import numpy as np

# White-key boundary each black key sits nearest, lowest C# to top A#.
# 25 keys starting on C: C D E F G A B C D E F G A B C (15 white).
BLACK_BOUNDARIES = np.array([1, 2, 4, 5, 6, 8, 9, 11, 12, 13], dtype=float)
# Black keys are NOT centred on the boundaries: like a real piano, C# and F#
# sit left, D# and A# right, G# in the middle. Measured on both reference
# images (offsets in white-key widths; they agree within 0.03). Fitting
# against the offset positions is what makes the pattern fit tight.
BLACK_OFFSETS = np.array([-0.12, 0.12, -0.15, 0.0, 0.15, -0.12, 0.12, -0.15, 0.0, 0.15])
BLACK_X = BLACK_BOUNDARIES + BLACK_OFFSETS
WHITE_KEYS = 15
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MIN_VISIBLE = 5
WHITE_OVER_BLACK = 1.60  # white-key length / black-key length: 1/0.624 photo, 1/0.626 render


class DetectionError(Exception):
    pass


@dataclass
class BlackKey:
    index: int  # 0..9, lowest C# first
    center: np.ndarray
    far_mid: np.ndarray
    near_mid: np.ndarray
    width: float
    length: float
    corners: np.ndarray  # near-left, near-right, far-right, far-left (image px)


@dataclass
class Result:
    keys: list[dict]
    keybed: list[list[float]]
    white_px: float
    measured: dict
    diagnostics: dict = field(default_factory=dict)
    H: np.ndarray | None = None  # refined canonical -> image


# ---------------------------------------------------------------- black keys


def _candidates(gray: np.ndarray, thr: int, k: int):
    """Dark, filled, elongated rectangles. Pads and the screen are dark too but
    roughly square; fader slots and lettering are elongated but much smaller,
    which the size clustering in _pick_pattern removes.

    The opening of size `k` strips the thin dark gap lines between white keys,
    which otherwise join onto a black key's end and make it look like a
    non-rectangle (seen on the Arturia render). The right k depends on image
    scale, so find_black_keys tries several."""
    mask = (gray < thr).astype(np.uint8) * 255
    if k > 1:
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < 20:
            continue
        (cx, cy), (w, h), ang = cv2.minAreaRect(c)
        short, long_ = min(w, h), max(w, h)
        if short < 2 or long_ / short < 2.5 or long_ / short > 12:
            continue
        if area / (w * h) < 0.7:  # not a filled rectangle
            continue
        # Long-axis unit vector (sign arbitrary, fixed later). Taken from the
        # box edges rather than minAreaRect's angle, whose convention changed
        # between OpenCV versions and silently swaps axes near 90 degrees.
        box = cv2.boxPoints(((cx, cy), (w, h), ang))
        e1, e2 = box[1] - box[0], box[2] - box[1]
        e = e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2
        d = e / np.linalg.norm(e)
        out.append(dict(c=np.array([cx, cy]), short=short, long=long_, area=area, d=d, box=box))
    return out


def _ransac_pattern(pos: np.ndarray):
    """Assign blobs (sorted positions across the keys) to black-key slots.

    Hypothesis from two neighbouring blobs and two slots, then count blobs
    that land within 0.1 white-key widths of a slot. Both reading directions
    are tried (pos and -pos) because the keyboard can lie either way round.
    Vectorised over all slot pairs: the loop version took ~3 s per image.
    Returns (inliers, rms, assignment {blob: slot}, s, t, reversed)."""
    pairs = np.array(list(combinations(range(10), 2)))
    dX = BLACK_X[pairs[:, 1]] - BLACK_X[pairs[:, 0]]
    best = None
    n = len(pos)
    for rev in (False, True):
        p = -pos if rev else pos
        order = np.argsort(p)
        ps = p[order]
        for i in range(n - 1):
            if ps[i + 1] - ps[i] < 1e-6:
                continue
            s = (ps[i + 1] - ps[i]) / dX  # (P,)
            t = ps[i] - s * BLACK_X[pairs[:, 0]]
            xs = (ps[None, :] - t[:, None]) / s[:, None]  # (P, n)
            dist = np.abs(xs[:, :, None] - BLACK_X[None, None, :])  # (P, n, 10)
            slot = dist.argmin(2)
            r = dist.min(2)
            ok = r < 0.1
            # One blob per slot: duplicates are rare (needs two blobs within
            # 0.2 white keys); count unique slots among inliers.
            counts = np.array([len(set(slot[h][ok[h]].tolist())) for h in range(len(pairs))])
            # Two blobs at the same position give s=0 -> inf/NaN rows; score them out.
            mean_r = np.nan_to_num(np.where(ok, r, 0).sum(1) / np.maximum(ok.sum(1), 1), nan=1.0)
            h = int(np.argmax(counts - 1e-3 * mean_r))
            if counts[h] < 2:
                continue
            rr = r[h][ok[h]]
            rms = float(np.sqrt(np.mean(rr**2)))
            cand = (int(counts[h]), -rms)
            if best is None or cand > best[0]:
                assign, used = {}, set()
                for j in np.argsort(r[h]):
                    if ok[h][j] and slot[h][j] not in used:
                        used.add(int(slot[h][j]))
                        assign[int(order[j])] = int(slot[h][j])
                best = (cand, rms, assign, float(s[h]), float(t[h]), rev)
    if best is None:
        return None
    (count, _), rms, assign, s, t, rev = best
    return count, rms, assign, s, t, rev


def _pick_pattern(cands):
    """The best same-size, same-orientation row of blobs that fits the black
    keys. Uniform spacing (fader slots, letters) can't fit 2-3-2-3.

    Every blob seeds a candidate group, but most seeds find the same group
    again: measured on a story frame with a hand over the keys, 160 seeds
    gave 16 distinct groups, and refitting each copy (RANSAC) was ~90 % of a
    detection (#44). So a group's geometry comes from its members, not its
    seed: the axis is the members' mean orientation and the row is cut around
    their median length. Identical members then give an identical fit, a
    group already fitted is skipped, and the axis is a better estimate than
    one blob's own. Same groups, same scores, a tenth of the work.
    """
    best = None
    seen: set[frozenset[int]] = set()
    for seed in cands:
        idx = [
            i
            for i, k in enumerate(cands)
            if 0.6 < k["area"] / seed["area"] < 1.6
            and 0.7 < k["long"] / seed["long"] < 1.4
            and abs(float(np.dot(k["d"], seed["d"]))) > np.cos(np.deg2rad(12))
        ]
        if len(idx) < MIN_VISIBLE:
            continue
        # Mean orientation of the members (long axes have no sign: align each
        # to the seed's before averaging, or opposite vectors cancel out).
        dirs = np.array([cands[i]["d"] * (1 if np.dot(cands[i]["d"], seed["d"]) >= 0 else -1) for i in idx])
        d = dirs.mean(0)
        d = d / np.linalg.norm(d)
        a = np.array([-d[1], d[0]])  # across the keys
        along = np.array([np.dot(cands[i]["c"], d) for i in idx])
        med = np.median(along)
        long_med = float(np.median([cands[i]["long"] for i in idx]))
        idx = [i for i, v in zip(idx, along) if abs(v - med) < 0.35 * long_med]
        if len(idx) < MIN_VISIBLE or len(idx) > 16:
            continue
        key = frozenset(idx)
        if key in seen:
            continue
        seen.add(key)
        group = [cands[i] for i in idx]
        pos = np.array([np.dot(k["c"], a) for k in group])
        r = _ransac_pattern(pos)
        if r is None:
            continue
        count, rms, assign, s, t, rev = r
        score = (count, -rms)
        if best is None or score > best[0]:
            best = (score, group, a, assign, rev, rms)
    return best


def find_black_keys(gray: np.ndarray):
    """Try several dark thresholds and opening sizes and keep the best fit:
    projector light, exposure and image scale all move what works."""
    best = None
    for thr in (50, 70, 90, 110, 130):
        for k in (1, 3, 5, 9, 15):
            r = _pick_pattern(_candidates(gray, thr, k))
            if r and (best is None or r[0] > best[0]):
                best = (*r, (thr, k))
        # All ten found with a tight fit: no other setting can beat it.
        if best and best[0][0] == 10 and -best[0][1] < 0.03:
            break
    if best is None:
        raise DetectionError("no black-key row found")
    (count, _), group, a, assign, rev, rms, thr = best
    slots = sorted(assign.values())
    if count < MIN_VISIBLE:
        raise DetectionError(f"only {count} black keys visible")
    # The pattern repeats every octave (7 white keys). If every visible key
    # could be shifted a whole octave and still land on real slots, we cannot
    # tell which octave we are looking at. Refuse rather than guess: a guess
    # lights keys an octave off, and the tracker keeps the last good fit.
    b = BLACK_BOUNDARIES[slots]
    if b.max() <= 6 or b.min() >= 8:
        raise DetectionError("visible black keys are all in one octave: ambiguous")
    if rev:
        a = -a
    # Low notes are on the player's left, so "far" (away from the player) is
    # `a` rotated -90 degrees in image coordinates (y down).
    f = np.array([a[1], -a[0]])
    keys = []
    for gi, slot in assign.items():
        k = group[gi]
        box = k["box"]
        rel = box - k["c"]
        far = rel @ f > 0
        right = rel @ a > 0
        corner = lambda fa, ri: box[np.argmax((far == fa) & (right == ri))]
        nl, nr, fr, fl = corner(False, False), corner(False, True), corner(True, True), corner(True, False)
        keys.append(BlackKey(slot, k["c"], (fl + fr) / 2, (nl + nr) / 2, k["short"], k["long"], np.array([nl, nr, fr, fl])))
    keys.sort(key=lambda k: k.index)
    return keys, dict(visible_black=count, pattern_rms=round(rms, 4), threshold=thr, across=a.round(4).tolist())


# ------------------------------------------------------- canonical frame fit


def _apply(H, pts):
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(pts, H).reshape(-1, 2)


def _subpixel_min(profile: np.ndarray, i: int) -> float:
    if 0 < i < len(profile) - 1:
        y0, y1, y2 = profile[i - 1], profile[i], profile[i + 1]
        den = y0 - 2 * y1 + y2
        if den > 1e-9:
            return i + 0.5 * (y0 - y2) / den
    return float(i)


def detect(img: np.ndarray, lowest_note: int = 48, debug: bool = False) -> Result:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    blacks, diag = find_black_keys(gray)

    # First homography from the visible black keys: far and near midpoints sit
    # on two lines y=0 and y=1 at x = their slot position.
    src = np.array([[BLACK_X[k.index], 0.0] for k in blacks] + [[BLACK_X[k.index], 1.0] for k in blacks])
    dst = np.array([k.far_mid for k in blacks] + [k.near_mid for k in blacks])
    H, _ = cv2.findHomography(src, dst, 0)
    if H is None:
        raise DetectionError("homography fit failed")

    # Rectify: S px per canonical unit. y spans the panel edge above the keys
    # to the lip and beyond below them (white keys are ~1.6 black-lengths).
    S = 60
    x0, x1, y0, y1 = -0.6, 15.6, -0.7, 2.6
    R = np.array([[S, 0, -S * x0], [0, S, -S * y0], [0, 0, 1]], dtype=np.float64)
    size = (int((x1 - x0) * S), int((y1 - y0) * S))
    rect = cv2.warpPerspective(gray, R @ np.linalg.inv(H), size, flags=cv2.INTER_LINEAR, borderValue=0).astype(np.float64)
    ypx = lambda y: int(round((y - y0) * S))
    xpx = lambda x: int(round((x - x0) * S))

    # --- white-key pitch from the dark gaps between white keys, measured below
    # the black keys where every white key is full width. A hand can put a
    # false minimum anywhere, so fit, drop outliers, refit.
    band = rect[ypx(1.15) : ypx(1.45), :]
    col = np.median(band, 0)
    gaps = []
    for k in range(1, WHITE_KEYS):
        lo, hi = xpx(k - 0.3), xpx(k + 0.3)
        i = lo + int(np.argmin(col[lo:hi]))
        gaps.append((k, _subpixel_min(col, i) / S + x0))
    kk = np.array([g[0] for g in gaps], dtype=float)
    xm = np.array([g[1] for g in gaps])
    keep = np.ones_like(kk, dtype=bool)
    for _ in range(3):
        A = np.stack([np.ones_like(kk[keep]), kk[keep]], 1)
        (t, s), *_ = np.linalg.lstsq(A, xm[keep], rcond=None)
        r = np.abs(t + s * kk - xm)
        keep = r < 0.06
        if keep.sum() < 6:
            t, s, keep = 0.0, 1.0, np.zeros_like(keep)
            break
    gap_rms = float(np.sqrt(np.mean(r[keep] ** 2))) if keep.any() else None
    C = np.array([[s, 0, t], [0, 1, 0], [0, 0, 1]], dtype=np.float64)  # refined x -> old x

    # --- near edge (player's end of the white keys) and far edge. Found per
    # white key, down that key's centre line (black keys never cover it), then
    # the median over the keys that look unobstructed. A median of one shared
    # profile wasn't enough: a hovering hand plus its shadow can cover half the
    # keyboard and drag the shared profile's edge onto the hand.
    cols = [xpx(t + s * (k + 0.5)) for k in range(WHITE_KEYS)]
    w = max(1, int(0.08 * S))
    profs = [cv2.GaussianBlur(rect[:, c - w : c + w + 1].mean(1).reshape(-1, 1), (1, 5), 0).ravel() for c in cols]
    fronts = np.array([np.median(p[ypx(1.1) : ypx(1.4)]) for p in profs])
    # 75th percentile, not max: a key lit by our own projector is brighter
    # than the rest and would make every other key look obstructed.
    white_level = float(np.percentile(fronts, 75)) if len(fronts) else 0.0
    # A key is "clear" if its front is about as bright as the brightest key's.
    clear = [i for i, f in enumerate(fronts) if f > white_level - max(12.0, 0.08 * white_level)]

    def first_edge(p: np.ndarray, start: float, stop: float, step: int, ref: float) -> float | None:
        # Walk away from the key body and stop at the first clear darkening:
        # the shadow gap where the key meets the lip (near) or the panel (far).
        # Measured on both reference images, that gap is 20-40 levels darker
        # than the key. Two traps this avoids:
        # - comparing against the *largest* drop in the window: the dark pads
        #   (far side) and the warp border or black cloth (near side) dwarf the
        #   gap, so a relative threshold skipped the real edge;
        # - taking the strongest edge: on black cloth the lip->cloth edge is the
        #   strongest, but it is further out and is not the key's edge.
        grad = np.gradient(p)
        # How much darker counts as "the gap": relative to this key's own noise,
        # not a fixed share of its brightness. The photo's front gap is only ~15
        # levels deep; a fixed 6% (14.5 levels) sat right on it and the edge
        # flipped between 1.63 and 1.77 from one run to the next.
        body = p[ypx(1.1) : ypx(1.4)] if step > 0 else p[ypx(0.12) : ypx(0.3)]
        drop = max(6.0, 4.0 * float(np.std(np.diff(body))) + 2.0)
        a_, b_ = ypx(start), ypx(stop)
        # Start from the key's brightest point in the first part of the window
        # (its plateau), not the window's edge: on small images blur from the
        # black keys darkens the start of the window and the walk "found" the
        # front edge right there (1.07 instead of ~1.6 at 11 px keys).
        # Near side: the plateau can be anywhere in the first 0.35. Far side:
        # only look 0.15 up, never reaching the panel above the keys, which is
        # bright too and would start the walk past the edge.
        span = range(a_, a_ + step * int((0.35 if step > 0 else 0.15) * S), step)
        a_ = max(span, key=lambda i: p[i]) if len(span) else a_
        ref = max(ref, float(p[a_]))
        for i in range(a_, b_, step):
            if p[i] < ref - drop:
                lo, hi = sorted((i - step * int(0.08 * S), i + step))
                g = -grad[lo:hi] * step
                return (lo + int(np.argmax(g))) / S + y0
        return None

    nears, fars = [], []
    for i in clear:
        p = profs[i]
        e = first_edge(p, 1.1, 2.55, +1, fronts[i])
        if e is not None:
            nears.append(e)
        # The far search compares with the key's brightness just below the far
        # end, not its front: next to the black keys blur darkens the key a
        # little, and on small images that alone crossed the threshold.
        ref = float(np.median(p[ypx(0.12) : ypx(0.3)]))
        e = first_edge(p, 0.3, -0.3, -1, ref)
        if e is not None:
            fars.append(e)
    if len(nears) < 3:
        raise DetectionError("front edge of the keys not found")
    y_near_measured = float(np.median(nears))
    # White and black keys start at the same back line under the panel, so the
    # far edge must be near the black keys' far end (y=0). Outside that window
    # (or not found) use that physical prior: measured +0.03..+0.05 on both
    # reference images. In keyboard units, so it holds at any camera distance.
    y_far = float(np.median(fars)) if len(fars) >= 3 else 0.04
    if not -0.08 <= y_far <= 0.12:
        y_far = 0.04
    y_near = y_near_measured
    rows_s = np.median(np.stack([profs[i] for i in clear], 1), 1)

    # --- black key tips. The thresholded blob can stop short of the real tip:
    # on the photo the sloped front face of each black key is lit grey, not
    # black. Walk down beside each key's centre line to where it turns white.
    black_level = float(np.median([rect[ypx(0.5), xpx(BLACK_X[k.index])] for k in blacks]))
    mid_level = (black_level + white_level) / 2
    tips = {}
    for k in blacks:
        # Sample either side of the centre, not on it: G# sits exactly on a
        # white-key gap line, and walking down that dark line ran the tip all
        # the way to the front of the keybed (seen on the render).
        dx = max(1, int(0.12 * S))
        c = xpx(BLACK_X[k.index])
        prof = np.maximum(rect[:, c - dx - 1 : c - dx + 2].mean(1), rect[:, c + dx - 1 : c + dx + 2].mean(1))
        for i in range(ypx(0.6), ypx(min(y_near, 1.6))):
            if prof[i] > mid_level:
                tips[k.index] = (i - 0.5) / S + y0
                break

    sides_old = {}
    band_b = rect[ypx(0.3) : ypx(0.7), :].mean(0)
    for k in blacks:
        c = BLACK_X[k.index]
        ci = xpx(c)
        if band_b[ci] > mid_level:
            continue
        lim = int(0.45 * S)
        l = r_ = None
        for j in range(ci, ci - lim, -1):
            if band_b[j] > mid_level:
                l = j + (mid_level - band_b[j]) / (band_b[j + 1] - band_b[j] + 1e-9)
                break
        for j in range(ci, ci + lim):
            if band_b[j] > mid_level:
                r_ = j - 1 + (mid_level - band_b[j - 1]) / (band_b[j] - band_b[j - 1] + 1e-9)
                break
        if l is not None and r_ is not None:
            sides_old[k.index] = (l / S + x0, r_ / S + x0)

    Hf = H @ C  # refined canonical -> image

    # --- black keys at their measured canonical position and width.
    Hinv = np.linalg.inv(Hf)
    black_canon = {}
    for k in blacks:
        cc = _apply(Hinv, k.corners)  # nl, nr, fr, fl in refined canonical
        xl, xr = (cc[0, 0] + cc[3, 0]) / 2, (cc[1, 0] + cc[2, 0]) / 2
        yf, yn = (cc[2, 1] + cc[3, 1]) / 2, (cc[0, 1] + cc[1, 1]) / 2
        # Only ever extend, and not by much: a much longer "tip" means the walk
        # ran onto something that isn't the key (a finger, a gap line).
        tip = tips.get(k.index)
        if tip is not None and yn < tip < yn + 0.3:
            yn = tip
        # Sides: measured at the black/white midpoint across the key, not taken
        # from the thresholded blob, whose width depends on which threshold
        # won (0.33 vs 0.51 white keys on the same photo). Measured in `rect`
        # (old x), converted to refined x.
        sides = sides_old.get(k.index)
        if sides is not None:
            xl, xr = (sides[0] - t) / s, (sides[1] - t) / s
        black_canon[k.index] = (xl, xr, yf, yn)
    # All black keys are the same part, so give them one shared length: the
    # median of the measured tips. Per-key tips wandered (one ran 0.97 keys
    # long on an unblurred image). Their far ends are snapped to the white
    # keys' far edge: black and white keys start at the same back line under
    # the panel, and the black key's own far end merges into the panel gap,
    # which made it the largest error left (~0.1 keys).
    tip_med = float(np.median([v[3] for v in black_canon.values()]))
    # White-key length / black-key length is a property of the MiniLab, not of
    # the camera: 1.60 on both reference images (tips measured at the
    # black/white midpoint, so independent of which threshold found the blobs;
    # the canonical y unit itself is NOT, which is why the ratio is used).
    # When the measured front edge disagrees by more than 6%, trust the
    # keyboard. Seen when overexposed: key, shadow gap and lip all clip to 255,
    # the gap vanishes and the edge search runs to the end of the lip.
    ratio = (y_near - y_far) / max(tip_med - y_far, 1e-6)
    if abs(ratio - WHITE_OVER_BLACK) > 0.06 * WHITE_OVER_BLACK:
        y_near = y_far + WHITE_OVER_BLACK * (tip_med - y_far)
        keybed_fixed = True
    else:
        keybed_fixed = False
    for i, (xl, xr, _yf, _yn) in list(black_canon.items()):
        black_canon[i] = (xl, xr, y_far, tip_med)
    # Hidden black keys: same width and ends as the visible ones, at their slot.
    bw = float(np.median([v[1] - v[0] for v in black_canon.values()]))
    byf = float(np.median([v[2] for v in black_canon.values()]))
    byn = float(np.median([v[3] for v in black_canon.values()]))
    for i in range(10):
        if i not in black_canon:
            xc = (BLACK_X[i] - t) / s
            black_canon[i] = (xc - bw / 2, xc + bw / 2, byf, byn)

    keys = []
    white_i = black_i = 0
    visible = {k.index for k in blacks}
    for i in range(25):
        note = lowest_note + i
        is_black = NOTE_NAMES[note % 12].endswith("#")
        if is_black:
            xl, xr, yf, yn = black_canon[black_i]
            quad = [[xl, yn], [xr, yn], [xr, yf], [xl, yf]]
            inferred = black_i not in visible
            black_i += 1
        else:
            quad = [[white_i, y_near], [white_i + 1, y_near], [white_i + 1, y_far], [white_i, y_far]]
            inferred = False
            white_i += 1
        keys.append(
            dict(note=note, name=f"{NOTE_NAMES[note % 12]}{note // 12 - 1}", black=is_black, inferred=inferred, corners=_apply(Hf, quad).round(2).tolist())
        )

    keybed = _apply(Hf, [[0, y_near], [WHITE_KEYS, y_near], [WHITE_KEYS, y_far], [0, y_far]])
    # A keybed running off the image means some black keys were cut by the
    # border; with a partial fit those cut blobs can shift the whole pattern.
    # Seen once at max zoom: 8 "visible" keys, result 17 keys off.
    hgt, wid = gray.shape[:2]
    margin = 0.5 * float(np.linalg.norm(keybed[1] - keybed[0]) / WHITE_KEYS)
    off_image = bool((keybed[:, 0] < -margin).any() or (keybed[:, 0] > wid + margin).any() or (keybed[:, 1] < -margin).any() or (keybed[:, 1] > hgt + margin).any())
    if off_image and len(blacks) < 10:
        raise DetectionError("keyboard partly outside the image and not all black keys visible")
    white_px = float(np.linalg.norm(keybed[1] - keybed[0]) / WHITE_KEYS)
    L = y_near - y_far
    vis = [black_canon[i] for i in sorted(visible)]
    measured = dict(
        # Same meaning as MINILAB3 in packages/room/src/devices/minilab3.ts:
        # blackLength = black length / white length, blackWidth = black width /
        # white width.
        blackLength=round(float(np.mean([yn - yf for _, _, yf, yn in vis]) / L), 3),
        blackWidth=round(float(np.mean([xr - xl for xl, xr, _, _ in vis])), 3),
        blackOffsets={int(i): round(float((black_canon[i][0] + black_canon[i][1]) / 2 - BLACK_BOUNDARIES[i]), 3) for i in sorted(visible)},
    )
    diag.update(gap_rms=None if gap_rms is None else round(gap_rms, 4), y_near=round(y_near, 3), y_near_measured=round(y_near_measured, 3), front_from_prior=keybed_fixed, y_far=round(y_far, 3), pitch=round(float(s), 4))
    res = Result(keys=keys, keybed=keybed.round(2).tolist(), white_px=white_px, measured=measured, diagnostics=diag, H=Hf)
    if debug:
        res.diagnostics["_rect"] = rect
        res.diagnostics["_rows"] = rows_s
    return res


# ------------------------------------------------------------------- overlay


def draw(img: np.ndarray, res: Result, labels: bool = True) -> np.ndarray:
    out = img.copy() if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    th = max(1, int(round(res.white_px / 25)))
    fs = max(0.3, res.white_px / 60)
    for k in res.keys:
        p = np.array(k["corners"], dtype=np.float32)
        color = (0, 165, 255) if k.get("inferred") else (255, 0, 255) if k["black"] else (0, 200, 0)
        cv2.polylines(out, [np.round(p).astype(np.int32)], True, color, th, cv2.LINE_AA)
        if labels and not k["black"] and res.white_px > 20:
            c = p[:2].mean(0) * 0.8 + p[2:].mean(0) * 0.2
            cv2.putText(out, k["name"], (int(c[0] - res.white_px * 0.3), int(c[1])), cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 120, 0), th, cv2.LINE_AA)
    kb = np.round(np.array(res.keybed)).astype(np.int32)
    cv2.polylines(out, [kb], True, (255, 140, 0), th + 1, cv2.LINE_AA)
    return out


if __name__ == "__main__":
    here = Path(__file__).parent
    paths = [Path(p) for p in sys.argv[1:]] or sorted((here / "reference").glob("*.jpg"))
    (here / "out").mkdir(exist_ok=True)
    for p in paths:
        img = cv2.imread(str(p))
        res = detect(img)
        cv2.imwrite(str(here / "out" / f"{p.stem}.overlay.png"), draw(img, res))
        (here / "out" / f"{p.stem}.keys.json").write_text(json.dumps(dict(keys=res.keys, keybed=res.keybed, measured=res.measured, diagnostics=res.diagnostics), indent=1))
        print(p.name, json.dumps(res.measured), json.dumps(res.diagnostics))
