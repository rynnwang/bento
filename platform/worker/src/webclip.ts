// Web clipper: URL -> Markdown. Pure functions (no I/O) except `clipUrl`,
// which does the (guarded) fetch. Workers have no DOM, so this carries its own
// small lenient HTML tokenizer/tree builder, a Readability-style main-content
// pick, and an HTML->Markdown converter that emits exactly the subset
// `markdown.ts` renders. Images and links are kept ONLINE (absolute URLs).
//
// Best-effort by design: pages that build their content with client-side JS
// (SPAs) arrive nearly empty — reported as an error, never as a blank deck.

// ---------------------------------------------------------------- tree

interface El {
  tag: string
  attrs: Record<string, string>
  kids: Node[]
  parent: El | null
}
type Node = El | string

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template'])
/** Opening one of the keys implicitly closes an open element in the value set
 *  (nearest ancestor only, and only inside the same list/table/paragraph). */
const IMPLIED_CLOSE: Record<string, string[]> = {
  li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'],
  option: ['option'], thead: ['tbody', 'thead'], tbody: ['thead', 'tbody'],
}
const BLOCKY = new Set(['div', 'ul', 'ol', 'table', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'section', 'article', 'p', 'figure', 'form'])
const MAX_NODES = 300_000
const MAX_DEPTH = 256

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•',
  middot: '·', times: '×', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', larr: '←', rarr: '→',
}
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ''
      return String.fromCodePoint(n)
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function parseHtml(src: string): El {
  const root: El = { tag: '#root', attrs: {}, kids: [], parent: null }
  let cur = root
  let depth = 0
  let count = 0
  let i = 0
  const n = src.length
  const text = (t: string) => {
    if (t) cur.kids.push(t)
  }
  while (i < n && count < MAX_NODES) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      text(src.slice(i))
      break
    }
    if (lt > i) text(src.slice(i, lt))
    i = lt
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      const end = src.indexOf('>', i)
      i = end < 0 ? n : end + 1
      continue
    }
    const close = /^<\/([a-zA-Z][^\s>/]*)[^>]*>/.exec(src.slice(i, i + 200))
    if (close) {
      const tag = close[1]!.toLowerCase()
      i += close[0].length
      // pop to the nearest matching open ancestor; a stray end tag is ignored
      let p: El | null = cur
      while (p && p.tag !== tag) p = p.parent
      if (p && p.parent) {
        cur = p.parent
        depth = depthOf(cur)
      }
      continue
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(i, i + 64))
    if (!m) {
      text('<')
      i++
      continue
    }
    const tag = m[1]!.toLowerCase()
    let j = i + m[0].length
    const attrs: Record<string, string> = {}
    // attribute scan (quotes may contain '>')
    for (;;) {
      while (j < n && /\s/.test(src[j]!)) j++
      if (j >= n) break
      if (src[j] === '>') { j++; break }
      if (src[j] === '/' ) { j++; continue }
      const a = /^([^\s=>/]+)/.exec(src.slice(j, j + 200))
      if (!a) { j++; continue }
      const name = a[1]!.toLowerCase()
      j += a[1]!.length
      while (j < n && /\s/.test(src[j]!)) j++
      let val = ''
      if (src[j] === '=') {
        j++
        while (j < n && /\s/.test(src[j]!)) j++
        const q = src[j]
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1)
          val = src.slice(j + 1, end < 0 ? n : end)
          j = end < 0 ? n : end + 1
        } else {
          const v = /^[^\s>]*/.exec(src.slice(j, j + 4000))![0]
          val = v
          j += v.length
        }
      }
      if (!(name in attrs)) attrs[name] = decodeEntities(val)
    }
    i = j
    count++
    // implied closes
    const closes = IMPLIED_CLOSE[tag]
    if (closes) {
      let p: El | null = cur
      while (p && p.parent && !closes.includes(p.tag) && !['ul', 'ol', 'table', 'dl', 'select', '#root'].includes(p.tag)) p = p.parent
      if (p && closes.includes(p.tag) && p.parent) cur = p.parent
    } else if (BLOCKY.has(tag) && cur.tag === 'p') {
      cur = cur.parent ?? cur
    }
    const el: El = { tag, attrs, kids: [], parent: cur }
    cur.kids.push(el)
    if (VOID.has(tag)) continue
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, 'gi')
      re.lastIndex = i
      const mm = re.exec(src)
      const body = src.slice(i, mm ? mm.index : n)
      if (tag !== 'script' && tag !== 'style' && tag !== 'template' && tag !== 'noscript') el.kids.push(body)
      i = mm ? mm.index + mm[0].length : n
      continue
    }
    if (depth < MAX_DEPTH) {
      cur = el
      depth++
    }
  }
  return root
}
function depthOf(e: El): number {
  let d = 0
  for (let p = e.parent; p; p = p.parent) d++
  return d
}

