import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from './config.ts'
import { compileComponent, createGenerator, createStudioStore, mountStudio, type Generator } from './studio.ts'
import { EXAMPLES } from '../web/src/studio/examples.ts'
import type { ComponentDocument } from '../web/src/studio/contract.ts'

/**
 * Provenance: bundled examples are the product's source corpus; all other
 * inputs are synthetic or schema-derived. No model recordings exist for this
 * new endpoint yet. Expected text, request fields and pre-edit snapshots are
 * independent oracles, rather than recompiling output to compare it to itself.
 * Importing studio directly keeps this suite runnable without brain/room.
 */
const config: ServerConfig = {
  elevenLabsApiKey: 'unused-test-key', agentId: undefined, port: 0, jevApiKey: undefined,
  llm: { baseUrl: 'https://configured-provider.example/v1/', apiKey: 'synthetic-private-key', model: 'configured-studio-model' },
}
const initialSource = 'export default function Component() { return <h1>Original tool</h1>; }'
const editedSource = 'export default function Component() { return <h1>Edited tool</h1>; }'

// The compiler's boundary is React + UI + exports, not the toolkit's CSS or
// KaTeX. Minimal UI adapters let real React execute the examples' hooks while
// keeping this server suite independent of browser/toolkit transformation.
const children = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children)
const UI = {
  Stack: children, Row: children, Badge: children, Text: children, Heading: children, Button: children,
  Math: ({ tex }: { tex: string }) => React.createElement('span', null, tex),
  Slider: ({ label, value }: { label: string; value: number }) => React.createElement('label', null, label, ': ', value),
  Stat: ({ label, value }: { label: string; value: React.ReactNode }) => React.createElement('div', null, label, ': ', value),
  Progress: ({ value }: { value: number }) => React.createElement('progress', { value, max: 100 }),
  Tabs: ({ options }: { options: string[] }) => React.createElement('div', null, options.join(', ')),
}
function renderCompiled(javascript: string) {
  const exports: { default?: React.ComponentType } = {}
  new Function('React', 'UI', 'exports', javascript)(React, UI, exports)
  expect(typeof exports.default).toBe('function')
  return renderToStaticMarkup(React.createElement(exports.default!))
}

describe('component compiler', () => {
  it('executes every bundled example with real React and its initial state', () => {
    // Break caught: emitting ESM, broken JSX, or a second React instance makes
    // a source that looks valid in the store fail in the projection frame.
    expect(EXAMPLES).toHaveLength(3)
    const expected = [
      ['A little change. A new wave.', 'Frequency: 2', 'Amplitude: 0.65', '<polyline'],
      ['A moment to focus.', '25:00', 'Begin session', 'Reset'],
      ['Set the feeling.', 'Aurora, Ember, Forest', 'Intensity: 72'],
    ]
    EXAMPLES.forEach((example, index) => {
      const html = renderCompiled(compileComponent(example.source))
      for (const text of expected[index]) expect(html).toContain(text)
    })
  })

  it.each([
    ['named function', 'export default function Tool() { return <h1>Working tool</h1>; }'],
    ['anonymous function', 'export default function () { return <h1>Working tool</h1>; }'],
    ['arrow', 'export default () => <h1>Working tool</h1>;'],
    ['function expression', 'const Tool = function () { return <h1>Working tool</h1>; }; export default Tool;'],
    ['identifier', 'const Tool = () => <h1>Working tool</h1>; export default Tool;'],
  ])('renders the %s default export from actual compiler output', (_kind, source) => {
    // Break caught: recognizing only one default-export spelling, or producing
    // a default binding the frame cannot call as a React component.
    expect(renderCompiled(compileComponent(source))).toBe('<h1>Working tool</h1>')
  })

  it.each([
    ['invalid TSX', 'export default function Broken() { return <h1>Unclosed; }'],
    ['static import', 'import React from "react"; export default () => <div />;'],
    ['type import', 'import type { ReactNode } from "react"; export default () => <div />;'],
    ['import equals', 'import React = require("react"); export default () => <div />;'],
    ['dynamic import', 'export default () => { import("react"); return <div />; };'],
    ['require', 'export default () => { const x = require("react"); return <div />; };'],
    ['re-export', 'export { default } from "other-tool";'],
    ['export star', 'export * from "other-tool"; export default () => <div />;'],
    ['missing default', 'export function Tool() { return <div />; }'],
    ['export equals', 'const Tool = () => <div />; export = Tool;'],
    ['default object', 'export default { title: "not a component" };'],
    ['default class', 'export default class Tool {}'],
  ])('rejects %s before publishing JavaScript', (_kind, source) => {
    // Break caught: permissive transpilation erases imports/types or accepts
    // malformed exports, leaving a stored document that the frame cannot load.
    expect(() => compileComponent(source)).toThrow()
  })

  it('rejects JSX that expands beyond the executable frame payload limit', () => {
    // Schema-derived: TSX fits the editor limit but many small JSX nodes emit
    // much larger createElement calls. Removing the output guard must fail.
    const source = `export default () => <>${'<i/>'.repeat(10_000)}</>;`
    expect(source.length).toBeLessThan(50_000)
    expect(() => compileComponent(source)).toThrow('The compiled component is too large.')
  })
})

