"""
Holds the keyboard's calibration across frames.

The keyboard lies still for most of the demo, so full detection doesn't need
to run on every frame. What matters is:
- a hand over the keys (or our own projected light) must NOT move or drop the
  calibration;
- a keyboard that really moved, or a camera that zoomed, must be followed;
- small drift must be caught. The first version checked "are black keys dark
  and white keys bright where we think" and passed a pose 0.65 keys off with
  a perfect score.

How: when a clean full detection succeeds, store a reference picture of the
keybed flattened into the canonical keyboard frame (x in white-key widths, y
in black-key lengths), so the reference is the same at any camera distance.
Every frame, flatten the live image with the current pose and align it to
the reference with ECC (cv2.findTransformECC, homography). Pixels that differ
a lot from the reference (a hand, its shadow, a projected light) are masked
out of the alignment. ECC's correlation tells us whether the pose still holds;
its warp corrects the pose to sub-pixel accuracy. Only when alignment fails
(a big jump, the keyboard gone) does full detection run.

All thresholds are in white-key widths or are ratios, never pixels.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from detect import DetectionError, Result, detect

SX, SY = 24.0, 60.0  # reference px per canonical unit (x: white key, y: black length)


def _apply(H, pts):
    p = np.asarray(pts, np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(p, H).reshape(-1, 2)


def pose_delta(a: Result, b: Result) -> float:
    """Largest keybed-corner shift, in white-key widths."""
    d = np.linalg.norm(np.array(a.keybed) - np.array(b.keybed), axis=1).max()
    return float(d / max(a.white_px, 1e-6))


@dataclass
class Reference:
    H: np.ndarray  # canonical -> image when the reference was taken
    R: np.ndarray  # canonical -> reference px
    img: np.ndarray  # flattened keybed, float32
    size: tuple[int, int]
    canon_keys: list[np.ndarray]  # key quads in canonical units
    canon_keybed: np.ndarray
    meta: list[dict]  # note, name, black for each key


def make_reference(gray: np.ndarray, res: Result) -> Reference:
    Hinv = np.linalg.inv(res.H)
    kb = _apply(Hinv, res.keybed)  # nl, nr, fr, fl in canonical
    y_near, y_far = kb[0, 1], kb[3, 1]
    x0, x1, y0, y1 = -0.4, 15.4, y_far - 0.35, y_near + 0.2
    R = np.array([[SX, 0, -SX * x0], [0, SY, -SY * y0], [0, 0, 1]])
    size = (int((x1 - x0) * SX), int((y1 - y0) * SY))
    img = cv2.warpPerspective(gray, R @ Hinv, size, flags=cv2.INTER_LINEAR).astype(np.float32)
    return Reference(
        H=res.H.copy(), R=R, img=img, size=size,
        canon_keys=[_apply(Hinv, k["corners"]) for k in res.keys], canon_keybed=kb,
        meta=[{k2: k[k2] for k2 in ("note", "name", "black", "inferred")} for k in res.keys],
    )


def result_from(ref: Reference, H: np.ndarray, diag: dict) -> Result:
    keys = [dict(**m, corners=_apply(H, q).round(2).tolist()) for m, q in zip(ref.meta, ref.canon_keys)]
    kb = _apply(H, ref.canon_keybed)
    return Result(keys=keys, keybed=kb.round(2).tolist(), white_px=float(np.linalg.norm(kb[1] - kb[0]) / 15), measured={}, diagnostics=diag, H=H)


def _norm(a: np.ndarray, m: np.ndarray | None = None) -> np.ndarray:
    v = a[m] if m is not None else a
    return (a - v.mean()) / (v.std() + 1e-6)


def align(gray: np.ndarray, ref: Reference, H: np.ndarray):
    """ECC-align the live keybed to the reference. Returns (H_new, rho,
    occluded fraction) or None if alignment failed."""
    patch = cv2.warpPerspective(gray, ref.R @ np.linalg.inv(H), ref.size, flags=cv2.INTER_LINEAR).astype(np.float32)
    inside = cv2.warpPerspective(np.ones(gray.shape, np.uint8), ref.R @ np.linalg.inv(H), ref.size, flags=cv2.INTER_NEAREST) > 0
    if inside.mean() < 0.6:
        return None  # pose points mostly outside the frame
    # Occlusion mask: after matching brightness, pixels far from the reference
    # are a hand, a shadow or a projected light. Threshold from the robust
    # spread of the differences, so it adapts to noise and lighting.
    d = np.abs(_norm(patch, inside) - _norm(ref.img))
    mad = np.median(d[inside]) + 1e-6
    ok = inside & (d < max(1.0, 4.0 * mad))
    occluded = 1.0 - ok.sum() / max(1, inside.sum())
    if occluded > 0.7:
        return None
    mask = cv2.erode(ok.astype(np.uint8), np.ones((3, 3), np.uint8))
    W = np.eye(3, dtype=np.float32)
    try:
        # 30 iterations, not 60: an alignment that holds converges well
        # within that, and one that fails (the keyboard really moved) burned
        # all 60 before detection took over: ~57 ms per moving frame, most of
        # a drag (#44). What is verified: every still frame stays right (the
        # story, and the lab simulator's move/story/drag scenarios), and the
        # demo story's statuses are identical at 12..60. Moving frames are a
        # trade, not identical: in the simulator's hand_moves_it drag, 30
        # accepts frames 15 and 18 as tracked with keys up to ~0.7 white-key
        # widths off, where 60 re-detected them; 60 instead gets 16 and 17
        # wrong. 38/40 right either way (review #45). Mid-drag frames are not
        # what the demo lights keys on, so the speed wins.
        rho, W = cv2.findTransformECC(
            ref.img, patch, W, cv2.MOTION_HOMOGRAPHY,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 1e-5), mask, 3,
        )
    except cv2.error:
        return None
    # patch(W(t)) ~= ref(t) and image = H R^-1 patch, so image = H R^-1 W R t.
    Rinv = np.linalg.inv(ref.R)
    H_new = H @ Rinv @ W.astype(np.float64) @ ref.R
    return H_new, float(rho), float(occluded)


@dataclass
class Step:
    res: Result | None
    status: str  # locked | tracked | occluded | moved | refined | lost | searching
    check: float  # ECC correlation (0 when not aligned)
    detected: bool
    visible: int | None


class Tracker:
    RHO = 0.80  # ECC correlation that means "this is our keyboard, in place"
    STEP = 1.0  # white-key widths: ECC corrections bigger than this aren't trusted
    MOVE = 0.3  # white-key widths: smaller differences between fits are noise

    def __init__(self):
        self.ref: Reference | None = None
        self.H: np.ndarray | None = None
        self.res: Result | None = None
        self.pending: Result | None = None

    def _adopt(self, gray, new: Result, status: str, rho: float, vis) -> Step:
        self.ref = make_reference(gray, new)
        self.H = new.H
        self.res = new
        self.pending = None
        return Step(new, status, rho, True, vis)

    def step(self, img: np.ndarray) -> Step:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        rho, occl = 0.0, 1.0
        if self.ref is not None:
            a = align(gray, self.ref, self.H)
            if a is not None:
                H_new, rho, occl = a
                cand = result_from(self.ref, H_new, dict(rho=round(rho, 3), occluded=round(occl, 3)))
                shift = pose_delta(cand, self.res)
                # With much of the keybed masked as "occluded", ECC can settle a
                # whole key off: the masked pixels are exactly the ones that
                # disagree (black keys), and white keys repeat every key. So a
                # heavily masked alignment may only nudge the pose; bigger
                # changes go to full detection. Seen on a fast zoom: rho 0.97
                # with the pose 1.4 keys off.
                limit = self.STEP if occl <= 0.15 else 0.25
                if rho >= self.RHO and shift < limit:
                    self.H, self.res = H_new, cand
                    status = "occluded" if occl > 0.15 else ("tracked" if shift > 0.05 else "locked")
                    return Step(cand, status, rho, False, None)
        # Alignment failed or doesn't hold: full detection.
        try:
            new = detect(img)
        except DetectionError:
            if self.res is None:
                return Step(None, "searching", 0.0, True, None)
            return Step(self.res, "lost", rho, True, None)
        vis = new.diagnostics.get("visible_black")
        if self.res is None:
            return self._adopt(gray, new, "moved", rho, vis)
        # All ten black keys in the 2-3-2-3 pattern can't be faked by a hand, so
        # a full fit is adopted at once. Partial fits (hands over the keys) need
        # a second sighting in the same place.
        # A partial fit is also adopted at once when the old pose clearly no
        # longer matches the image (ECC correlation low): otherwise heavy
        # noise, where one black key always drops out, left the tracker
        # waiting for a second sighting that never comes while sliding.
        if vis == 10 or (rho < 0.5 and vis is not None and vis >= 7):
            return self._adopt(gray, new, "moved" if pose_delta(new, self.res) >= self.MOVE else "refined", rho, vis)
        if self.pending is not None and pose_delta(new, self.pending) < self.MOVE:
            # Adopt the pose but keep the old reference picture: a picture taken
            # with a hand in it would mask out the wrong pixels later.
            self.H, self.res, self.pending = new.H, new, None
            return Step(new, "moved", rho, True, vis)
        self.pending = new
        return Step(self.res, "lost", rho, True, vis)
