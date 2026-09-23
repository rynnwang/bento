// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Server-side PDF rendering via Cloudflare Browser Rendering — a real,
// Cloudflare-managed headless Chromium this Worker drives through the
// BROWSER binding (see env.ts), rather than the visitor's own browser's
// print dialog. v1 of Download PDF ran window.print() client-side; real
// content (diagrams, tables, arbitrary or entirely absent print CSS)
// paginated badly through a visitor's own browser's margin/scale defaults,
// which this Worker has no control over (docs/DECISIONS.md). A
// server-controlled Chromium instance gives a deterministic result
// independent of the visitor's own browser/OS.
//
// Browser Rendering's free tier is tight (10 browser-minutes/day, 3
// concurrent browsers, 60s/session as of writing —
// developers.cloudflare.com/browser-run/limits/), and this is reachable by
// ANY viewer with access to a deck, not just the owner — see index.ts's
// handlePdf, which caches every render in R2 (store.ts's
// getCachedPdf/putCachedPdf) keyed to the deck's own `updated_at`. A repeat
// download of an unchanged deck never touches the browser at all.
import puppeteer from '@cloudflare/puppeteer'
import type { Env } from './env.ts'

const VIEWPORT_WIDTH = 1280 // matches slides/'s own 16:9 default deck width

/** Bump whenever renderBentoDeckPdf/renderHtmlDeckPdf's actual OUTPUT
 *  changes — folded into the R2 cache key (store.ts's getCachedPdf/
 *  putCachedPdf) alongside the deck's own `updated_at`, so a rendering fix
 *  can never keep serving bytes produced by the OLD, now-wrong logic just
 *  because the deck itself hasn't changed. History: v1 forced a single
 *  giant seamless page for every 'html' deck, ignoring a deck's own
 *  hand-authored `@media print` CSS (docs/DECISIONS.md 2026-09-23). v2
 *  switched to standard pagination but left `margin` unset — Puppeteer's
 *  own docs are explicit that an unset margin means NO margin is applied,
 *  not some implicit sane default, so v2 still shipped with content
 *  running edge-to-edge on every page (verified against a real render,
 *  not assumed — docs/DECISIONS.md 2026-09-23 second entry). v3 sets an
 *  explicit default margin. v4 gives a canvas-containing 'html' deck (an
 *  interactive map, say) extra time to actually PAINT before the snapshot
 *  — see CANVAS_SETTLE_MS. */
export const PDF_RENDER_VERSION = 4

/** Render an already-live 'bento' deck (navigated to its own `/d/:id` — the
 *  URL a real viewer would open, so editor-vs-player mode and access level
 *  are whatever they'd actually see) to a real, paginated PDF: one slide per
 *  page, sized to the deck's own aspect, states excluded. Reuses
 *  slides/src/pdfexport.ts's EXACT page-building logic via the
 *  `window.bento.preparePdf()` hook (both editor and player mode expose it),
 *  then lets Puppeteer's own `page.pdf({preferCSSPageSize:true})` read the
 *  resulting `@page` CSS rule directly instead of calling window.print(). */
export async function renderBentoDeckPdf(env: Env, viewUrl: string): Promise<Buffer> {
  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 800 })
    await page.goto(viewUrl, { waitUntil: 'networkidle0' })
    await page.waitForFunction('window.bento && typeof window.bento.preparePdf === "function"')
    await page.evaluate('window.bento.preparePdf()')
    await page.waitForSelector('#bento-print')
    return await page.pdf({ preferCSSPageSize: true, printBackground: true })
  } finally {
    await browser.close()
  }
}

/** Default page margin for an 'html' deck that declares no `@page { margin }`
 *  of its own — Puppeteer's `margin` PDFOption is explicitly undefined-means-
 *  NONE, not "browser's usual print margin" (confirmed the hard way: v2
 *  shipped without this and every page ran edge-to-edge). 20mm is an
 *  ordinary "normal margins" document default, comparable to what Word/
 *  Google Docs use out of the box. */
const HTML_DECK_PDF_MARGIN = '20mm'

/** Extra wait, gated on the page actually containing a `<canvas>`, before
 *  the PDF snapshot — see renderHtmlDeckPdf's own comment for why. An
 *  ordinary canvas-free deck (most of them) pays nothing extra; a map/
 *  WebGL-bearing one pays this once per edit (R2-cached after), which is a
 *  small fraction of Browser Rendering's 60s/session ceiling. */
const CANVAS_SETTLE_MS = 5000