describe('component frame protocol', () => {
  it('preserves component state and identity when HMR repeats a requested revision', async () => {
    // Synthetic reproduction of the observed duplicate-mount protocol: replay the
    // source, then change its payload without a new revision. A module-level
    // counter independently proves neither duplicate was even evaluated.
    const bundle = await build({
      entryPoints: ['apps/web/src/studio/frameRuntime.tsx'], bundle: true, write: false,
      format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    const window = new Window({ url: 'http://studio.example/api/studio/frame?origin=http%3A%2F%2Fstudio.example', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } })
    try {
      window.document.body.innerHTML = '<div id="component"></div>'
      const messages: Array<{ type: string; revision?: number }> = []
      window.postMessage = (data: unknown) => { messages.push(data as { type: string; revision?: number }) }
      window.eval(bundle.outputFiles[0].text)
      const mount = (source: string, revision: number) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window.eval('parent'), origin: 'http://studio.example',
        data: { channel: 'hubble-component', type: 'mount', revision, javascript: compileComponent(source) },
      }))
      const source = 'globalThis.evaluations = (globalThis.evaluations || 0) + 1; export default function Tool() { const [count, setCount] = React.useState(0); return <button onClick={() => setCount(count + 1)}>Count {count}</button>; }'
      // A failed first request must not consume revision 1.
      mount('const Tool = 42; export default Tool;', 1)
      mount(source, 1)
      await vi.waitFor(() => expect(window.document.querySelector('button')?.textContent).toBe('Count 0'))
      const button = window.document.querySelector('button')!
      button.click()
      await vi.waitFor(() => expect(button.textContent).toBe('Count 1'))
      mount(source, 1)
      mount('globalThis.evaluations += 1; export default () => <h1>Replacement</h1>;', 1)
      expect(window.eval('globalThis.evaluations')).toBe(1)
      expect(window.document.querySelector('button')).toBe(button)
      expect(button.textContent).toBe('Count 1')
      expect(window.document.querySelector('h1')).toBeNull()
      mount(editedSource, 2)
      await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'mounted', revision: 2 })))
      expect(window.document.querySelector('h1')?.textContent).toBe('Edited tool')
    } finally { await window.happyDOM.close() }
  })

  it('reports the failing revision without acknowledging a failed effect mount', async () => {
    // Synthetic React lifecycle failure: testing the actual bundled runtime
    // catches an ancestor effect acknowledging success during boundary recovery.
    const bundle = await build({
      entryPoints: ['apps/web/src/studio/frameRuntime.tsx'], bundle: true, write: false,
      format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    const window = new Window({ url: 'http://studio.example/api/studio/frame?origin=http%3A%2F%2Fstudio.example', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } })
    try {
      window.document.body.innerHTML = '<div id="component"></div>'
      const messages: Array<{ type: string; revision?: number }> = []
      window.postMessage = (data: unknown) => { messages.push(data as { type: string; revision?: number }) }
      window.eval(bundle.outputFiles[0].text)
      const mount = (source: string, revision: number) => window.dispatchEvent(new window.MessageEvent('message', {
        source: window.eval('parent'), origin: 'http://studio.example',
        data: { channel: 'hubble-component', type: 'mount', revision, javascript: compileComponent(source) },
      }))
      mount('export default function Tool() { React.useEffect(() => { throw new Error("private diagnostic") }, []); return <h1>Broken effect</h1> }', 7)
      await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'error', revision: 7 })))
      mount(initialSource, 8)
      await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'mounted', revision: 8 })))
      expect(messages).not.toContainEqual(expect.objectContaining({ type: 'mounted', revision: 7 }))
      expect(JSON.stringify(messages)).not.toContain('private diagnostic')
      mount('const Tool = 42; export default Tool;', 9)
      expect(messages).toContainEqual(expect.objectContaining({ type: 'error', revision: 9 }))
      window.dispatchEvent(new window.MessageEvent('message', {
        source: window.eval('parent'), origin: 'http://studio.example',
        data: { channel: 'hubble-component', type: 'mount', revision: 10, javascript: ' '.repeat(150_001) },
      }))
      expect(messages).toContainEqual(expect.objectContaining({ type: 'error', revision: 10 }))
    } finally { await window.happyDOM.close() }
  })
})

