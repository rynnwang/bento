// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// #493 — connectors in a deck authored outside the editor route on every slide.
//
//   npm run build:single --prefix slides && node scripts/test-slides-connectors-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. A deck written by hand or by an
// agent names a connector's from/to elements but carries stale or placeholder
// endpoints. Before #493 only the slide on screen was ever routed, and only on
// an edit — so slide 2's connector stayed wherever the author left it, in the
// thumbnail, the show and the PDF. Now:
//   1. a deck SAVED that way (the file's own #bento-doc) opens with slide 2's
//      connector already on its two elements' borders, while slide 1 is shown;
//   2. slide 2's thumbnail draws it there;
//   3. that routing is not an edit — the deck is not dirty, and ⌘Z does not
//      bring the stale endpoints back;
//   4. a deck put in with window.bento.loadDoc (Replace from JSON) routes the
//      same way, on every slide.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const OPEN = '<script type="application/bento+json" id="bento-doc">'

// a line's two endpoints from its box (kernel geom lineEndpoints)
const ends = (el) => {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2, t = ((el.rotation || 0) * Math.PI) / 180
  const dx = (Math.cos(t) * el.w) / 2, dy = (Math.sin(t) * el.w) / 2
  return [{ x: cx - dx, y: cy - dy }, { x: cx + dx, y: cy + dy }]
}
const routed = (el) => {
  if (!el) return false
  const [a, b] = ends(el)
  return Math.abs(a.x - 300) < 1.5 && Math.abs(a.y - 350) < 1.5 && Math.abs(b.x - 800) < 1.5 && Math.abs(b.y - 350) < 1.5
}
const box = (id, x) => ({ id, type: 'shape', shape: 'rect', x, y: 300, w: 200, h: 100, rotation: 0, opacity: 1, fill: '#5E7699' })
const conn = { id: 'conn', type: 'shape', shape: 'line', x: 20, y: 20, w: 40, h: 2, rotation: 0, opacity: 1, fill: '#1E2A3A', strokeWidth: 3, from: { el: 'A' }, to: { el: 'B' } }
const staleDeck = (base) => {
  const d = JSON.parse(JSON.stringify(base))
  d.slides = [
    { id: 's1', background: '#ffffff', elements: [box('A', 100)] },
    { id: 's2', background: '#ffffff', elements: [box('A', 100), box('B', 800), JSON.parse(JSON.stringify(conn))] },
  ]
  return d
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(shellPath.href)
  await p.waitForFunction(() => window.bento?.doc)
  const base = await p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc)))

  console.log('\na deck saved with stale connector endpoints\n')
  const shell = readFileSync(shellPath, 'utf8')
  const i = shell.indexOf(OPEN) + OPEN.length, j = shell.indexOf('</' + 'script>', i)
  const json = JSON.stringify(staleDeck(base)).replace(/</g, '\\u003c')
  const dir = mkdtempSync(join(tmpdir(), 'bento-493-'))
  const file = join(dir, 'stale-connectors.bento.html')
  writeFileSync(file, shell.slice(0, i) + json + shell.slice(j))
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-sidebar .ed-thumb[data-index="1"]'))
  await p.waitForTimeout(600)
  const s = await p.evaluate(() => ({
    conn: window.bento.doc.slides[1].elements.find((e) => e.id === 'conn'),
    current: document.querySelector('.ed-stage-scale [data-el-id="A"]') && !document.querySelector('.ed-stage-scale [data-el-id="B"]'),
    dirty: !!document.querySelector('.ed-dirty.on'),
  }))
  ok(s.current, 'slide 1 is the one on screen')
  ok(routed(s.conn), `slide 2's connector opens on A's and B's borders (${ends(s.conn).map((q) => `${Math.round(q.x)},${Math.round(q.y)}`).join(' → ')})`)
  const thumb = await p.evaluate(() => {
    const t = document.querySelector('.ed-sidebar .ed-thumb[data-index="1"] [data-el-id="conn"]')
    return t ? { left: parseFloat(t.style.left), width: parseFloat(t.style.width) } : null
  })
  const want = s.conn
  ok(!!thumb && Math.abs(thumb.left - want.x) < 0.5 && Math.abs(thumb.width - want.w) < 0.5, `slide 2's thumbnail draws it there (left ${thumb?.left}, width ${thumb?.width})`)
  ok(!s.dirty, 'opening it is not an edit — the deck is not dirty')
  await p.evaluate(() => window.bento.undo())
  await p.waitForTimeout(200)
  const afterUndo = await p.evaluate(() => window.bento.doc.slides[1].elements.find((e) => e.id === 'conn'))
  ok(routed(afterUndo), '⌘Z does not bring the stale endpoints back (routing made no undo step)')

  console.log('\na deck put in with loadDoc\n')
  await p.goto(shellPath.href)
  await p.waitForFunction(() => window.bento?.doc)
  await p.evaluate((d) => window.bento.loadDoc(JSON.stringify(d)), staleDeck(base))
  await p.waitForTimeout(400)
  const viaLoad = await p.evaluate(() => window.bento.doc.slides[1].elements.find((e) => e.id === 'conn'))
  ok(routed(viaLoad), 'slide 2 — not the slide on screen — is routed after loadDoc')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