// ---------------------------------------------------------------- helpers

const isEl = (n: Node): n is El => typeof n !== 'string'
function textOf(n: Node): string {
  if (!isEl(n)) return decodeEntities(n)
  if (NOISE_TAGS.has(n.tag)) return ''
  return n.kids.map(textOf).join('')
}
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

const NOISE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'form', 'button', 'select', 'input', 'textarea', 'nav', 'footer', 'aside', 'dialog', 'object', 'embed', 'audio', 'video', 'map', 'menu'])
const NOISE_RE = /(^|[\s_-])(comment|comments|sidebar|side-bar|footer|nav|navbar|navigation|menu|breadcrumb|share|sharing|social|promo|advert|ads?|sponsor|cookie|consent|popup|modal|newsletter|subscribe|related|recommend|toolbar|skip-link|paywall|banner|editsection|navbox|catlinks|printfooter|interlanguage|mw-jump|toc)([\s_-]|$)/i

function isNoise(e: El): boolean {
  if (NOISE_TAGS.has(e.tag)) return true
  if (e.attrs.hidden !== undefined || e.attrs['aria-hidden'] === 'true') return true
  if (/display\s*:\s*none/i.test(e.attrs.style ?? '')) return true
  if (e.tag === 'header' && !e.parent?.tag.match(/^(article|main|section)$/)) return true
  const role = e.attrs.role
  if (role && /^(navigation|banner|contentinfo|complementary|search|dialog)$/.test(role)) return true
  // page-level wrappers often carry state classes ("comment_feature", "menu-open")
  // that would veto the whole page — never judge them by class
  if (e.tag === 'body' || e.tag === 'html' || e.tag === 'main' || e.tag === 'article') return false
  const cls = `${e.attrs.class ?? ''} ${e.attrs.id ?? ''}`
  if (cls.trim() && NOISE_RE.test(cls) && !/(^|[\s_-])(article|content|post|entry|story|main|body)([\s_-]|$)/i.test(cls)) return true
  return false
}

function* walk(e: El): Generator<El> {
  for (const k of e.kids) {
    if (isEl(k)) {
      yield k
      yield* walk(k)
    }
  }
}
const find = (e: El, tag: string): El | null => {
  for (const x of walk(e)) if (x.tag === tag) return x
  return null
}

// ---------------------------------------------------------------- content pick

function linkTextLen(e: El): number {
  let n = 0
  for (const x of walk(e)) if (x.tag === 'a') n += collapse(textOf(x)).length
  return n
}

/** Readability-style: each substantial <p> credits its parent and grandparent
 *  with its text length; link-heavy containers are penalised. */
