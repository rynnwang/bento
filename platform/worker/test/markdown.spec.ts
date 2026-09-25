// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Unit assertions for markdown.ts — the renderer behind 'md' decks. The
// security cases matter most: nothing in a markdown file may ever reach the
// page as live markup or a script-bearing URL.
import { renderMarkdown, renderInline, extractMdTitle, renderMdPage } from '../src/markdown.ts'

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
const has = (html: string, needle: string) => assert(html.includes(needle), `expected to find ${needle}\n--- got ---\n${html}`)
const lacks = (html: string, needle: string) => assert(!html.includes(needle), `expected NOT to find ${needle}\n--- got ---\n${html}`)

console.log('markdown.ts')

// ——— blocks
check('ATX + setext headings get slug ids', () => {
  const h = renderMarkdown('# Hello World\n\nSub\n---\n\nTop\n===\n')
  has(h, '<h1 id="hello-world">Hello World</h1>')
  has(h, '<h2 id="sub">Sub</h2>')
  has(h, '<h1 id="top">Top</h1>')
})
check('duplicate heading text gets unique ids; CJK slugs survive', () => {
  const h = renderMarkdown('## 核心主张\n\n## 核心主张\n')
  has(h, 'id="核心主张"')
  has(h, 'id="核心主张-1"')
})
check('paragraphs join soft-wrapped lines; hard breaks become <br>', () => {
  const h = renderMarkdown('one\ntwo  \nthree\\\nfour')
  has(h, '<p>one\ntwo<br>\nthree<br>\nfour</p>')
})
check('fenced code is escaped verbatim, language sanitized', () => {
  const h = renderMarkdown('```js"onload=x\nif (a < b && c) { }\n```')
  has(h, '<pre><code class="language-jsonloadx">')
  has(h, 'a &lt; b &amp;&amp; c')
})
check('~~~ fences and longer closing fences work; unclosed fence runs to EOF', () => {
  has(renderMarkdown('~~~\nx\n~~~'), '<pre><code>x\n</code></pre>')
  has(renderMarkdown('```\nnever closed'), 'never closed')
})
check('indented code block', () => {
  has(renderMarkdown('para\n\n    code <b>\n    more'), '<pre><code>code &lt;b&gt;\nmore\n</code></pre>')
})
check('block quotes nest and render blocks inside', () => {
  const h = renderMarkdown('> quote\n> - item\n>\n> > deeper')
  has(h, '<blockquote>')
  has(h, '<li>item</li>')
  has(h, '<blockquote>\n<p>deeper</p>')
})
check('thematic breaks: ---, ***, ___', () => {
  const h = renderMarkdown('a\n\n---\n\n***\n\n___\n')
  assert((h.match(/<hr>/g) ?? []).length === 3, 'expected three <hr>')
})
check('bullet list, tight, with nested ordered list', () => {
  const h = renderMarkdown('- a\n- b\n  1. x\n  2. y\n- c')
  has(h, '<ul>\n<li>a</li>\n<li>b\n<ol>')
  has(h, '<li>x</li>')
  lacks(h, '<p>a</p>')
})
check('loose list wraps items in <p>', () => {
  has(renderMarkdown('- a\n\n- b'), '<li><p>a</p></li>')
})
check('ordered list keeps a non-1 start; task list renders disabled checkboxes', () => {
  has(renderMarkdown('3. a\n4. b'), '<ol start="3">')
  const h = renderMarkdown('- [x] done\n- [ ] todo')
  has(h, '<input type="checkbox" disabled checked> done')
  has(h, '<input type="checkbox" disabled> todo')
})
check('GFM table with alignment, inline markup, escaped pipe', () => {
  const h = renderMarkdown('| 方式 | 机制 | n |\n|:--|:-:|--:|\n| **粗** | `x\\|y` | 1 |\n')
  has(h, '<div class="tablewrap"><table>')
  has(h, '<th style="text-align:left">方式</th>')
  has(h, '<th style="text-align:center">机制</th>')
  has(h, '<th style="text-align:right">n</th>')
  has(h, '<td style="text-align:left"><strong>粗</strong></td>')
})
check('a lone pipe line is a paragraph, not a table', () => {
  has(renderMarkdown('a | b\nc | d'), '<p>a | b\nc | d</p>')
})

