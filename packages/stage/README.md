# @hubble/stage

The contract of Hubble's table-rendering engine: what the model may write, the
streaming parser that turns its output into finished pieces only, and the
physical table everything is measured against. No DOM, no React.

- `src/catalog.ts` — every component the model may use (one source of truth:
  the parser validates against it, the prompt documents it, the renderer
  implements it).
- `src/parser.ts` — streaming restricted-JSX parser. Never emits a partial tag,
  attribute, or TeX body.
- `src/prompt.ts` — the system prompt, generated from the catalog and the scene.
- `src/protocol.ts` — the events the parser emits and every display consumes.
- `src/scene.ts` — the physical table: `Surface` (px + mm/px), objects, real
  sizes, type scale.
- `src/layout.ts` — panel placement guard, arrow endpoints, object-relative boxes.
- `src/geometry.ts` — overlap, gaps, sides, nearest, reading order.
- `src/report.ts` — `layoutReport` / `resolvePanels`: the one panel geometry
  the brain verifies and the renderer draws.
- `src/surfaces.ts` — the windows on the table (open, move, close, hit-test).
- `src/assets.ts` — the asset library in the catalog (`Asset`, per request).
- `src/math/expr.ts` — the safe formula evaluator for `Plot` (never `eval`).
- `src/swipe/` (`@hubble/stage/swipe`) — the swipe keyboard: key layout,
  decoder, lexicon and the reducer the runtime owns.
- `src/testing.ts` (`@hubble/stage/testing`) — loads the recordings for every
  package's tests.
- `fixtures/stage-streams/` — recorded real model streams (the test corpus);
  `fixtures/notebooks/` — synthetic notebook photos for the bench and recorder.
- `scripts/` — the recorder (`record-stage-stream.ts`) and census
  (`stage-census.ts`) that produce and audit the corpus, the lexicon generator
  (`gen-lexicon.ts`), and the notebook-photo generator.

Developed inside the [hubble](https://github.com/Juliusolsson05/hubble) app
repo, where it is mounted as a submodule at `packages/stage`; run tests and
scripts from there (`npm test`, `npm run record:stage`, `npm run census:stage`).
