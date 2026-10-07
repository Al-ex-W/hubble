import { useEffect, useRef, useState } from 'react'
import type { Status } from '../operator/status.ts'

/**
 * The iPad's problems, picked from a menu (#88). The owner: "make it so that
 * I can just select a couple of problems from the worksheet UI in a menu
 * button."
 *
 * A button that opens a list of every worksheet problem with a checkbox
 * each. Every tick goes to the server at once as the whole new list
 * (`{ on: true, taskIds }`), so the iPad follows tick by tick and there is
 * no "apply" step to forget mid-demo. `on: true` rides along so the first
 * tick also hosts the worksheet, as the single-task picker did: a menu that
 * needed a checkbox first was the trap that picker was built to remove.
 *
 * What is ticked is the server's (status.ts, from the worksheet state, the
 * one owner of what the iPad shows). This view holds only `sent`: the list
 * it last sent, until the 1 s status poll shows it. Without it, two quick
 * ticks would both start from the same stale list and the second would
 * silently undo the first.
 *
 * Numbers are the worksheet state's (`shown.numbers`): a problem keeps its
 * number while it is shown, and the iPad and the brain use the same one, so
 * "problem 2" is the one marked 2 here. A pick the server hasn't confirmed
 * yet shows "…" rather than a guess at its number.
 */

type Sheet = NonNullable<Status['worksheet']>

/** The server's picks: taskIds, or the one taskId of a server from before #88; none while off. */
export const shownPicks = (sheet: Sheet): string[] => (sheet.on && sheet.shown ? (sheet.shown.taskIds ?? [sheet.shown.taskId]) : [])

export function ProblemsMenu({ sheet, send }: { sheet: Sheet; send: (taskIds: string[]) => Promise<{ ok: boolean }> }) {
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState<string[] | null>(null)
  // Which send is the newest. Only the newest one's failure may drop `sent`:
  // an older tick failing while a newer one is still on its way used to
  // clear the newer picks too, and the next tick then started from the stale
  // server list (review of #93: [linear, integral] instead of all four).
  const latest = useRef(0)
  // The cap is the state owner's (apps/worksheet/state.ts max), sent
  // in the status rather than copied here, so the two can't drift. A server
  // from before #88 sends none and takes one task, so 1.
  const max = sheet.maxPicks ?? 1
  const server = shownPicks(sheet)
  const picks = sent ?? server

  // The poll caught up: the server's list is ours again.
  const serverKey = server.join(',')
  useEffect(() => {
    if (sent && sent.join(',') === serverKey) setSent(null)
  }, [serverKey, sent])

  const toggle = (id: string, want: boolean) => {
    const next = want ? [...picks, id] : picks.filter((x) => x !== id)
    if (next.length === 0 || next.length > max) return
    setSent(next)
    const mine = ++latest.current
    // The newest send refused or failed: drop the local list so the menu
    // shows what the iPad really shows (the server's), never a pick that
    // didn't happen. An older one failing changes nothing: the newer list
    // already carries what the operator wants.
    const failed = () => mine === latest.current && setSent(null)
    void send(next).then((r) => !r.ok && failed(), failed)
  }

  const byId = new Map(sheet.tasks.map((t) => [t.id, t.task]))
  // The server's number for each shown problem; a server from before the #93
  // review sends none, and then its numbers were the position.
  const shownNumbers = sheet.shown?.numbers ?? server.map((_, i) => i + 1)
  const numberOf = new Map(server.map((id, i) => [id, shownNumbers[i]]))
  const label = (id: string) => (numberOf.has(id) ? String(numberOf.get(id)) : '…')
  return (
    <div className="show-picks">
      <button aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
        Problems ▾ {picks.length > 0 && <span className="show-picks-count">{picks.length}</span>}
      </button>
      {picks.length > 0 ? (
        <small className="show-picks-summary">
          on the iPad: {picks.map((id) => `${label(id)}. ${byId.get(id) ?? id}`).join(' · ')}
        </small>
      ) : (
        <small>{sheet.on ? 'nothing picked' : 'pick problems (starts the iPad page)'}</small>
      )}
      {open && (
        <div className="show-picks-list" role="group" aria-label="iPad problems">
          <small>
            Tick up to {max}. Each keeps its number while it is on the iPad.
          </small>
          {sheet.tasks.map((t) => {
            const n = picks.indexOf(t.id)
            const on = n >= 0
            // The last ticked one stays: the iPad must show something. And
            // at the cap, the rest wait until one is unticked.
            const disabled = on ? picks.length === 1 : picks.length >= max
            return (
              <label key={t.id} className={`show-pick ${on ? 'on' : ''} ${disabled ? 'off' : ''}`}>
                <input type="checkbox" aria-label={t.id} checked={on} disabled={disabled} onChange={(e) => toggle(t.id, e.target.checked)} />
                <span className="show-pick-n">{on ? label(t.id) : ''}</span>
                <span className="show-pick-text">{t.task}</span>
              </label>
            )
          })}
          <button className="show-link" onClick={() => setOpen(false)}>
            done
          </button>
        </div>
      )}
    </div>
  )
}
