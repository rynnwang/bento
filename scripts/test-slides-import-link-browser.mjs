// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Save as → Import PowerPoint… and Export for PowerPoint… open the converter
// on bento.page, and say so.
//
//   npm run build:single --prefix slides && node scripts/test-slides-import-link-browser.mjs
//
// WHAT THIS PROVES, in the packaged document:
//   1. the Save-as menu has "Import PowerPoint…" directly after "Replace from
//      JSON…" (where spaces keeps Import Markdown…) and "Export for
//      PowerPoint…" directly after it, each ONE line;
//   2. each description is the hover tooltip, naming bento.page, a new tab and
//      the internet connection; the export one also says the deck is not
//      uploaded;
//   3. clicking each opens exactly its URL in a new tab, with no opener (the
//      page cannot reach back into this document), and leaves this document
//      where it was: import → /convert?from=pptx (new shells go straight to
//      the page; /import only redirects for old ones), export → /convert;
//   4. both entries are translated in every catalog (checked in German).
// The network is blocked throughout: a click is measured by the tab it asks
// for, not by the page loading.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const ENTRIES = [
  { name: 'Import PowerPoint…', url: 'https://bento.page/convert?from=pptx', de: 'PowerPoint importieren' },
  { name: 'Export for PowerPoint…', url: 'https://bento.page/convert', de: 'Für PowerPoint exportieren', tipAlso: /not uploaded/ },
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // record what navigations ASK for, then refuse them: nothing leaves the rig
  const asked = []
  await ctx.route(/^https?:/, (r) => { if (r.request().isNavigationRequest()) asked.push(r.request().url()); return r.abort() })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  const shell = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
  await p.goto(shell)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-split-caret'))
  const openSave = () => p.evaluate(() => document.querySelector('.ed-split-caret').click())
  const rowsNow = () => p.evaluate(() => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].map((b) => ({
    name: b.getAttribute('aria-label') ?? b.querySelector('span')?.firstChild?.textContent?.trim() ?? b.textContent.trim(),
    title: b.title, h: Math.round(b.getBoundingClientRect().height),
  })))

  console.log('the entries\n')
  await openSave()
  const rows = await rowsNow()
  const names = rows.map((r) => r.name)
  const at = names.indexOf('Replace from JSON…')
  ok(at >= 0 && names[at + 1] === ENTRIES[0].name && names[at + 2] === ENTRIES[1].name,
    `Replace from JSON… · Import PowerPoint… · Export for PowerPoint…, in that order (${names.join(' · ')})`)
  for (const e of ENTRIES) {
    const r = rows.find((x) => x.name === e.name)
    ok(!!r && r.h <= 32, `${e.name}: one line (${r?.h}px)`)
    const tip = r?.title ?? ''
    ok(/bento\.page/.test(tip) && /new tab/.test(tip) && /internet/.test(tip) && (!e.tipAlso || e.tipAlso.test(tip)),
      `${e.name}: tooltip names bento.page, a new tab and the connection${e.tipAlso ? ', and that the deck is not uploaded' : ''} ("${tip}")`)
  }

  console.log('\nthe clicks\n')
  for (const e of ENTRIES) {
    asked.length = 0
    if (!(await p.evaluate(() => document.querySelector('.ed-save-menu')?.closest('.ed-dropdown')?.classList.contains('open')))) await openSave()
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
      p.evaluate((n) => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].find((b) => b.getAttribute('aria-label') === n || b.textContent.trim().startsWith(n)).click(), e.name),
    ])
    ok(!!popup, `${e.name}: opens a new tab`)
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {})
      ok(asked.length === 1 && asked[0] === e.url, `${e.name}: the tab asks for ${e.url}, and only it (${asked.join(', ') || 'nothing'})`)
      ok(await popup.evaluate(() => window.opener === null).catch(() => true), `${e.name}: the new tab has no opener`)
      await popup.close()
    }
    ok(p.url() === shell, `${e.name}: this document stays where it was`)
    ok(!(await p.evaluate(() => document.querySelector('.ed-save-menu')?.closest('.ed-dropdown')?.classList.contains('open'))), `${e.name}: the menu closes`)
  }

  console.log('\ntranslated\n')
  await p.evaluate(() => [...document.querySelectorAll('.ed-lang-menu .ed-btn')].find((b) => b.textContent.trim() === 'Deutsch').click())
  await openSave()
  const de = await p.evaluate(() => [...document.querySelectorAll('.ed-save-menu > .ed-btn')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()))
  for (const e of ENTRIES) ok(de.some((x) => x.startsWith(e.de)), `German shows "${e.de}…"`)
  await p.evaluate(() => [...document.querySelectorAll('.ed-lang-menu .ed-btn')].find((b) => b.textContent.trim() === 'English').click())

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
