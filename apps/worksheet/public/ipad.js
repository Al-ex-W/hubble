// The iPad worksheet page's script (hubble#60). Plain JS, no build step: the
// worksheet server serves this file as-is, and the tests import it.

/**
 * CSS px per real millimetre on the iPad (A16).
 *
 * Apple's tech specs: 2360 × 1640 px at 264 ppi; Safari's devicePixelRatio is
 * 2, so one CSS px is 2/264 inch = 0.1924 mm.
 *
 * Why not CSS's own `mm` unit: CSS defines 1 mm as 96/25.4 = 3.78 CSS px
 * whatever the screen, which on this iPad is 0.73 real mm, 1.37× too small.
 * Every physical size on the page goes through this number instead, and the
 * 10 cm ruler is how anyone checks it with a real ruler on site. A different
 * iPad model changes this one line.
 */
export const PX_PER_MM = 264 / 25.4 / 2

export const mm = (v) => `${(v * PX_PER_MM).toFixed(2)}px`

/**
 * Draws the worksheet into `root`: the problems in handwriting, then (in the
 * page) a true 10 cm ruler.
 *
 * Several problems (#88) are one column, each with its number in the margin.
 * The number is the worksheet state's (`view.numbers`), never the position
 * on the page: a problem keeps it while shown, so unticking problem 1 leaves
 * "2." on the one that was 2 (review of #93). That number is what the brain is told
 * (apps/server/worksheet.ts withIpad), so "problem 2" means the same thing on
 * the iPad and in the answer. One column, not a 2 × 2 grid: a column would be
 * ~71 mm wide, and the longest line (30 characters) needs ~120 mm at 8 mm.
 *
 * `view.tasks` is missing from a pre-#88 server; then it is the one task.
 * `view.numbers` is missing from a server before the #93 review; then 1, 2, 3.
 */
export function render(root, view) {
  const tasks = view.tasks ?? [view.task]
  const many = tasks.length > 1
  const list = root.querySelector('#task')
  list.classList.toggle('many', many)
  list.replaceChildren(
    ...tasks.map((t, i) => {
      const li = document.createElement('li')
      if (many) {
        const n = document.createElement('b')
        n.className = 'n'
        n.textContent = `${view.numbers?.[i] ?? i + 1}.`
        li.append(n)
      }
      for (const l of t.lines) {
        const p = document.createElement('p')
        p.textContent = l
        li.append(p)
      }
      return li
    }),
  )
  root.querySelector('#title').textContent = many ? `Uppgifter · ${tasks.length}` : `Uppgift · ${tasks[0].id}`
  fit(root, list, view.textMm)
}

/**
 * The text size actually used: the operator's `textMm`, stepped down 0.5 mm
 * at a time (to a 4 mm floor, the state's own minimum) while the problems
 * overflow the space above the ruler. Never up: the operator's size is the
 * ceiling. Measured in the iPad's own DOM because only Safari knows how wide
 * Noteworthy's glyphs are and where a line wraps; a server-side estimate
 * would be a guess. Four long problems at 20 mm come out smaller than asked,
 * which beats running off the screen (plan ruling, #88).
 *
 * Returns the size used, so tests can check it; nothing else reads it (the
 * brain's label carries no size).
 */
export const FIT_FLOOR_MM = 4
export function fit(root, list, textMm) {
  let size = textMm
  root.style.setProperty('--text', mm(size))
  while (size > FIT_FLOOR_MM && list.scrollHeight > list.clientHeight) {
    size = Math.max(FIT_FLOOR_MM, size - 0.5)
    root.style.setProperty('--text', mm(size))
  }
  return size
}

export function drawRuler(el) {
  el.style.width = mm(100)
  const ticks = []
  for (let i = 0; i <= 100; i++) {
    const t = document.createElement('i')
    t.style.left = mm(i)
    t.style.height = mm(i % 10 === 0 ? 6 : i % 5 === 0 ? 4 : 2.5)
    ticks.push(t)
    if (i % 10 === 0) {
      const n = document.createElement('b')
      n.style.left = mm(i)
      n.textContent = String(i / 10)
      ticks.push(n)
    }
  }
  el.replaceChildren(...ticks)
}

/**
 * Follows the server. EventSource reconnects by itself, but iPad Safari
 * suspends a page whose screen dimmed and doesn't always resume the stream;
 * re-fetching on wake makes a woken iPad show the current task, not the one
 * from before it slept.
 */
export function follow(root, dot) {
  // The last view, re-drawn on a resize: fit() measured against the old
  // height, and an iPad turned to landscape has ~70 mm less of it.
  let last = null
  const show = (v) => {
    last = v
    render(root, v)
  }
  window.addEventListener('resize', () => last && render(root, last))
  // Relative, not '/api/...': the iPad opens this page at :5173/worksheet/
  // (Vite proxies it here, so the room only ever sees the one port), and an
  // absolute path would ask the bench's /api instead of this server.
  const refetch = () =>
    fetch('api/state')
      .then((r) => r.json())
      .then(show)
      .catch(() => {})
  const es = new EventSource('api/events')
  es.onmessage = (e) => show(JSON.parse(e.data))
  es.onopen = () => dot.classList.remove('off')
  es.onerror = () => dot.classList.add('off')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refetch()
  })
}