function pickContent(body: El): El {
  const arts = [...walk(body)].filter((e) => (e.tag === 'article' || e.tag === 'main' || e.attrs.role === 'main' || e.attrs.itemprop === 'articleBody') && !isNoise(e))
  const textLen = (e: El) => collapse(textOf(e)).length
  let best: El | null = null
  for (const a of arts) if (!best || textLen(a) > textLen(best)) best = a
  if (best && textLen(best) > 400) return best

  const scores = new Map<El, number>()
  for (const p of walk(body)) {
    if (p.tag !== 'p' && p.tag !== 'pre') continue
    let skip = false
    for (let q: El | null = p; q; q = q.parent) if (isNoise(q)) { skip = true; break }
    if (skip) continue
    const len = collapse(textOf(p)).length
    if (len < 25) continue
    const pts = 1 + Math.min(3, Math.floor(len / 100)) + (len > 0 ? Math.min(3, (collapse(textOf(p)).match(/[,，。.]/g) ?? []).length / 3) : 0)
    const parent = p.parent
    if (parent) {
      scores.set(parent, (scores.get(parent) ?? 0) + pts)
      if (parent.parent) scores.set(parent.parent, (scores.get(parent.parent) ?? 0) + pts / 2)
    }
  }
  let top: El | null = null
  let topScore = 0
  for (const [e, s] of scores) {
    const total = textLen(e)
    const density = total ? 1 - linkTextLen(e) / total : 0
    const adj = s * density
    if (adj > topScore) { topScore = adj; top = e }
  }
  return top ?? best ?? body
}

// ---------------------------------------------------------------- html -> md

interface Ctx { base: URL }

function absUrl(raw: string | undefined, ctx: Ctx): string | null {
  if (!raw) return null
  const t = raw.trim()
  if (!t) return null
  try {
    const u = new URL(t, ctx.base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch {
    return null
  }
}
const mdUrl = (u: string) => u.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/[<>]/g, (c) => (c === '<' ? '%3C' : '%3E'))
const escInline = (s: string) => s.replace(/[\\`*_\[\]<>~|]/g, '\\$&')

function firstSrcset(v: string | undefined): string | undefined {
  if (!v) return undefined
  const first = v.split(',')[0]?.trim().split(/\s+/)[0]
  return first || undefined
}
function imgSrc(e: El, ctx: Ctx): string | null {
  const cands = [e.attrs['data-src'], e.attrs['data-original'], e.attrs['data-lazy-src'], e.attrs.src, firstSrcset(e.attrs['data-srcset']), firstSrcset(e.attrs.srcset)]
  for (const c of cands) {
    if (c && !c.startsWith('data:')) {
      const a = absUrl(c, ctx)
      if (a) return a
    }
  }
  return null
}

function inline(nodes: Node[], ctx: Ctx, pre = false): string {
  let out = ''
  for (const n of nodes) {
    if (!isEl(n)) {
      const t = decodeEntities(n).replace(/ /g, ' ')
      out += pre ? t : escInline(t.replace(/\s+/g, ' '))
      continue
    }
    if (isNoise(n)) continue
    switch (n.tag) {
      case 'br': out += '  \n'; break
      case 'img': {
        const src = imgSrc(n, ctx)
        if (src) out += `![${escInline(collapse(decodeEntities(n.attrs.alt ?? '')))}](${mdUrl(src)})`
        break
      }
      case 'a': {
        const href = absUrl(n.attrs.href, ctx)
        const inner = inline(n.kids, ctx).trim()
        out += href && inner ? `[${inner}](${mdUrl(href)})` : inner
        break
      }
      case 'strong': case 'b': {
        const inner = inline(n.kids, ctx).trim()
        out += inner ? `**${inner}**` : ''
        break
      }
      case 'em': case 'i': case 'cite': {
        const inner = inline(n.kids, ctx).trim()
        out += inner ? `*${inner}*` : ''
        break
      }
      case 'del': case 's': case 'strike': {
        const inner = inline(n.kids, ctx).trim()
        out += inner ? `~~${inner}~~` : ''
        break
      }
      case 'code': case 'kbd': case 'samp': {
        const t = collapse(textOf(n))
        if (t) {
          const fence = '`'.repeat((Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length)) || 0) + 1)
          out += `${fence}${t.startsWith('`') || t.endsWith('`') ? ` ${t} ` : t}${fence}`
        }
        break
      }
      default: out += inline(n.kids, ctx, pre)
    }
  }
  return out
}