/** Render an 'html' deck's raw bytes to a normal, STANDARD-PAGINATED PDF —
 *  the same shape any "Print to PDF" of an ordinary web page produces:
 *  A4-ish pages, a normal document margin, breaking wherever the content
 *  naturally falls. `preferCSSPageSize: true` lets the deck's OWN
 *  `@page`/`@media print` rules win when it has them — many AI-generated
 *  reports do (this one's own print stylesheet hides its sidebar nav,
 *  resets to a single column, and marks tables/figures `break-inside:
 *  avoid`), and throwing that away in favor of a "clever" single endless
 *  page was the exact v1 mistake this superseded (docs/DECISIONS.md
 *  2026-09-23): mechanically seamless, but no reasonable PDF viewer shows a
 *  page several thousand points tall at a readable zoom, so a real
 *  multi-section document came out unreadable. A deck with NO print CSS at
 *  all just gets Chromium's ordinary default pagination plus
 *  HTML_DECK_PDF_MARGIN — the same reasonable fallback "Ctrl+P → Save as
 *  PDF" already gives on any page. `margin` here is an explicit OVERRIDE,
 *  not a CSS-aware default — a deck that ever needs a genuinely different
 *  margin (or a deliberate full-bleed `@page{margin:0}`) would need this
 *  hardcoded value replaced with real per-deck margin support; not needed
 *  yet, so not built yet. Feeds the raw bytes directly via
 *  `page.setContent`, bypassing the sandboxed-iframe wrapper
 *  (`htmlDeckWrapper`) entirely — this headless browser instance has no
 *  ambient session or cookies to protect (a fresh, throwaway context per
 *  render), so the cross-origin-cookie-theft threat model the sandbox
 *  exists for simply does not apply here. External resources (a
 *  `<script src>` CDN reference, say) still load normally over this
 *  instance's own network access; `waitUntil: 'networkidle0'` waits for
 *  them.
 *
 *  **Interactive maps / WebGL / canvas content**: `networkidle0` only
 *  tracks NETWORK activity — it's satisfied once a map library (MapLibre
 *  GL JS, say) has finished FETCHING its style and tiles, which can be
 *  well before it has actually PAINTED them. Tile decoding (often in a
 *  Web Worker) and the WebGL draw call itself happen entirely off the
 *  network, so nothing about network-idle waits for them, and the PDF
 *  snapshot could land in that gap — a gray, empty map area with
 *  everything else on the page rendered correctly. This gets worse in
 *  Browser Rendering specifically: cloud/headless Chromium environments
 *  commonly have no real GPU, so WebGL falls back to a CPU software
 *  rasterizer (SwiftShader) — still fully functional, just markedly
 *  slower than hardware rendering (matches reports on Cloudflare's own
 *  community forum of slow WebGL2 in Browser Rendering). `CANVAS_SETTLE_MS`
 *  is a deliberately blunt fix for this: NOT a `toDataURL()`-based
 *  "freeze the canvas to a still image" trick — tried that first, and it
 *  made things WORSE. `canvas.toDataURL()` reads from WebGL's own drawing
 *  buffer, which the browser is allowed to clear immediately after
 *  compositing when `preserveDrawingBuffer` is false (the default, and
 *  not something this Worker can change — it doesn't control a deck's own
 *  script); Chromium's native print/PDF pipeline instead reads from the
 *  COMPOSITOR's retained texture, which survives that clear. Verified
 *  directly: a raw WebGL triangle printed to PDF correctly with NO
 *  freezing; the identical page's canvas came out BLANK once `toDataURL()`
 *  swapped in a snapshot `<img>`. So the only lever actually available
 *  here is time — give the (possibly software-rendered) draw a chance to
 *  land before capturing what Chromium already renders correctly once it
 *  has. This has NOT been verified against a real MapLibre deck through
 *  actual Browser Rendering (no owner credentials to test end-to-end from
 *  here) — if maps are still blank after this ships, the next thing to
 *  check is whether Browser Rendering's Chromium can create a WebGL2
 *  context AT ALL (`docs/DECISIONS.md` 2026-09-20 — MapLibre v6 dropped
 *  WebGL1, so no context at all means no fallback either); no amount of
 *  extra waiting fixes that case, and a genuinely different approach
 *  (e.g. a static tile-image fallback) would be needed. */
export async function renderHtmlDeckPdf(env: Env, rawHtml: string): Promise<Buffer> {
  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 800 })
    await page.setContent(rawHtml, { waitUntil: 'networkidle0' })
    if (await page.evaluate('document.querySelectorAll("canvas").length > 0')) {
      await new Promise((resolve) => setTimeout(resolve, CANVAS_SETTLE_MS))
    }
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: HTML_DECK_PDF_MARGIN,
        bottom: HTML_DECK_PDF_MARGIN,
        left: HTML_DECK_PDF_MARGIN,
        right: HTML_DECK_PDF_MARGIN,
      },
    })
  } finally {
    await browser.close()
  }
}
