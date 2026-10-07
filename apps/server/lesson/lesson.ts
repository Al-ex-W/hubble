/**
 * The piano lesson (act 2 of the demo): one note at a time, the next key lit
 * green, a wrong key flashed red, advance only on the right key.
 *
 * Key presses arrive as MIDI from the plugged-in MiniLab 3 (#19): exact and
 * trusted, so this engine never has to guess what was pressed. It is pure,
 * driven by note-on numbers, and knows nothing about light or geometry.
 */
export interface Song {
  title: string
  /** MIDI note numbers in order. */
  notes: number[]
}

export type PressResult = { kind: 'correct'; index: number; done: boolean } | { kind: 'wrong'; expected: number; got: number }

export function createLesson(song: Song) {
  let index = 0
  return {
    song,
    /** The note to light green, or null when the song is finished. */
    expected: (): number | null => (index < song.notes.length ? song.notes[index] : null),
    /**
     * The note after the expected one, shown as a quieter "next" marker so the
     * player can see where the hand goes after this key (owner on the live
     * table, 7 Oct: "see the next key with an indicator as well"). Null on the
     * last note and after the end: there is nothing to prepare for.
     */
    upcoming: (): number | null => (index + 1 < song.notes.length ? song.notes[index + 1]! : null),
    progress: () => ({ index, total: song.notes.length }),
    press(note: number): PressResult {
      const want = song.notes[index]
      if (want === undefined) return { kind: 'correct', index, done: true }
      if (note !== want) return { kind: 'wrong', expected: want, got: note }
      index++
      return { kind: 'correct', index: index - 1, done: index >= song.notes.length }
    },
  }
}

// Songs in note numbers (C4 = 60). Chosen to fit the MiniLab's 25 keys from C3.
export const SONGS: Record<string, Song> = {
  'ode-to-joy': { title: 'Ode to Joy', notes: [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62] },
  'twinkle': { title: 'Twinkle Twinkle', notes: [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60] },
}