function paragraph(s: string): string {
  const t = s.replace(/[ \t]+\n/g, '\n').replace(/^\s+|\s+$/g, '')
  if (!t) return ''
  // keep a literal line-start from being read as block syntax
  return t.replace(/^(#{1,6}\s|[>+-]\s|\d+[.)]\s|={3,}|-{3,}|`{3,}|~{3,})/, '\\$1')
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'details', 'summary', 'address', 'fieldset'])

function blocks(nodes: Node[], ctx: Ctx): string[] {
  const out: string[] = []
  let buf: Node[] = []
  const flush = () => {
    if (!buf.length) return
    const p = paragraph(inline(buf, ctx))
    if (p) out.push(p)
    buf = []
  }
  for (const n of nodes) {
    if (!isEl(n)) { buf.push(n); continue }
    if (isNoise(n)) continue
    if (!BLOCK_TAGS.has(n.tag)) { buf.push(n); continue }
    flush()
    out.push(...block(n, ctx))
  }
  flush()
  return out
}

function indent(s: string, first: string, rest: string): string {
  return s.split('\n').map((l, i) => (i === 0 ? first : l ? rest : '') + l).join('\n')
}

function listBlock(e: El, ctx: Ctx): string {
  const ordered = e.tag === 'ol'
  let num = Number.parseInt(e.attrs.start ?? '1', 10)
  if (!Number.isFinite(num)) num = 1
  const items: string[] = []
  // a long list that is almost all link text is navigation (language pickers,
  // tag clouds, "more stories"), not article content
  const lis = e.kids.filter((k): k is El => isEl(k) && k.tag === 'li')
  if (lis.length >= 5) {
    const total = collapse(textOf(e)).length
    if (total && linkTextLen(e) / total > 0.8) return ''
  }
  for (const k of e.kids) {
    if (!isEl(k) || k.tag !== 'li' || isNoise(k)) continue
    const inner = blocks(k.kids, ctx)
    const marker = ordered ? `${num++}. ` : '- '
    // a nested list hugs the text above it (tight list), other blocks are loose
    const body = inner.reduce((acc, b, idx) => (idx === 0 ? b : `${acc}${/^(- |\d+\. )/.test(b) ? '\n' : '\n\n'}${b}`), '')
    if (!body.trim()) continue
    items.push(indent(body, marker, ' '.repeat(marker.length)))
  }
  return items.join('\n')
}

function tableBlock(e: El, ctx: Ctx): string | string[] {
  const rows: string[][] = []
  const grab = (x: El) => {
    for (const k of x.kids) {
      if (!isEl(k) || isNoise(k)) continue
      if (k.tag === 'tr') {
        const cells = k.kids.filter((c): c is El => isEl(c) && (c.tag === 'td' || c.tag === 'th'))
        rows.push(cells.map((c) => inline(c.kids, ctx).replace(/\s*\n\s*/g, ' ').trim()))
      } else if (['thead', 'tbody', 'tfoot'].includes(k.tag)) grab(k)
    }
  }
  grab(e)
  const width = Math.max(0, ...rows.map((r) => r.length))
  // layout tables (one column / one cell) are not data — unwrap their text
  if (rows.length === 0 || width < 2) {
    const flat = e.kids.flatMap((k) => (isEl(k) ? (k.tag === 'tr' || ['thead', 'tbody', 'tfoot'].includes(k.tag) ? [k] : []) : []))
    return flat.length ? blocks(flat.flatMap((f) => f.kids.flatMap((r) => (isEl(r) && r.tag === 'tr' ? r.kids : [r]))), ctx) : []
  }
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '')
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

function block(e: El, ctx: Ctx): string[] {
  const t = e.tag
  if (/^h[1-6]$/.test(t)) {
    const s = inline(e.kids, ctx).replace(/\s+/g, ' ').trim()
    return s ? [`${'#'.repeat(Number(t[1]))} ${s}`] : []
  }
  switch (t) {
    case 'p': case 'address': case 'summary': case 'dt': {
      const p = paragraph(inline(e.kids, ctx))
      return p ? [t === 'summary' || t === 'dt' ? `**${p}**` : p] : []
    }
    case 'hr': return ['---']
    case 'ul': case 'ol': {
      const l = listBlock(e, ctx)
      return l ? [l] : []
    }
    case 'blockquote': {
      const inner = blocks(e.kids, ctx).join('\n\n')
      return inner ? [indent(inner, '> ', '> ')] : []
    }
    case 'pre': {
      const codeEl = find(e, 'code')
      const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(`${codeEl?.attrs.class ?? ''} ${e.attrs.class ?? ''}`)?.[1] ?? ''
      const raw = decodeEntities(textOfPre(e)).replace(/ /g, ' ').replace(/^\n+|\s+$/g, '')
      if (!raw) return []
      const fence = '`'.repeat(Math.max(3, ...(raw.match(/`+/g) ?? []).map((r) => r.length + 1)))
      return [`${fence}${lang}\n${raw}\n${fence}`]
    }
    case 'table': {
      const r = tableBlock(e, ctx)
      return typeof r === 'string' ? [r] : r
    }
    case 'figcaption': {
      const p = paragraph(inline(e.kids, ctx))
      return p ? [`*${p}*`] : []
    }
    case 'dd': return blocks(e.kids, ctx)
    default: return blocks(e.kids, ctx)
  }
}
function textOfPre(n: Node): string {
  if (!isEl(n)) return n
  if (n.tag === 'br') return '\n'
  return n.kids.map(textOfPre).join('')
}

// ---------------------------------------------------------------- page-level

function meta(doc: El, key: string): string | undefined {
  for (const m of walk(doc)) {
    if (m.tag !== 'meta') continue
    if ((m.attrs.property ?? m.attrs.name)?.toLowerCase() === key && m.attrs.content) return collapse(decodeEntities(m.attrs.content))
  }
  return undefined
}

export interface Clip { title: string; md: string }

/** Convert a fetched HTML page to a Markdown document. Throws Error with a
 *  user-presentable message when nothing article-like could be extracted. */
export function htmlToClip(html: string, pageUrl: string): Clip {
  const base = new URL(pageUrl)
  const doc = parseHtml(html)
  const head = find(doc, 'head') ?? doc
  const bodyEl = find(doc, 'body') ?? doc
  const titleTag = find(head, 'title')
  const pageTitle = collapse(decodeEntities(titleTag ? textOf(titleTag) : ''))
  let baseHref = base
  const baseEl = find(doc, 'base')
  if (baseEl?.attrs.href) {
    try { baseHref = new URL(baseEl.attrs.href, base) } catch { /* keep page url */ }
  }
  const ctx: Ctx = { base: baseHref }

  const h1 = find(bodyEl, 'h1')
  const title = (
    meta(doc, 'og:title') ||
    (h1 ? collapse(textOf(h1)) : '') ||
    pageTitle ||
    base.hostname
  ).slice(0, 200)

  const content = pickContent(bodyEl)
  let md = blocks([content], ctx).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  // cap: keep clips well inside the deck size limit
  if (md.length > 1_500_000) md = md.slice(0, 1_500_000)
  const words = collapse(md.replace(/[!\[\]()*_#>`|-]/g, ' ')).length
  if (words < 120) {
    throw new Error("Couldn't find readable article text on that page (it may load its content with JavaScript, or sit behind a login/paywall).")
  }

  if (!/^#\s/.test(md)) md = `# ${escInline(title)}\n\n${md}`
  const siteLine = `Source: [${escInline(base.hostname.replace(/^www\./, ''))}](${mdUrl(base.href)}) · clipped ${new Date().toISOString().slice(0, 10)}`
  // source line goes right under the first heading
  const nl = md.indexOf('\n')
  md = nl < 0 ? `${md}\n\n${siteLine}` : `${md.slice(0, nl)}\n\n${siteLine}${md.slice(nl)}`
  return { title, md: md + '\n' }
}

// ---------------------------------------------------------------- fetch

const MAX_FETCH_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 15_000

export class ClipError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Reject anything that is not a plain public http(s) URL. Workers cannot reach
 *  private ranges anyway; this is cheap defense in depth and clearer errors. */
export function validateClipUrl(raw: string, selfHost?: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new ClipError('That is not a valid URL.', 422)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ClipError('Only http(s) URLs can be clipped.', 422)
  if (u.username || u.password) throw new ClipError('URLs with embedded credentials are not allowed.', 422)
  const h = u.hostname.toLowerCase()
  if (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':') ||
    /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.startsWith('[') || h === selfHost
  ) throw new ClipError('That address is not a public web page.', 422)
  return u
}

function charsetOf(contentType: string, head: Uint8Array): string {
  const h = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
  if (h) return h
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 2048))
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8'
}

/** Header sets tried in order. Many sites (WAFs, ModSecurity rules) 403 anything that
 *  announces itself as a bot, yet serve the same PUBLIC page to an ordinary
 *  browser request — so a plain browser-like profile goes first and other
 *  browser profiles are only tried after a block-style status. We never
 *  impersonate a search-engine crawler, and never try to defeat a captcha or
 *  login: a site that still refuses is reported as such. */
const PROFILES: Record<string, string>[] = [
  {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.8,*/*;q=0.7',
    'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    'upgrade-insecure-requests': '1',
  },
  {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.5',
  },
  {
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  },
]
const RETRY_STATUSES = new Set([401, 403, 406, 429, 451])

async function fetchFollow(start: URL, headers: Record<string, string>, selfHost?: string): Promise<{ res: Response; url: URL }> {
  let url = start
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetch(url.href, { redirect: 'manual', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch {
      throw new ClipError("Couldn't reach that page (timed out or refused the connection).", 502)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new ClipError('Too many redirects.', 502)
      try {
        url = validateClipUrl(new URL(res.headers.get('location')!, url).href, selfHost)
      } catch (e) {
        throw e instanceof ClipError ? e : new ClipError('Bad redirect target.', 502)
      }
      continue
    }
    return { res, url }
  }
}

export async function clipUrl(raw: string, selfHost?: string): Promise<Clip & { url: string }> {
  const start = validateClipUrl(raw, selfHost)
  let res: Response | null = null
  let url = start
  for (const profile of PROFILES) {
    ;({ res, url } = await fetchFollow(start, profile, selfHost))
    if (!RETRY_STATUSES.has(res.status)) break
    await res.body?.cancel()
  }
  if (!res) throw new ClipError("Couldn't fetch that page.", 502)
  if (!res.ok) throw new ClipError(`The site answered HTTP ${res.status}${RETRY_STATUSES.has(res.status) ? ' (it blocks automated fetches, or the page needs a login)' : ''}.`, 502)
  const ctype = res.headers.get('content-type') ?? ''
  const isHtml = /html|xml/i.test(ctype) || ctype === ''
  const isText = /^text\/(plain|markdown)/i.test(ctype)
  if (!isHtml && !isText) throw new ClipError(`That URL is ${ctype.split(';')[0] || 'not a web page'}, not an HTML article.`, 415)

  // bounded read
  const reader = res.body?.getReader()
  if (!reader) throw new ClipError('Empty response.', 502)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_FETCH_BYTES) {
      await reader.cancel()
      throw new ClipError('That page is too large to clip (over 5 MB).', 413)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { bytes.set(c, off); off += c.length }
  let decoder: TextDecoder
  try { decoder = new TextDecoder(charsetOf(ctype, bytes)) } catch { decoder = new TextDecoder('utf-8') }
  const body = decoder.decode(bytes)

  if (isText) {
    // a raw .md / .txt URL: store it as-is
    return { title: body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 200) || url.hostname, md: body, url: url.href }
  }
  try {
    return { ...htmlToClip(body, url.href), url: url.href }
  } catch (e) {
    throw e instanceof ClipError ? e : new ClipError((e as Error).message, 422)
  }
}
