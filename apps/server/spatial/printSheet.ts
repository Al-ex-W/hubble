import { markerBits } from '../../shared/markers/detect.ts'
import { PHYSICAL_IDS, PHYSICAL_MM } from '../../shared/markers/layout.ts'

/**
 * The printable sheet of physical reference markers (#91): an A4 SVG in
 * millimetres, so "print at 100 %" gives 60 mm markers, the size the
 * localizer's anchors are learned at (it doesn't assume the size: anchors
 * are measured, but a wildly different print would be harder to detect).
 *
 * Each marker keeps a white margin of one cell: ArUco finds the black
 * border as a dark square on a light ground, and a dark table edge or a
 * shadow touching the border would merge with it.
 */
export function printSheet(): string {
  const bits = markerBits()
  const cell = PHYSICAL_MM / 6
  const parts: string[] = []
  PHYSICAL_IDS.forEach((id, i) => {
    const x = 20 + (i % 2) * 95
    const y = 30 + Math.floor(i / 2) * 120
    parts.push(`<rect x="${x - cell}" y="${y - cell}" width="${PHYSICAL_MM + 2 * cell}" height="${PHYSICAL_MM + 2 * cell}" fill="white" stroke="#bbb" stroke-width="0.2" stroke-dasharray="1 1"/>`)
    parts.push(`<rect x="${x}" y="${y}" width="${PHYSICAL_MM}" height="${PHYSICAL_MM}" fill="black"/>`)
    const code = bits(id)
    for (let k = 0; k < 16; k++) if (code[k] === '1') parts.push(`<rect x="${x + cell * (1 + (k % 4))}" y="${y + cell * (1 + Math.floor(k / 4))}" width="${cell}" height="${cell}" fill="white"/>`)
    parts.push(`<text x="${x}" y="${y + PHYSICAL_MM + cell + 6}" font-size="4" font-family="sans-serif">Hubble marker ${id} · ${PHYSICAL_MM} mm · cut on the dashed line</text>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"><rect width="210" height="297" fill="white"/>${parts.join('')}</svg>`
}
