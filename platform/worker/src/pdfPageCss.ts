// Reads a deck's own `@page` rule so the server-side PDF render can honour it.
//
// Why this exists: a deck that declares `@page { size: 1280px 720px }` (every
// slide-style HTML deck should) is laid out by Chromium against the PAPER SIZE
// given to page.pdf() — `preferCSSPageSize` only changes the paper afterwards.
// We passed `format: 'A4'` (794 CSS px wide), so a deck's `@media (min-width:900px)`
// desktop layout never applied: slides printed in their phone layout, scaled up
// and clipped. Passing the deck's own width/height up front makes the layout
// match what the deck's author sees (verified on a real 50-slide deck).

export interface PageSetup {
  /** CSS px, when the deck declares an explicit two-length `size`. */
  width?: number
  height?: number
  /** True when the deck's @page sets its own margin — then we must not override it. */
  ownMargin: boolean
}

const PX_PER: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, q: 96 / 101.6 }

function toPx(value: string): number | null {
  const m = /^(\d*\.?\d+)\s*(px|in|cm|mm|pt|pc|q)$/i.exec(value.trim())
  if (!m) return null
  const n = Number(m[1]) * PX_PER[m[2]!.toLowerCase()]!
  return Number.isFinite(n) && n >= 96 && n <= 20000 ? Math.round(n * 100) / 100 : null
}

export function readPageSetup(html: string): PageSetup {
  const out: PageSetup = { ownMargin: false }
  // every @page { … } block, wherever it sits (top level or inside @media print)
  for (const m of html.matchAll(/@page\b[^{}]*\{([^{}]*)\}/gi)) {
    const body = m[1]!
    const size = /(?:^|[;\s])size\s*:\s*([^;}]+)/i.exec(body)
    if (size) {
      const parts = size[1]!.trim().split(/\s+/)
      if (parts.length === 2) {
        const w = toPx(parts[0]!)
        const h = toPx(parts[1]!)
        if (w && h) {
          out.width = w
          out.height = h
        }
      }
    }
    if (/(?:^|[;\s])margin(?:-(?:top|right|bottom|left))?\s*:/i.test(body)) out.ownMargin = true
  }
  return out
}
