// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Unit assertions for webclip.ts — URL -> Markdown. The converted output is fed
// straight into the 'md' renderer, so the round-trip cases matter as much as the
// conversion itself: nothing a hostile page contains may become live markup.
import { htmlToClip, parseHtml, validateClipUrl, decodeEntities, clipUrl } from '../src/webclip.ts'
import { renderMarkdown } from '../src/markdown.ts'
import { splitBlocks, parseDrop, aiCleanClip } from '../src/clipclean.ts'

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
const has = (s: string, needle: string) => assert(s.includes(needle), `expected to find ${needle}\n--- got ---\n${s}`)
const lacks = (s: string, needle: string) => assert(!s.includes(needle), `expected NOT to find ${needle}\n--- got ---\n${s}`)

const filler = 'This is a reasonably long paragraph of genuine article text, with commas, clauses, and enough words to count as real content. '.repeat(3)

const PAGE = `<!doctype html><html><head><title>Site | A Great Article</title>
<meta property="og:title" content="A Great Article">
<style>.x{color:red}</style><script>var secret = "SHOULD-NOT-APPEAR"</script></head>
<body>
<nav><a href="/home">Home</a><a href="/about">About</a></nav>
<header class="site-header"><a href="/">LOGO-TEXT</a></header>
<div class="sidebar"><p>SIDEBAR-JUNK ${filler}</p></div>
<article>
  <h1>A Great Article</h1>
  <p>${filler} <a href="/relative/link?a=1&amp;b=2">a relative link</a> and <strong>bold</strong> and <em>italic</em> and <code>code()</code>.</p>
  <figure><img src="/img/photo.jpg" alt="A photo"><figcaption>Photo caption</figcaption></figure>
  <img data-src="https://cdn.example.com/lazy.png" src="data:image/gif;base64,R0lGOD" alt="lazy">
  <h2>Section</h2>
  <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
  <ol start="3"><li>three</li><li>four</li></ol>
  <blockquote><p>A quote worth keeping.</p></blockquote>
  <pre><code class="language-ts">const a = 1 &lt; 2\nif (a) {}</code></pre>
  <table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr><tr><td>Pear | x</td><td>4</td></tr></table>
  <p>${filler}</p>
</article>
<div class="comments"><p>COMMENT-JUNK ${filler}</p></div>
<footer>FOOTER-JUNK</footer>
</body></html>`

console.log('webclip.ts')

check('parseHtml: lenient with unclosed/stray tags and raw-text elements', () => {
  const root = parseHtml('<div><p>a<p>b</span></div><script>if (a<b) </script>c')
  assert(root.kids.length >= 1, 'no nodes')
})

check('decodeEntities: named, numeric, hex, and bogus references', () => {
  assert(decodeEntities('&amp;&lt;&#65;&#x42;&nbsp;&bogus;') === '&<AB &bogus;', decodeEntities('&amp;&lt;&#65;&#x42;&nbsp;&bogus;'))
  assert(decodeEntities('&#0;&#xD800;&#99999999;') === '', 'invalid code points must vanish')
})

const clip = htmlToClip(PAGE, 'https://news.example.com/2026/story?id=1')

check('title comes from og:title; heading + source line lead the document', () => {
  assert(clip.title === 'A Great Article', clip.title)
  assert(clip.md.startsWith('# A Great Article\n\nSource: [news.example.com](https://news.example.com/2026/story?id=1)'), clip.md.slice(0, 200))
})

check('page chrome is dropped: nav, header, sidebar, comments, footer, script, style', () => {
  for (const junk of ['LOGO-TEXT', 'SIDEBAR-JUNK', 'COMMENT-JUNK', 'FOOTER-JUNK', 'SHOULD-NOT-APPEAR', 'color:red', 'About']) lacks(clip.md, junk)
})

check('relative links and images become absolute (media stays online)', () => {
  has(clip.md, '[a relative link](https://news.example.com/relative/link?a=1&b=2)')
  has(clip.md, '![A photo](https://news.example.com/img/photo.jpg)')
  has(clip.md, '![lazy](https://cdn.example.com/lazy.png)')
  lacks(clip.md, 'data:image')
})

