import type { usePuppetAssistant } from './usePuppetAssistant.ts'

/** The server label is "Alice (British, confident)": the select shows only the name, because a
 * full label is wider than the composer row (it was clipped under the send button at 800px) and
 * the name is what a person picks by. The full label stays on the option as its tooltip. */
export const voiceName = (label: string) => label.split(' (')[0]

/** The voice picker, shared by Studio and /hubble so both list the same server-owned voices.
 * Renders nothing until /api/puppet/voices answered: an empty select would invite a pick
 * the server never offered. */
export function VoiceSelect({ assistant, className }: { assistant: Pick<ReturnType<typeof usePuppetAssistant>, 'voices' | 'voice' | 'setVoice'>; className?: string }) {
  if (!assistant.voices.length) return null
  return <label className={className}>
    voice
    <select value={assistant.voice} onChange={event => assistant.setVoice(event.target.value)}>
      {assistant.voices.map(v => <option key={v.id} value={v.id} title={v.label}>{voiceName(v.label)}</option>)}
    </select>
  </label>
}
