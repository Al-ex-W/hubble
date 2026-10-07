import jpeg from 'jpeg-js'

/*
 * STATUS: built and tested, NOT wired into the product (checked 2026-10-07:
 * only locate.test.ts calls locateTasks; it is exported from index.ts but no
 * app, package or script imports it).
 *
 * Why it exists: Marks are drawn on the notebook page, and the model's own
 * task coordinates drift (see below), so a Mark could land on the wrong task.
 * The plan was to give Marks real task positions measured from the photo
 * (docs/plans/2026-10-05-layout-agent-loop.md). Photos do reach the brain
 * (/api/render's `image`, attached by the bench and sent to the model in
 * agent.ts), but nothing runs locateTasks on them: the model still places
 * Marks from its own reading of the photo.
 *
 * Why it is kept rather than deleted as dead code: the owner's ruling is
 * "this will come back later", and it is proven against a real photographed
 * worksheet (fixtures/photos/upgift.jpg). Deleting it would throw away a
 * tested answer to a problem we know returns once a photo path lands. It is
 * also why jpeg-js stays in this package's dependencies.
 */

/**
 * Finds where each task sits on a photographed page, from the pixels.
 *
 * The model reads *what* the tasks are well, but its coordinates drift: two
 * runs on the same photo put task 5 170 px apart, once past the image bottom.
 * Marks drawn from that land on the wrong task. Ink rows don't drift, so the
 * positions come from here and the model only supplies the order.
 *
 * Method: grayscale → ink mask relative to the local paper brightness → per-row
 * ink counts → text lines → task starts, i.e. lines whose ink begins at the
 * number column (the leftmost text column on the page). A task spans from its
 * start line to just before the next one.
 */

export interface NormBox {
  /** 0..1 of the image. */
  x: number
  y: number
  w: number
  h: number
}

interface Line {
  top: number
  bottom: number
  left: number
  right: number
  /** Width of the first ink run on the line, and the blank gap after it. */
  firstRun: number
  gapAfter: number
}

export function decodeJpeg(data: Uint8Array): { width: number; height: number; gray: Float32Array } {
  const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: true })
  const gray = new Float32Array(img.width * img.height)
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4
    gray[i] = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2]
  }
  return { width: img.width, height: img.height, gray }
}

/** Text lines on the page, top to bottom, in pixels. */
export function findLines(width: number, height: number, gray: Float32Array): Line[] {
  // The paper is the bright region; the photo usually has dark table around
  // it. Find the paper's column range per row from a brightness threshold.
  let sum = 0
  for (let i = 0; i < gray.length; i++) sum += gray[i]
  const mean = sum / gray.length
  const paper = (v: number) => v > mean * 0.9

  // Ink: noticeably darker than the paper around it (a 31 px box mean),
  // which survives the uneven lighting of a photo where a global threshold
  // would not.
  const R = 15
  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x]
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row
    }
  }
  const boxMean = (x: number, y: number) => {
    const x0 = Math.max(0, x - R)
    const y0 = Math.max(0, y - R)
    const x1 = Math.min(width, x + R + 1)
    const y1 = Math.min(height, y + R + 1)
    const s = integral[y1 * (width + 1) + x1] - integral[y0 * (width + 1) + x1] - integral[y1 * (width + 1) + x0] + integral[y0 * (width + 1) + x0]
    return s / ((x1 - x0) * (y1 - y0))
  }

  const ink = new Uint8Array(width * height)
  const rowInk = new Int32Array(height)
  const rowLeft = new Int32Array(height).fill(width)
  const rowRight = new Int32Array(height).fill(-1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x]
      const m = boxMean(x, y)
      if (!paper(m)) continue
      if (v < m * 0.78) {
        ink[y * width + x] = 1
        rowInk[y]++
        if (x < rowLeft[y]) rowLeft[y] = x
        if (x > rowRight[y]) rowRight[y] = x
      }
    }
  }

  // Rows with a few inked pixels form lines; tiny gaps inside a line (between
  // a fraction's parts) are bridged.
  const minInk = Math.max(3, Math.round(width * 0.004))
  const lines: Line[] = []
  let start = -1
  let gap = 0
  const GAP = Math.round(height * 0.006)
  for (let y = 0; y <= height; y++) {
    const on = y < height && rowInk[y] >= minInk
    if (on) {
      if (start < 0) start = y
      gap = 0
    } else if (start >= 0) {
      gap++
      if (gap > GAP || y === height) {
        const top = start
        const bottom = y - gap
        if (bottom - top >= 3) {
          let left = width
          let right = -1
          for (let yy = top; yy <= bottom; yy++) {
            if (rowInk[yy] >= minInk) {
              left = Math.min(left, rowLeft[yy])
              right = Math.max(right, rowRight[yy])
            }
          }
          // Column profile of this line: the first *word* (ink up to the first
          // gap wider than a letter space) and the gap after it. A thin "1"
          // breaks into slivers, so runs are measured to a real gap, not to
          // the first blank column.
          const col = new Uint8Array(width)
          for (let yy = top; yy <= bottom; yy++) for (let x = left; x <= right; x++) if (ink[yy * width + x]) col[x] = 1
          const wordGap = Math.max(5, Math.round(width * 0.009))
          let x = left
          let blank = 0
          while (x <= right && blank < wordGap) {
            blank = col[x] ? 0 : blank + 1
            x++
          }
          const runEnd = x - blank
          let g = runEnd
          while (g <= right && !col[g]) g++
          lines.push({ top, bottom, left, right, firstRun: runEnd - left, gapAfter: g - runEnd })
        }
        start = -1
        gap = 0
      }
    }
  }
  return lines
}

