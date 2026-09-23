// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Deck → PDF via the browser's own print pipeline (no server, no dependency —
// every viewer's browser already knows how to print-to-PDF). Shared by the
// editor's Export PDF button (editor.ts) and the read-only player card
// (main.ts's playerMode) so a view-access link gets the identical capability
// without booting the full editor.

import { renderSlide } from './render.ts'
import { inLinearFlow, type BentoDoc } from './model.ts'
import { t } from './i18n.ts'
import { netFetch, OfflineError } from '../../kernel/src/net.ts'

/** Builds the `#bento-print` box: every linear slide becomes one exact page
 *  sized to the deck's own aspect (width normalised to 1600). Anything
 *  outside the linear flow stays off the paper: a state is reachable only
 *  through interaction, and a hidden slide is material the audience was not
 *  meant to be handed. The `@page`/`#bento-print` rules this relies on live
 *  in styles.css unconditionally, so they're present in both editor and
 *  player builds. Split out from exportDeckPdf so a server-side render (the
 *  platform's Download PDF — see platform/worker/src/pdf.ts) can build the
 *  identical box via `window.bento.preparePdf()` and hand it to a real,
 *  controlled Chromium's `page.pdf({ preferCSSPageSize: true })` instead of
 *  the visitor's own browser's print dialog, whose margins/scale defaults
 *  turned out unreliable for real content (docs/DECISIONS.md). */
export function buildPrintBox(doc: BentoDoc): void {
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
}

/** Export a deck to PDF via the LOCAL browser's own print pipeline —
 *  `buildPrintBox` then `window.print()`. Kept for offline use (no network
 *  round trip) and as the fallback save path; the platform's live "Download
 *  PDF" button instead drives a server-side render (see buildPrintBox's own
 *  comment) for consistent output independent of the visitor's browser/OS. */
export function exportDeckPdf(doc: BentoDoc): void {
  buildPrintBox(doc)
  const box = document.getElementById('bento-print')!
  const cleanup = () => {
    box.remove()
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  // give the freshly-inserted images a beat to decode before printing
  setTimeout(() => window.print(), 250)
}

/** Downloads the platform's server-rendered PDF from `url` (kernel/src/
 *  save.ts's hostPdfUrl — GET /d/:id/pdf), showing a loading state on
 *  `button` while it's in flight and restoring it after. Fetched (not a
 *  plain navigation) specifically so this loading state is possible: the
 *  FIRST download of a freshly-edited deck is a real Browser Rendering
 *  cold render (platform/worker/src/pdf.ts), not the usual instant R2
 *  cache hit, and a plain link click gives the visitor no sign anything is
 *  happening until the browser's own download UI appears seconds later.
 *  Reuses the existing, already-fully-translated `t('Requesting…')` key
 *  (currently unused elsewhere in this app) rather than adding a new one
 *  just for this wording. Goes through `netFetch` (kernel/src/net.ts), not
 *  raw `fetch` — Offline Mode's whole guarantee rests on `scripts/
 *  test-offline.ts` failing the build if ANY file outside net.ts calls
 *  `fetch(`/`new WebSocket` directly, so a server-rendered PDF download is
 *  exactly the kind of network touch that switch must also catch. */
export async function downloadServerPdf(url: string, button: HTMLElement): Promise<void> {
  const original = button.innerHTML
  const btn = button as HTMLButtonElement
  btn.disabled = true
  button.innerHTML = `<span class="ed-spinner"></span>${t('Requesting…')}`
  try {
    const res = await netFetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const disposition = res.headers.get('content-disposition') ?? ''
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'deck.pdf'
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
    button.innerHTML = t('Downloaded ✓')
  } catch (err) {
    console.error(err)
    button.innerHTML = err instanceof OfflineError ? 'Offline' : 'Download failed'
  } finally {
    setTimeout(() => {
      btn.disabled = false
      button.innerHTML = original
    }, 1500)
  }
}
