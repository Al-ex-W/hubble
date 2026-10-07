"""
Writes the keybed fixtures: simulated overhead-camera frames of the MiniLab
plus the true position of every key, for the server's tests (#36).

Label: mechanical mutation of a product shot. sim.render places the
Thomann product photo on black cloth with a known transform and adds hands,
projector light, keystone, blur, noise and JPEG. The truth is the clean
shot's keys (detected once, checked by eye on out/*.overlay.png) carried
through that same known transform, so it never depends on what the detector
makes of the mutated frame.

Small on purpose (960x540, JPEG 80): enough pixels for the room's scale
(white keys 12-30 px here) without making the repo heavy. Re-run with
`npm run -w @hubble/keybed fixtures` after changing sim.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import sim  # noqa: E402

OUT = HERE / "fixtures"
W, H = 960, 540

# One frame each: the conditions the stress grid found hardest, plus hands.
SINGLES = {
    "static": ({}, "static", 0),
    "rotated-135": ({"angle": 135}, "static", 0),
    "tiny": ({"width_px": 170}, "static", 0),
    "bright": ({"brightness": 1.25, "noise": 4, "jpeg": 70, "tint": [0.8, 1.0, 1.15]}, "static", 0),
    "harsh": ({"brightness": 0.6, "noise": 10, "jpeg": 40, "blur": 1.2, "keystone": 0.06}, "static", 0),
    "hover-hand": ({}, "hover", 20),
    "two-hands": ({}, "two_hands", 5),
    "lit-key": ({}, "play", 8),
}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.jpg"):
        old.unlink()
    sp = sim.load_sprite("photo")
    meta = {"label": "mechanical mutation of a product shot (reference/white-topdown-photo.jpg) by sim.py", "size": [W, H], "lowestNote": 48, "frames": []}

    def keys(truth):
        # The clean shot's keys are in note order from C3 (48), as detect.py names them.
        return [{"note": 48 + i, "black": sp.black[i], "corners": [[round(float(x), 2), round(float(y), 2)] for x, y in q]} for i, q in enumerate(truth)]

    for name, (opts, scen, idx) in SINGLES.items():
        o = {"W": W, "H": H, "seed": 3, "width_px": opts.get("width_px", 0.45 * W), **opts}
        spec = sim.scenario(scen, {**o, "frames": max(idx + 1, 24)})[idx]
        frame, truth = sim.render(spec, o)
        cv2.imwrite(str(OUT / f"{name}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        meta["frames"].append({"file": f"{name}.jpg", "kind": "single", "moving": spec.moving, "hands": len(spec.hands), "keys": keys(truth)})

    # One tracked sequence: the demo story (placed, played, dragged by a hand,
    # played with two hands), every other frame to keep it light.
    o = {"W": W, "H": H, "seed": 5, "width_px": 0.45 * W}
    for n, spec in enumerate(sim.scenario("story", o)[::2]):
        frame, truth = sim.render(spec, o)
        f = f"story-{n:02d}.jpg"
        cv2.imwrite(str(OUT / f), frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        meta["frames"].append({"file": f, "kind": "sequence", "index": n, "moving": spec.moving, "hands": len(spec.hands), "keys": keys(truth)})

    (OUT / "manifest.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {len(meta['frames'])} frames to {OUT}")


if __name__ == "__main__":
    main()
