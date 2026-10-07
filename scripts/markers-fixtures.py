"""Step 2 of the marker fixtures (#91): composite markers into the recorded room frame.

Label: mechanical mutation of a recording. The base is the recorded `off.jpg`
(calibration-2026-10-07: our /table page on the projector, nothing lit). The
markers are rendered by OpenCV's own ArUco generator (cv2.aruco, DICT_4X4_1000),
NOT by our layout code's bits, and warped by cv2 at the camera->table map the
recorded dot run fits. So the fixture's truth is independent of the code under
test: the detector (js-aruco2) and the fit (localize.ts) must recover it.

Light model, kept simple and stated so a reader can judge it:
- projected markers ADD light: camera = off + GAIN * light, where light is the
  projector image (lit quiet zone, black marker, white cells) warped into the
  camera and blurred 1.2 px (projector focus + Brio optics);
- printed markers MULTIPLY: camera = off * (DARK + (1 - DARK) * paper), ink at
  DARK of the table's brightness.
Neither is a measurement of the real room's contrast; the next hardware window
records real frames (plan, "Verification boundary").

Run: npx tsx scripts/markers-fixtures.ts && python3 scripts/markers-fixtures.py
"""
import json
import os

import cv2
import numpy as np

OUT = 'apps/server/fixtures/markers-2026-10-07/'
GAIN = 110.0
DARK = 0.25
inp = json.load(open(OUT + 'inputs.json'))
H = np.array(inp['cameraToTable'], dtype=np.float64).reshape(3, 3)
TO_CAM = np.linalg.inv(H)
W, Hh = inp['surface']['widthPx'], inp['surface']['heightPx']
DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_1000)
base = cv2.imread(inp['source'], cv2.IMREAD_COLOR).astype(np.float32)
CAM = (base.shape[1], base.shape[0])


# Pixel conventions. Our maps (the dot fit, MediaPipe landmarks, the
# detector's corners) put the image's left EDGE at x=0, so pixel i spans
# [i, i+1]. cv2.warpPerspective works in pixel CENTRES (pixel i at i). A map
# M in edge coordinates is S(-0.5) M S(+0.5) for cv2; without this the
# fixtures' truth is half a camera pixel off from what they show (found when
# the detector moved to edge coordinates and every variant shifted ~0.6 px).
def cv(m):
    s = np.array([[1, 0, 0.5], [0, 1, 0.5], [0, 0, 1]], np.float64)
    return np.linalg.inv(s) @ m @ s


def projected_light(markers, skip=()):
    """The projector's image in table px: 1 = full light, 0 = none."""
    img = np.zeros((Hh, W), np.float32)
    for m in markers:
        if m['id'] in skip:
            continue
        (x0, y0), (x1, _), _, _ = [(c['x'], c['y']) for c in m['corners']]
        side = int(round(x1 - x0))
        cell = side // 6
        q = cell
        img[int(y0) - q:int(y0) + side + q, int(x0) - q:int(x0) + side + q] = 1.0
        mk = cv2.aruco.generateImageMarker(DICT, m['id'], side).astype(np.float32) / 255.0
        img[int(y0):int(y0) + side, int(x0):int(x0) + side] = mk
    return img


def add_light(cam, light_table, to_cam):
    light = cv2.warpPerspective(light_table, cv(to_cam), CAM, flags=cv2.INTER_LINEAR)
    light = cv2.GaussianBlur(light, (0, 0), 1.2)
    return cam + GAIN * light[..., None]


def add_ink(cam, anchors, side_px, to_cam, moved=None):
    """Printed markers, each a 60 mm black square on a white margin of one cell."""
    paper = np.ones((CAM[1], CAM[0]), np.float32)
    res = 600
    for a in anchors:
        x, y = a['x'], a['y']
        if moved and a['id'] == moved[0]:
            x, y = x + moved[1], y + moved[2]
        mk = cv2.aruco.generateImageMarker(DICT, a['id'], res).astype(np.float32) / 255.0
        cell = res // 6
        mk = cv2.copyMakeBorder(mk, cell, cell, cell, cell, cv2.BORDER_CONSTANT, value=1.0)
        n = mk.shape[0]
        # Marker image px -> table px: the black square spans [x - s/2, x + s/2].
        s = side_px / res
        to_table = np.array([[s, 0, x - side_px / 2 - cell * s], [0, s, y - side_px / 2 - cell * s], [0, 0, 1]])
        # Pre-blur the 600 px source by its downscale, so warping it doesn't alias.
        scale = side_px * 0.8 / res
        mk = cv2.GaussianBlur(mk, (0, 0), max(0.5, 0.5 / scale))
        warped = cv2.warpPerspective(mk, cv(to_cam @ to_table), CAM, flags=cv2.INTER_LINEAR, borderValue=1.0)
        mask = cv2.warpPerspective(np.ones((n, n), np.float32), cv(to_cam @ to_table), CAM, flags=cv2.INTER_NEAREST)
        paper = np.where(mask > 0, warped, paper)
    return cam * (DARK + (1 - DARK) * paper[..., None])


