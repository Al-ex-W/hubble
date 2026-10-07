import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StudioPage } from './StudioPage.tsx'
import { LabPage } from '../lab/LabPage.tsx'
import { TvPage } from '../tv/TvPage.tsx'
import './liquid.css'
import '../styles.css'

// studio.html is the entry for every owner-branch page in `--mode studio`
// (vite.config.ts rewrites /studio, /studio/projector and /lab to it), so the
// path picks the page here, the way routes.ts does for the full app.
// The root gets liquid-theme like main.tsx does, because the lab's cards use its tokens.
const root = document.getElementById('root')!
root.classList.add('liquid-theme')
const lab = location.pathname === '/lab'
const tv = location.pathname === '/tv'
createRoot(root).render(<StrictMode>{tv ? <TvPage /> : lab ? <LabPage /> : <StudioPage projector={location.pathname === '/studio/projector'} />}</StrictMode>)
