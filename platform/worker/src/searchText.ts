// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Plain-text extraction for the sidebar's search box (migrations/
// 0009_search_text.sql, store.ts's `search_text` column + `searchDecks`).
// Content search needs something readable to match against beyond the
// title, and re-fetching every deck's bytes from R2 on every keystroke
// isn't viable — so a lowercase text blob is precomputed HERE at write
// time (create/replace) and stored in D1 alongside the metadata it's
// queried with, one LIKE scan away. See index.ts/store.ts for how it's
// kept in sync: every path that changes a deck's stored CONTENT
// recomputes it; a plain rename (title-only) does not need to, because
// the search query matches `title` and `search_text` as two separate
// OR'd columns rather than title being folded into this blob.
//
// A 'bento' deck is walked GENERICALLY — a BLOCKLIST of known structural/
// style keys, not an allowlist of content keys — so this keeps working as
// slides/src/model.ts grows new element types without a matching edit
// here. The cost is an occasional stray non-content string slipping in
// (a rare false-positive match); the alternative, an allowlist, silently
// stops indexing new content-bearing fields until this file is updated,
// which is the worse failure mode for a search feature. An 'html' deck
// just strips markup.

const MAX_SEARCH_TEXT = 20_000 // characters — a search index, not an archive

const STRUCTURAL_KEYS = new Set([
  'id', 'docId', 'x', 'y', 'w', 'h', 'width', 'height', 'rotation', 'opacity',
  'radius', 'strokeWidth', 'strokeStyle', 'stroke', 'fill', 'fillGradient',
  'color', 'bg', 'background', 'accent', 'fontFamily', 'fontSize', 'fontWeight',
  'lineHeight', 'align', 'valign', 'shape', 'type', 'kind', 'format', 'version',
  'shell_version', 'transition', 'easing', 'morphGroup', 'morphId', 'layout',
  'src', 'href', 'link', 'groupId', 'group', 'order', 'delay', 'repeat', 'yoyo',
  'ease', 'zoom', 'dir', 'secs', 'chartType', 'yAxisIndex', 'borderColor',
  'borderWidth', 'headerBg', 'headerColor', 'cellPadX', 'cellPadY', 'zebra',
  'theme', 'chartPalette', 'size', 'stateOf', 'role', 'placeholder', 'hover',
  'fx', 'present', 'collab', 'sync', 'readonly', 'shadow', 'lineStart', 'lineEnd',
])

function stripHtmlTags(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function isColorLike(s: string): boolean {
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^(rgba?|hsla?)\(/i.test(s)
}

interface WalkState {
  chars: number
}

function walk(value: unknown, out: string[], state: WalkState, depth: number): void {
  if (depth > 12 || state.chars > MAX_SEARCH_TEXT) return
  if (typeof value === 'string') {
    if (value.length < 2 || isColorLike(value)) return
    const cleaned = stripHtmlTags(value)
    if (!cleaned) return
    out.push(cleaned)
    state.chars += cleaned.length
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, out, state, depth + 1)
      if (state.chars > MAX_SEARCH_TEXT) return
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (STRUCTURAL_KEYS.has(key)) continue
      walk(val, out, state, depth + 1)
      if (state.chars > MAX_SEARCH_TEXT) return
    }
  }
}

/** Lowercase, tag-stripped, size-capped text pulled from a compiled
 *  bento/slides doc — every string reachable under a non-structural key. */
export function extractBentoSearchText(doc: unknown): string {
  const out: string[] = []
  walk(doc, out, { chars: 0 }, 0)
  return out.join(' ').toLowerCase().slice(0, MAX_SEARCH_TEXT)
}

/** Lowercase, tag-stripped, size-capped text from a raw 'html' deck file. */
export function extractHtmlSearchText(html: string): string {
  return stripHtmlTags(html).toLowerCase().slice(0, MAX_SEARCH_TEXT)
}
