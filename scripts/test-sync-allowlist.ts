#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Doc-level sync allowlist (PR2). When an app binds a field-class map, the
// engine syncs doc-level keys by ALLOWLIST instead of the shipped denylist:
//
//   node scripts/test-sync-allowlist.ts
//
// The shipped rule is skipDoc — a denylist: a named set is never emitted and
// never adopted, everything else flows. That is the security floor and it
// still holds. PR2 adds the other half, OFF until an app passes `classes` to
// shape():
//   - SENDER: a peer emits a doc-level key only if its own map classes it
//     'content' (per-key maps aside). A non-content key (identity / mode /
//     capability / history) and an UNKNOWN key — one a newer build added that
//     this build has no class for — are never emitted. Not emitting a key is
//     not deleting it: silence is never a del.
//   - RECEIVER: a key this map knows as non-content is ignored, whatever the
//     sender claims. An unknown key is APPLIED (option (a), APPLY_UNKNOWN_DOC_
//     KEYS = true): a newer build's content survives an older peer and lands in
//     this replica's own file — but this replica still never re-emits it.
//   - skipDoc remains the floor under both: never emitted, never adopted,
//     with or without a class map.
//
// With NO class map the engine is byte-for-byte the shipped denylist, so PR2
// is dormant until an app opts in. That control is the last section.
//
// Mutations (edit kernel/src/sync/crdt.ts, re-run — each turns a row red):
//   - outboundDocKey → `return true`              : sender emits non-content/unknown
//   - ignoreInboundDocKey non-content → false     : receiver adopts identity/mode
//   - APPLY_UNKNOWN_DOC_KEYS = false              : unknown key no longer applied
//   - outboundDocKey, drop `skipDoc.has(k)` guard : OUTBOUND floor red (diff + outboundDoc)
//   - ignoreInboundDocKey, drop `skipDoc.has(k)`  : INBOUND floor red (applySet + snapshot)
// The last two matter because a bound map classes some skipDoc keys as content
// (spaces does), so the skipDoc-first guard is the only thing holding them off.

import { SyncEngine, shape } from '../slides/src/sync/crdt.ts'
import type { DocShape } from '../slides/src/sync/crdt.ts'
import type { FieldClass } from '../kernel/src/docfields.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }
const H = (s: string) => console.log(`\n=== ${s} ===`)
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

// A spaces-shaped doc (pages → blocks) with a doc-level class map. One field is
// left OUT of the map on purpose: `mystery`, the newer-build key.
const CLASSES: Record<string, FieldClass> = {
  title: 'content', mood: 'content',
  owner: 'identity', locked: 'mode', seat: 'capability', log: 'history',
}
const CLASSED: DocShape = shape('pages', 'blocks', 'html', [], CLASSES)
const PLAIN: DocShape = shape('pages', 'blocks') // the shipped denylist, no map
// The floor fixture: a map that classes skipDoc keys as `content`. skipDoc must
// win over the class in BOTH directions, or a map could re-open a never-synced
// field. This is not hypothetical — spaces' real map classes policy / format /
// version / modified as content, and the floor is what keeps them off the wire.
const FLOOR_FIELDS: Record<string, FieldClass> = {
  ...CLASSES,
  collab: 'content', docId: 'content', policy: 'content', format: 'content',
  version: 'content', modified: 'content', revisions: 'content', trail: 'content',
  readonly: 'content', template: 'content',
}
const FLOORED: DocShape = shape('pages', 'blocks', 'html', [], FLOOR_FIELDS)
class Classed extends SyncEngine { constructor(a: string) { super(a, CLASSED) } }
class Plain extends SyncEngine { constructor(a: string) { super(a, PLAIN) } }
class Floored extends SyncEngine { constructor(a: string) { super(a, FLOORED) } }

type Rec = Record<string, unknown>
const doc = (over: Rec = {}): Rec => ({
  format: 'bento/spaces', version: 1, docId: 'd-mine', title: 'mine', home: 'p1',
  collab: { room: 'wMINE', key: 'MINE' },
  pages: [{ id: 'p1', title: 'Page one', blocks: [{ id: 'b1', type: 'p', html: 'x' }] }],
  ...over,
})
// doc-level set ops a diff produced, by field (maps collapse to their field)
const docSets = (ops: Array<Rec>) =>
  ops.filter(o => o.op === 'set' && o.el === undefined && o.sl === undefined)
     .map(o => String(o.k).split('.')[0])

H('SENDER: a classed peer emits only content keys')
{
  const A = new Classed('alice'); const d = doc(); A.adopt(d as never)
  const before = clone(d)
  d.mood = 'bright'; d.owner = 'eve'; d.locked = true; d.seat = 'gold'; d.log = [{ at: 't' }]
  d.mystery = 'from a newer build'; (d.collab as Rec).key = 'ROTATED'
  const emitted = docSets(A.diff(before, d as never, { text: true }) as never)
  ok(emitted.includes('mood'), 'a content field (mood) is emitted')
  ok(!emitted.includes('owner') && !emitted.includes('locked') && !emitted.includes('seat') && !emitted.includes('log'),
    'identity / mode / capability / history fields are NOT emitted')
  ok(!emitted.includes('mystery'), 'an UNKNOWN field (not in the map) is NOT emitted')
  ok(!emitted.includes('collab'), 'a skipDoc field (collab) is NOT emitted — the floor')
}

