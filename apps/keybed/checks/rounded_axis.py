"""
The sidecar's shrink keeps a separate x and y scale (review #41, round 2).

A frame whose size doesn't divide evenly (2881x1621) is shrunk to 1920x1080:
the output sizes are rounded to whole pixels, so the two axes really have
different scales (1920/2881 vs 1080/1621). Using one nominal scale for both
put corners up to 0.32 px off on the rounded axis.

Oracle: the inverse pixel-centre transform from the independently known
source and destination sizes, applied to the detection on the shrunk frame.
Label: mechanical mutation (a nearest-neighbour resize of fixtures/static.jpg).
Run by apps/server/keybed.test.ts; exits non-zero on failure.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import service  # noqa: E402  (importing does not start the server)
from detect import detect  # noqa: E402

img = cv2.resize(cv2.imread(str(HERE / "fixtures/static.jpg")), (2881, 1621), interpolation=cv2.INTER_NEAREST)
small, scales = service._shrink(img)
assert small.shape[:2] == (1080, 1920), small.shape
res = detect(small)
actual = np.array([k["corners"] for k in service._keys_out(res, scales)])
expected = (np.array([k["corners"] for k in res.keys]) + 0.5) * np.array([2881 / 1920, 1621 / 1080]) - 0.5
worst = float(np.max(np.abs(actual - expected)))
print(json.dumps({"scales": scales, "worst_error_px": round(worst, 4)}))
# Corners are rounded to 0.01 px on the way out; the nominal-scale bug was 0.32 px.
sys.exit(0 if worst < 0.02 else 1)
