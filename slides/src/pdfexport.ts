// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Deck → PDF via the browser's own print pipeline (no server, no dependency —
// every viewer's browser already knows how to print-to-PDF). Shared by the
// editor's Export PDF button (editor.ts) and the read-only player card
// (main.ts's playerMode) so a view-access link gets the identical capability
// without booting the full editor.

import { renderSlide } from './render.ts'
import { inLinearFlow, type BentoDoc } from './model.ts'

/** Export a deck to PDF via the browser's print pipeline: every linear slide
 *  becomes one exact page sized to the deck's own aspect (width normalised
 *  to 1600). Anything outside the linear flow stays off the paper: a state
 *  is reachable only through interaction, and a hidden slide is material the
 *  audience was not meant to be handed. The `@page`/`#bento-print` rules
 *  this relies on live in styles.css unconditionally, so they're present in
 *  both editor and player builds. */
export function exportDeckPdf(doc: BentoDoc): void {
  document.getElementById('bento-print')?.remove()
  const box = document.createElement('div')
  box.id = 'bento-print'
  // page geometry follows the deck's aspect (width normalised to 1600)
  const pageH = Math.round((1600 * doc.size.height) / doc.size.width)
  const pageCss = document.createElement('style')
  pageCss.textContent = `@page { size: 1600px ${pageH}px; margin: 0; } #bento-print .bp-page { height: ${pageH}px; }`
  box.appendChild(pageCss)
  for (const slide of doc.slides) {
    if (!inLinearFlow(slide)) continue
    const page = document.createElement('div')
    page.className = 'bp-page'
    const surface = renderSlide(slide, doc, { svgAsImage: true, hidePlaceholders: true })
    // normalise to the print page size regardless of doc size
    const s = 1600 / doc.size.width
    surface.style.transformOrigin = '0 0'
    if (s !== 1) surface.style.transform = `scale(${s})`
    page.appendChild(surface)
    box.appendChild(page)
  }
  document.body.appendChild(box)
  const cleanup = () => {
    box.remove()
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  // give the freshly-inserted images a beat to decode before printing
  setTimeout(() => window.print(), 250)
}