// A realistic wire: a CLASS-LESS peer (old build) emits every non-skip field,
// so it can hand the classed replica the non-content and unknown ops to refuse
// or apply. skipDoc is still never emitted by anyone, so that op is hand-made.
// Each call uses a DISTINCT actor so its op isn't dropped as a duplicate `s`.
let peerN = 0
const peerOps = (change: Rec): Array<Rec> => {
  const P = new Plain(`oldpeer${peerN++}`); const d = doc(); P.adopt(d as never)
  const before = clone(d); Object.assign(d, change)
  return P.diff(before, d as never, { text: true }) as never
}

H('RECEIVER: a classed peer ignores non-content, applies content and unknown')
{
  const A = new Classed('alice'); const d = doc(); A.adopt(d as never)
  A.apply(d as never, peerOps({ mood: 'bright' }) as never)
  ok(d.mood === 'bright', 'a content field from a peer is applied')
  A.apply(d as never, peerOps({ owner: 'eve' }) as never)
  ok(d.owner !== 'eve', 'an identity field from a peer is ignored, whatever it claims')
  A.apply(d as never, peerOps({ locked: true }) as never)
  ok(d.locked !== true, 'a mode field from a peer is ignored')
  // option (a): an unknown field a newer build sent IS applied, and lands here
  A.apply(d as never, peerOps({ mystery: 'newer content' }) as never)
  ok(d.mystery === 'newer content', 'an UNKNOWN field from a peer IS applied (option a)')
  // the floor: a hand-crafted skipDoc op (no honest peer emits one) is refused
  A.apply(d as never, [{ op: 'set', k: 'collab', v: { room: 'wEVIL', key: 'EVIL' }, a: 'evil', s: 1, l: 9999 }] as never)
  ok((d.collab as Rec).key === 'MINE', 'a skipDoc field (collab) is refused — the floor')
}

H('a value applied from an unknown key is NOT re-emitted (applied, never echoed)')
{
  const A = new Classed('alice'); const d = doc(); A.adopt(d as never)
  A.apply(d as never, peerOps({ mystery: 'newer content', mood: 'bright' }) as never)
  const regs = (A.toJSON() as { regs: Rec }).regs
  const docRegKeys = Object.keys(regs).filter(k => k.startsWith('#doc ') || k.includes(' ')).filter(k => /(^|\s)(mystery|mood)$/.test(k))
  ok(docRegKeys.some(k => k.endsWith(' mood')), 'the stamped state carries the content register (mood)')
  ok(!docRegKeys.some(k => k.endsWith(' mystery')), 'but NOT the unknown one — applied locally, never echoed to peers')
}

H('LOADING a saved state drops a non-content doc register')
{
  // a state stamped by some build that DID carry an identity register
  const A = new Classed('alice'); const d = doc(); A.adopt(d as never)
  A.apply(d as never, peerOps({ mood: 'bright' }) as never)
  const j = A.toJSON() as { regs: Rec }
  // forge an identity register into the saved state, as a pre-allowlist stamp had
  const docNode = Object.keys(j.regs).find(k => k.endsWith(' mood'))!.split(' ')[0]
  j.regs[`${docNode} owner`] = [9999, 'someone']
  const B = Classed.fromJSON('bob', j as never)
  const bregs = (B.toJSON() as { regs: Rec }).regs
  ok(Object.keys(bregs).some(k => k.endsWith(' mood')), 'the content register survives the load')
  ok(!Object.keys(bregs).some(k => k.endsWith(' owner')), 'the forged identity register is dropped on load')
}

H('SNAPSHOT merge obeys the same receive rule')
{
  const A = new Classed('alice'); const d = doc(); A.adopt(d as never)
  // a peer's snapshot: a doc carrying content + identity + unknown. The fields
  // are DIFFED in (not merely adopted) so the state actually carries their
  // doc-level registers, which is what mergeSnapshot replays.
  const P = new Plain('snappeer'); const pd = doc(); P.adopt(pd as never)
  const pbefore = clone(pd); pd.mood = 'bright'; pd.owner = 'eve'; pd.mystery = 'newer'
  P.diff(pbefore, pd as never, { text: true })
  const pstate = P.toJSON()
  const rdoc = A.outboundDoc(clone(pd)) // sender-side projection is content-only…
  ok(rdoc.owner === undefined && rdoc.mystery === undefined && rdoc.mood === 'bright',
    'outboundDoc keeps content + container and drops identity / unknown')
  // …but merge the RAW peer doc+state to prove the RECEIVE rule, not the send one
  A.mergeSnapshot(d as never, pd as never, pstate as never)
  ok(d.mood === 'bright', 'snapshot: a content field lands')
  ok(d.owner !== 'eve', 'snapshot: an identity field is refused')
  ok(d.mystery === 'newer', 'snapshot: an unknown field is applied (option a)')
}

