"""
Keybed lab: the simulator's results page (http://localhost:8799).

Where the detector and tracker were worked out, and where the numbers in
docs/plans/2026-10-06-keybed-detector.md come from. Not part of the product
path: the server talks to service.py. Kept to try ideas against the
simulator (black cloth, hands, projector light, keystone, scale sweeps)
before they reach detect.py / track.py.

Run: `python3 apps/keybed/lab.py`, open http://localhost:8799. `python3
detect.py` writes overlays for the reference images to out/; `python3 sim.py
[scenario...]` runs scenarios from the command line.
"""

from __future__ import annotations

import json
import shutil
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import sim

HERE = Path(__file__).parent
RUNS = HERE / "out" / "runs"
PORT = 8799


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _json(self, code: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.path = "/web/index.html"
        if self.path == "/api/scenarios":
            return self._json(200, sim.SCENARIOS)
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/run":
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            name = body.pop("scenario", "story")
            if name not in sim.SCENARIOS:
                return self._json(400, {"error": f"unknown scenario {name}"})
            run_id = f"{int(time.time() * 1000)}-{name}"
            d = RUNS / run_id
            d.mkdir(parents=True, exist_ok=True)
            res = sim.run(name, body, d)
            res["id"] = run_id
            res["base"] = f"/out/runs/{run_id}/"
            (d / "result.json").write_text(json.dumps(res))
            # Keep the last 30 runs only.
            old = sorted(RUNS.iterdir())[:-30]
            for o in old:
                shutil.rmtree(o, ignore_errors=True)
            return self._json(200, res)
        except Exception as e:  # surface the failure in the page, not a hung request
            return self._json(500, {"error": str(e), "trace": traceback.format_exc()})


if __name__ == "__main__":
    RUNS.mkdir(parents=True, exist_ok=True)
    print(f"keybed lab on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
