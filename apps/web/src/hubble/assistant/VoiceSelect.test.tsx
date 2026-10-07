import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceSelect, voiceName } from './VoiceSelect.tsx'

describe('VoiceSelect', () => {
  it('shows only the voice name in the option, with the full server label as its title', () => {
    // Break caught: the full label ("Roger (American male, ...)") is wider than the
    // Studio composer row and was clipped under the send button at 800px.
    const html = renderToStaticMarkup(<VoiceSelect assistant={{ voices: [{ id: 'a', label: 'Alice (British, confident)' }, { id: 'b', label: 'Custom (ELEVENLABS_TTS_VOICE_ID)' }], voice: 'a', setVoice: () => {} } as any} />)
    expect(html).toMatch(/title="Alice \(British, confident\)"[^>]*>Alice<\/option>/)
    expect(html).not.toContain('>Alice (')
    expect(voiceName('Plain')).toBe('Plain')
  })
})
