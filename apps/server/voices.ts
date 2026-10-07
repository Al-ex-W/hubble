import type { ServerConfig } from './config.ts'

export interface VoiceOption { id: string; label: string }

/**
 * THE ONE OWNER of which ElevenLabs voices the UI may pick for the puppet master.
 *
 * Source of truth: these are ElevenLabs premade voices, verified present in the
 * owner's account on 2026-10-07 with `elevenlabs voices search`. Ids are account
 * facts, not guesses; if one ever stops resolving, TTS answers 4xx and the speech
 * route reports "Speech unavailable", so re-verify with that command rather than
 * editing an id from memory. The demo speaks English, so only English-fluent
 * voices are listed (the model, DEFAULT_TTS_MODEL, stays multilingual).
 *
 * Why a closed server-side list and not "any id the browser sends": the browser
 * is untrusted and the server holds the ElevenLabs key. An arbitrary id would let
 * any page on the network make us call TTS with voices we never vetted (including
 * cloned or other-account voices). puppetMaster.ts rejects unknown ids with 400.
 */
export const PREMADE_VOICES: readonly VoiceOption[] = [
  { id: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger (American man, laid-back)' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice (British woman, clear educator)' },
  { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica (American woman, playful, warm)' },
  { id: 'cjVigY5qzO86Huf0OWal', label: 'Eric (American man, smooth)' },
  { id: 'SAz9YHcvj6GT2YYXdXww', label: 'River (neutral, relaxed)' },
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel (British man, broadcaster)' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda (American woman, professional)' },
]

/** Roger: the voice the server used before voices were selectable. */
export const FALLBACK_VOICE_ID = PREMADE_VOICES[0].id

/** The default voice: ELEVENLABS_TTS_VOICE_ID (config.ts defaults it to Roger). */
export const defaultVoiceId = (config: Pick<ServerConfig, 'voiceId'>) => config.voiceId ?? FALLBACK_VOICE_ID

/**
 * The selectable list for this server. A voice set in .env that is not one of the
 * premade ones is PREPENDED, not dropped: the owner chose it deliberately, and a
 * list that silently omitted the configured default would make the select show a
 * different voice than the one actually speaking.
 */
export function voiceOptions(config: Pick<ServerConfig, 'voiceId'>): VoiceOption[] {
  const id = defaultVoiceId(config)
  return PREMADE_VOICES.some(voice => voice.id === id)
    ? [...PREMADE_VOICES]
    : [{ id, label: 'Custom (ELEVENLABS_TTS_VOICE_ID)' }, ...PREMADE_VOICES]
}