check('inline formatting, headings, lists, quotes, code, tables convert', () => {
  has(clip.md, '**bold**')
  has(clip.md, '*italic*')
  has(clip.md, '`code()`')
  has(clip.md, '## Section')
  has(clip.md, '- one')
  has(clip.md, '  - nested')
  has(clip.md, '3. three')
  has(clip.md, '4. four')
  has(clip.md, '> A quote worth keeping.')
  has(clip.md, '```ts\nconst a = 1 < 2\nif (a) {}\n```')
  has(clip.md, '| Name | Qty |')
  has(clip.md, '| --- | --- |')
  has(clip.md, 'Pear \\| x')
  has(clip.md, '*Photo caption*')
})

check('round trip: the converted Markdown renders through markdown.ts', () => {
  const html = renderMarkdown(clip.md)
  has(html, '<h1')
  has(html, '<img')
  has(html, 'src="https://news.example.com/img/photo.jpg"')
  has(html, '<table>')
  has(html, '<pre><code class="language-ts">')
  lacks(html, '<script')
})

check('hostile page: script URLs, event handlers, raw tags never become live', () => {
  const evil = `<html><body><article><h1>x</h1><p>${filler}<a href="javascript:alert(1)">click</a><img src="javascript:alert(2)" onerror="alert(3)"><a href="data:text/html,<script>alert(4)</script>">d</a> &lt;script&gt;alert(5)&lt;/script&gt; <b onclick="alert(6)">b</b></p><p>${filler}</p></article></body></html>`
  const c = htmlToClip(evil, 'https://evil.example/')
  lacks(c.md, 'javascript:')
  lacks(c.md, 'data:text/html')
  const html = renderMarkdown(c.md)
  lacks(html, '<script')
  lacks(html, 'onerror')
  lacks(html, 'onclick')
  lacks(html, 'javascript:')
})

check('a page with no article tag falls back to the densest text block', () => {
  const c = htmlToClip(`<html><body><div id="a"><a href="/x">menu</a> <a href="/y">menu2</a></div><div id="post"><p>${filler}</p><p>${filler}</p></div></body></html>`, 'https://blog.example.com/p')
  has(c.md, 'genuine article text')
  lacks(c.md, 'menu2')
})

check('state classes on <body> (e.g. WeChat "comment_feature") never veto the whole page', () => {
  const c = htmlToClip(`<html><body class="wx comment_feature menu-open"><div id="js_content" style="visibility:hidden"><section><p>${filler}</p><p>${filler}</p></section></div></body></html>`, 'https://mp.weixin.qq.com/s/x')
  has(c.md, 'genuine article text')
})

check('JS-only / empty pages are reported, not saved as blank decks', () => {
  let msg = ''
  try {
    htmlToClip('<html><body><div id="root"></div><script src="/app.js"></script></body></html>', 'https://spa.example.com/')
  } catch (e) {
    msg = (e as Error).message
  }
  assert(/readable article text/.test(msg), `got: ${msg}`)
})

check('URL validation: only public http(s)', () => {
  for (const bad of ['ftp://x.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/a', 'http://127.0.0.1/', 'http://192.168.1.5/', 'http://10.0.0.1/', 'http://intranet/', 'http://user:pw@example.com/', 'http://[::1]/', 'not a url', 'https://me.example.com/']) {
    let threw = false
    try {
      validateClipUrl(bad, 'me.example.com')
    } catch {
      threw = true
    }
    assert(threw, `should have rejected ${bad}`)
  }
  assert(validateClipUrl('https://example.com/a?b=1#c').hostname === 'example.com', 'good url rejected')
})

check('pathological input terminates quickly', () => {
  const t0 = Date.now()
  try {
    htmlToClip('<div>'.repeat(20000) + '<p>' + 'x '.repeat(50000), 'https://x.example.com/')
  } catch { /* too little content is fine — we only care that it returns */ }
  htmlToClip('<a href="' + 'a'.repeat(100000) + '">' + '<'.repeat(50000) + '</a>' + `<p>${filler}</p>`.repeat(3), 'https://x.example.com/')
  assert(Date.now() - t0 < 4000, `took ${Date.now() - t0}ms`)
})

