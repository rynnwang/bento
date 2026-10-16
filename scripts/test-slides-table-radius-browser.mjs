// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A rounded table never hides a row (#494).
//
//   npm run build:single --prefix slides && node scripts/test-slides-table-radius-browser.mjs
//
// WHAT THIS PROVES, in the packaged editor. `style.radius` rounds a table's
// corners by clipping, and the clip used to be the element's box: every row the
// box was too short for was cut off, with nothing on screen saying so. Now:
//   1. a rounded table whose rows outgrow its box shows its LAST row — the
//      point at its centre hit-tests to that row's cell (a clipped area is not
//      hit-testable), and no wrapper ends above it;
//   2. its corners are still rounded, on the table's real bottom;
//   3. a rounded table SHORTER than its box still fills it, rows stretched as
//      before (the fix must not shrink tables that fit);
//   4. a table without a radius is unchanged.
// (validate()'s `table-overflow` finding, which says the box is too short, is
// pinned in scripts/test-bento-check.ts.)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc)
  await p.evaluate(() => {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ cells: [{ html: `Row ${i + 1}` }, { html: String(i * 10) }] }))
    const table = (id, x, h, n, radius) => ({
      id, type: 'table', x, y: 60, w: 300, h, rotation: 0, opacity: 1, columns: [{ w: 1 }, { w: 1 }], header: false,
      rows: rows(n), style: { fontSize: 16, cellPadX: 10, cellPadY: 8, borderWidth: 1, borderColor: '#ccc', radius, headerBg: '#eee' },
    })
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 's1', background: '#ffffff', elements: [
      table('over', 60, 90, 9, 14), table('fits', 420, 400, 3, 14), table('plain', 780, 400, 3, 0),
    ] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)

  const look = (id) => p.evaluate((i) => {
    const node = document.querySelector(`.ed-stage-scale [data-el-id="${i}"]`)
    const wrap = node.querySelector('.bento-table-wrap'), table = node.querySelector('.bento-table')
    const rows = [...table.querySelectorAll('tr')]
    const last = rows.at(-1).getBoundingClientRect(), box = node.getBoundingClientRect(), w = wrap.getBoundingClientRect(), t = table.getBoundingClientRect()
    const hit = document.elementFromPoint(last.left + last.width / 4, last.top + last.height / 2)
    return {
      boxH: Math.round(box.height), tableH: Math.round(t.height), wrapBottom: Math.round(w.bottom), lastBottom: Math.round(last.bottom),
      lastHit: !!hit && rows.at(-1).contains(hit), radius: getComputedStyle(wrap).borderTopLeftRadius, bottomRadius: getComputedStyle(wrap).borderBottomLeftRadius,
      rowHs: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    }
  }, id)

  console.log('\na rounded table taller than its box\n')
  const o = await look('over')
  ok(o.tableH > o.boxH, `its rows are taller than the box (${o.tableH} > ${o.boxH}) — the case #494 is about`)
  ok(o.lastHit, 'its last row is on screen: the point at its centre hits that row, not whatever lies beneath')
  ok(o.wrapBottom >= o.lastBottom - 1, `no wrapper ends above the last row (wrapper bottom ${o.wrapBottom}, row bottom ${o.lastBottom})`)
  ok(o.radius !== '0px' && o.bottomRadius !== '0px', `its corners are still rounded, the bottom ones on the real bottom (${o.radius})`)

  console.log('\na rounded table shorter than its box\n')
  const f = await look('fits')
  ok(Math.abs(f.tableH - f.boxH) <= 1, `it still fills its box (${f.tableH} of ${f.boxH})`)
  const sum = f.rowHs.reduce((a, b) => a + b, 0)
  ok(Math.abs(sum - f.boxH) <= 3 && Math.max(...f.rowHs) - Math.min(...f.rowHs) <= 1,
    `its rows are stretched to share the height, as before (${f.rowHs.join('/')} = ${sum} of ${f.boxH})`)

  console.log('\na table without a radius\n')
  const q = await look('plain')
  ok(Math.abs(q.tableH - q.boxH) <= 1 && q.radius === '0px', `fills its box, square corners (${q.tableH} of ${q.boxH})`)
  ok(JSON.stringify(q.rowHs) === JSON.stringify(f.rowHs), `same row heights as the rounded one (${q.rowHs.join('/')})`)

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
