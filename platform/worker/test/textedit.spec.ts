// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Unit assertions for textedit.ts — limited in-place text editing. The point of
// the module is what it REFUSES: nothing but text and plain formatting may change.
import { applyHtmlTextEdit, applyMdTextEdit, EditError, normText } from '../src/textedit.ts'
import { renderMarkdown } from '../src/markdown.ts'

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
function rejects(fn: () => unknown, status = 422): string {
  try {
    fn()
  } catch (e) {
    assert(e instanceof EditError, `expected EditError, got ${e}`)
    assert(e.status === status, `expected ${status}, got ${e.status}: ${e.message}`)
    return e.message
  }
  throw new Error('expected the edit to be rejected')
}

console.log('textedit.ts — HTML decks')

const HTML = `<!doctype html><html><head><title>T</title><style>h1{color:red}</style><script>var x = "<h1>Script Title</h1>"</script></head>
<body class="a"><h1 id="t">  Big   Title </h1>
<p class="lead">First <b>bold</b> para &amp; more</p>
<p>Same</p><div><p>Same</p></div>
<p>Link <a href="/x?a=1&amp;b=2" class="k">here</a> ok</p>
<div class="card"><h2>Inner</h2><p>Block child</p></div>
<ul><li>one<li>two</li></ul>
<table><tr><td>Cell</td></tr></table>
</body></html>`

const edit = (over: Partial<Parameters<typeof applyHtmlTextEdit>[1]>) =>
  applyHtmlTextEdit(HTML, { tag: 'h1', oldText: 'Big Title', nth: 0, html: 'New Title', ...over })

check("replaces ONLY the element's inner content; every other byte is untouched", () => {
  const out = edit({})
  assert(out === HTML.replace('  Big   Title ', 'New Title'), 'splice differs from a pure inner replacement')
})

check('plain formatting (b/i/u/s/br) is allowed; entities round-trip', () => {
  const out = edit({ html: 'A <b>b</b> <i>i</i><br>x &amp; &lt;y&gt;' })
  assert(out.includes('<h1 id="t">A <b>b</b> <i>i</i><br>x &amp; &lt;y&gt;</h1>'), out.slice(60, 200))
})

check('anything that could change structure or style is rejected', () => {
  for (const bad of [
    '<span style="color:red">x</span>', '<b style="color:red">x</b>', '<script>alert(1)</script>', 'x</h1><h1>y', '</div>x',
    '<div>block</div>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', 'x<!-- c -->', '<b>unclosed',
    '<b onclick="x()">x</b>', '<a <script>>x', '<p>para</p>', '<h2>x</h2>',
  ]) rejects(() => edit({ html: bad }))
})

check('an inline element that already existed may stay, but only with IDENTICAL attributes', () => {
  const ok = applyHtmlTextEdit(HTML, { tag: 'p', oldText: 'Link here ok', nth: 0, html: 'Changed <a href="/x?a=1&amp;b=2" class="k">here</a> text' })
  assert(ok.includes('<p>Changed <a href="/x?a=1&amp;b=2" class="k">here</a> text</p>'), 'kept link lost')
  rejects(() => applyHtmlTextEdit(HTML, { tag: 'p', oldText: 'Link here ok', nth: 0, html: 'x <a href="/evil" class="k">here</a>' }))
  rejects(() => applyHtmlTextEdit(HTML, { tag: 'p', oldText: 'Link here ok', nth: 0, html: 'x <a href="/x?a=1&amp;b=2" class="k" target="_blank">here</a>' }))
})

check('nth selects among identical elements in document order', () => {
  const out = applyHtmlTextEdit(HTML, { tag: 'p', oldText: 'Same', nth: 1, html: 'Second' })
  assert(out.includes('<p>Same</p><div><p>Second</p></div>'), 'wrong duplicate edited')
  rejects(() => applyHtmlTextEdit(HTML, { tag: 'p', oldText: 'Same', nth: 2, html: 'x' }))
})

check('text that only exists inside a <script> string is not found (script-generated content)', () => {
  const msg = rejects(() => applyHtmlTextEdit(HTML, { tag: 'h1', oldText: 'Script Title', nth: 0, html: 'x' }))
  assert(/script/.test(msg), msg)
})

check('an element containing block children is not editable; leaf ones and unclosed <li> handled', () => {
  rejects(() => applyHtmlTextEdit(HTML, { tag: 'div', oldText: 'Inner Block child', nth: 0, html: 'x' }))
  assert(applyHtmlTextEdit(HTML, { tag: 'li', oldText: 'two', nth: 0, html: 'deux' }).includes('<li>deux</li>'), 'closed li')
  rejects(() => applyHtmlTextEdit(HTML, { tag: 'li', oldText: 'one', nth: 0, html: 'un' })) // no close tag → offsets unknown → refused
  assert(applyHtmlTextEdit(HTML, { tag: 'td', oldText: 'Cell', nth: 0, html: 'C' }).includes('<td>C</td>'), 'td')
})

