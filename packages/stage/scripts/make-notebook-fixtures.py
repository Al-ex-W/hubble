"""Renders synthetic notebook photos for the render pipeline.

Labelled SYNTHETIC: drawn pages, not camera captures. They stand in for a
cropped 4K still of a notebook page (the MX Brio sees ~0.8 mm/px at 1.75 m, so
a page is a few hundred pixels wide). Two things read the JPEGs in
fixtures/notebooks/: the bench's chat (apps/web/src/preview/ChatPreview.tsx
offers them as the "photo" of the page) and the stage recorder
(scripts/record-stage-stream.ts attaches one to a recorded case). The one real
photographed page lives in packages/brain/fixtures/photos/.

The manifest.json written next to them (each page's task lines) is read by the
iPad worksheet (apps/worksheet/tasks.ts loadWorksheetTasks), which shows one
task at real size and tells the brain the task's text. Regenerate it with the
JPEGs, never by hand.
"""
import json, os, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "notebooks")
FONT = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"
TASKS = {
    "linear": ["Uppgift 3", "Lös ekvationen:", "5(2x - 3) = 4x + 9"],
    "quadratic": ["Task 7", "Solve:", "x² - 5x + 6 = 0"],
    "fractions": ["Exercise 2", "Solve for x:", "x/3 + 1/2 = 5/6"],
    "inequality": ["Uppgift 5", "Lös olikheten:", "3x - 7 < 2x + 4"],
    "derivative": ["Problem 4", "Differentiate:", "f(x) = x³ · sin(x)"],
    # Advanced set: multi-step problems that need the full-size components.
    "integral": ["Uppgift 9", "Beräkna integralen:", "∫ x·eˣ dx"],
    "system": ["Task 12", "Solve the system:", "2x + 3y = 12", "x - y = 1"],
    "optimize": ["Problem 6", "A farmer has 100 m of fence.", "Maximize the rectangular", "area against a wall."],
    "projectile": ["Physics 3", "A ball is thrown up at 20 m/s.", "How high does it go?", "When does it land? (g = 9.8)"],
    "limit": ["Exercise 8", "Evaluate:", "lim (x→0) sin(3x) / x"],
}
random.seed(7)
os.makedirs(OUT, exist_ok=True)
manifest = {}
for name, lines in TASKS.items():
    w, h = 620, 820
    im = Image.new("RGB", (w, h), (238, 236, 228))
    d = ImageDraw.Draw(im)
    for y in range(90, h, 34):  # ruled lines
        d.line([(0, y), (w, y)], fill=(170, 190, 215), width=1)
    d.line([(70, 0), (70, h)], fill=(220, 150, 150), width=2)  # margin
    y = 120
    for i, text in enumerate(lines):
        size = 34 if i < 2 else (46 if len(text) < 22 else 34)
        f = ImageFont.truetype(FONT, size)
        d.text((90 + random.randint(-4, 4), y), text, fill=(35, 40, 70), font=f)
        y += 70 if i < 2 else 80
    im = im.rotate(random.uniform(-3, 3), expand=False, fillcolor=(20, 20, 20))
    im = im.filter(ImageFilter.GaussianBlur(0.8))
    im.save(f"{OUT}/{name}.jpg", quality=82)
    # "lines" is the source of truth for line breaks; "task" stays for older
    # readers. " / " can't carry them: the limit task has a division in it
    # ("sin(3x) / x"), so splitting "task" on " / " breaks that line in two.
    manifest[name] = {"label": "synthetic", "task": " / ".join(lines[1:]), "lines": lines[1:], "size": [w, h]}
json.dump(manifest, open(f"{OUT}/manifest.json", "w"), indent=2, ensure_ascii=False)
print("wrote", len(manifest), "notebooks to", OUT)
