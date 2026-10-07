"""
How much work one detection does, counted rather than timed (#44).

Every blob seeds a candidate group of black keys, but most seeds find the
same group again; refitting each copy made a detection with a hand over the
keys ~250 ms and pushed the demo-story test past its 5 s budget under load.
Groups are now fitted once per distinct membership. This counts the RANSAC
fits on that same frame: wall-clock time on a loaded laptop is noise, a
count is not. Label: the committed fixture story-15.jpg (mechanical mutation
of a product shot, a hand dragging the keyboard). Run by
apps/server/keybed.test.ts; exits non-zero when the work grows back.
"""

import json
import sys
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import detect  # noqa: E402

calls = 0
fit = detect._ransac_pattern


def counted(pos):
    global calls
    calls += 1
    return fit(pos)


detect._ransac_pattern = counted
img = cv2.imread(str(HERE / "fixtures/story-15.jpg"))
res = detect.find_black_keys(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
print(json.dumps({"ransac_fits": calls, "visible": res[1]["visible_black"]}))
# 160 before (one per seed); about 20 distinct groups over the 25 settings now.
sys.exit(0 if calls <= 40 else 1)
