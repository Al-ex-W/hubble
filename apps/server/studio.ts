import type { Express, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'esbuild'
import { z } from 'zod'
import type { ServerConfig } from './config.ts'
import { UI_CONTRACT, MAX_COMPONENT_SOURCE, MAX_COMPONENT_JAVASCRIPT, type ComponentDocument } from '../web/src/studio/contract.ts'
import { EXAMPLES } from '../web/src/studio/examples.ts'
import { mountPuppetMaster } from './puppetMaster.ts'

export function compileComponent(source: string): string {
  if (source.length > MAX_COMPONENT_SOURCE) throw new Error('The component source is too large.')
  const file = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  let defaultExport = false
  function inspect(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) throw new Error('Use the provided React and UI objects instead of imports.')
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) throw new Error('Dynamic imports are not part of the component contract.')
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals) throw new Error('Use export default, not export =.')
      if (!ts.isArrowFunction(node.expression) && !ts.isFunctionExpression(node.expression) && !ts.isIdentifier(node.expression)) throw new Error('The default export must be a React function component.')
      defaultExport = true
    }
    if (ts.isFunctionDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) defaultExport = true
    ts.forEachChild(node, inspect)
  }
  inspect(file)
  if (!defaultExport) throw new Error('Export a default React function component.')
  const result = ts.transpileModule(source, {
    fileName: 'component.tsx', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: false },
  })
  const error = result.diagnostics?.find(d => d.category === ts.DiagnosticCategory.Error)
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  if (result.outputText.length > MAX_COMPONENT_JAVASCRIPT) throw new Error('The compiled component is too large. Split it into a smaller component.')
  return result.outputText
}

export type Generator = (prompt: string, previous: string | undefined, signal: AbortSignal) => Promise<string>
export function createGenerator(config: ServerConfig, fetchImpl: typeof fetch = fetch): Generator {
  return async (prompt, previous, signal) => {
    if (!config.llm.apiKey) throw new Error('Set HUBBLE_LLM_API_KEY in .env to generate components. The examples and editor work without it.')
    let response: globalThis.Response
    try {
      response = await fetchImpl(`${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify({
          model: config.llm.model, temperature: 0.5, max_tokens: 6000,
          chat_template_kwargs: { thinking: false },
          messages: [
            { role: 'system', content: `You are Hubble, the spatial assistant. Create a thoughtful interactive tool for the user's table. ${UI_CONTRACT}` },
            ...(previous ? [{ role: 'user', content: `The current component source follows. Revise it according to my next instruction:\n${previous}` }] : []),
            { role: 'user', content: prompt },
          ],
        }),
      })
    } catch {
      // Transport exceptions are provider-controlled too (including URLs and
      // proxy diagnostics). Only our fixed public messages cross into the UI.
      throw new Error(signal.aborted ? 'Component generation timed out. Try a smaller component.' : 'The Aixia model could not be reached. Try again.')
    }
    // Provider bodies can echo headers/keys. They never become UI errors.
    if (!response.ok) throw new Error(`The Aixia model request failed (${response.status}).`)
    let raw: unknown
    try { raw = await response.json() } catch { throw new Error('The Aixia model returned an unreadable response.') }
    const parsed = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().optional() })).min(1) }).safeParse(raw)
    if (!parsed.success) throw new Error('The Aixia model did not return component source.')
    const body = parsed.data
    const choice = body.choices?.[0]
    if (choice?.finish_reason === 'length') throw new Error('The generated component was cut short. Try a smaller component.')
    const source = choice?.message?.content?.trim().replace(/^```(?:tsx|jsx|typescript|javascript)?\s*\n/i, '').replace(/\n```\s*$/, '')
    if (!source || source.length > 50_000) throw new Error('The model did not return a complete component.')
    return source
  }
}

export function createStudioStore() {
  let documents: ComponentDocument[] = EXAMPLES.map(example => ({ ...example, id: randomUUID(), revision: 1, javascript: compileComponent(example.source) }))
  let version = 0
  const listeners = new Set<Response>()
  const snapshot = () => ({ documents })
  const publish = () => { for (const response of listeners) response.write(`data: ${JSON.stringify(snapshot())}\n\n`) }
  return {
    snapshot,
    version: () => version,
    get: (id: string) => documents.find(document => document.id === id),
    put(input: { title: string; prompt: string; source: string }, id?: string) {
      // Compile BEFORE mutating: a malformed update must leave the last
      // working component available to every projection subscriber.
      const javascript = compileComponent(input.source)
      const previous = id ? documents.find(document => document.id === id) : undefined
      if (id && !previous) throw new Error('This component no longer exists.')
      if (!id && documents.length >= 12) throw new Error('The surface holds up to 12 components. Remove one to make room.')
      const document: ComponentDocument = { ...input, id: id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, javascript }
      documents = previous ? documents.map(item => item.id === id ? document : item) : [...documents, document]
      version++
      publish()
      return document
    },
    remove(id: string) { documents = documents.filter(document => document.id !== id); version++; publish() },
    clear() { documents = []; version++; publish() },
    reset() {
      documents = EXAMPLES.map(example => ({ ...example, id: randomUUID(), revision: 1, javascript: compileComponent(example.source) }))
      version++; publish()
    },
    subscribe(response: Response) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.write(`data: ${JSON.stringify(snapshot())}\n\n`)
      listeners.add(response)
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
      response.on('close', () => { clearInterval(heartbeat); listeners.delete(response) })
    },
  }
}