describe('studio document store', () => {
  it('leaves the complete last working document intact after a bad update', () => {
    // Break caught: replacing source/revision before compilation succeeds loses
    // the working projection and makes a failed edit observable to subscribers.
    const store = createStudioStore()
    const old = structuredClone(store.snapshot())
    const document = old.documents[0]
    expect(() => store.put({ title: 'Broken edit', prompt: 'change it', source: 'export default () => <div' }, document.id)).toThrow()
    expect(store.snapshot()).toEqual(old)
    expect(renderCompiled(store.get(document.id)!.javascript)).toContain('A little change. A new wave.')
  })

  it('adds a fresh document without changing existing ids, revisions or JavaScript', () => {
    // Break caught: rebuilding the whole surface on insertion changes iframe
    // identity/revision and resets independently running timers and controls.
    const store = createStudioStore()
    const before = structuredClone(store.snapshot().documents)
    const added = store.put({ title: 'Another tool', prompt: 'make one', source: initialSource })
    expect(store.snapshot().documents).toHaveLength(before.length + 1)
    expect(store.snapshot().documents.slice(0, before.length)).toEqual(before)
    expect(before.map(document => document.id)).not.toContain(added.id)
    expect(added.revision).toBe(1)
    expect(renderCompiled(added.javascript)).toBe('<h1>Original tool</h1>')
  })

  it('deletes only the requested document', () => {
    // Break caught: deleting by position, clearing the surface, or retaining a
    // deleted id makes the editor and displayed document set disagree.
    const store = createStudioStore()
    const before = structuredClone(store.snapshot().documents)
    store.remove(before[1].id)
    expect(store.get(before[1].id)).toBeUndefined()
    expect(store.snapshot().documents).toEqual([before[0], before[2]])
  })
})

