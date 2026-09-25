// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Markdown → HTML for 'md' decks (store.ts's DeckKind). A deliberately
// small, zero-dependency CommonMark/GFM subset — headings (ATX + setext),
// paragraphs, emphasis/strong/strikethrough, code spans + fenced/indented
// code, block quotes, nested bullet/ordered/task lists, GFM tables, hard
// breaks, thematic breaks, inline links/images/autolinks, YAML front
// matter (only `title:` is read). Same zero-external-dependency ethos as
// the rest of the repo (own charts engine, hand-drawn icons), and small
// enough to be safe by construction rather than by a separate sanitizer:
//
//   - RAW HTML IS NEVER PASSED THROUGH. Every `<`, `>`, `&`, `"` in the
//     source is escaped, so `<script>` in a markdown file renders as
//     visible text. (A markdown deck can't embed a map or a widget — that
//     is what an 'html' deck is for.)
//   - link/image URLs are allow-listed by scheme (http, https, mailto,
//     tel, fragments, relative paths); `javascript:`/`data:`/`vbscript:`
//     and anything else render as plain text instead of a link.
//   - a fence's language tag is reduced to [A-Za-z0-9_-] before it lands
//     in a class attribute.
//
// Not supported (renders as literal text, never breaks the page): reference
// links/definitions, footnotes, raw HTML blocks, setext headings inside
// list items, lazy block-quote continuation edge cases. Images must be
// absolute URLs — an 'md' deck has no asset store of its own.
//
// The result is served through the SAME sandboxed-iframe wrapper as an
// 'html' deck (index.ts's htmlDeckWrapper) — defense in depth in case this
// file ever has a hole — and rendered to PDF through the same html path.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ESC[c]!)

// ——— URLs

const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/|[^:]*$)/i

/** Returns an attribute-safe (already-escaped) URL, or null when the scheme
 *  isn't on the allow-list. Input is the RAW source text of the URL. */
function safeUrl(raw: string): string | null {
  const url = raw.trim().replace(/^<|>$/g, '')
  if (!url) return null
  // strip control chars/whitespace browsers ignore inside schemes ("java\tscript:")
  const probe = url.replace(/[\u0000- \u007f-\u009f]/g, '')
  if (!SAFE_URL.test(probe)) return null
  return escapeHtml(url)
}

// ——— inline

const TOKEN = /\u0000(\d+)\u0000/g

/** Render inline markdown (already a single logical line-run: paragraph,
 *  heading text, table cell). */
export function renderInline(src: string): string {
  const stash: string[] = []
  const hold = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`
  let s = src.replace(/\u0000/g, '')

  // code spans — longest-run matching, contents escaped verbatim
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, body: string) => {
    let code = body.replace(/\n/g, ' ')
    if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1)
    return hold(`<code>${escapeHtml(code)}</code>`)
  })
  // backslash escapes
  s = s.replace(/\\([!-\/:-@\[-`{-~])/g, (_m, ch: string) => hold(escapeHtml(ch)))
  // <https://…> / <mailto:…> autolinks (before the text is escaped)
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_m, url: string) => {
    const href = safeUrl(url)
    return href ? hold(`<a href="${href}" rel="noopener noreferrer">${escapeHtml(url)}</a>`) : escapeHtml(_m)
  })

  s = escapeHtml(s)

  // hard line breaks (two trailing spaces, or a trailing backslash)
  s = s.replace(/(?: {2,}|\\)\n/g, () => hold('<br>\n'))

  // images, then links. URL body: <…> or a run without whitespace/`)`;
  // one level of balanced parens is allowed (wikipedia-style urls).
  const URL_BODY = '(<[^>\\n]*>|(?:[^\\s()]|\\([^\\s()]*\\))+)'
  const TITLE = '(?:\\s+&quot;([^\\n]*?)&quot;)?'
  s = s.replace(new RegExp(`!\\[([^\\]]*)\\]\\(\\s*${URL_BODY}${TITLE}\\s*\\)`, 'g'), (m, alt: string, url: string, title?: string) => {
    const src2 = safeUrl(unescapeBasic(url))
    if (!src2 || /^(?:mailto:|tel:|#)/i.test(src2)) return m
    const plainAlt = alt.replace(TOKEN, '')
    return hold(`<img src="${src2}" alt="${plainAlt}"${title ? ` title="${title}"` : ''} loading="lazy">`)
  })
  s = s.replace(new RegExp(`\\[([^\\]]+)\\]\\(\\s*${URL_BODY}${TITLE}\\s*\\)`, 'g'), (m, text: string, url: string, title?: string) => {
    const href = safeUrl(unescapeBasic(url))
    if (!href) return m
    const open = hold(`<a href="${href}"${title ? ` title="${title}"` : ''} rel="noopener noreferrer">`)
    return `${open}${text}${hold('</a>')}`
  })

  // bare-URL autolinks (GFM)
  s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<]+[^\s<.,;:!?'"')\]])/g, (_m, lead: string, url: string) => {
    const href = safeUrl(unescapeBasic(url))
    return href ? `${lead}${hold(`<a href="${href}" rel="noopener noreferrer">${url}</a>`)}` : _m
  })

  // emphasis. Underscores only count at word boundaries (snake_case_names
  // stay literal); asterisks may sit mid-word, as in CJK text.
  s = s
    .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![A-Za-z0-9_])__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9_])/g, '<strong>$1</strong>')
    .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '<em>$1</em>')
    .replace(/(?<![A-Za-z0-9_])_(?=\S)([^_\n]+?)(?<=\S)_(?![A-Za-z0-9_])/g, '<em>$1</em>')
    .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>')

  return s.replace(TOKEN, (_m, i: string) => stash[Number(i)]!)
}