let runtimeBuild: Promise<Map<string, Uint8Array>> | undefined
function runtimeAssets() {
  // Bundle once per server process. The iframe gets local fonts, React and
  // KaTeX even offline, and the Vite host's CSS stays outside its sandbox.
  return runtimeBuild ??= build({
    entryPoints: [fileURLToPath(new URL('../web/src/studio/frameRuntime.tsx', import.meta.url))],
    bundle: true, write: false, outdir: '/studio-runtime', entryNames: 'runtime',
    assetNames: 'assets/[name]-[hash]', publicPath: '/api/studio/runtime',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    format: 'iife', minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  }).then(result => new Map(result.outputFiles!.map(file => [file.path.replace('/studio-runtime/', ''), file.contents])))
}

export function mountStudio(app: Express, config: ServerConfig, generate = createGenerator(config), store = createStudioStore(), puppet: Parameters<typeof mountPuppetMaster>[3] = {}) {
  const bodySchema = z.object({ prompt: z.string().trim().min(1).max(2000), id: z.string().optional() })
  const sourceSchema = z.object({ title: z.string().trim().min(1).max(80), source: z.string().min(1).max(50_000) })
  app.get('/api/studio', (_req, res) => res.json({ ...store.snapshot(), model: config.llm.model, configured: Boolean(config.llm.apiKey) }))
  app.get('/api/studio/events', (_req, res) => store.subscribe(res))
  // `puppet.table` is the Julius adapter; the full server passes it, studioServer.ts does not.
  mountPuppetMaster(app, config, store, puppet)
  app.post('/api/studio/generate', async (req, res) => {
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Enter a prompt of at most 2000 characters.' })
    const previous = parsed.data.id ? store.get(parsed.data.id) : undefined
    if (parsed.data.id && !previous) return void res.status(404).json({ error: 'Component not found.' })
    const revision = previous?.revision
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)])
    let onAbort: (() => void) | undefined
    try {
      // A provider adapter may ignore cancellation or stall while reading its
      // body. Race the deadline ourselves so the HTTP request still completes,
      // and a late answer never becomes a document after the timeout response.
      const source = await Promise.race([
        Promise.resolve().then(() => generate(parsed.data.prompt, previous?.source, signal)),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('Component generation timed out. Try a smaller component.'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      if (abort.signal.aborted) return
      if (previous && store.get(previous.id)?.revision !== revision) return void res.status(409).json({ error: 'This component changed during generation. Try again with its latest source.' })
      const document = store.put({ source, prompt: parsed.data.prompt, title: previous?.title ?? parsed.data.prompt.slice(0, 60) }, parsed.data.id)
      res.json(document)
    } catch (error) {
      if (!abort.signal.aborted) res.status(422).json({ error: error instanceof Error ? error.message : 'Component generation failed.' })
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
  })
  app.put('/api/studio/components/:id', (req, res) => {
    const parsed = sourceSchema.safeParse(req.body)
    const previous = store.get(req.params.id)
    if (!previous) return void res.status(404).json({ error: 'Component not found.' })
    if (!parsed.success) return void res.status(400).json({ error: 'Provide a title and complete source (up to 50,000 characters).' })
    try { res.json(store.put({ ...parsed.data, prompt: previous.prompt }, previous.id)) }
    catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : 'Compilation failed.' }) }
  })
  app.post('/api/studio/examples', (req, res) => {
    const example = EXAMPLES.find(item => item.title === req.body?.title)
    if (!example) return void res.status(400).json({ error: 'Choose an example from the library.' })
    try { res.json(store.put(example)) }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Could not add example.' }) }
  })
  app.delete('/api/studio/components/:id', (req, res) => { store.remove(req.params.id); res.json({ ok: true }) })
  app.get('/api/studio/runtime/*', async (req, res) => {
    try {
      const name = (req.params as Record<string, string>)['0']
      const contents = (await runtimeAssets()).get(name)
      if (!contents) return void res.sendStatus(404)
      res.set('Access-Control-Allow-Origin', '*').type(name).send(Buffer.from(contents))
    } catch { res.status(500).send('The component runtime could not be built.') }
  })
  app.get('/api/studio/frame', (req, res) => {
    const origin = typeof req.query.origin === 'string' ? req.query.origin : ''
    let url: URL
    try { url = new URL(origin) } catch { return void res.sendStatus(400) }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return void res.sendStatus(400)
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-eval' ${origin}; style-src 'unsafe-inline' ${origin}; font-src ${origin}; img-src data: ${origin}; connect-src 'none'; form-action 'none'; base-uri 'none'`)
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/api/studio/runtime/runtime.css"><style>html,body{margin:0;background:transparent}body{padding:2px}#component{min-height:40px;overflow:hidden}</style></head><body class="liquid-theme"><div id="component"></div><script src="/api/studio/runtime/runtime.js" crossorigin="anonymous"></script></body></html>`)
  })
  return store
}
