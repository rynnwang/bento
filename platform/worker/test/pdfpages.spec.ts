// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Unit assertions for pdfPages.ts — the print-dialog-style page range used by
// GET /d/:id/pdf?pages=…
import { readPageSetup } from '../src/pdfPageCss.ts'
import { normalizePageRange, toChromiumRange, rangeFileTag, countPdfPages, PageRangeError } from '../src/pdfPages.ts'

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}
const eq = (raw: string | null, want: string | null) => {
  const got = normalizePageRange(raw)
  assert(got === want, `${JSON.stringify(raw)} -> ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}
const bad = (raw: string) => {
  try {
    normalizePageRange(raw)
  } catch (e) {
    assert(e instanceof PageRangeError, `wrong error type for ${raw}`)
    return
  }
  throw new Error(`${JSON.stringify(raw)} should have been rejected`)
}

console.log('pdfPages.ts')

check('empty / all means the whole document', () => {
  eq(null, null)
  eq('', null)
  eq('   ', null)
  eq('All', null)
})

check('singles, spans, open-ended spans', () => {
  eq('3', '3')
  eq('1-3', '1-3')
  eq('7-', '7-')
  eq('2-2', '2')
})

check('normalised: sorted, merged, whitespace/CJK separators tolerated', () => {
  eq('3, 1-2', '1-3')
  eq('5,1,3', '1,3,5')
  eq('1-3 , 2-6, 9', '1-6,9')
  eq('1，3、5', '1,3,5')
  eq('4-5 1', '1,4-5')
  eq('1-3,5-', '1-3,5-')
  eq('2-, 9', '2-')
  eq('1 – 3', '1-3')
})

check('garbage and impossible ranges are rejected', () => {
  for (const b of ['abc', '0', '0-3', '-', '1-a', '3-1', '1--3', '99999', '1;;-', '1/2', '<script>', '1-3-5']) bad(b)
  bad(Array.from({ length: 60 }, (_, i) => i * 2 + 1).join(','))
  bad('1,'.repeat(150))
})

check('toChromiumRange gives open-ended spans a concrete end; rangeFileTag is filename-safe', () => {
  assert(toChromiumRange('1-3,7-') === '1-3,7-5000', toChromiumRange('1-3,7-'))
  assert(toChromiumRange('2,4-6') === '2,4-6', 'untouched')
  assert(rangeFileTag('1-3,5') === 'p1-3_5', rangeFileTag('1-3,5'))
})

check('countPdfPages counts /Type /Page but not /Type /Pages', () => {
  const body = '%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages /Count 3>>\nendobj\n' +
    '3 0 obj\n<</Type /Page /Parent 2 0 R>>\nendobj\n4 0 obj\n<</Type /Page>>\nendobj\n5 0 obj\n<</Type/Page /X 1>>\nendobj\n'
  const bytes = new TextEncoder().encode(body)
  assert(countPdfPages(bytes.buffer as ArrayBuffer) === 3, String(countPdfPages(bytes.buffer as ArrayBuffer)))
  assert(countPdfPages(new TextEncoder().encode('not a pdf').buffer as ArrayBuffer) === null, 'null when nothing matches')
})

check('readPageSetup: size in px/in/mm/pt, inside @media print, and own-margin detection', () => {
  const a = readPageSetup('<style>@media print{ @page{size:1280px 720px;margin:0} }</style>')
  assert(a.width === 1280 && a.height === 720 && a.ownMargin, JSON.stringify(a))
  const b = readPageSetup('<style>@page { size: 11in 8.5in }</style>')
  assert(b.width === 1056 && b.height === 816 && !b.ownMargin, JSON.stringify(b))
  const c = readPageSetup('<style>@page{size:297mm 210mm;margin-top:5mm}</style>')
  assert(Math.round(c.width!) === 1123 && Math.round(c.height!) === 794 && c.ownMargin, JSON.stringify(c))
  const d = readPageSetup('<style>@page{size:960pt 540pt}</style>')
  assert(d.width === 1280 && d.height === 720, JSON.stringify(d))
})

check('readPageSetup: keywords, one-length sizes, nonsense and no @page leave A4 behaviour alone', () => {
  for (const css of ['@page{size:A4 landscape}', '@page{size:landscape}', '@page{size:10in}', '@page{size:5px 5px}', '@page{size:99999px 720px}', 'body{margin:0}', '']) {
    const r = readPageSetup('<style>' + css + '</style>')
    assert(r.width === undefined && r.height === undefined, css + ' -> ' + JSON.stringify(r))
  }
  assert(readPageSetup('<style>.a{size:1280px 720px}</style>').width === undefined, 'size outside @page is ignored')
})

console.log('')
if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