/** The url text was already HTML-escaped; safeUrl() escapes again, so undo
 *  the one layer first (only the four entities escapeHtml produces). */
function unescapeBasic(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

// ——— blocks

interface Ctx {
  /** heading slug → count, for unique ids */
  slugs: Map<string, number>
  headings: Array<{ level: number; text: string; id: string }>
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const BULLET = /^( {0,3})([-*+])([ \t]+|$)/
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/
const QUOTE = /^ {0,3}>/
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

function slugify(text: string, ctx: Ctx): string {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  const n = ctx.slugs.get(base) ?? 0
  ctx.slugs.set(base, n + 1)
  return n === 0 ? base : `${base}-${n}`
}

function splitRow(line: string): string[] {
  let l = line.trim()
  if (l.startsWith('|')) l = l.slice(1)
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '\\' && l[i + 1] === '|') { cur += '|'; i++ }
    else if (l[i] === '|') { cells.push(cur.trim()); cur = '' }
    else cur += l[i]
  }
  cells.push(cur.trim())
  return cells
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) ||
    BULLET.test(line) || /^ {0,3}1[.)]([ \t]+|$)/.test(line)
  )
}

function leadingSpaces(l: string): number {
  return l.length - l.trimStart().length
}

function renderBlocks(lines: string[], ctx: Ctx, tight = false): string {
  const out: string[] = []
  let i = 0
  const paragraph = (text: string) => (tight ? renderInline(text) : `<p>${renderInline(text)}</p>`)

  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }

    // fenced code
    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1]!
      const lang = (fence[2] ?? '').replace(/[^A-Za-z0-9_-]/g, '')
      const indent = leadingSpaces(line)
      const body: string[] = []
      i++
      while (i < lines.length) {
        const l = lines[i]!
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l)
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) { i++; break }
        body.push(l.replace(new RegExp(`^ {0,${indent}}`), ''))
        i++
      }
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(body.join('\n'))}\n</code></pre>`)
      continue
    }

    // ATX heading
    const atx = ATX.exec(line)
    if (atx) {
      const level = atx[1]!.length
      const text = (atx[2] ?? '').trim()
      const id = slugify(text, ctx)
      ctx.headings.push({ level, text, id })
      out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(text)}</h${level}>`)
      i++
      continue
    }

    if (HR.test(line)) { out.push('<hr>'); i++; continue }

    // block quote
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && lines[i]!.trim() && (QUOTE.test(lines[i]!) || !startsBlock(lines[i]!))) {
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ''))
        i++
      }
      out.push(`<blockquote>\n${renderBlocks(inner, ctx)}\n</blockquote>`)
      continue
    }

    // GFM table
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = splitRow(line)
      const delim = splitRow(lines[i + 1]!)
      if (head.length === delim.length) {
        const align = delim.map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : ''))
        const cell = (tag: string, text: string, k: number) =>
          `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${renderInline(text)}</${tag}>`
        const rows: string[] = []
        i += 2
        while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|') && !startsBlock(lines[i]!)) {
          const cells = splitRow(lines[i]!)
          rows.push(`<tr>${align.map((_a, k) => cell('td', cells[k] ?? '', k)).join('')}</tr>`)
          i++
        }
        out.push(
          `<div class="tablewrap"><table>\n<thead><tr>${head.map((h, k) => cell('th', h, k)).join('')}</tr></thead>\n` +
            `<tbody>\n${rows.join('\n')}\n</tbody></table></div>`,
        )
        continue
      }
    }

    // lists
    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet || ordered) {
      i = renderList(lines, i, ctx, out)
      continue
    }

    // indented code (not inside a paragraph)
    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = []
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]!) || !lines[i]!.trim())) {
        body.push(lines[i]!.replace(/^( {4}|\t)/, ''))
        i++
      }
      while (body.length && !body[body.length - 1]!.trim()) body.pop()
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}\n</code></pre>`)
      continue
    }

    // paragraph (with setext-heading detection)
    const para: string[] = [line]
    i++
    let setext = 0
    while (i < lines.length && lines[i]!.trim()) {
      const l = lines[i]!
      if (/^ {0,3}=+[ \t]*$/.test(l)) { setext = 1; i++; break }
      if (/^ {0,3}-+[ \t]*$/.test(l)) { setext = 2; i++; break }
      if (startsBlock(l)) break
      if (l.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) break
      para.push(l)
      i++
    }
    const text = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '')
    if (setext) {
      const id = slugify(text, ctx)
      ctx.headings.push({ level: setext, text, id })
      out.push(`<h${setext} id="${escapeHtml(id)}">${renderInline(text)}</h${setext}>`)
    } else {
      out.push(paragraph(text))
    }
  }
  return out.join('\n')
}

/** Renders one list starting at lines[start]; returns the next line index. */
function renderList(lines: string[], start: number, ctx: Ctx, out: string[]): number {
  const first = lines[start]!
  const isOrdered = ORDERED.test(first) && !BULLET.test(first)
  const marker = (isOrdered ? ORDERED : BULLET).exec(first)!
  const startNum = isOrdered ? Number(marker[2]) : 1
  const sameKind = (l: string) => (isOrdered ? ORDERED.test(l) : BULLET.test(l) && !HR.test(l))

  const items: string[][] = []
  let loose = false
  let i = start
  while (i < lines.length) {
    const line = lines[i]!
    const m = (isOrdered ? ORDERED : BULLET).exec(line)
    if (!m || (!isOrdered && HR.test(line))) break
    // content column = marker width + the spaces after it (1–4; more than
    // that means the item starts with an indented code block, which we
    // simply treat as a single space)
    const markerW = m[1]!.length + (isOrdered ? m[2]!.length + 1 : 1)
    const gapLen = m[0].length - markerW
    const contentCol = markerW + (gapLen >= 1 && gapLen <= 4 ? gapLen : 1)
    const item: string[] = [line.slice(contentCol)]
    i++
    let blankRun = false
    while (i < lines.length) {
      const l = lines[i]!
      if (!l.trim()) { blankRun = true; item.push(''); i++; continue }
      if (leadingSpaces(l) >= contentCol) {
        if (blankRun) loose = true
        blankRun = false
        item.push(l.slice(contentCol))
        i++
        continue
      }
      // a sibling marker ends this item (with blanks before it → loose list)
      if (sameKind(l) && leadingSpaces(l) < contentCol) { if (blankRun) loose = true; break }
      if (blankRun || startsBlock(l) || TABLE_DELIM.test(l)) break
      item.push(l.replace(/^[ \t]+/, '')) // lazy paragraph continuation
      i++
    }
    while (item.length && !item[item.length - 1]!.trim()) item.pop()
    items.push(item)
  }

  const tag = isOrdered ? 'ol' : 'ul'
  const rendered = items.map((item) => {
    let task = ''
    const head = /^\[([ xX])\][ \t]+/.exec(item[0] ?? '')
    if (head) {
      task = `<input type="checkbox" disabled${head[1] !== ' ' ? ' checked' : ''}> `
      item = [item[0]!.slice(head[0].length), ...item.slice(1)]
    }
    return `<li${task ? ' class="task"' : ''}>${task}${renderBlocks(item, ctx, !loose)}</li>`
  })
  out.push(`<${tag}${isOrdered && startNum !== 1 ? ` start="${startNum}"` : ''}>\n${rendered.join('\n')}\n</${tag}>`)
  return i
}

// ——— front matter, title, page

interface Parsed {
  body: string
  frontTitle: string | null
}

function parseFrontMatter(md: string): Parsed {
  const text = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text)
  if (!m) return { body: text, frontTitle: null }
  const t = /^title:[ \t]*(.+)$/m.exec(m[1]!)
  const frontTitle = t ? t[1]!.trim().replace(/^(['"])(.*)\1$/, '$2') : null
  return { body: text.slice(m[0].length), frontTitle: frontTitle || null }
}

const plain = (s: string): string =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Deck title: front-matter `title:`, else the first heading, else the first
 *  non-empty line (truncated), else 'Untitled deck'. */
export function extractMdTitle(md: string): string {
  const { body, frontTitle } = parseFrontMatter(md)
  if (frontTitle) return frontTitle.slice(0, 200)
  let inFence = false
  let firstLine = ''
  for (const line of body.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const h = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (h) return plain(h[1]!).slice(0, 200) || 'Untitled deck'
    if (!firstLine && line.trim()) firstLine = line.trim()
  }
  return firstLine ? plain(firstLine).slice(0, 80) || 'Untitled deck' : 'Untitled deck'
}

/** Body HTML only (no page chrome) — exported for tests. */
export function renderMarkdown(md: string): string {
  const { body } = parseFrontMatter(md)
  const ctx: Ctx = { slugs: new Map(), headings: [] }
  return renderBlocks(body.replace(/\t/g, '    ').split('\n'), ctx)
}

const PAGE_CSS = `
:root{--bg:#fff;--fg:#1c2230;--muted:#5a6172;--line:#d8dbe2;--soft:#f4f5f8;--accent:#2b3a8c;--code-bg:#f1f2f6}
@media (prefers-color-scheme:dark){:root{--bg:#14171f;--fg:#e6e8ee;--muted:#a3a9b8;--line:#2e3342;--soft:#1b1f29;--accent:#9aa6ff;--code-bg:#1b1f29}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:780px;margin:0 auto;padding:48px 24px 96px}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.8em 0 .6em;font-weight:700}
h1{font-size:2em;margin-top:0;padding-bottom:.3em;border-bottom:1px solid var(--line)}
h2{font-size:1.5em;padding-bottom:.25em;border-bottom:1px solid var(--line)}
h3{font-size:1.25em}h4{font-size:1.05em}h5,h6{font-size:1em;color:var(--muted)}
p,ul,ol,pre,blockquote,.tablewrap{margin:0 0 1em}
a{color:var(--accent)}
ul,ol{padding-left:1.6em}li{margin:.25em 0}li>ul,li>ol{margin:.25em 0}
li.task{list-style:none;margin-left:-1.3em}li.task input{margin-right:.5em}
blockquote{margin-left:0;padding:.1em 1em;border-left:4px solid var(--line);color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
code{font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code-bg);padding:.15em .35em;border-radius:4px}
pre{background:var(--code-bg);padding:14px 16px;border-radius:8px;overflow:auto;line-height:1.5}
pre code{background:none;padding:0;font-size:.88em}
img{max-width:100%;height:auto}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.95em}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--soft);font-weight:700}
del{color:var(--muted)}
@media print{
  :root{--bg:#fff;--fg:#000;--muted:#333;--line:#bbb;--soft:#eee;--accent:#000;--code-bg:#f2f2f2}
  body{font-size:11pt}
  main{max-width:none;padding:0}
  a{text-decoration:none}
  h1,h2,h3,h4{break-after:avoid}
  pre,blockquote,img,tr,li{break-inside:avoid}
  pre{white-space:pre-wrap;overflow:visible}
  .tablewrap{overflow:visible}
}`

/** A complete, self-contained HTML document for an 'md' deck. */
export function renderMdPage(md: string): string {
  const title = extractMdTitle(md)
  const body = renderMarkdown(md)
  const lang = /[぀-ヿ㐀-鿿가-힯]/.test(md) ? 'zh' : 'en'
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head><body><main>
${body}
</main></body></html>`
}
