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
 *  because the deck itself hasn't changed. See docs/DECISIONS.md 2026-09-23:
 *  v1 forced a single giant seamless page for every 'html' deck, which
 *  ignored a deck's own hand-authored `@media print` CSS and produced an
 *  unreadable result for ordinary multi-section reports. */
export const PDF_RENDER_VERSION = 2

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

/** Render an 'html' deck's raw bytes to a normal, STANDARD-PAGINATED PDF —
 *  the same shape any "Print to PDF" of an ordinary web page produces:
 *  A4-ish pages, Chromium's own default margins, breaking wherever the
 *  content naturally falls. `preferCSSPageSize: true` lets the deck's OWN
 *  `@page`/`@media print` rules win when it has them — many AI-generated
 *  reports do (this one's own print stylesheet hides its sidebar nav,
 *  resets to a single column, and marks tables/figures `break-inside:
 *  avoid`), and throwing that away in favor of a "clever" single endless
 *  page was the exact v1 mistake this superseded (docs/DECISIONS.md
 *  2026-09-23): mechanically seamless, but no reasonable PDF viewer shows a
 *  page several thousand points tall at a readable zoom, so a real
 *  multi-section document came out unreadable. A deck with NO print CSS at
 *  all just gets Chromium's ordinary default pagination — the same
 *  reasonable fallback "Ctrl+P → Save as PDF" already gives on any page.
 *  Feeds the raw bytes directly via `page.setContent`, bypassing the
 *  sandboxed-iframe wrapper (`htmlDeckWrapper`) entirely — this headless
 *  browser instance has no ambient session or cookies to protect (a fresh,
 *  throwaway context per render), so the cross-origin-cookie-theft threat
 *  model the sandbox exists for simply does not apply here. External
 *  resources (a `<script src>` CDN reference, say) still load normally over
 *  this instance's own network access; `waitUntil: 'networkidle0'` waits
 *  for them. */
export async function renderHtmlDeckPdf(env: Env, rawHtml: string): Promise<Buffer> {
  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 800 })
    await page.setContent(rawHtml, { waitUntil: 'networkidle0' })
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
  } finally {
    await browser.close()
  }
}
