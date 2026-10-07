# @hubble/stage-react

The renderer for [@hubble/stage](https://github.com/Juliusolsson05/hubble-stage):
it consumes finished stage events and draws them on the projected table.

- `src/director.ts` — decides when each piece appears (answers arrive whole in
  about a second; the director paces them into something readable).
- `src/StageView.tsx` — the projection surface and every answer component.
- `src/SurfaceLayer.tsx` — draws the table's surface set (answers, assets,
  webpages, the keyboard) at the boxes the server owns.
- `src/KeyboardFace.tsx` — the swipe keyboard's face, drawn from its state;
  `src/keyboard.css` is its look.
- `src/AssetView.tsx` — one library asset, inside an answer's panel or as
  its own surface on the table.
- `src/math/` — MathJax SVG typesetting with pen-written glyphs.
- `src/plot/` — `Plot` drawing (formulas go through stage's safe evaluator).
- `src/styles.css` — projection look (black is no light; Pi-safe effects only).

It never parses model text; that is `@hubble/stage`'s job.

Developed inside the [hubble](https://github.com/Juliusolsson05/hubble) app
repo, mounted as a submodule at `packages/stage-react`.
