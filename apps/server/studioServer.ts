import express from 'express'
import { loadConfig, readiness } from './config.ts'
import { mountStudio } from './studio.ts'
import { mountPuppetLab } from './puppetLab.ts'
import { mountProjectorMode } from './projectorMode.ts'

// UI development should not depend on the hardware/brain submodules (they were
// unreadable from the owner's account until 7 Oct; they load now, but the Studio
// server stays independent of them).
// The regular Hubble server mounts the same studio service; this small entry
// point shares its model configuration and the puppet master's voice routes
// (no table tools here: there is no table). ELEVENLABS_API_KEY is optional
// since Julius's main stopped requiring it, so no placeholder key is needed.
const config = loadConfig()
const app = express()
app.use(express.json({ limit: '1mb' }))
app.get('/api/health', (_req, res) => res.json({ ok: true, config: readiness() }))
mountStudio(app, config)
mountPuppetLab(app, config)
mountProjectorMode(app)
app.use((( _error, _req, res, _next) => { res.status(400).json({ error: 'Invalid request.' }) }) as express.ErrorRequestHandler)
app.listen(config.port, '0.0.0.0', () => console.log(`Hubble studio API on :${config.port}. Open http://localhost:5173/studio`))
