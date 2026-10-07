"""
Keybed sidecar: the server's camera loop asks it where the MiniLab's keys are.

Why a sidecar and not a TypeScript port (#36, docs/plans/2026-10-06-keybed-
detector.md): detect.py and track.py are the code that was proven on the
simulator (100 % of still frames light the right key); moving them in as-is
carries no re-implementation risk the day before the demo. The app itself
stays OpenCV-free (packages/room camera.ts): only this process needs
opencv-python, and when it is not running the runtime falls back to
perceive.ts and the lesson still works.

Endpoints (127.0.0.1 only: the server on the same laptop is the one client):
  POST /track   JPEG body -> the tracker's answer (keeps its reference picture between calls)
  POST /detect  JPEG body -> one stateless detection (tests, debugging)
  POST /reset   forget the tracked keyboard (tests; the keyboard was swapped)
  GET  /health  -> { ok, opencv }
Answers: { status, keybed: [[x,y], ...] | null, keys: [{note, name, black, corners}] | null, visibleBlack, check, ms }.
corners are camera px of the frame that was posted, in the KeyQuad order
near-left, near-right, far-right, far-left (near = the player's edge).

Run: `python3 apps/keybed/service.py` (port KEYBED_PORT, default 8792), or
`npm run dev`, which starts it next to the server.
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

from detect import DetectionError, detect
from track import Tracker

PORT = int(os.environ.get("KEYBED_PORT", "8792"))
# Detection cost grows with pixels and the algorithm is scale-free (every
# threshold is in white-key widths), so big frames are shrunk first. The
# room's full-res still is up to 4K, which would take seconds; at a 1920 long
# side the MiniLab's white keys are still ~12 px at the room's ~1.6 mm/px.
MAX_SIDE = int(os.environ.get("KEYBED_MAX_SIDE", "1920"))  # settable so a test can check the scale-back exactly
MAX_BODY = 25 * 1024 * 1024

_lock = threading.Lock()  # one tracker, one client; requests are serialised
_tracker = Tracker()
_tracker_shape: tuple[int, int] | None = None


def _shrink(img: np.ndarray) -> tuple[np.ndarray, tuple[float, float]]:
    """Returns the frame to detect on and its (x, y) scale. Each axis keeps
    its own scale: the output sizes are rounded to whole pixels, so one
    nominal scale for both axes would be slightly off on the rounded one."""
    h, w = img.shape[:2]
    s = min(1.0, MAX_SIDE / max(h, w))
    if s >= 1.0:
        return img, (1.0, 1.0)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    return cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA), (nw / w, nh / h)


def _corners_out(corners, s: tuple[float, float]) -> list[list[float]]:
    """Keys and the enclosing boundary share one pixel-centre inverse. A
    separately scaled boundary would drift from keys on the operator preview
    whenever a large camera frame was shrunk. resize maps pixel centres as
    (x + 0.5) * s - 0.5, so the inverse is (x + 0.5) / s - 0.5, not x / s."""
    c = np.array(corners, dtype=np.float64)
    if s != (1.0, 1.0):
        c = (c + 0.5) / np.array(s, dtype=np.float64) - 0.5
    return c.round(2).tolist()


def _keys_out(res, s: tuple[float, float]) -> list[dict]:
    return [{"note": k["note"], "name": k["name"], "black": k["black"],
             "corners": _corners_out(k["corners"], s)} for k in res.keys]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # the server logs failures; keep this quiet
        pass

    def _json(self, code: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _frame(self):
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_BODY:
            return None
        buf = np.frombuffer(self.rfile.read(n), dtype=np.uint8)
        return cv2.imdecode(buf, cv2.IMREAD_COLOR)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "opencv": cv2.__version__})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        global _tracker, _tracker_shape
        if self.path == "/reset":
            with _lock:
                _tracker = Tracker()
                _tracker_shape = None
            return self._json(200, {"ok": True})
        if self.path not in ("/track", "/detect"):
            return self._json(404, {"error": "not found"})
        img = self._frame()
        if img is None:
            return self._json(400, {"error": "expected a JPEG body"})
        t0 = time.time()
        small, s = _shrink(img)
        try:
            with _lock:
                if self.path == "/track":
                    # A retained pose belongs to the previous frame space.
                    # Applying this frame's inverse resize to that old pose
                    # put every corner outside the image on a 3x→1x switch.
                    # Reacquire even if both frames shrink to the same size:
                    # resolution changes may also change the crop/FOV, and
                    # there is no recorded transform that preserves the pose.
                    if _tracker_shape != img.shape[:2]:
                        _tracker = Tracker()
                        _tracker_shape = img.shape[:2]
                    st = _tracker.step(small)
                    body = {
                        "status": st.status,
                        "keybed": _corners_out(st.res.keybed, s) if st.res is not None else None,
                        "keys": _keys_out(st.res, s) if st.res is not None else None,
                        "visibleBlack": st.visible,
                        "check": round(st.check, 3),
                    }
                else:
                    try:
                        res = detect(small)
                        body = {"status": "detected", "keybed": _corners_out(res.keybed, s), "keys": _keys_out(res, s), "visibleBlack": res.diagnostics.get("visible_black"), "check": None}
                    except DetectionError as e:
                        body = {"status": "none", "keybed": None, "keys": None, "visibleBlack": None, "check": None, "reason": str(e)}
        except Exception as e:  # a bug here must not take the sidecar down mid-demo
            return self._json(500, {"error": f"{type(e).__name__}: {e}"[:300]})
        body["ms"] = round((time.time() - t0) * 1000)
        self._json(200, body)


if __name__ == "__main__":
    print(f"keybed sidecar on http://127.0.0.1:{PORT} (opencv {cv2.__version__})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
