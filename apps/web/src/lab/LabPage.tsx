import { AssistantPanel } from './AssistantPanel.tsx'
import './lab.css'

/** /lab: self-contained demos for the pieces of the assistant. Reached through :5173 only (AGENTS.md, one port).
 * Demo 1 (live transcription) was removed on 7 Oct 2026 with all speech input, see the puppet-lab plan's scope correction. */
export function LabPage() {
  return <main className="lab-page">
    <header className="lab-head">
      <span className="liquid-badge">HUBBLE LAB</span>
      <h1 className="liquid-heading">Hubble Lab</h1>
      <p className="liquid-text liquid-muted">Small demos for testing one piece at a time.</p>
    </header>
    <div className="lab-grid"><AssistantPanel /></div>
  </main>
}
