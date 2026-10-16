#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Sync override: a history-class doc key that still syncs (shape().syncHistory).
//
//   node scripts/test-sync-history-override.ts
//
// The doc-level allowlist (#683) syncs by copy-class: only `content` keys flow.
// But a field's copy class and its sync decision can diverge. bento/type classes
// `comments` as `history` so reader and export copies drop them, yet comments
// must still flow between live collaborators. `shape().syncHistory` names such a
// key: it emits and accepts though non-content, WITHOUT changing the wire shape
// (still a whole `#doc <key>` register), so a build that binds a class map stays
// mixed-version-compatible with one that does not.
//
// The restriction, both halves: syncHistory may name ONLY history-class keys.
// `shape()` throws at RUNTIME otherwise (the rows below, run in CI), and
// `historySyncKeys` makes naming an identity / mode / capability / unclassified
// key a COMPILE error — enforced at every app call site under tsc (type's opt-in
// build fails if it lists a non-history key), and shown by the type-only lines
// at the end of this file (scripts aren't type-checked in CI, so those document
// and locally verify the constraint; the runtime rows are the CI guarantee).
// skipDoc is still checked FIRST, so this can never reopen a never-synced field.
//
// Mutations (edit kernel/src/sync/crdt.ts, re-run — each turns a row red):
//   - outboundDocKey, drop `syncHistory.has(k) → true`   : comments stop being emitted
//   - ignoreInboundDocKey, drop `syncHistory.has(k) → false`: comments refused inbound
//   - shape(), drop the history-class throw               : runtime-refusal rows red
//   - shape(), drop the skipDoc-in-syncHistory throw       : the bind-time floor rows red
//   - outboundDocKey, move syncHistory ABOVE the skipDoc check : the gate-order floor rows red
//   - historySyncKeys, loosen the key type                : the @ts-expect-error lines fail tsc

import { SyncEngine, shape, historySyncKeys } from '../slides/src/sync/crdt.ts'
import type { DocShape } from '../slides/src/sync/crdt.ts'
import type { FieldClass } from '../kernel/src/docfields.ts'

let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const H = (s: string) => console.log(`\n=== ${s} ===`)
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
type Rec = Record<string, unknown>

// A type-like class map. `comments` is history (the #663 copy ruling), and so is
// `revisions`; `signatures` is content; identity/mode/capability as usual.
const TFIELDS = {
  title: 'content', body: 'content', comments: 'history', revisions: 'history',
  signatures: 'content', docId: 'identity', collab: 'capability',
  readonly: 'mode', template: 'mode',
} satisfies Record<string, FieldClass>

// NEW build: binds the map AND shares comments.
const SHARED: DocShape = shape('body', null, 'text', [], TFIELDS, historySyncKeys(TFIELDS, ['comments']))
// bound but does NOT share comments (the control).
const BOUND: DocShape = shape('body', null, 'text', [], TFIELDS)
// a 1.2.7-shaped peer: no class map at all, comments is just a plain register.
const OLD: DocShape = shape('body', null, 'text')
class Shared extends SyncEngine { constructor(a: string) { super(a, SHARED) } }
class Bound extends SyncEngine { constructor(a: string) { super(a, BOUND) } }
class Old extends SyncEngine { constructor(a: string) { super(a, OLD) } }

const doc = (over: Rec = {}): Rec => ({
  format: 'bento/type', version: 1, docId: 'd-mine', title: 't',
  body: [{ id: 'b1', text: 'hi' }], comments: {} as Rec, ...over,
})
const docSets = (ops: Array<Rec>) =>
  ops.filter(o => o.op === 'set' && o.el === undefined && o.sl === undefined).map(o => String(o.k))

// a peer's ops for a doc change, from a distinct actor each call
let n = 0
const opsFrom = (Engine: new (a: string) => SyncEngine, change: Rec): Array<Rec> => {
  const P = new Engine(`peer${n++}`); const d = doc(); P.adopt(d as never)
  const before = clone(d); Object.assign(d, change)
  return P.diff(before, d as never, { text: true }) as never
}

H('with the override, a history key (comments) is emitted and accepted')
{
  const A = new Shared('a'); const d = doc(); A.adopt(d as never)
  const before = clone(d); (d.comments as Rec).T1 = { text: 'hello' }
  const emitted = docSets(A.diff(before, d as never, { text: true }) as never)
  ok(emitted.includes('comments'), 'a diff EMITS comments though it is history-class')
  ok(emitted.every(k => !k.includes('.')), 'and as a WHOLE register (no dotted key — wire shape unchanged)')
  const B = new Shared('b'); const bd = doc(); B.adopt(bd as never)
  B.apply(bd as never, opsFrom(Shared, { comments: { T9: { text: 'hi' } } }) as never)
  ok(JSON.stringify((bd.comments as Rec).T9) === JSON.stringify({ text: 'hi' }), 'and a peer\'s comments are APPLIED inbound')
}

