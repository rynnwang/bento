// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Typing after an inline code run that ends a line types plain text (#626).
//
//   npm run build:single --prefix slides && node scripts/test-slides-code-run-exit-browser.mjs
//
// WHAT THIS PROVES, with real mouse and keyboard in the packaged editor. A
// text box that ALREADY ends in a `code` run — saved, reopened, pasted, from a
// file — had no text position after the <code>, so the caret could only sit
// inside it: everything typed at the end of the line became code, and no
// arrow key got out. (The ` autoformat leaves a zero-width space after the
// code it makes, which is why typing it fresh never showed this.) Now a box
// opening for edit gets the same escape hatch after every code run that ends a
// line, and commit strips it:
//   1. click at the end of a line that ends in code, type: the text is plain;
//   2. the same via ⌘↓ + End in the last of two lines;
//   3. a code run that ends the FIRST line (before a <br>) too;
//   4. opening and closing a box without typing leaves its html, and the
//      deck, untouched.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc)
  const load = async (html) => {
    await p.evaluate((h) => {
      const d = JSON.parse(JSON.stringify(window.bento.doc))
      d.slides = [{ id: 's1', background: '#ffffff', elements: [
        { id: 't1', type: 'text', x: 100, y: 200, w: 800, h: 200, rotation: 0, opacity: 1, html: h, fontSize: 32, color: '#1e2a3a' },
      ] }]
      window.bento.loadDoc(JSON.stringify(d))
    }, html)
    await p.waitForTimeout(400)
  }
  const html = () => p.evaluate(() => window.bento.doc.slides[0].elements[0].html)
  const box = () => p.locator('.ed-stage-scale [data-el-id="t1"]')
  const edit = async () => { const b = await box().boundingBox(); await p.mouse.dblclick(b.x + 30, b.y + 15); await p.waitForTimeout(250) }
  const leave = async () => { const s = await p.locator('.ed-stage-scale').boundingBox(); await p.mouse.click(s.x + 20, s.y + s.height - 20); await p.waitForTimeout(250) }
  const clickRightOf = async (nth) => {
    const r = await p.evaluate((n) => { const c = document.querySelectorAll('.ed-stage-scale [data-el-id="t1"] code')[n].getBoundingClientRect(); return { x: c.right + 40, y: c.top + c.height / 2 } }, nth)
    await p.mouse.click(r.x, r.y)
  }

  console.log('\nthe end of a line that ends in code\n')
  await load('Hello <code>code</code>')
  await edit(); await clickRightOf(0)
  await p.keyboard.type(' after', { delay: 15 }); await leave()
  ok(await html() === 'Hello <code>code</code> after', `click at the end, type: plain text (${await html()})`)

  await load('First line<br>Hello <code>code</code>')
  await edit(); await p.keyboard.press(`${MOD}+ArrowDown`); await p.keyboard.press('End')
  await p.keyboard.type(' after', { delay: 15 }); await leave()
  ok(await html() === 'First line<br>Hello <code>code</code> after', `⌘↓ + End in the last line: plain text (${await html()})`)

  await load('Hello <code>code</code><br>Second line')
  await edit(); await clickRightOf(0)
  await p.keyboard.type(' after', { delay: 15 }); await leave()
  ok(await html() === 'Hello <code>code</code> after<br>Second line', `a code run ending the FIRST line: plain text (${await html()})`)

  console.log('\nnothing changes unless you type\n')
  for (const h of ['Hello <code>code</code>', 'A <code>mid</code> line<br>End <code>run</code>']) {
    await load(h)
    await p.evaluate(() => { window.__dirtyBefore = document.querySelector('.ed-dirty')?.classList.contains('on') })
    await edit(); await p.keyboard.press('Escape'); await leave()
    const dirty = await p.evaluate(() => document.querySelector('.ed-dirty')?.classList.contains('on'))
    ok(await html() === h && !/​/.test(await html()), `open and close "${h}": html identical, no zero-width space saved`)
    ok(dirty === (await p.evaluate(() => window.__dirtyBefore)), 'and the deck is no dirtier than before')
  }

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
