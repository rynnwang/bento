// Limited in-place text editing for 'html' and 'md' decks.
//
// The rule (from the product owner): editing may change the TEXT inside one
// element — plus simple bold/italic-style formatting — but never the structure
// around it. So an edit is a splice of ONE element's inner content in the stored
// source; nothing else is ever re-serialized, and the original bytes outside the
// splice are untouched (an HTML deck's scripts/CSS/layout survive verbatim).
//
// The browser reports which element it edited as (tag, its old text, and which
// of the same-tag-same-text elements it was). The server re-finds that element in
// the SOURCE by text — it never trusts client offsets — and validates the new
// inner HTML: only plain formatting tags (no attributes, so no colours/styles/
// scripts/handlers) or tags that already existed inside that element, byte-for-
// attribute identical. Anything else is rejected, not sanitized-and-hoped.
//
// Elements whose text is produced by page script don't exist in the source, so
// they cannot be found and are refused with an explanation.

import { parseHtml, decodeEntities, type El, type Node } from './webclip.ts'
import { renderInline } from './markdown.ts'

export class EditError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface TextEdit {
  tag: string
  /** normText() of the element's text BEFORE the edit, as the browser saw it */
  oldText: string
  /** which of the same-tag, same-old-text elements (document order) was edited */
  nth: number
  /** the element's new inner HTML (browser-side cleaned; re-validated here) */
  html: string
}

const MAX_FRAGMENT = 200_000
const FORMAT_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'br'])
const VOID_TAGS = new Set(['br', 'img', 'wbr', 'hr'])
/** Tags a leaf text element may contain (mirrors the browser-side eligibility test). */
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'br', 'cite', 'code', 'del', 'em', 'i', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'wbr'])
const HTML_EDITABLE = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'dt', 'dd', 'figcaption', 'caption', 'summary', 'blockquote', 'div', 'span'])
const MD_EDITABLE = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li'])

export const normText = (s: string): string => s.replace(/[\s ]+/g, ' ').trim()

const isEl = (n: Node): n is El => typeof n !== 'string'

function plainText(n: Node): string {
  if (!isEl(n)) return decodeEntities(n)
  if (n.tag === 'script' || n.tag === 'style') return ''
  return n.kids.map(plainText).join('')
}

const attrSig = (e: El): string =>
  e.tag + '|' + Object.entries(e.attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')

function* descendants(e: El): Generator<El> {
  for (const k of e.kids) {
    if (isEl(k)) {
      yield k
      yield* descendants(k)
    }
  }
}

function checkFragmentShape(frag: string): void {
  if (frag.length > MAX_FRAGMENT) throw new EditError('That text is too long to save as an edit.', 413)
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
  const stack: string[] = []
  let last = 0
  let rest = ''
  for (let m = tagRe.exec(frag); m; m = tagRe.exec(frag)) {
    rest += frag.slice(last, m.index)
    last = m.index + m[0].length
    const closing = m[1] === '/'
    const tag = m[2]!.toLowerCase()
    if (m[3]!.includes('<')) throw new EditError('Unsupported markup in the edited text.', 422)
    if (closing) {
      if (VOID_TAGS.has(tag) || stack.pop() !== tag) throw new EditError('Unbalanced tags in the edited text.', 422)
    } else if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(m[3]!)) stack.push(tag)
  }
  rest += frag.slice(last)
  if (stack.length) throw new EditError('Unbalanced tags in the edited text.', 422)
  if (/<[a-zA-Z/!?]/.test(rest)) throw new EditError('Unsupported markup in the edited text.', 422)
}

/** Validate a new inner-HTML fragment against the tags the element already had. */
export function validateFragment(frag: string, known: Set<string>): El {
  checkFragmentShape(frag)
  const root = parseHtml(frag)
  for (const e of descendants(root)) {
    const noAttrs = Object.keys(e.attrs).length === 0
    if (known.has(attrSig(e)) || (FORMAT_TAGS.has(e.tag) && noAttrs)) continue
    throw new EditError(`Only text and simple bold/italic formatting can be edited here (found <${e.tag}>).`, 422)
  }
  return root
}

// ---------------------------------------------------------------- HTML decks

