import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OperatingSurface } from './surface/OperatingSurface.tsx'
import { TableDisplay } from './table/TableDisplay.tsx'
import { SpatialPage } from './spatial/SpatialPage.tsx'
import { IpadCamera } from './ipad/IpadCamera.tsx'
import { pageFor } from './routes.ts'
// Owner's branch: the Hubble orb (/hubble) and Liquid Studio (/studio). Both talk
// through the puppet master (typed in, spoken out; no speech input).
import { HubbleApp } from './hubble/HubbleApp.tsx'
import { StudioPage } from './studio/StudioPage.tsx'
import { LabPage } from './lab/LabPage.tsx'
import { TvPage } from './tv/TvPage.tsx'
import { DataWall } from './datawall/DataWall.tsx'
import { PitchPage } from './pitch/PitchPage.tsx'
import { OverallPage } from './overall/OverallPage.tsx'
import './styles.css'
import './studio/liquid.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
// Every demo route inherits the Studio's design tokens from one owner. Keeping
// the theme on the existing root avoids introducing a layout wrapper around
// the projector's physically measured surface.
root.classList.add('liquid-theme')

// The app has three faces on one Vite origin: the projector display, the
// operating surface (Show and Setup modes, #75; Setup is the bench with the
// show column, #66), and the spatial workbench. routes.ts decides which, why an unknown path shows
// nothing, and why /operator redirects instead.
//
// /hubble, the orb, left Julius's main on 7 Oct (it lives in branch
// archive/voice-orb there, docs/voice-orb.md). On this owner branch
// (alex/aixia-sim) the orb lives here on purpose: the puppet master
// speaks through it, and Liquid Studio (/studio, /studio/projector) uses it.
const page = pageFor(window.location.pathname)
if (page === 'to-bench') window.location.replace('/')

function Route() {
  if (page === 'table') return <TableDisplay />
  if (page === 'spatial') return <SpatialPage />
  if (page === 'ipad-camera') return <IpadCamera />
  if (page === 'bench') return <OperatingSurface />
  if (page === 'hubble') return <HubbleApp />
  if (page === 'studio' || page === 'studio-projector') return <StudioPage projector={page === 'studio-projector'} />
  if (page === 'lab') return <LabPage />
  if (page === 'tv') return <TvPage />
  if (page === 'datawall') return <DataWall />
  if (page === 'pitch') return <PitchPage />
  if (page === 'overall') return <OverallPage />
  return null
}

createRoot(root).render(<StrictMode><Route /></StrictMode>)
