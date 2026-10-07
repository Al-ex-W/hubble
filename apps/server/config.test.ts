import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_ALLOW, loadConfig, readiness } from './config.ts'

const FULL_ENV = {
  HUBBLE_LLM_API_KEY: 'sk-real',
}

describe('config', () => {
  it('loads what the server needs, including the LLM key for table rendering', () => {
    expect(loadConfig(FULL_ENV)).toEqual({
      jevApiKey: undefined,
      voiceId: 'CwhRBWXzGAHq8TQ4Fs17',
      port: 8787,
      spatialRegistrationFile: '.hubble/spatial-registration.json',
      spatialAnchorsFile: '.hubble/anchors.json',
      llm: { baseUrl: 'https://llm.aiqu.ai/v1', apiKey: 'sk-real', model: 'aixia-labs' },
      tableAgent: true,
      webAllow: DEFAULT_WEB_ALLOW,
    })
  })

  it('HUBBLE_WEB_ALLOW replaces the web allow-list rather than adding to it (#31)', () => {
    // Break caught: the room locked to one site still showing the defaults,
    // or a stray comma allowing the empty hostname.
    expect(loadConfig({ ...FULL_ENV, HUBBLE_WEB_ALLOW: ' www.desmos.com, ,127.0.0.1 ' }).webAllow).toEqual(['www.desmos.com', '127.0.0.1'])
    expect(loadConfig({ ...FULL_ENV, HUBBLE_WEB_ALLOW: '  ' }).webAllow).toEqual(DEFAULT_WEB_ALLOW)
    // The stage switch back to direct renders (#54): only an explicit off turns the agent off.
    expect(loadConfig({ ...FULL_ENV, HUBBLE_TABLE_AGENT: 'OFF ' }).tableAgent).toBe(false)
    expect(loadConfig({ ...FULL_ENV, HUBBLE_TABLE_AGENT: 'yes' }).tableAgent).toBe(true)
  })

  it('boots from an empty environment: no key is a boot requirement', () => {
    // Break caught: a missing key (once ELEVENLABS_API_KEY, for the parked
    // voice orb) throwing in loadConfig and taking the math and keyboard acts
    // down with it. Missing keys are reported by readiness(), not by a crash.
    expect(() => loadConfig({})).not.toThrow()
    expect(loadConfig({}).llm.apiKey).toBeUndefined()
  })

  it('the puppet master voice and model settings are all optional', () => {
    // Break caught: ELEVENLABS_API_KEY becoming a boot requirement again (main
    // removed that), or a typo in HUBBLE_LLM_THINKING reaching a provider that
    // rejects the field.
    const c = loadConfig({ ...FULL_ENV, ELEVENLABS_API_KEY: 'sk-replace-me', HUBBLE_LLM_THINKING: 'maybe' })
    expect(c.elevenLabsApiKey).toBeUndefined()
    expect(c.llm.thinking).toBeUndefined()
    const d = loadConfig({ ...FULL_ENV, ELEVENLABS_API_KEY: 'el-real', ELEVENLABS_AGENT_ID: 'agent_1', HUBBLE_LLM_THINKING: ' ON ', HUBBLE_PUPPET_MODEL: 'm', ELEVENLABS_TTS_MODEL: 't' })
    expect([d.elevenLabsApiKey, d.agentId, d.llm.thinking, d.llm.puppetModel, d.ttsModel]).toEqual(['el-real', 'agent_1', 'on', 'm', 't'])
  })

  it('HUBBLE_LLM_MODEL is the default model', () => {
    // Break caught: config ignoring the env var (the brain falls back to
    // config.llm.model for every request that names none).
    expect(loadConfig({ ...FULL_ENV, HUBBLE_LLM_MODEL: 'aixia-code' }).llm.model).toBe('aixia-code')
  })

  it('treats an unedited placeholder as missing', () => {
    // Break caught: .env copied from .env.example unedited, sending the
    // literal placeholder as a bearer token and getting a confusing 401.
    expect(loadConfig({ HUBBLE_LLM_API_KEY: 'sk-replace-me' }).llm.apiKey).toBeUndefined()
    expect(loadConfig({ TYPESAFE_API_KEY: 'replace-me' }).jevApiKey).toBeUndefined()
  })

  it('reports readiness per piece without throwing', () => {
    expect(readiness(FULL_ENV)).toEqual({ llm: true, jev: false, elevenlabs: false })
    expect(readiness({})).toEqual({ llm: false, jev: false, elevenlabs: false })
  })
})