H('without the override, the same history key does NOT sync')
{
  const A = new Bound('a'); const d = doc(); A.adopt(d as never)
  const before = clone(d); (d.comments as Rec).T1 = { text: 'hello' }
  ok(!docSets(A.diff(before, d as never, { text: true }) as never).includes('comments'),
    'a bound build that does not share comments never emits them')
  const B = new Bound('b'); const bd = doc(); B.adopt(bd as never)
  B.apply(bd as never, opsFrom(Old, { comments: { T9: { text: 'hi' } } }) as never)
  ok((bd.comments as Rec).T9 === undefined, 'and refuses comments inbound')
}

H('MIXED VERSION: a shared-build peer and a 1.2.7 peer see the same comments')
{
  // NEW -> OLD
  const NEW = new Shared('new'); const OLDP = new Old('old')
  const dN = doc(); const dO = doc(); NEW.adopt(dN as never); OLDP.adopt(dO as never)
  const bN = clone(dN); (dN.comments as Rec).T1 = { text: 'from new' }
  const opsN = NEW.diff(bN, dN as never, { text: true })
  ok(docSets(opsN as never).includes('comments') && docSets(opsN as never).every(k => !k.includes('.')),
    'the shared build emits comments as a whole register — the 1.2.7 wire')
  OLDP.apply(dO as never, opsN as never)
  ok(JSON.stringify((dO.comments as Rec).T1) === JSON.stringify({ text: 'from new' }), 'the 1.2.7 peer receives it (no stray dotted key)')
  ok(Object.keys(dO).every(k => !k.includes('.')), 'and no "comments.T1" literal key was created')
  // OLD -> NEW
  const bO = clone(dO); (dO.comments as Rec).T2 = { text: 'from old' }
  NEW.apply(dN as never, OLDP.diff(bO, dO as never, { text: true }) as never)
  ok(JSON.stringify((dN.comments as Rec).T2) === JSON.stringify({ text: 'from old' }), 'and the shared build receives the 1.2.7 peer\'s comments')
}

H('the skipDoc floor is checked first at the gate too (defence in depth)')
{
  // shape() refuses a skipDoc key in syncHistory at bind time (below). But the
  // gate is the second line: even a FORGED shape that got a skipDoc key past the
  // bind guard must still be refused, because skipDoc is checked FIRST in both
  // gates. Force `revisions` in past the guard and prove the gate holds. (This
  // is the row security's "override above the floor" gate-order mutation reds.)
  const FORGED: DocShape = shape('body', null, 'text', [], TFIELDS)
  ;(FORGED.syncHistory as Set<string>).add('revisions')
  class Forged extends SyncEngine { constructor(a: string) { super(a, FORGED) } }
  const A = new Forged('a'); const d = doc({ revisions: [{ id: 'r1' }] }); A.adopt(d as never)
  const before = clone(d); (d.revisions as unknown[]).push({ id: 'r2' })
  ok(!docSets(A.diff(before, d as never, { text: true }) as never).includes('revisions'),
    'a skipDoc key forced into syncHistory is still never emitted (gate order)')
  const B = new Forged('b'); const bd = doc(); B.adopt(bd as never)
  B.apply(bd as never, [{ op: 'set', k: 'revisions', v: [{ id: 'EVIL' }], a: 'evil', s: 1, l: 9000 }] as never)
  ok((bd as Rec).revisions === undefined, 'and is still refused inbound (gate order)')
}

H('syncHistory may name ONLY history-class keys — runtime refusal')
{
  const throws = (fn: () => void) => { try { fn(); return false } catch { return true } }
  ok(throws(() => shape('body', null, 'text', [], TFIELDS, ['collab'])), 'a capability key is refused')
  ok(throws(() => shape('body', null, 'text', [], TFIELDS, ['docId'])), 'an identity key is refused')
  ok(throws(() => shape('body', null, 'text', [], TFIELDS, ['readonly'])), 'a mode key is refused')
  ok(throws(() => shape('body', null, 'text', [], TFIELDS, ['nope'])), 'an unclassified key is refused')
  ok(throws(() => shape('body', null, 'text', [], undefined, ['comments'])), 'naming a key with no class map is refused')
  // belt and braces: a skipDoc key is refused at bind time regardless of its
  // class — the guard must not trust the app's map to keep a floor field out.
  ok(throws(() => shape('body', null, 'text', [], TFIELDS, ['revisions'])),
    'a skipDoc key (revisions) is refused at bind time though it is history-class')
  const MISCLASSED = { ...TFIELDS, collab: 'history' } satisfies Record<string, FieldClass>
  ok(throws(() => shape('body', null, 'text', [], MISCLASSED, ['collab'])),
    'a skipDoc key MIS-classed history + named is refused — the floor does not trust the class map')
  ok(!throws(() => shape('body', null, 'text', [], TFIELDS, ['comments'])), 'a history key is accepted')
}

// COMPILE-TIME half: these must each be a type error, or tsc fails on the unused
// directive. (Runtime no-ops; the assertion is that the file type-checks.)
// @ts-expect-error collab is capability, not history
historySyncKeys(TFIELDS, ['collab'])
// @ts-expect-error docId is identity, not history
historySyncKeys(TFIELDS, ['docId'])
// @ts-expect-error not a key of the map
historySyncKeys(TFIELDS, ['nope'])
ok(true, 'the @ts-expect-error lines above hold the compile-time restriction (checked by tsc)')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