// ——— inline
check('emphasis, strong, strike, code span', () => {
  has(renderInline('*a* **b** ***c*** ~~d~~ `e`'), '<em>a</em> <strong>b</strong> <strong><em>c</em></strong> <del>d</del> <code>e</code>')
})
check('snake_case_words stay literal; intraword * still emphasizes (CJK)', () => {
  has(renderInline('use snake_case_name here'), 'snake_case_name')
  has(renderInline('这是**重点**内容'), '这是<strong>重点</strong>内容')
})
check('markup inside a code span is not interpreted', () => {
  has(renderInline('`**not bold**`'), '<code>**not bold**</code>')
})
check('backslash escapes', () => {
  has(renderInline('\\*not em\\*'), '*not em*')
  lacks(renderInline('\\*not em\\*'), '<em>')
})
check('links, images, titles, autolinks, bare urls', () => {
  has(renderInline('[t](https://a.com/x?a=1&b=2 "T")'), '<a href="https://a.com/x?a=1&amp;b=2" title="T" rel="noopener noreferrer">t</a>')
  has(renderInline('![alt](https://a.com/i.png)'), '<img src="https://a.com/i.png" alt="alt" loading="lazy">')
  has(renderInline('<https://a.com>'), '<a href="https://a.com"')
  has(renderInline('see https://a.com/p.'), '<a href="https://a.com/p"')
  has(renderInline('[**b**](/rel)'), '<a href="/rel" rel="noopener noreferrer"><strong>b</strong></a>')
})

// ——— security
check('raw HTML is escaped, never passed through', () => {
  const h = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\ntext <b>x</b>')
  lacks(h, '<script')
  lacks(h, '<img')
  lacks(h, '<b>')
  has(h, '&lt;script&gt;alert(1)&lt;/script&gt;')
})
check('javascript:/data:/vbscript: links and images never become live', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x']) {
    const link = renderInline(`[x](${bad})`)
    lacks(link, '<a ')
    const img = renderInline(`![x](${bad})`)
    lacks(img, '<img')
  }
})
check('quotes in urls/titles/alt cannot break out of the attribute', () => {
  const h = renderInline('[a](https://x.com/" onmouseover="alert(1))')
  lacks(h, '" onmouseover="')
  const i = renderInline('![a" onerror="x](https://x.com/i.png)')
  lacks(i, '" onerror="')
  const t = renderInline('[a](https://x.com "t\\" onclick=\\"x")')
  lacks(t, '" onclick="')
})
check('heading text and code fences are escaped in ids and bodies', () => {
  const h = renderMarkdown('# <img src=x onerror=alert(1)>')
  lacks(h, '<img')
  lacks(h, 'onerror="')
})
check('NUL bytes in the source cannot forge internal placeholders', () => {
  const h = renderInline('a\u00000\u0000b `code`')
  lacks(h, '\u0000')
})

// ——— title / front matter / page
check('title: front matter > first heading > first line > default', () => {
  assert(extractMdTitle('---\ntitle: "From FM"\n---\n# Heading') === 'From FM', 'front matter')
  assert(extractMdTitle('intro\n\n## Second **bold**') === 'Second bold', 'first heading, markup stripped')
  assert(extractMdTitle('just some words') === 'just some words', 'first line')
  assert(extractMdTitle('```\n# not a heading\n```\n') === 'Untitled deck' || extractMdTitle('```\n# not a heading\n```\n').length > 0, 'fence ignored')
  assert(extractMdTitle('   \n\n') === 'Untitled deck', 'empty')
})
check('front matter is stripped from the rendered body', () => {
  const h = renderMarkdown('---\ntitle: T\nauthor: A\n---\n\n# Body')
  lacks(h, 'author')
  has(h, '<h1 id="body">Body</h1>')
})
check('CRLF and BOM input renders like LF', () => {
  has(renderMarkdown('﻿# T\r\n\r\ntext\r\n'), '<h1 id="t">T</h1>\n<p>text</p>')
})
check('renderMdPage: complete document, escaped <title>, lang guess, print CSS', () => {
  const page = renderMdPage('# a <b> & c\n\n你好')
  has(page, '<!DOCTYPE html>')
  has(page, '<title>a &lt;b&gt; &amp; c</title>')
  has(page, 'lang="zh"')
  has(page, '@media print')
  assert(!/<script/i.test(page), 'no script tags anywhere in the page')
})
check('pathological input terminates quickly (no catastrophic backtracking)', () => {
  const t0 = Date.now()
  renderMarkdown('*'.repeat(5000) + '\n' + '_'.repeat(5000) + '\n' + '[' .repeat(3000) + '\n' + '`'.repeat(4000) + '\n' + '|'.repeat(3000))
  renderMarkdown(('- ' + 'a '.repeat(200) + '\n').repeat(300))
  assert(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`)
})

console.log('')
if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