export function applyHtmlTextEdit(src: string, edit: TextEdit): string {
  const tag = edit.tag.toLowerCase()
  if (!HTML_EDITABLE.has(tag)) throw new EditError(`<${tag}> elements can't be edited here.`, 422)
  const root = parseHtml(src)
  const found: El[] = []
  const visit = (e: El) => {
    for (const k of e.kids) {
      if (!isEl(k)) continue
      if (k.tag === tag && k.oe !== undefined && k.ce !== undefined && normText(plainText(k)) === edit.oldText) found.push(k)
      visit(k)
    }
  }
  visit(root)
  const el = found[edit.nth]
  if (!el) {
    throw new EditError("Couldn't find that text in the page's source — it is probably generated by the page's own script, so it can't be edited here.", 422)
  }
  const kidsOk = [...descendants(el)].every((d) => INLINE_TAGS.has(d.tag))
  if (!kidsOk) throw new EditError('That element contains other elements (not just text), so it can\'t be edited here.', 422)
  const known = new Set([...descendants(el)].map(attrSig))
  const frag = validateFragment(edit.html, known)
  if (!normText(plainText(frag))) throw new EditError("Text can't be empty.", 422)
  return src.slice(0, el.oe!) + edit.html + src.slice(el.ce!)
}

// ---------------------------------------------------------------- Markdown decks

const mdEscape = (s: string): string => s.replace(/[\\`*_[\]<>~|]/g, '\\$&')

function wrapMark(inner: string, mark: string): string {
  const lead = /^\s*/.exec(inner)![0]
  const trail = /\s*$/.exec(inner)![0]
  const core = inner.trim()
  return core ? `${lead}${mark}${core}${mark}${trail}` : inner
}

const mdUrl = (u: string): string => u.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')

/** Inner HTML (already validated) -> a single inline-Markdown string. */
export function fragmentToInlineMd(frag: string): string {
  const conv = (nodes: Node[]): string =>
    nodes
      .map((n) => {
        if (!isEl(n)) return mdEscape(decodeEntities(n).replace(/ /g, ' '))
        switch (n.tag) {
          case 'br': return '  \n'
          case 'b': case 'strong': return wrapMark(conv(n.kids), '**')
          case 'i': case 'em': return wrapMark(conv(n.kids), '*')
          case 's': case 'del': return wrapMark(conv(n.kids), '~~')
          case 'code': {
            const t = plainText(n)
            const fence = '`'.repeat((Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length)) || 0) + 1)
            return `${fence}${t.startsWith('`') || t.endsWith('`') ? ` ${t} ` : t}${fence}`
          }
          case 'a': {
            const href = n.attrs.href
            const inner = conv(n.kids)
            return href && inner ? `[${inner}](${mdUrl(href)})` : inner
          }
          default: return conv(n.kids)
        }
      })
      .join('')
  return conv(parseHtml(frag).kids)
}

