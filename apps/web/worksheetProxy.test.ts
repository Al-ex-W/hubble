import { describe, expect, it } from 'vitest'
import { needsSlash, readOnly, worksheetProxy } from './worksheetProxy.ts'

/**
 * The :5173/worksheet/ proxy (label: schema-derived, the methods the iPad
 * page and an attacker on the room Wi-Fi would send). Oracle: Vite's bypass
 * contract, where undefined forwards and false answers 404.
 */
describe('the worksheet proxy', () => {
  it('forwards reads and refuses every write', () => {
    // Break caught: a write forwarded to the worksheet server. Proxied
    // requests arrive from loopback, which is exactly what its "loopback
    // only" check trusts, so anyone on the room Wi-Fi could switch the
    // iPad's task behind the brain's back.
    expect(readOnly({ method: 'GET' })).toBeUndefined()
    expect(readOnly({ method: 'HEAD' })).toBeUndefined()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', undefined]) expect(readOnly({ method })).toBe(false)
  })

  it('maps /worksheet/... onto the worksheet server root', () => {
    // Break caught: the prefix reaching the worksheet server, which serves
    // its page at / and would answer 404 to /worksheet/.
    const rewrite = worksheetProxy(8793).rewrite!
    expect(rewrite('/worksheet/')).toBe('/')
    expect(rewrite('/worksheet/api/events')).toBe('/api/events')
  })

  it('redirects the slashless /worksheet instead of serving it', () => {
    // Break caught: /worksheet served as the page. Its relative api/state
    // then resolves to the bench's /api/state, and the iPad stays blank.
    expect(needsSlash('/worksheet')).toBe(true)
    expect(needsSlash('/worksheet?x=1')).toBe(true)
    expect(needsSlash('/worksheet/')).toBe(false)
    expect(needsSlash('/worksheet/api/state')).toBe(false)
  })
})
