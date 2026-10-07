import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEXICON_TXT } from './lexicon-words.ts'
import { LEXICON } from './lexicon.ts'

describe('lexicon', () => {
  it('the generated module is exactly lexicon.txt', () => {
    // Break caught: lexicon.txt edited without re-running
    // scripts/gen-lexicon.ts, so the keyboard silently keeps the old words.
    expect(LEXICON_TXT).toBe(readFileSync(join(__dirname, 'lexicon.txt'), 'utf8'))
  })

  it('keeps every word of the list (corpus pin) with the demo words near the top', () => {
    // Break caught: a shrinking or reordered list (rank is the decoder's
    // tie-breaker). 9884 upstream words (counted: the no-swears list); 'hubble' is a demo word the web
    // list lacks.
    expect(LEXICON_TXT.split('\n').filter((w) => w.trim()).length).toBe(9884)
    expect(LEXICON.indexOf('hubble')).toBe(100)
  })
})