interface Unit {
  tag: string
  from: number // first line
  to: number // exclusive
  /** what stays in front of the editable text on its first line (indent, "- ", "## ") */
  lead: string
  /** the inline-markdown text (lines joined with \n, block prefixes stripped) */
  text: string
  editable: boolean
}

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/
const RE_ATX = /^( {0,3})(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const RE_LI = /^(\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)(.*)$/
const RE_QUOTE = /^ {0,3}>/
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const isTableLine = (l: string): boolean => l.includes('|') && l.trim() !== ''
const isBlockStart = (l: string): boolean => RE_ATX.test(l) || RE_LI.test(l) || RE_QUOTE.test(l) || RE_FENCE.test(l) || RE_HR.test(l)

function scanUnits(lines: string[]): Unit[] {
  const units: Unit[] = []
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }
    const f = RE_FENCE.exec(line)
    if (f) {
      const fence = f[1]!
      i++
      while (i < n && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i]!)) i++
      i++
      continue
    }
    const atx = RE_ATX.exec(line)
    if (atx) {
      units.push({ tag: `h${atx[2]!.length}`, from: i, to: i + 1, lead: `${atx[1]}${atx[2]} `, text: atx[3]!, editable: true })
      i++
      continue
    }
    if (RE_HR.test(line)) { i++; continue }
    if (RE_QUOTE.test(line)) {
      const from = i
      while (i < n && RE_QUOTE.test(lines[i]!)) i++
      const qtext = lines.slice(from, i).map((l) => l.replace(/^ {0,3}(?:>[ \t]?)+/, '')).join('\n')
      units.push({ tag: 'p', from, to: i, lead: '', text: qtext, editable: false })
      continue
    }
    const li = RE_LI.exec(line)
    if (li) {
      const next = lines[i + 1]
      const single = next === undefined || !next.trim() || isBlockStart(next)
      units.push({ tag: 'li', from: i, to: i + 1, lead: li[1]!, text: li[2]!, editable: single })
      i++
      continue
    }
    if (isTableLine(line) && isTableLine(lines[i + 1] ?? '')) {
      // GFM table: header + delimiter + rows — consume the whole run, edit none of it
      while (i < n && isTableLine(lines[i]!)) i++
      continue
    }
    if (/^ {4,}/.test(line) && (i === 0 || !lines[i - 1]!.trim())) { i++; continue } // indented code
    // paragraph (possibly a setext heading, which we count but do not edit)
    const from = i
    const lead = /^\s*/.exec(line)![0]
    const body: string[] = []
    while (i < n && lines[i]!.trim() && (i === from || !isBlockStart(lines[i]!)) && !(i > from && isTableLine(lines[i]!) && isTableLine(lines[i + 1] ?? ''))) {
      body.push(lines[i]!.replace(/^\s+/, ''))
      i++
      if (i < n && RE_SETEXT.test(lines[i]!)) break
    }
    if (i < n && RE_SETEXT.test(lines[i]!)) {
      i++
      units.push({ tag: /^ {0,3}=/.test(lines[i - 1]!) ? 'h1' : 'h2', from, to: i, lead, text: body.join('\n'), editable: false })
      continue
    }
    units.push({ tag: 'p', from, to: i, lead, text: body.join('\n'), editable: true })
  }
  return units
}

const htmlToPlain = (html: string): string => normText(decodeEntities(html.replace(/<[^>]*>/g, '')))

/** Returns the new Markdown source. Line endings are normalized to \n. */
export function applyMdTextEdit(mdIn: string, edit: TextEdit): { md: string; oldInnerHtml: string } {
  const tag = edit.tag.toLowerCase()
  if (!MD_EDITABLE.has(tag)) throw new EditError("In a Markdown deck only headings, paragraphs and list items can be edited (not table cells or quotes).", 422)
  const bom = mdIn.startsWith('﻿') ? '﻿' : ''
  const text = mdIn.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  // skip front matter, exactly as markdown.ts does
  const fm = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text)
  const head = fm ? fm[0] : ''
  const lines = text.slice(head.length).split('\n')
  const units = scanUnits(lines)

  // every unit (editable or not) takes part in the ordinal, so an identical
  // paragraph inside a quote can never be mistaken for the one being edited
  const unit = units.filter((u) => u.tag === tag && htmlToPlain(renderInline(u.text)) === edit.oldText)[edit.nth]
  if (!unit) throw new EditError("Couldn't find that text in the Markdown source.", 422)
  if (!unit.editable) throw new EditError("That block (quote or underlined heading) can't be edited here.", 422)

  const oldInner = renderInline(unit.text)
  const known = new Set([...descendants(parseHtml(oldInner))].map(attrSig))
  const frag = validateFragment(edit.html, known)
  if (!normText(plainText(frag))) throw new EditError("Text can't be empty.", 422)

  let md1 = fragmentToInlineMd(edit.html)
  const multiline = unit.tag === 'p'
  if (!multiline) md1 = md1.replace(/ *\n */g, ' ')
  md1 = md1.replace(/^\s+|\s+$/g, '')
  if (!md1) throw new EditError("Text can't be empty.", 422)
  if (multiline) md1 = md1.replace(/^(#{1,6}\s|[>+-]\s|\d+[.)]\s|={3,}|-{3,}|`{3,}|~{3,})/, '\\$1')
  const newLines = multiline ? md1.split('\n').map((l) => unit.lead + l) : [unit.lead + md1]
  const out = [...lines.slice(0, unit.from), ...newLines, ...lines.slice(unit.to)]
  return { md: bom + head + out.join('\n'), oldInnerHtml: oldInner }
}
