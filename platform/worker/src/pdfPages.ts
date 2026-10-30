// Page-range handling for the PDF endpoint (GET /d/:id/pdf?pages=1-3,5) — the
// same syntax as a print dialog. Pure functions, no I/O.
//
// The range is handed to Chromium (`page.pdf({ pageRanges })`), which renders
// only those pages. We normalise first — sort, merge, drop whitespace — so that
// "3, 1-2" and "1-3" are the SAME request and share one R2 cache entry, and so
// nothing but digits, commas and dashes can ever reach the browser.

export class PageRangeError extends Error {}

const MAX_TOKENS = 40
const MAX_PAGE = 5000

/** `null` (or an empty/whitespace-only string, or "all") means the whole
 *  document. Otherwise returns the canonical range string, e.g. "1-3,5,7-". */
export function normalizePageRange(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim().toLowerCase()
  if (!text || text === 'all' || text === '*') return null
  if (text.length > 200) throw new PageRangeError('That page range is too long.')
  const tokens = text.replace(/\s*[-–—~]\s*/g, '-').split(/[,;，、]\s*|\s+/).filter(Boolean)
  if (!tokens.length) return null
  if (tokens.length > MAX_TOKENS) throw new PageRangeError('Too many page ranges.')
  const spans: Array<[number, number]> = []
  for (const t of tokens) {
    const m = /^(\d{1,5})?(?:(-|–|—|~)(\d{1,5})?)?$/.exec(t)
    if (!m || (m[1] === undefined && m[3] === undefined)) throw new PageRangeError(`"${t}" isn't a page or page range (try 1-3, 5).`)
    const a = m[1] === undefined ? 1 : Number(m[1])
    const hasDash = m[2] !== undefined
    const b = !hasDash ? a : m[3] === undefined ? Infinity : Number(m[3])
    if (a < 1 || (b !== Infinity && b < 1) || a > MAX_PAGE || (b !== Infinity && b > MAX_PAGE)) {
      throw new PageRangeError(`Page numbers start at 1 and go up to ${MAX_PAGE}.`)
    }
    if (b < a) throw new PageRangeError(`"${t}" runs backwards — write it as ${b}-${a}.`)
    spans.push([a, b])
  }
  spans.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const merged: Array<[number, number]> = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= (last[1] === Infinity ? Infinity : last[1] + 1)) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  return merged.map(([a, b]) => (b === Infinity ? `${a}-` : a === b ? `${a}` : `${a}-${b}`)).join(',')
}

/** Chromium's pageRanges syntax has no open-ended "7-" — rewrite it to a span
 *  that is certainly past the end (Chromium clamps an end beyond the count). */
export const toChromiumRange = (canonical: string): string => canonical.replace(/(\d+)-(?=,|$)/g, `$1-${MAX_PAGE}`)

/** File-name-safe tag for a canonical range: "1-3,5" -> "p1-3_5". */
export const rangeFileTag = (canonical: string): string => `p${canonical.replace(/,/g, '_')}`

/** Count pages of a Chromium-produced PDF by scanning for `/Type /Page`
 *  (not `/Pages`). Byte scan, not a string regex: this runs inside a Worker
 *  request whose CPU budget is small. Returns null if nothing matched. */
export function countPdfPages(bytes: ArrayBuffer): number | null {
  const u = new Uint8Array(bytes)
  const needle = [0x2f, 0x54, 0x79, 0x70, 0x65] // "/Type"
  let n = 0
  for (let i = 0; i + 12 < u.length; i++) {
    if (u[i] !== 0x2f) continue
    let j = 1
    for (; j < 5; j++) if (u[i + j] !== needle[j]) break
    if (j < 5) continue
    let k = i + 5
    while (u[k] === 0x20) k++
    if (u[k] === 0x2f && u[k + 1] === 0x50 && u[k + 2] === 0x61 && u[k + 3] === 0x67 && u[k + 4] === 0x65 && u[k + 5] !== 0x73) n++
  }
  return n || null
}
