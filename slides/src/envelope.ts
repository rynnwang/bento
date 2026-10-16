// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * A document's ENVELOPE is what makes it a document rather than content: its
 * collaboration block (`collab` — room, read key, private halves, the saved
 * sync state) and its identity (`docId`). An embed's `doc` is another deck's
 * JSON, and that deck's envelope must never ride inside this one — not on the
 * way in (the shape gate, untrusted.ts) and not on the way out (every export
 * that keeps the room, editor.ts stripCollabSecrets). One rule, both
 * boundaries, so they cannot drift; the export-secrets rig runs both.
 *
 * Node-importable on purpose (type-only imports): the rig drives it directly,
 * where the shape gate's module graph needs a bundler.
 */
import type { BentoDoc } from './model'

/** The keys that make a JSON object a document's envelope. */
export const EMBED_ENVELOPE = ['collab', 'docId'] as const

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * How many documents deep an embedded document may nest (the embed's own
 * document is depth 1). A document nested deeper is DROPPED, never kept: past
 * the bound nothing is inspected, so nothing past it may travel.
 */
export const ENVELOPE_MAX_DEPTH = 16

/** Is this object a document of ANY Bento app? (`bento/slides`, `bento/type`, …) */
const isBentoDoc = (v: Record<string, unknown>): boolean =>
  typeof v.format === 'string' && v.format.startsWith('bento/')

const DROP: unique symbol = Symbol('drop')

/**
 * `v` at document depth `depth`; `isDoc` when the caller knows it is a
 * document (the embed's own `doc`, or any object under a `doc` key) whether or
 * not it declares a format. Copy-on-write: returns `v` itself when nothing
 * beneath it changed, a copy along the changed path otherwise, or DROP.
 */
function walk(v: unknown, depth: number, isDoc: boolean): unknown {
  if (Array.isArray(v)) {
    let out: unknown[] | null = null
    for (let i = 0; i < v.length; i++) {
      const w = walk(v[i], depth, false)
      if (w !== v[i] && !out) out = v.slice(0, i)
      if (out && w !== DROP) out.push(w)
    }
    return out ?? v
  }
  if (!isObj(v)) return v
  const doc = isDoc || isBentoDoc(v)
  const here = doc ? depth + 1 : depth
  if (here > ENVELOPE_MAX_DEPTH) return DROP
  let out: Record<string, unknown> | null = null
  if (doc && EMBED_ENVELOPE.some((k) => k in v)) {
    out = { ...v }
    for (const k of EMBED_ENVELOPE) delete out[k]
  }
  for (const k of Object.keys(v)) {
    if (doc && (EMBED_ENVELOPE as readonly string[]).includes(k)) continue
    const w = walk(v[k], here, k === 'doc')
    if (w === v[k]) continue
    out ??= { ...v }
    if (w === DROP) delete out[k]
    else out[k] = w
  }
  return out ?? v
}

/**
 * The embedded document without its envelope — and without the envelope of
 * every document nested inside it, at any depth, of any Bento app: an object is
 * a document when it declares a `bento/…` format or sits under a `doc` key (the
 * embed convention). Documents nested more than ENVELOPE_MAX_DEPTH deep are
 * dropped. Returns the input ITSELF when nothing was removed — callers
 * (audience.ts) detect a change by identity — and a copy along the changed path
 * otherwise; the input is never modified.
 */
export function stripEnvelope<T>(v: T): T {
  const out = walk(v, 0, true)
  return (out === DROP ? undefined : out) as T
}

/**
 * Walk a deck's elements and strip the envelope from every embedded document
 * (`elements[].doc` when it is an object). Mutates `doc` — it is called on
 * export CLONES, beside the top-level strip. Returns how many were stripped.
 */
export function stripEmbeddedEnvelopes(doc: BentoDoc): number {
  let n = 0
  const walk = (slides: BentoDoc['slides'] | undefined) => {
    for (const s of slides ?? []) {
      for (const el of s.elements ?? []) {
        const src = (el as { doc?: unknown }).doc
        if (!isObj(src)) continue
        const out = stripEnvelope(src)
        if (out !== src) { (el as { doc?: unknown }).doc = out; n++ }
      }
    }
  }
  walk(doc.slides)
  walk(doc.layouts)
  return n
}
