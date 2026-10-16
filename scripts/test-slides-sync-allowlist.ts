#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/slides syncs doc-level keys by ALLOWLIST (kernel PR2, #683).
//
//   node scripts/test-slides-sync-allowlist.ts
//
// WHAT THIS PROVES, on slides' real bound engine (sync/crdt.ts SyncState over
// SLIDES_SHAPE, which now carries the field-class map in docclass.ts):
//   1. the binding: SLIDES_SHAPE.classes IS the map, and every doc key slides
//      synced before the opt-in is classed 'content' — so opting in stops
//      nothing that used to sync (theme, title, layouts, fonts, meta, …);
//   2. SENDER: a content change mints its op; a change to a NON-content key
//      (docId, readonly, template, collab) mints none — and neither does a key
//      the map does not know (a newer build's field);
//   3. RECEIVER: from a peer that sends everything, content and unknown keys
//      land, and a non-content key is refused whatever the peer claims;
//   4. a key applied from the wire but unknown here is never echoed in the
//      state this replica stamps or sends.
// For slides, every non-content key is ALSO in the kernel's skipDoc floor, so
// rows 2–3 for those keys held before the opt-in too; what the map adds is
// row 2's unknown-key case and row 4. The mutations at the end say which rows
// each piece holds up.

import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { SyncState, SLIDES_SHAPE, SyncEngine, shape } = await import('../slides/src/sync/crdt.ts')
const { SLIDES_FIELDS } = await import('../slides/src/docclass.ts')
const { newDoc } = await import('../slides/src/model.ts')

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }
const H = (s: string) => console.log(`\n${s}\n`)
type Rec = Record<string, any>
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const docSets = (ops: Array<Rec>) => ops.filter((o) => o.op === 'set' && o.el === undefined && o.sl === undefined).map((o) => String(o.k).split('.')[0])
const fresh = (): Rec => { const d = newDoc() as Rec; d.docId = 'd-mine'; d.collab = { room: 'wMINE', key: 'MINE' }; return d }

H('the binding')
{
  ok(SLIDES_SHAPE.classes === SLIDES_FIELDS, 'SLIDES_SHAPE carries slides\' field-class map')
  // what slides synced BEFORE the opt-in: every declared doc key not in skipDoc
  const before = Object.keys(SLIDES_FIELDS).filter((k) => !SLIDES_SHAPE.skipDoc.has(k))
  const notContent = before.filter((k) => (SLIDES_FIELDS as Rec)[k] !== 'content')
  ok(before.length >= 9 && notContent.length === 0, `every key that synced before is 'content' (${before.join(', ')})`)
}

H('SENDER: only content leaves this replica')
{
  const A = new SyncState('alice'); const d = fresh(); A.adopt(d as never)
  const was = clone(d)
  d.title = 'Renamed'; d.theme.accent = '#ff0000'; d.meta = { author: 'Ada' }; d.size = { width: 1600, height: 900 }
  d.present = { controls: true }; d.layouts = []; d.fonts = []
  const content = docSets(A.diff(was, d as never, { text: true }) as never)
  ok(['title', 'theme', 'meta', 'size', 'present', 'layouts', 'fonts'].every((k) => content.includes(k)), `content changes mint ops (${content.join(', ')})`)
  const was2 = clone(d)
  d.docId = 'EVIL'; d.readonly = true; d.template = true; d.collab.key = 'ROTATED'
  const nonContent = docSets(A.diff(was2, d as never, { text: true }) as never)
  ok(nonContent.length === 0, `a change to docId / readonly / template / collab mints no op (${nonContent.join(', ') || 'none'})`)
  const was3 = clone(d)
  d.futureField = 'from a newer build'
  const unknown = docSets(A.diff(was3, d as never, { text: true }) as never)
  ok(!unknown.includes('futureField'), `a key the map does not know mints no op (${unknown.join(', ') || 'none'})`)
}

// a peer from before the opt-in: same container shape, no class map — it
// emits every non-skipDoc key, which is what a classed replica must judge
const PLAIN = shape('slides', 'elements')
class Plain extends SyncEngine { constructor(a: string) { super(a, PLAIN) } }
let n = 0
const peerOps = (change: Rec) => { const P = new Plain(`old${n++}`); const d = fresh(); P.adopt(d as never); const b = clone(d); Object.assign(d, change); return P.diff(b, d as never, { text: true }) }

H('RECEIVER: content and unknown land, non-content is refused')
{
  const A = new SyncState('alice'); const d = fresh(); A.adopt(d as never)
  A.apply(d as never, peerOps({ title: 'From a peer' }) as never)
  ok(d.title === 'From a peer', 'a content key from a peer is applied')
  A.apply(d as never, peerOps({ futureField: 'newer content' }) as never)
  ok(d.futureField === 'newer content', 'an unknown key from a peer is applied (kept for this file)')
  let act = 0
  for (const [k, v] of [['docId', 'EVIL'], ['readonly', true], ['template', true], ['collab', { room: 'wEVIL', key: 'EVIL' }]] as const) {
    A.apply(d as never, [{ op: 'set', k, v, a: `evil${act++}`, s: 1, l: 9999 }] as never)
  }
  ok(d.docId === 'd-mine' && d.readonly === undefined && d.template === undefined && d.collab.key === 'MINE',
    'a forged docId / readonly / template / collab op is refused')
}

H('an unknown key is applied but never echoed')
{
  const A = new SyncState('alice'); const d = fresh(); A.adopt(d as never)
  A.apply(d as never, peerOps({ futureField: 'newer content', title: 'T' }) as never)
  const regs = Object.keys((A.toJSON() as Rec).regs)
  ok(regs.some((k) => k.endsWith(' title')), 'the stamped state carries the content register')
  ok(!regs.some((k) => k.endsWith(' futureField')), 'but not the unknown one')
  ok((A.outboundDoc(clone(d)) as Rec).futureField === undefined, 'and the snapshot this replica sends leaves it out')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