const MDDOC = ["# T",
  "Source: [x](https://x.com)",
  "[€](a) [$](b)",
  "Real paragraph one that is long enough to matter.",
  "```js\nlet a\n\nlet b\n```",
  "Real paragraph two that is also long enough.",
  "© 2026 Footer text"].join('\n\n')

const CHALLENGE = '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=x"></head><body></body></html>'
const withFetch = async (impl: () => Response, fn: () => Promise<void>) => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => impl()) as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = real
  }
}

async function cleanCheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

check('splitBlocks keeps fenced code (with blank lines) as ONE block', () => {
  const b = splitBlocks(MDDOC)
  assert(b.length === 7, `got ${b.length}: ${JSON.stringify(b)}`)
  assert(b[4]!.startsWith('```js') && b[4]!.includes('let b'), b[4]!)
})

check('parseDrop: tolerant of shapes, ignores head/out-of-range/garbage', () => {
  assert([...(parseDrop('sure: {"drop":[2,"6",99,-1,0,1,"x"]}', 7) ?? [])].join() === '2,6', 'string reply')
  assert([...(parseDrop({ response: { drop: [3] } }, 7) ?? [])].join() === '3', 'object reply')
  assert(parseDrop('no json here', 7) === null, 'no json')
  assert(parseDrop('{"nope":1}', 7) === null, 'wrong shape')
})

await cleanCheck('clipUrl: a bot-check interstitial falls back to the browser renderer, once', async () => {
  let renders = 0
  await withFetch(() => new Response(CHALLENGE, { status: 202, headers: { 'content-type': 'text/html' } }), async () => {
    const c = await clipUrl('https://guarded.example.com/a', undefined, async (u) => {
      renders++
      return { html: PAGE, url: u }
    })
    assert(c.title === 'A Great Article' && renders === 1, `title=${c.title} renders=${renders}`)
  })
})

await cleanCheck('clipUrl: no renderer → the plain error; a fine page never touches the renderer', async () => {
  await withFetch(() => new Response(CHALLENGE, { status: 202, headers: { 'content-type': 'text/html' } }), async () => {
    let msg = ''
    try { await clipUrl('https://guarded.example.com/a') } catch (e) { msg = (e as Error).message }
    assert(/bot-check/.test(msg), msg)
  })
  let renders = 0
  await withFetch(() => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
    await clipUrl('https://fine.example.com/a', undefined, async (u) => { renders++; return { html: '', url: u } })
    assert(renders === 0, 'renderer used unnecessarily')
  })
})

await cleanCheck('clipUrl: challenge that persists in the browser is reported with the upload-it-yourself hint', async () => {
  await withFetch(() => new Response('blocked', { status: 403 }), async () => {
    let msg = ''
    try { await clipUrl('https://wall.example.com/a', undefined, async (u) => ({ html: CHALLENGE, url: u })) } catch (e) { msg = (e as Error).message }
    assert(/captcha/.test(msg) && /upload/.test(msg), msg)
  })
})

await cleanCheck('aiCleanClip removes only the named blocks, deterministically', async () => {
  const ai = { run: async () => ({ response: '{"drop":[2,6]}' }) }
  const r = await aiCleanClip(ai, MDDOC)
  assert(r.dropped === 2, `dropped ${r.dropped}`)
  assert(!r.md.includes('€') && !r.md.includes('Footer'), r.md)
  assert(r.md.includes('let a\n\nlet b') &&r.md.includes('Real paragraph two'), 'content lost')
})

await cleanCheck('aiCleanClip falls back to the input on: no binding, error, hang, junk, or a mass-delete answer', async () => {
  assert((await aiCleanClip(undefined, MDDOC)).md === MDDOC, 'no binding')
  assert((await aiCleanClip({ run: async () => { throw new Error('quota') } }, MDDOC)).md === MDDOC, 'error')
  assert((await aiCleanClip({ run: async () => 'lol' }, MDDOC)).md === MDDOC, 'junk')
  assert((await aiCleanClip({ run: async () => ({ response: '{"drop":[2,3,4,5,6]}' }) }, MDDOC)).md === MDDOC, 'drop-everything must be rejected')
})

console.log('')
if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
