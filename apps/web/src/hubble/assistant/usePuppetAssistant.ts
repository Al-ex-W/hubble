import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioTap } from '../orb/Orb.tsx'
import type { AssistantState } from './state.ts'
import type { PuppetEvent, PuppetTurn } from '../../studio/puppetContract.ts'

/** Where the viewer's voice pick lives. Per-browser convenience only: the server list
 * (/api/puppet/voices) stays the authority and the server re-validates every turn. */
export const VOICE_STORAGE_KEY = 'hubble.puppet.voice'
export interface VoiceChoice { id: string; label: string }
const readStoredVoice = () => { try { return localStorage.getItem(VOICE_STORAGE_KEY) ?? undefined } catch { return undefined } }
const writeStoredVoice = (id: string) => { try { localStorage.setItem(VOICE_STORAGE_KEY, id) } catch { /* private window / blocked storage: the pick just lasts this page load */ } }

/** One Hubble conversation. The person TYPES; Hubble answers by TALKING (the server's `say`
 * tool, played here as ElevenLabs TTS) and by editing the canvas. There is no speech INPUT:
 * the owner dropped it (7 Oct 2026, "the event is way too loud"), see the plan's scope
 * correction. A running turn is never interrupted either; only Stop (stopTurn) ends one. */
export function usePuppetAssistant(options: { followTableInput?: boolean } = {}) {
  const followTableInput = options.followTableInput === true
  const [state, setState] = useState<AssistantState>('idle')
  const [busy, setBusy] = useState(false)
  const [turns, setTurns] = useState<Array<PuppetTurn & { id: number }>>([])
  const [error, setError] = useState<string | null>(null)
  const [activity, setActivity] = useState('')
  // A short line for the page to show when a table input was dropped because a turn was running.
  const [notice, setNotice] = useState<string | null>(null)
  const id = useRef<Promise<string> | null>(null)
  const sessionId = useRef<string | null>(null)
  const active = useRef<AbortController | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const serial = useRef(0)
  const mounted = useRef(true)
  const selected = useRef<string | undefined>(undefined)
  const [voices, setVoices] = useState<VoiceChoice[]>([])
  const [voice, setVoiceState] = useState<string | undefined>(undefined)
  // Only an EXPLICIT pick is sent with a turn. Sending the displayed default too
  // would override the hosted agent's voice (ELEVENLABS_AGENT_ID) for everyone
  // who never touched the select; the server's precedence is pick > agent > default.
  const chosenVoice = useRef<string | undefined>(undefined)
  // Synchronous "a turn is running" flag. React `busy` state lags a render behind, so two
  // sends inside that gap (a double Enter) would both pass a state check; the guard must be a ref.
  const turnActive = useRef(false)
  // Autoplay unlock happens once, inside the first send (a user gesture).
  const unlocked = useRef(false)

  const ensureSession = useCallback(() => {
    return id.current ??= fetch('/api/puppet/sessions', { method: 'POST' }).then(async response => {
      const data = await response.json()
      if (!response.ok || typeof data.id !== 'string') throw new Error(data.error ?? 'Could not open Hubble.')
      sessionId.current = data.id
      return data.id as string
    }).catch(error => { id.current = null; throw error })
  }, [])

  const stopTurn = useCallback(() => {
    active.current?.abort()
    audio.current?.pause()
    audio.current = null
    if (sessionId.current) void fetch(`/api/puppet/sessions/${sessionId.current}/cancel`, { method: 'POST' }).catch(() => {})
  }, [])

  /** Starts one agent turn. Resolves true if it ran, false if ignored (empty text
   * or a turn already active). The active turn wins and the newcomer is dropped (a new
   * turn used to abort the running one, and one stray sentence killed a demo answer
   * mid-speech). Only the explicit Stop button (stopTurn) cancels. The server also
   * answers 409 busy if a second turn is posted, so this guard is the polite
   * client-side half of it. */
  const send = useCallback(async (text: string, target?: string): Promise<boolean> => {
    if (!text.trim()) return false
    if (turnActive.current) return false
    turnActive.current = true
    if (!unlocked.current) {
      // Unlock playback during the user's gesture (Enter / click): speech streamed
      // after an asynchronous model/tool round trip could otherwise be blocked by autoplay policy.
      unlocked.current = true
      const unlock = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=')
      try { void unlock.play().catch(() => {}) } catch { /* no autoplay unlock available: playback may still work after any interaction */ }
    }
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError(null); setState('thinking'); setActivity('Thinking')
    setTurns(previous => [...previous, { id: ++serial.current, role: 'user', content: text }])
    try {
      const session = await ensureSession()
      controller.signal.throwIfAborted()
      const cancel = await fetch(`/api/puppet/sessions/${session}/cancel`, { method: 'POST', signal: controller.signal })
      if (!cancel.ok) throw new Error('Conversation expired. Restart Hubble.')
      controller.signal.throwIfAborted()
      const response = await fetch(`/api/puppet/sessions/${session}/turn`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, selected: target, audio: true, voice: chosenVoice.current }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error ?? `Hubble request failed (${response.status})`)
      }
      if (!response.body) throw new Error('Hubble returned no stream.')
      const acknowledge = async (speech: string, ok: boolean) => {
        const ack = await fetch(`/api/puppet/sessions/${session}/speech/${speech}/ack`, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok }),
        })
        if (!ack.ok) throw new Error('Speech acknowledgement failed.')
      }
      const receive = async (event: PuppetEvent) => {
        controller.signal.throwIfAborted()
        if (event.type === 'error') throw new Error(event.message)
        if (event.type === 'tool') { setActivity(`${event.phase === 'start' ? 'Working: ' : 'Finished: '}${event.name.replaceAll('_', ' ')}`); return }
        if (event.type !== 'speech') return
        setTurns(previous => [...previous, { id: ++serial.current, role: 'assistant', content: event.text }])
        if (!event.audio) { await acknowledge(event.id, true); return }
        const player = new Audio(`/api/puppet/sessions/${session}/speech/${event.id}`)
        audio.current = player
        setState('speaking'); setActivity('Speaking')
        try {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              controller.signal.removeEventListener('abort', aborted)
              player.onended = null; player.onerror = null
            }
            const aborted = () => { player.pause(); cleanup(); reject(new Error('Playback stopped.')) }
            player.onended = () => { cleanup(); resolve() }
            player.onerror = () => { cleanup(); reject(new Error('ElevenLabs audio could not be played.')) }
            controller.signal.addEventListener('abort', aborted, { once: true })
            void player.play().catch(reason => { cleanup(); reject(reason) })
          })
          await acknowledge(event.id, true)
        } catch (reason) {
          if (!controller.signal.aborted) await acknowledge(event.id, false)
          throw reason
        } finally {
          player.pause(); player.removeAttribute('src'); player.load()
          if (audio.current === player) audio.current = null
        }
        setState('thinking')
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let doneEvent = false
      try {
        while (true) {
          const { value, done } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
            if (line.trim()) {
              const event = JSON.parse(line) as PuppetEvent
              if (event.type === 'done') doneEvent = true
              await receive(event)
            }
          }
          if (done) break
        }
        if (!doneEvent) throw new Error('Hubble stream ended before the turn finished.')
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current) setError(reason instanceof Error ? reason.message : 'Hubble could not respond.')
      if (!controller.signal.aborted) throw reason
    } finally {
      if (active.current === controller) {
        active.current = null
        turnActive.current = false
        if (mounted.current) { setBusy(false); setState('idle'); setActivity('') }
      }
    }
    return true
  }, [ensureSession])

  // Text typed on Julius's inputs (the projected keyboard's SEND, pinch typing) arrives on the
  // server's input stream. OPT-IN: only the page that is the demo passes followTableInput,
  // because every tab running this hook would otherwise start its own turn for one sentence
  // (and speak it: the first answer would play from several browsers at once).
  // The latest `send` is read through a ref so the EventSource is opened once, not re-opened
  // on every render.
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (!followTableInput || typeof EventSource === 'undefined') return
    const seen = new Set<string>()
    const source = new EventSource('/api/puppet/input/events')
    source.onmessage = (message: MessageEvent) => {
      let input: { type?: string; id?: unknown; text?: unknown }
      try { input = JSON.parse(String(message.data)) } catch { return }
      // Another landing page connected and took over the conversation (puppetInput.ts, "one page
      // only"). Stop following for good: reconnecting would steal it back and the two pages would
      // fight over it. Close, and say so, so nobody wonders why typing here no longer answers.
      if (input.type === 'superseded') {
        source.close()
        setNotice('Another screen is the conversation now. Reload this page to take it back.')
        return
      }
      if (input.type !== 'input' || typeof input.id !== 'string' || typeof input.text !== 'string') return
      // EventSource reconnects replay nothing today, but an id seen twice must never be two turns.
      if (seen.has(input.id)) return
      seen.add(input.id)
      // Same rule as the 409: a running turn is never interrupted. Drop the newcomer, say so.
      if (turnActive.current) { setNotice('Hubble is busy answering, so that message was dropped. Type it again in a moment.'); return }
      setNotice(null)
      sendRef.current(input.text).catch(() => { /* send already put the reason in `error` */ })
    }
    return () => source.close()
  }, [followTableInput])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; stopTurn()
      if (sessionId.current) void fetch(`/api/puppet/sessions/${sessionId.current}`, { method: 'DELETE', keepalive: true })
      sessionId.current = null; id.current = null
    }
  }, [stopTurn])
  useEffect(() => {
    let cancelled = false
    void fetch('/api/puppet/voices').then(async response => {
      const data = await response.json() as { voices?: VoiceChoice[]; default?: string }
      if (cancelled || !response.ok || !Array.isArray(data.voices) || typeof data.default !== 'string') return
      const stored = readStoredVoice()
      // A stored id the server no longer lists (env changed, list edited) must not
      // be sent: it would 400 every turn. Fall back to the server default instead.
      const valid = stored !== undefined && data.voices.some(v => v.id === stored)
      chosenVoice.current = valid ? stored : undefined
      setVoices(data.voices); setVoiceState(valid ? stored : data.default)
    }).catch(() => { /* no list: the select stays hidden and turns carry no voice */ })
    return () => { cancelled = true }
  }, [])
  const setVoice = useCallback((id: string) => { chosenVoice.current = id; setVoiceState(id); writeStoredVoice(id) }, [])
  const tap = useMemo<AudioTap>(() => ({ input: () => null, output: () => null }), [])
  return { state, turns, error, busy, activity, notice, stopTurn, send, tap, voices, voice, setVoice,
    select: (target?: string) => { selected.current = target } }
}
