/**
 * Prepared questions for the math act: one click each, so nothing has to be
 * typed live in front of an audience (owner, 7 Oct: preset buttons are one of
 * the three demo inputs, with typing and the projected keyboard).
 *
 * Written to stand on their own and to refer to "the task" rather than to a
 * specific equation: the table agent knows which task the iPad shows (the
 * worksheet tells every turn), so the same buttons work for any task picked
 * in step 1. Edit the wording here before the show; nothing else reads it.
 */
export const PRESETS: { label: string; text: string }[] = [
  { label: 'Solve it step by step', text: 'Solve the task on the iPad step by step.' },
  { label: 'Show the graph', text: 'Show the graph for the task on the iPad.' },
  { label: 'Explain the last step', text: 'Explain the last step again, more slowly.' },
  { label: 'Give me a hint', text: 'Give me a hint for the task on the iPad, without solving it.' },
]