/**
 * Boxes for `count` tasks, in reading order, or null when the page does not
 * split into that many tasks (the caller then falls back to the model's own
 * boxes rather than marking the wrong place).
 */
export function locateTasks(data: Uint8Array, count: number): NormBox[] | null {
  const { width, height, gray } = decodeJpeg(data)
  const lines = findLines(width, height, gray)
  if (lines.length < count || lines.length === 0) return null
  const norm = (top: number, bottom: number, left: number, right: number): NormBox => {
    const pad = height * 0.008
    return {
      x: Math.max(0, left - pad) / width,
      y: Math.max(0, top - pad) / height,
      w: Math.min(width, right - left + 2 * pad) / width,
      h: Math.min(height, bottom - top + 2 * pad) / height,
    }
  }
  if (count === 1) {
    // One task: the whole written block. A ruled margin line shows up as a
    // 1-3 px first run on every line; start after it.
    const realLeft = (l: Line) => (l.firstRun <= 3 ? l.left + l.firstRun + l.gapAfter : l.left)
    return [norm(lines[0].top, lines.at(-1)!.bottom, Math.min(...lines.map(realLeft)), Math.max(...lines.map((l) => l.right)))]
  }

  // A task starts with its number: a short blob ("5.") then a clear gap
  // before the text. Indented content starts with a word, no such gap. This
  // holds on a page photographed at an angle, where the number column itself
  // drifts sideways (upgift.jpg: x 155 at the top, 120 at the bottom).
  const starts = lines.filter((l) => l.firstRun > 3 && l.firstRun < width * 0.04 && l.gapAfter > width * 0.01)
  // Starts that are actually the next row of a multi-line task header (no
  // vertical gap before them) are merged into the previous start.
  const merged: Line[] = []
  for (const s of starts) {
    const prev = merged.at(-1)
    if (prev && s.top - prev.bottom < height * 0.02) prev.bottom = s.bottom
    else merged.push({ ...s })
  }
  if (merged.length !== count) return null

  return merged.map((s, i) => {
    const next = merged[i + 1]
    // A task's content lines run until the next task's number.
    const content = lines.filter((l) => l.top >= s.top && (!next || l.bottom < next.top))
    return norm(s.top, Math.max(...content.map((l) => l.bottom)), Math.min(...content.map((l) => l.left)), Math.max(...content.map((l) => l.right)))
  })
}
