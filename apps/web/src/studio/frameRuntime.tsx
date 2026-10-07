import * as React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from './kit.tsx'
import './liquid.css'
import { MAX_COMPONENT_JAVASCRIPT } from './contract.ts'

const root = createRoot(document.getElementById('component')!)
const parentOrigin = new URLSearchParams(location.search).get('origin')!
const report = (message: object) => parent.postMessage({ channel: 'hubble-component', ...message }, parentOrigin)
let revision = 0
let requestedRevision = 0
const failedRevisions = new Set<number>()
function reportError(message: string, version = revision) {
  failedRevisions.add(version)
  report({ type: 'error', revision: version, message })
}
class ComponentBoundary extends React.Component<{ children: React.ReactNode; revision: number }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  componentDidCatch() { reportError('This component encountered a runtime error. Edit its source to repair it.', this.props.revision) }
  render() { return this.state.error ? <UI.Text muted>Component paused. Its source is available in the studio.</UI.Text> : this.props.children }
}

function Committed({ children, revision: version }: { children: React.ReactNode; revision: number }) {
  React.useEffect(() => {
    // React can continue running ancestor effects after a child effect throws.
    // Let the entire effect flush and boundary recovery finish before calling
    // this revision mounted; an effect merely running is not proof of success.
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled && revision === version && !failedRevisions.has(version)) report({ type: 'mounted', revision: version })
    })
    return () => { cancelled = true }
  }, [version])
  return children
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== parentOrigin || event.data?.channel !== 'hubble-component' || event.data.type !== 'mount') return
  if (!Number.isSafeInteger(event.data.revision) || event.data.revision < 1) return
  // HMR can replay a mount without changing the stored revision. Evaluating it
  // again creates a new component function identity and resets hooks, even
  // though the unchanged Committed revision will not acknowledge another mount.
  // Only successful render requests advance this guard; invalid exports retain
  // their error path and do not prevent a retry of the first valid request.
  if (event.data.revision <= requestedRevision) return
  revision = event.data.revision
  if (typeof event.data.javascript !== 'string' || event.data.javascript.length > MAX_COMPONENT_JAVASCRIPT) {
    reportError('The compiled component is too large.'); return
  }
  try {
    // Executable source is deliberately confined to this script-only iframe.
    // Both the compiled module and the hooks use this ONE React instance;
    // fetching a second React would make hooks fail with invalid-hook-call.
    const exports: { default?: React.ComponentType } = {}
    new Function('React', 'UI', 'exports', event.data.javascript)(React, UI, exports)
    if (typeof exports.default !== 'function') throw new Error('No default component')
    const Component = exports.default
    root.render(<ComponentBoundary key={revision} revision={revision}><Committed revision={revision}><Component /></Committed></ComponentBoundary>)
    requestedRevision = revision
  } catch { reportError('This component could not start. Check its source and try again.') }
})
let lastHeight = 0
new ResizeObserver(() => {
  const height = Math.ceil(document.getElementById('component')!.getBoundingClientRect().height + 4)
  if (height !== lastHeight) { lastHeight = height; report({ type: 'height', height }) }
}).observe(document.getElementById('component')!)
window.addEventListener('error', () => reportError('Component script error.'))
window.addEventListener('unhandledrejection', () => reportError('Component async operation failed.'))
report({ type: 'ready' })
