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
const PDF_MAX_DIM = 20000 // px — a sane ceiling on a measured content box

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

/** Render an 'html' deck's raw bytes to ONE seamless page sized to its own
 *  measured content box — no page breaks to fight arbitrary (or entirely
 *  absent) print CSS an 'html' deck was never authored with pagination in
 *  mind. Feeds the raw bytes directly via `page.setContent`, bypassing the
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
    // A string, not a typed callback: the callback runs in the PAGE's own
    // DOM realm, not this Worker's (which has no `dom` lib — Workers and DOM
    // globals conflict, e.g. both declare `fetch`/`Response` differently —
    // so tsc can't typecheck a function body meant for the other side).
    const height = (await page.evaluate(
      `Math.min(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), ${PDF_MAX_DIM})`,
    )) as number
    return await page.pdf({
      width: `${VIEWPORT_WIDTH}px`,
      height: `${height}px`,
      printBackground: true,
      margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' },
    })
  } finally {
    await browser.close()
  }
}
