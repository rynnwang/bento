// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The text caret at the start of a line is visible while editing (#547).
//
//   npm run build:single --prefix slides && node scripts/test-slides-caret-ring-browser.mjs
//
// WHAT THIS PROVES, in the packaged editor with real input, light and dark:
//   1. a real double-click enters text editing and ←  puts the caret at the
//      start of the first line — at the text box's left edge, x = 0;
//   2. nothing paints over that edge: the editing ring is an outline held off
//      the box (not a shadow hugging it), Moveable's control box — which keeps
//      its last lines drawn although it has no target while you edit — is
//      hidden, and a real screenshot of the strip just left of the caret has
//      no ring-blue pixel in it (before the fix: the ring and Moveable's left
//      line, both blue, sat on that strip);
//   3. the text does not move when editing starts (the model owns geometry);
//   4. once the edit ends and the box is selected again, the control box is
//      back — the hide is for the edit only.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const theme of ['light', 'dark']) {
    console.log(`\n${theme}\n`)
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.route(/^https?:/, (r) => r.abort())
    await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
    await p.waitForFunction(() => window.bento?.doc)
    await p.evaluate((th) => {
      document.documentElement.dataset.theme = th
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', elements: [{ id: 't1', type: 'text', x: 200, y: 200, w: 600, h: 200, rotation: 0, opacity: 1, html: 'First line<br>Second line', fontSize: 40, color: '#1e2a3a' }] }]
      window.bento.loadDoc(JSON.stringify(d))
    }, theme)
    await p.waitForTimeout(400)
    const textAt = () => p.evaluate(() => {
      const inner = document.querySelector('.ed-stage-scale [data-el-id="t1"] .bento-text-inner')
      const r = document.createRange(); r.selectNodeContents(inner.firstChild); const b = r.getBoundingClientRect()
      return [Math.round(b.left * 100) / 100, Math.round(b.top * 100) / 100]
    })
    const before = await textAt()
    const node = p.locator('.ed-stage-scale [data-el-id="t1"]')
    const nb = await node.boundingBox()
    await p.mouse.dblclick(nb.x + 80, nb.y + 20)
    await p.waitForTimeout(250)
    await p.keyboard.press('ArrowLeft') // collapse the select-all to the very start
    await p.waitForTimeout(250)
    const m = await p.evaluate(() => {
      const inner = document.querySelector('.ed-stage-scale [data-el-id="t1"] .bento-text-inner')
      const sel = getSelection(), rg = sel.getRangeAt(0)
      const r = rg.getClientRects()[0] ?? rg.getBoundingClientRect()
      const ir = inner.getBoundingClientRect(), cs = getComputedStyle(inner)
      const mid = r.top + r.height / 2
      const over = (x) => document.elementsFromPoint(x, mid).filter((e) => e.closest?.('.moveable-control-box')).length
      const box = document.querySelector('.ed-stage-scale .moveable-control-box')
      return {
        editing: inner.isContentEditable && document.activeElement === inner,
        collapsed: rg.collapsed && rg.startOffset === 0,
        caret: [r.left, r.top, r.height], innerLeft: ir.left,
        shadow: cs.boxShadow, outline: cs.outlineStyle, offset: parseFloat(cs.outlineOffset),
        boxVisible: box ? getComputedStyle(box).visibility : 'none',
        overCaret: over(r.left + 0.25) + over(r.left - 0.75),
      }
    })
    ok(m.editing && m.collapsed, 'a real double-click enters editing, and ← puts the caret at the start')
    ok(Math.abs(m.caret[0] - m.innerLeft) < 0.6, `the caret is at the text box's left edge (caret ${m.caret[0]}, edge ${m.innerLeft})`)
    ok(m.shadow === 'none' && m.outline === 'solid' && m.offset >= 2, `the ring is an outline held ${m.offset}px off the box, no hugging shadow (${m.shadow})`)
    ok(m.boxVisible === 'hidden' && m.overCaret === 0, `Moveable's leftover lines are not drawn over the caret (${m.boxVisible}, ${m.overCaret} hits)`)
    // pixels: the 2px strip just left of the caret, the caret's own height
    const shot = await p.screenshot({ clip: { x: m.caret[0] - 2, y: m.caret[1] + 3, width: 2, height: Math.max(4, m.caret[2] - 6) } })
    const blue = await p.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const x = c.getContext('2d'); x.drawImage(img, 0, 0)
      const d = x.getImageData(0, 0, img.width, img.height).data
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 60 && d[i + 2] > 150) n++
      return n
    }, shot.toString('base64'))
    ok(blue === 0, `no ring-blue pixel in the strip beside the caret (${blue})`)
    const during = await textAt()
    ok(during[0] === before[0] && during[1] === before[1], `the text did not move when editing started (${before} → ${during})`)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(200)
    await p.mouse.click(nb.x + 80, nb.y + 20)
    await p.waitForTimeout(250)
    const back = await p.evaluate(() => { const b = document.querySelector('.ed-stage-scale .moveable-control-box'); return b ? getComputedStyle(b).visibility : 'none' })
    ok(back === 'visible', `after the edit, the selected box shows its controls again (${back})`)
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
    await p.close()
  }
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