def occlude(cam, markers, ids, to_cam):
    """A grey hand-sized blob over each listed marker."""
    out = cam.copy()
    for m in markers:
        if m['id'] not in ids:
            continue
        c = np.mean([[p['x'], p['y']] for p in m['corners']], axis=0)
        u = cv2.perspectiveTransform(c.reshape(1, 1, 2).astype(np.float64), to_cam)[0, 0]
        cv2.ellipse(out, (int(u[0]), int(u[1])), (95, 70), 20, 0, 360, (120, 135, 160), -1)
    return out


def save(name, img, truth, size, expect, quality=88):
    cv2.imwrite(OUT + name + '.jpg', np.clip(img, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, quality])
    frames.append({'name': name, 'width': size[0], 'height': size[1], 'cameraToTable': (truth / truth[2, 2]).flatten().tolist(), 'expect': expect, 'jpegQuality': quality})


frames = []
proj = inp['projected']
phys = inp['physical']
pid = [m['id'] for m in proj]
lit = projected_light(proj)

save('projected', add_light(base, lit, TO_CAM), H, CAM, {'ids': pid})
save('projected-q40', add_light(base, lit, TO_CAM), H, CAM, {'ids': pid}, quality=40)
save('projected-occluded', occlude(add_light(base, lit, TO_CAM), proj, (5, 6), TO_CAM), H, CAM, {'ids': [i for i in pid if i not in (5, 6)]})
save('physical', add_ink(base, phys['anchors'], phys['sidePx'], TO_CAM), H, CAM, {'ids': [a['id'] for a in phys['anchors']]})
save('projected-physical', add_ink(add_light(base, lit, TO_CAM), phys['anchors'], phys['sidePx'], TO_CAM), H, CAM, {'ids': pid + [a['id'] for a in phys['anchors']]})
# One printed marker moved 150 table px after its anchor was learned: its
# corners agree with each other but not with the plane. RANSAC must drop it.
save('physical-moved', add_ink(add_light(base, lit, TO_CAM), phys['anchors'], phys['sidePx'], TO_CAM, moved=(42, -150, -60)), H, CAM, {'ids': pid + [a['id'] for a in phys['anchors']], 'outlier': 42})

# A synthetic oblique "iPad" view: the same scene through one more
# perspective, at 1280x720. truth = (cam -> table) o (ipad -> cam).
IPAD = (1280, 720)
src = np.float32([[0, 0], [CAM[0], 0], [CAM[0], CAM[1]], [0, CAM[1]]])
dst = np.float32([[70, 40], [1230, 0], [1280, 720], [0, 680]])
P = cv2.getPerspectiveTransform(src, dst)
scene = add_ink(add_light(base, lit, TO_CAM), phys['anchors'], phys['sidePx'], TO_CAM)
ipad = cv2.warpPerspective(np.clip(scene, 0, 255), cv(P), IPAD, flags=cv2.INTER_AREA)
save('ipad-oblique', ipad, H @ np.linalg.inv(P), IPAD, {'ids': pid + [a['id'] for a in phys['anchors']]})

json.dump({
    'label': 'mechanical mutation of a recording',
    'recording': inp['source'],
    'how': 'scripts/markers-fixtures.ts then scripts/markers-fixtures.py (cv2 %s)' % cv2.__version__,
    'model': {'gain': GAIN, 'inkDark': DARK, 'blurPx': 1.2},
    'projected': proj,
    'anchors': phys['anchors'],
    'frames': frames,
    # cv2's own bits per id (row-major, '1' = white), the oracle for the
    # overlay drawing: our markerShapes() gets its bits from js-aruco2.
    'bits': {str(i): ''.join('1' if cv2.aruco.generateImageMarker(DICT, i, 6)[1 + k // 4, 1 + k % 4] > 0 else '0' for k in range(16)) for i in pid + [a['id'] for a in phys['anchors']]},
}, open(OUT + 'manifest.json', 'w'), indent=1)
print('wrote', [f['name'] for f in frames])
