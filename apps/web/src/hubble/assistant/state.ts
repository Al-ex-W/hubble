import type { OrbState } from '../orb/dynamics.ts'

/** What the assistant can be doing. There is no speech input (owner, 7 Oct 2026), so the
 * orb never "listens" or "connects": it is idle, the model/tools are working (thinking), or
 * a say is playing (speaking). The orb itself still knows more faces; /hubble's preview
 * mode cycles through all of them. */
export type AssistantState = Extract<OrbState, 'idle' | 'thinking' | 'speaking'>