H('FLOOR: skipDoc beats a content classification, both directions')
{
  // Every one of these is classed `content` in FLOOR_FIELDS, yet skipDoc must
  // still refuse it — on the wire and in the file.
  const FLOORED_KEYS = ['collab', 'docId', 'policy', 'format', 'version', 'modified', 'revisions', 'trail', 'readonly', 'template']
  // --- outbound: a diff emits none of them, though the map calls them content
  const A = new Floored('alice'); const d = doc(); A.adopt(d as never)
  const before = clone(d)
  ;(d.collab as Rec).key = 'ROTATED'; d.docId = 'EVIL'; d.policy = 'evil'; d.format = 'evil'
  d.version = 999; d.modified = '1999'; d.revisions = [{ id: 'x' }]; d.trail = [{}]; d.readonly = true; d.template = true
  const emitted = docSets(A.diff(before, d as never, { text: true }) as never)
  ok(FLOORED_KEYS.every(k => !emitted.includes(k)),
    'a skipDoc key classed content is still never EMITTED by a diff')
  // --- outbound: the snapshot projection drops them too
  const proj = A.outboundDoc(clone(d)) as Rec
  ok(FLOORED_KEYS.every(k => proj[k] === undefined) && proj.pages !== undefined,
    'outboundDoc drops every skipDoc key, content-classed or not, and keeps the container')
  // --- inbound: a hand-crafted op per key (no honest peer emits one) is refused
  const B = new Floored('bob'); const bd = doc(); B.adopt(bd as never)
  let act = 0
  for (const k of FLOORED_KEYS) {
    B.apply(bd as never, [{ op: 'set', k, v: k === 'collab' ? { key: 'EVIL' } : 'EVIL', a: `evil${act++}`, s: 1, l: 9000 }] as never)
  }
  ok((bd.collab as Rec).key === 'MINE' && bd.docId === 'd-mine' && bd.policy === undefined && bd.readonly === undefined,
    'a skipDoc key classed content is still REFUSED on receive (applySet)')
  // --- inbound: the same through a snapshot with a VALID state carrying forged regs
  const C = new Floored('carol'); const cd = doc(); C.adopt(cd as never)
  C.apply(cd as never, peerOps({ mood: 'bright' }) as never) // a real content reg, so the state is valid
  const st = C.toJSON() as { regs: Rec }
  const node = Object.keys(st.regs).find(k => k.endsWith(' mood'))!.split(' ')[0]
  const rdoc = doc({ collab: { key: 'EVIL' }, docId: 'EVIL', policy: 'evil', readonly: true }) as Rec
  for (const k of FLOORED_KEYS) st.regs[`${node} ${k}`] = [9000, 'evil']
  C.mergeSnapshot(cd as never, rdoc as never, st as never)
  ok((cd.collab as Rec).key === 'MINE' && cd.docId === 'd-mine' && cd.policy === undefined && cd.readonly === undefined,
    'a skipDoc key classed content is still REFUSED on snapshot merge (mergeSnapshot)')
}

H('CONTROL: with no class map, the engine is the shipped denylist')
{
  const A = new Plain('alice'); const d = doc(); A.adopt(d as never)
  const before = clone(d)
  d.owner = 'eve'; d.mystery = 'anything'; (d.collab as Rec).key = 'ROTATED'
  const emitted = docSets(A.diff(before, d as never, { text: true }) as never)
  ok(emitted.includes('owner') && emitted.includes('mystery'),
    'a class-less peer emits every non-skip field, exactly as shipped')
  ok(!emitted.includes('collab'), 'and still never a skipDoc field')
  const B = new Plain('bob'); const bd = doc(); B.adopt(bd as never)
  B.apply(bd as never, peerOps({ owner: 'eve' }) as never)
  ok(bd.owner === 'eve', 'and a class-less peer adopts a non-content field, exactly as shipped')
}

H('MIXED VERSION: a new build and an old build converge; silence is not a del')
{
  const NEW = new Classed('newbuild'); const OLD = new Plain('oldbuild')
  const dN = doc(); const dO = doc()
  NEW.adopt(dN as never); OLD.adopt(dO as never)
  // OLD (no map) sets content + an unknown + an identity; NEW receives
  const b = clone(dO)
  dO.mood = 'bright'; dO.mystery = 'from old'; dO.owner = 'oldowner'
  NEW.apply(dN as never, OLD.diff(b, dO as never, { text: true }) as never)
  ok(dN.mood === 'bright', 'content flows old → new')
  ok(dN.mystery === 'from old', 'an unknown field flows old → new (applied)')
  ok(dN.owner !== 'oldowner', 'but the old build cannot set the new build\'s identity field')
  // NEW holds mystery but never emits it. Its stamped state, merged back into
  // OLD, must not DELETE OLD's mystery — not-emitting is not a del.
  OLD.mergeSnapshot(dO as never, NEW.outboundDoc(clone(dN)) as never, NEW.toJSON() as never)
  ok(dO.mystery === 'from old', 'the new build\'s silence on `mystery` did not delete it from the old build')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
