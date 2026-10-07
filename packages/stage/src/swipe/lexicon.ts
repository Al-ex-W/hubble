// The list as a module, not `lexicon.txt?raw`: the server imports these
// rules too (#29), and only Vite understands `?raw` (scripts/gen-lexicon.ts).
import { LEXICON_TXT as base } from './lexicon-words.ts'

/**
 * The words the keyboard can produce, most frequent first (rank is the
 * decoder's tie-breaker).
 *
 * lexicon.txt is google-10000-english-usa-no-swears from
 * github.com/first20hours/google-10000-english, derived from the Google Web
 * Trillion Word Corpus. Its terms allow research and educational use, which
 * covers the hackathon demo; anything commercial needs another list.
 */

// What people will actually say to Hubble on stage, and words the web list
// lacks ("hubble"). Ranked just after the very commonest words so they win
// ties against rarer lookalikes without outranking "the" or "and".
const DEMO = [
  'hubble', 'hello', 'hi', 'math', 'solve', 'explain', 'show', 'help', 'next', 'stop', 'again', 'step',
  'integral', 'derivative', 'equation', 'function', 'graph', 'plot', 'theorem', 'pythagorean', 'notebook',
  'task', 'answer', 'why', 'how', 'what', 'piano', 'song', 'lesson', 'play', 'teach',
]

const words = base.split('\n').map((w) => w.trim()).filter(Boolean)

export const LEXICON: string[] = [...new Set([...words.slice(0, 100), ...DEMO, ...words.slice(100)])]
