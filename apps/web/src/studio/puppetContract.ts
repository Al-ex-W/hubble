/** Speech and tools are one ordered turn. The speech acknowledgement is sent
 * only after playback ends, so a following canvas edit cannot race the voice. */
export type PuppetEvent =
  | { type: 'speech'; id: string; text: string; audio: boolean }
  | { type: 'tool'; name: string; phase: 'start' | 'done' }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface PuppetTurn { role: 'user' | 'assistant'; content: string }