check('empty result and disallowed tags (body/html/script) are rejected', () => {
  rejects(() => edit({ html: '   ' }))
  rejects(() => edit({ html: '<b></b>' }))
  rejects(() => applyHtmlTextEdit(HTML, { tag: 'body', oldText: 'x', nth: 0, html: 'x' }))
  rejects(() => applyHtmlTextEdit(HTML, { tag: 'script', oldText: 'x', nth: 0, html: 'x' }))
})

console.log('textedit.ts — Markdown decks')

const MD = [
  '---', 'title: "FM"', '---', '',
  '# Heading *one*', '',
  'A paragraph with **bold** and a [link](https://example.com/a).', 'Second line of it.', '',
  '- item one', '- [ ] task item', '  - nested item', '',
  '> quoted line', '',
  'quoted line', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '',
  'Setext title', '============', '',
  '```', '# not a heading', '```', '', '## Last  heading ##', '',
].join('\n')
const mdEdit = (tag: string, oldText: string, html: string, nth = 0) => applyMdTextEdit(MD, { tag, oldText, nth, html }).md

check('heading: text replaced, level/marker kept, front matter and the rest untouched', () => {
  const out = mdEdit('h1', 'Heading one', 'Renamed <i>it</i>')
  assert(out === MD.replace('# Heading *one*', '# Renamed *it*'), out)
})

check('paragraph: multi-line, bold and links survive an edit that keeps them', () => {
  const rel = 'https://example.com/a'
  const out = mdEdit('p', 'A paragraph with bold and a link. Second line of it.', `New <b>bold</b> and <a href="${rel}" rel="noopener noreferrer">link</a><br>line two`)
  assert(out.includes('New **bold** and [link](https://example.com/a)  \nline two'), out)
  assert(out.includes('- item one'), 'later content lost')
})

check('list items keep their marker/indent/task box; nested item edits in place', () => {
  assert(mdEdit('li', 'item one', 'first').includes('\n- first\n'), 'plain item')
  assert(mdEdit('li', 'task item', 'done').includes('\n- [ ] done\n'), 'task item')
  assert(mdEdit('li', 'nested item', 'deep').includes('\n  - deep\n'), 'nested')
})

check('typed markdown/HTML specials are escaped, so an edit can never create structure', () => {
  const out = mdEdit('h1', 'Heading one', '# *x* [y](z) `c` &lt;b&gt;')
  assert(out.includes('# # \\*x\\* \\[y\\](z) \\`c\\` \\<b\\>'), out)
  const html = renderMarkdown(out)
  const h1 = /<h1[^>]*>[\s\S]*?<\/h1>/.exec(html)?.[0] ?? ''
  assert(h1 && !h1.includes('<em>') && !h1.includes('<a ') && !h1.includes('<b>'), h1)
  const p = mdEdit('p', 'A paragraph with bold and a link. Second line of it.', '- looks like a list')
  assert(p.includes('\\- looks like a list'), p)
})

check('identical text inside a quote counts for the ordinal, and quotes/tables/setext are refused', () => {
  const second = mdEdit('p', 'quoted line', 'changed', 1) // 0 = the quote, 1 = the plain paragraph
  assert(second.includes('> quoted line') && second.includes('\nchanged\n'), second)
  rejects(() => mdEdit('p', 'quoted line', 'x', 0))
  rejects(() => mdEdit('td', '1', 'x'))
  rejects(() => mdEdit('h1', 'Setext title', 'x'))
})

check('fenced code is never treated as content; closing-hash headings normalise', () => {
  rejects(() => mdEdit('h1', 'not a heading', 'x'))
  assert(mdEdit('h2', 'Last heading', 'End').includes('\n## End\n'), 'closing hashes')
})

check('markup that is not plain formatting is rejected for markdown too; CRLF/BOM sources work', () => {
  rejects(() => mdEdit('h1', 'Heading one', '<span style="color:red">x</span>'))
  rejects(() => mdEdit('h1', 'Heading one', '<a href="http://evil">x</a>'))
  const crlf = '﻿' + MD.replace(/\n/g, '\r\n')
  const out = applyMdTextEdit(crlf, { tag: 'h1', oldText: 'Heading one', nth: 0, html: 'X' }).md
  assert(out.startsWith('﻿---\ntitle: "FM"\n---\n\n# X\n'), JSON.stringify(out.slice(0, 40)))
})

check('normText collapses whitespace and nbsp', () => {
  assert(normText(' a  b\n c ') === 'a b c', 'norm')
})

console.log('')
if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
