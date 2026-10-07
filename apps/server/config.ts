import 'dotenv/config'

/**
 * Server configuration read from the environment, in one place, so a missing
 * key is reported at its source instead of as a confusing 401 mid-answer.
 *
 * Not every variable lives here yet: the room wiring at the bottom of
 * index.ts (ROOM, ROOM_URL, ROOM_TOKEN, ROOM_TEAM, PUBLIC_BASE, KEYBED_URL)
 * still reads process.env itself. Moving it is a follow-up of
 * docs/plans/2026-10-07-clean-codebase.md, held back only because an open
 * branch (feat/emulator-live-camera) rewrites that block.
 *
 * Nothing is required at boot. The LLM key is optional so the server starts,
 * serves /table and the operator, and runs the keyboard act even before the
 * key exists; /api/render answers 503 until it does. (Until 7 Oct the parked
 * ElevenLabs voice orb made ELEVENLABS_API_KEY a boot requirement, which meant
 * a missing *voice* key stopped the math and keyboard acts. On the owner's
 * alex/aixia-sim branch the orb and the puppet master's voice live on,
 * but ELEVENLABS_API_KEY stays optional: without it the puppet master is text only.)
 */
export interface ServerConfig {
  port: number
  /** Explicit read-only Pi input, independent of ROOM and all room outputs. */
  lidarUrl?: string
  /** Simulated lidar for the overall view: 'on' forces it available, 'off' disables it, unset = available only without a room. */
  lidarSim?: 'on' | 'off'
  /** The virtual lidar's mount, "x,y,rotation" (table mm, degrees). */
  lidarSimPose?: string
  spatialRegistrationFile?: string
  /** Learned table positions of the printed reference markers (#91). */
  spatialAnchorsFile?: string
  /**
   * The LLM the brain calls for table answers (aiqu, OpenAI-compatible). `model` is the one default:
   * requests that name no model get it (brain/render.ts), and so does the puppet master.
   */
  llm: {
    baseUrl: string
    apiKey: string | undefined
    model: string
    /**
     * HUBBLE_LLM_THINKING. Undefined means "not configured": the puppet master
     * then decides from the base URL (see puppetThinking in puppetMaster.ts).
     */
    thinking?: 'off' | 'on'
    /** HUBBLE_PUPPET_MODEL: a model for the puppet master only; table rendering keeps `model`. */
    puppetModel?: string
  }
  /**
   * Puppet master voice (owner's branch). Optional since main stopped requiring
   * ELEVENLABS_API_KEY at boot: without it the puppet master still answers, in
   * text only (puppetMaster.ts `hasVoice`).
   */
  elevenLabsApiKey?: string
  /** Optional hosted ElevenLabs agent whose configured TTS voice the puppet master reuses. */
  agentId?: string
  /** Puppet master falls back to this voice if no hosted agent is set. */
  voiceId?: string
  /** ELEVENLABS_TTS_MODEL; the puppet's speech default lives in puppetMaster.ts. */
  ttsModel?: string
  /** TypeSafe Jev, the optional placement judge in the brain's loop. */
  jevApiKey: string | undefined
  /**
   * What a web surface may show (#31): `['*']` for any public site (web.ts
   * policyFrom), or exact hostnames. Optional so test configs need not
   * spell it out; createApp falls back to DEFAULT_WEB_ALLOW.
   */
  webAllow?: string[]
  /**
   * The table agent (#54) in front of the brain: on unless HUBBLE_TABLE_AGENT=off,
   * the switch for falling back to direct renders on stage if it misbehaves.
   */
  tableAgent?: boolean
  /**
   * The room camera's base URL (pi-projector, e.g. http://192.168.42.21),
   * proxied at /api/camera/* for the hand tracker. Unset: those routes 503.
   */
  roomCameraUrl?: string
}

