# @hubble/brain

Hubble's model layer, built on the Vercel AI SDK. It turns a request (chat or
voice) into an answer that has been verified against the table before any of
it is shown, and hands the finished pieces to
[hubble-stage](https://github.com/Juliusolsson05/hubble-stage).

## How an answer is made

```
draft ──► verify ──ok──► stream to the table
            │ problems
            ▼
edit_answer(find/replace) ──► verify ──► … until it passes, or MAX_REPAIR_STEPS (3)
```

- **`src/render.ts`**: `createBrain(cfg).render(req, emit)` is the stream
  contract the server relays (`RenderStreamLine` from `@hubble/stage`):
  `start`, `trace` and `raw` lines for the bench's debug view, then the
  verified answer's `event` lines and `done`. Nothing reaches the table until
  the loop has verified it; an answer that never verifies, misses the deadline
  (15 s, 30 s with thinking) or hits a model error is replaced by a verified
  failure line and a short `error` code (a cancelled render gets only the
  code).
- **`src/agent.ts`**: `runLoop`. The draft is plain text; repairs are
  `edit_answer` tool calls. The AI SDK's `stopWhen` is our verification: the
  loop ends the moment it passes, or after `MAX_REPAIR_STEPS`.
- **`src/verify.ts`**: `verifyAnswer` parses with the stage parser (catalog for
  this table) and measures with `layoutReport`, then turns what blocks
  rendering into problems written for the model. Optionally (when
  `TYPESAFE_API_KEY` is set), Jev judges whether the main panel sits beside
  the object the request is about; only a score below 0.4 counts as a problem.
- **`src/jev.ts`**: the Jev call, with its own 2.5 s timeout plus the render's
  abort signal. It never checks math (it caught 1 of 4 broken solutions).
- **`src/edits.ts`**: token-level find/replace edits, never a rewrite, so the
  text the user reads stays as written. Ambiguous edits are refused.
- **`src/llm.ts`**: the aiqu gateway as an OpenAI-compatible provider, and the
  per-call thinking switch.
- **`src/locate.ts`**: finds tasks on a photographed worksheet from its ink
  rows. Built and tested, **not wired into the product** yet; kept for later.

## Fixtures

- `fixtures/repairs/`: real repair sessions (aixia-labs fixing failing stage
  recordings live), replayed by the loop tests. Re-record with
  `npx tsx packages/brain/scripts/record-repairs.ts` from the app repo root.
- `fixtures/photos/upgift.jpg`: a real photographed worksheet, for `locate`.

Developed inside the [hubble](https://github.com/Juliusolsson05/hubble) app
repo, mounted as a submodule at `packages/brain`.