describe('configured model generator', () => {
  it.each([
    ['malformed JSON', `{"private":"${config.llm.apiKey}",`],
    ['invalid schema', JSON.stringify({ choices: [{ message: { content: { private: config.llm.apiKey } } }] })],
  ])('sanitizes a successful provider response containing %s', async (_kind, body) => {
    // Synthetic credential echoes prove JSON parsing and schema failures cannot
    // copy provider content or parser diagnostics into the public HTTP error.
    const { request, store } = await startStudio(createGenerator(config, vi.fn<typeof fetch>().mockResolvedValue(new Response(body))))
    const before = structuredClone(store.snapshot())
    const response = await request('/generate', 'POST', { prompt: 'Create a tool' })
    expect(response.status).toBe(422)
    const error = await response.json()
    expect(error.error).toMatch(/^The Aixia model (returned an unreadable response|did not return component source)\.$/)
    expect(JSON.stringify(error)).not.toContain(config.llm.apiKey)
    expect(store.snapshot()).toEqual(before)
  })

  it('sanitizes arbitrary transport exceptions', async () => {
    // Synthetic fetch failure: transport error messages can contain a proxy URL
    // or echoed credentials just as an HTTP error body can.
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`https://private-host.example/${config.llm.apiKey}`))
    await expect(createGenerator(config, fetchImpl)('Create a tool', undefined, new AbortController().signal)).rejects.toThrow('The Aixia model could not be reached. Try again.')
  })
  it('uses the configured provider/model contract and sends the previous source for revisions', async () => {
    // Break caught: a studio-only hardcoded provider/model or missing thinking
    // setting silently changes the model contract used by the rest of Hubble.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: `\`\`\`tsx\n${editedSource}\n\`\`\`` }, finish_reason: 'stop' }],
    }), { status: 200 }))
    const signal = new AbortController().signal
    const result = await createGenerator(config, fetchImpl)('Make it editable', initialSource, signal)
    expect(result).toBe(editedSource)
    expect(renderCompiled(compileComponent(result))).toBe('<h1>Edited tool</h1>')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://configured-provider.example/v1/chat/completions')
    expect(init).toMatchObject({ method: 'POST', signal, headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer synthetic-private-key',
    } })
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({ model: config.llm.model, chat_template_kwargs: { thinking: false } })
    expect(body.messages).toHaveLength(3)
    expect(body.messages[0]).toMatchObject({ role: 'system' })
    expect(body.messages[0].content).toContain('export default')
    expect(body.messages[0].content).toContain('React')
    expect(body.messages[0].content).toContain('UI')
    expect(body.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining(initialSource) })
    expect(body.messages[2]).toEqual({ role: 'user', content: 'Make it editable' })
    expect(JSON.stringify(body)).not.toContain(config.llm.apiKey)
  })

  it('does not expose or read an error provider body that echoes private credentials', async () => {
    // Break caught: using response.text() as the UI error leaks upstream keys
    // and provider diagnostics through the generate route's error response.
    const response = new Response(`Authorization: Bearer ${config.llm.apiKey}; PRIVATE_PROVIDER_DIAGNOSTIC`, { status: 401 })
    const readBody = vi.spyOn(response, 'text')
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const error = await createGenerator(config, fetchImpl)('Create a tool', undefined, new AbortController().signal).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('401')
    expect(error.message).not.toContain(config.llm.apiKey)
    expect(error.message).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC')
    expect(readBody).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
  })
})