/**
 * Any public website (7 Oct: "it should work for every website"; the demo is
 * "open up Amazon"). Local and private addresses stay refused whatever the
 * setting (web.ts isPrivateHost): the room's devices and our own API live
 * there. HUBBLE_WEB_ALLOW=host,host replaces this with an exact list, so the
 * room can still be locked down to a few sites. Before 7 Oct the default was
 * four reference sites (Wikipedia ×2, Desmos, MDN).
 */
/** The Aiqu gateway: the one provider whose DeepSeek template needs `thinking:false` spelled out. */
export const DEFAULT_LLM_BASE_URL = 'https://llm.aiqu.ai/v1'

export const DEFAULT_WEB_ALLOW = ['*']

function isPlaceholder(value: string | undefined): boolean {
  return !value || value.trim() === '' || value.startsWith('sk-replace-me') || value === 'replace-me'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    elevenLabsApiKey: isPlaceholder(env.ELEVENLABS_API_KEY) ? undefined : env.ELEVENLABS_API_KEY,
    agentId: isPlaceholder(env.ELEVENLABS_AGENT_ID) ? undefined : env.ELEVENLABS_AGENT_ID,
    voiceId: env.ELEVENLABS_TTS_VOICE_ID ?? 'CwhRBWXzGAHq8TQ4Fs17',
    port: Number(env.PORT ?? 8787),
    lidarUrl: env.LIDAR_URL?.trim() || undefined,
    lidarSim: env.HUBBLE_LIDAR_SIM?.trim().toLowerCase() === 'on' ? 'on' : env.HUBBLE_LIDAR_SIM?.trim().toLowerCase() === 'off' ? 'off' : undefined,
    lidarSimPose: env.HUBBLE_LIDAR_SIM_POSE?.trim() || undefined,
    spatialRegistrationFile: env.HUBBLE_SPATIAL_REGISTRATION_FILE ?? '.hubble/spatial-registration.json',
    spatialAnchorsFile: env.HUBBLE_SPATIAL_ANCHORS_FILE ?? '.hubble/anchors.json',
    llm: {
      baseUrl: env.HUBBLE_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
      apiKey: isPlaceholder(env.HUBBLE_LLM_API_KEY) ? undefined : env.HUBBLE_LLM_API_KEY,
      model: env.HUBBLE_LLM_MODEL ?? 'aixia-labs',
      // Anything but exactly off/on is "unset", so a typo cannot silently
      // send a provider-specific field to a provider that rejects it.
      thinking: env.HUBBLE_LLM_THINKING?.trim().toLowerCase() === 'off' ? 'off' : env.HUBBLE_LLM_THINKING?.trim().toLowerCase() === 'on' ? 'on' : undefined,
      puppetModel: env.HUBBLE_PUPPET_MODEL?.trim() || undefined,
    },
    ttsModel: env.ELEVENLABS_TTS_MODEL?.trim() || undefined,
    jevApiKey: isPlaceholder(env.TYPESAFE_API_KEY) ? undefined : env.TYPESAFE_API_KEY,
    tableAgent: env.HUBBLE_TABLE_AGENT?.trim().toLowerCase() !== 'off',
    roomCameraUrl: env.HUBBLE_ROOM_CAMERA_URL?.trim() || undefined,
    webAllow: env.HUBBLE_WEB_ALLOW?.trim() ? env.HUBBLE_WEB_ALLOW.split(',').map((h) => h.trim()).filter(Boolean) : DEFAULT_WEB_ALLOW,
  }
}

/** Readiness for /api/health: which optional keys are present, so an operator
 * can tell "no answers because no LLM key" from a real failure without
 * reading the server log. Values are booleans only; a key never leaves here. */
export function readiness(env: NodeJS.ProcessEnv = process.env) {
  return {
    llm: !isPlaceholder(env.HUBBLE_LLM_API_KEY),
    // The /hubble orb and Studio's voice button read this to disable themselves.
    elevenlabs: !isPlaceholder(env.ELEVENLABS_API_KEY),
    jev: !isPlaceholder(env.TYPESAFE_API_KEY),
  }
}