const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })))
})
async function startStudio(generate: Generator) {
  // Mount only the standalone routes: importing createApp would drag in absent
  // brain/room submodules and hide whether studio itself is independently usable.
  const app = express()
  app.use(express.json())
  const store = mountStudio(app, config, generate)
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    store,
    request: (path = '', method = 'GET', body?: unknown) => fetch(`${base}/api/studio${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('studio HTTP routes', () => {
  it('bounds feedback even when generation ignores cancellation and never publishes its late answer', async () => {
    // Synthetic stalled adapter. An explicit timeout signal avoids fake-clock
    // interference with real sockets and proves the route owns its deadline.
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const entered = deferred<void>()
    const result = deferred<string>()
    const { request, store } = await startStudio(async () => { entered.resolve(); return result.promise })
    const before = structuredClone(store.snapshot())
    const pending = request('/generate', 'POST', { prompt: 'Stalled tool' })
    await entered.promise
    expect(timeout).toHaveBeenCalledWith(90_000)
    deadline.abort()
    const response = await pending
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'Component generation timed out. Try a smaller component.' })
    result.resolve(initialSource)
    await request()
    expect(store.snapshot()).toEqual(before)
  })
  it('compiles generated source, stores it, and returns the same document from GET', async () => {
    // Break caught: responding with raw model text or forgetting the store
    // write produces a successful generation that never reaches the table.
    const generate = vi.fn<Generator>().mockResolvedValue(initialSource)
    const { request, store } = await startStudio(generate)
    const before = structuredClone(store.snapshot().documents)
    const response = await request('/generate', 'POST', { prompt: '  Create a tool  ' })
    expect(response.status).toBe(200)
    const document = await response.json() as ComponentDocument
    expect(document).toMatchObject({ title: 'Create a tool', prompt: 'Create a tool', source: initialSource, revision: 1 })
    expect(renderCompiled(document.javascript)).toBe('<h1>Original tool</h1>')
    expect(generate).toHaveBeenCalledWith('Create a tool', undefined, expect.any(AbortSignal))
    const get = await request()
    expect(get.status).toBe(200)
    const snapshot = await get.json()
    expect(snapshot).toEqual({ documents: [...before, document], model: config.llm.model, configured: true })
    expect(JSON.stringify(snapshot)).not.toContain(config.llm.apiKey)
  })

  it('edits source with stable identity, a new revision and executable JavaScript', async () => {
    // Break caught: editor updates that regenerate identity, lose the original
    // prompt, or return stale compiled JavaScript despite displaying new source.
    const generate = vi.fn<Generator>()
    const { request, store } = await startStudio(generate)
    const previous = structuredClone(store.snapshot().documents[0])
    const others = structuredClone(store.snapshot().documents.slice(1))
    const response = await request(`/components/${previous.id}`, 'PUT', { title: 'Edited title', source: editedSource })
    expect(response.status).toBe(200)
    const edited = await response.json() as ComponentDocument
    expect(edited).toMatchObject({ id: previous.id, revision: previous.revision + 1, title: 'Edited title', source: editedSource, prompt: previous.prompt })
    expect(edited.javascript).not.toBe(previous.javascript)
    expect(renderCompiled(edited.javascript)).toBe('<h1>Edited tool</h1>')
    expect((await (await request()).json()).documents).toEqual([edited, ...others])
    expect(generate).not.toHaveBeenCalled()
    const bad = await request(`/components/${previous.id}`, 'PUT', { title: 'Bad edit', source: 'export default () => <h1' })
    expect(bad.status).toBe(422)
    expect((await (await request()).json()).documents).toEqual([edited, ...others])
  })

  it('rejects stale asynchronous generation after an editor revision wins', async () => {
    // Break caught: a slow model answer overwrites a newer user edit. Explicit
    // barriers establish request ordering without sleeps or timing assumptions.
    const entered = deferred<void>()
    const result = deferred<string>()
    const generate = vi.fn<Generator>(async () => { entered.resolve(); return result.promise })
    const { request, store } = await startStudio(generate)
    const previous = structuredClone(store.snapshot().documents[0])
    const pending = request('/generate', 'POST', { id: previous.id, prompt: 'Slow revision' })
    await entered.promise
    expect(generate).toHaveBeenCalledWith('Slow revision', previous.source, expect.any(AbortSignal))
    const edit = await request(`/components/${previous.id}`, 'PUT', { title: 'User edit wins', source: editedSource })
    expect(edit.status).toBe(200)
    const winner = await edit.json()
    result.resolve(initialSource)
    const conflict = await pending
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: expect.stringContaining('changed during generation') })
    expect(store.get(previous.id)).toEqual(winner)
    expect((await (await request()).json()).documents.find((document: ComponentDocument) => document.id === previous.id)).toEqual(winner)
  })

  it('keeps the surface intact when generated source does not compile', async () => {
    // Break caught: trusting model success as compilation success publishes a
    // broken insertion and discards the projection's last working snapshot.
    const { request, store } = await startStudio(async () => 'export default () => <div')
    const before = structuredClone(store.snapshot())
    const response = await request('/generate', 'POST', { prompt: 'Broken synthetic source' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: expect.any(String) })
    expect(store.snapshot()).toEqual(before)
    expect((await (await request()).json()).documents).toEqual(before.documents)
  })

  it('returns a sanitized model failure over HTTP without exposing the provider body', async () => {
    // Break caught: the HTTP error boundary reattaching upstream diagnostics
    // even when the model adapter has hidden the provider's credential echo.
    const provider = new Response(`Bearer ${config.llm.apiKey}; PRIVATE_PROVIDER_DIAGNOSTIC`, { status: 502 })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(provider)
    const { request, store } = await startStudio(createGenerator(config, fetchImpl))
    const before = structuredClone(store.snapshot())
    const response = await request('/generate', 'POST', { prompt: 'Create a tool' })
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body).toMatchObject({ error: expect.stringContaining('502') })
    expect(JSON.stringify(body)).not.toContain(config.llm.apiKey)
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC')
    expect(provider.bodyUsed).toBe(false)
    expect(store.snapshot()).toEqual(before)
  })

  it('removes a document over HTTP and no longer allows edits to that id', async () => {
    // Break caught: DELETE acknowledging success without removing the stored
    // document, or PUT resurrecting a component that the user deleted.
    const { request, store } = await startStudio(vi.fn<Generator>())
    const before = structuredClone(store.snapshot().documents)
    const response = await request(`/components/${before[0].id}`, 'DELETE')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect((await (await request()).json()).documents).toEqual(before.slice(1))
    expect((await request(`/components/${before[0].id}`, 'PUT', { title: 'Deleted', source: editedSource })).status).toBe(404)
  })
})
