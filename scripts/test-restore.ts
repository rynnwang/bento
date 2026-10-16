#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Whole-document restore: applyRestore (kernel/src/docfields.ts).
//
//   node scripts/test-restore.ts
//
// The class-driven generalisation of keepLiveIdentity for undo/redo, version
// restore and crash recovery. A field's behaviour is decided per field from its
// class, with per-field overrides, and the RESTORE DIRECTION matters:
//   - 'back'    (undo/redo, version restore): going back in time — a 'live' field
//               keeps the live value, so identity and history don't roll back.
//   - 'recover' (crash recovery): the incoming snapshot is a NEWER copy of THIS
//               document — a 'live' history field is reconciled with it (a
//               revision made just before the crash must survive).
// Overrides: type's comments are class 'history' (copy reasons) but must be
// undoable/restorable, so they are keepLive 'follows'. Recover hooks: a field
// may bind one (newestListWins for an UNSIGNED list); a signed list uses the
// default (follow incoming), or a tie can pair a signature with history it never
// signed.
//
// Mutations (edit kernel/src/docfields.ts, re-run — each reds a row):
//   - applyRestore, make a 'live' field follow on 'back'   : identity/history roll back
//   - applyRestore, drop the recover history reconciliation : a newer revision is lost on recover
//   - applyRestore, drop "absent never wipes on recover"    : a missing key wipes live
//   - newestListWins, tie `>` → `>=`                        : a trim is lost (tie takes incoming)
//   - applyRestore, drop the PROTO_KEYS skip                : a null-proto map lets a snapshot swap the prototype
//   - applyRestore, honour the override for a floor class   : collab/readonly/docId follow a snapshot

import { applyRestore, defaultKeepLive, newestListWins, validateRestoreRules, restoreOverrides } from '../kernel/src/docfields.ts'
import type { RestoreRules, RecoverHook } from '../kernel/src/docfields.ts'
import type { FieldClass } from '../kernel/src/docfields.ts'

let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const H = (s: string) => console.log(`\n=== ${s} ===`)
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
type Rec = Record<string, unknown>

const CLASSES = {
  title: 'content', body: 'content',
  docId: 'identity', collab: 'capability', readonly: 'mode', template: 'mode',
  revisions: 'history', trail: 'history', comments: 'history',
} satisfies Record<string, FieldClass>
// comments: history class (copy), but restorable/undoable → keepLive 'follows'
const RULES: RestoreRules = { classes: CLASSES, keepLive: { comments: 'follows' } }

const live = (): Rec => ({
  title: 'live title', body: 'live body',
  docId: 'LIVE-ID', collab: { key: 'LIVE' }, readonly: false, template: false,
  revisions: [{ id: 'r1', at: '2026-01-01' }, { id: 'r2', at: '2026-02-01' }],
  comments: { t1: 'live' }, mystery: 'live-x',
})
const incoming = (over: Rec = {}): Rec => ({
  title: 'incoming title', body: 'incoming body',
  docId: 'OLD-ID', collab: { key: 'OLD' }, readonly: true, template: true,
  revisions: [{ id: 'r1', at: '2026-01-01' }],
  comments: { t1: 'incoming' }, mystery: 'incoming-x', ...over,
})

H('defaultKeepLive: content/unknown follow; identity/mode/capability/history live')
{
  ok(defaultKeepLive('content') === 'follows', 'content follows')
  ok(defaultKeepLive(undefined) === 'follows', 'an unknown field follows')
  ok(defaultKeepLive('identity') === 'live' && defaultKeepLive('capability') === 'live', 'identity + capability live')
  ok(defaultKeepLive('mode') === 'live' && defaultKeepLive('history') === 'live', 'mode + history live')
}

H('back (version restore): content follows; identity/mode/capability + history stay live')
{
  const r = applyRestore(live(), incoming(), 'back', RULES) as Rec
  ok(r.title === 'incoming title', 'content follows the version')
  ok(r.docId === 'LIVE-ID', 'identity stays live (a restore never rolls back docId)')
  ok((r.collab as Rec)?.key === 'LIVE', 'capability stays live')
  ok(r.readonly === false, 'mode stays live')
  ok(eq(r.revisions, live().revisions), 'history (revisions) stays LIVE — a version restore does not discard newer revisions')
  ok((r.comments as Rec)?.t1 === 'incoming', 'comments (keepLive override) FOLLOW the version')
  ok(r.mystery === 'incoming-x', 'an unknown field follows')
}

H('recover (crash): the newer snapshot wins content AND history; identity still live')
{
  const r = applyRestore(live(), incoming(), 'recover', RULES) as Rec
  ok(r.title === 'incoming title', 'content follows the newer snapshot')
  ok(r.docId === 'LIVE-ID', 'identity is still kept live on recover (same document)')
  ok(eq(r.revisions, incoming().revisions), 'history follows the snapshot on recover — a revision made just before the crash survives')
  ok((r.comments as Rec)?.t1 === 'incoming', 'comments follow the snapshot on recover')
}

H('recover of a WHOLE snapshot (the default): a deleted field stays removed — by EFFECTIVE keepLive, not class')
{
  // Every app's recovery snapshot is contentOnly(doc) — the WHOLE document minus
  // capability — so an absent field means the user DELETED it before the crash.
  // wholeSnapshot defaults true. Removal keys on EFFECTIVE keepLive, not class:
  // an effective-'follows' field (content, unknown, AND a history field OVERRIDDEN
  // to 'follows' like comments) absent → REMOVED; a history field at its default
  // 'live' keep (revisions) absent → kept live. (comments is the case security
  // required: a deleted comment/redaction must not resurrect and ride the next
  // shared copy. Regression first introduced in #701, partly fixed in #716.)
  const inc = incoming(); delete inc.body; delete inc.mystery; delete inc.revisions; delete inc.comments
  const r = applyRestore(live(), inc, 'recover', RULES) as Rec
  ok(!('body' in r), 'a CONTENT field the user deleted stays removed (not brought back)')
  ok(!('mystery' in r), 'an UNKNOWN field absent from the whole snapshot is removed too')
  ok(!('comments' in r), 'an OVERRIDDEN history field (comments, keepLive follows) deleted stays removed')
  ok(eq(r.revisions, live().revisions), 'but a DEFAULT-live history field (revisions) absent keeps the live value')
}

H('recover of a PROJECTION snapshot (wholeSnapshot:false): absent keeps live')
{
  // An incoming that legitimately omits fields it still has — a projection — must
  // not have those fields removed. The caller opts out of the whole-doc default.
  const PROJ: RestoreRules = { ...RULES, wholeSnapshot: false }
  const inc = incoming(); delete inc.body; delete inc.mystery; delete inc.revisions; delete inc.comments
  const r = applyRestore(live(), inc, 'recover', PROJ) as Rec
  ok(r.body === 'live body', 'a content field absent from a PROJECTION keeps live (never wiped)')
  ok(r.mystery === 'live-x', 'an unknown field absent from a projection keeps live')
  ok((r.comments as Rec)?.t1 === 'live', 'an overridden-to-follows history field (comments) absent from a projection keeps live')
  ok(eq(r.revisions, live().revisions), 'and history keeps live either way')
}

H('a back restore reflects the version exactly (wholeSnapshot does not apply)')
{
  const inc2 = incoming(); delete inc2.comments
  const r2 = applyRestore(live(), inc2, 'back', RULES) as Rec
  ok(!('comments' in r2), 'on back, a follows field the version lacks is dropped (the version had none)')
}

H('recover hooks: newestListWins (unsigned lists) vs the default (signed-safe)')
{
  const RH: RestoreRules = { classes: CLASSES, recover: { revisions: newestListWins } }
  // snapshot OLDER than live → keep the live list (a skewed older snapshot can't drop days/revisions)
  const older = applyRestore(live(), incoming(), 'recover', RH) as Rec
  ok(eq(older.revisions, live().revisions), 'newestListWins keeps the live list when the snapshot is older')
  // snapshot NEWER → take it
  const incNew = incoming({ revisions: [{ id: 'r1', at: '2026-01-01' }, { id: 'r2', at: '2026-02-01' }, { id: 'r3', at: '2026-03-01' }] })
  ok(((applyRestore(live(), incNew, 'recover', RH) as Rec).revisions as unknown[]).length === 3,
    'newestListWins takes the snapshot when it is newer (all three revisions)')
  // trim + re-sign makes a TIE on the newest `at`. newestListWins keeps live (the
  // untrimmed list), which for a SIGNED list would be wrong — hence the default.
  const liveFull: Rec = { ...live(), revisions: [{ id: 'r1', at: '2026-01-01' }, { id: 'r2', at: '2026-02-01' }, { id: 'r3', at: '2026-03-01' }] }
  const incTrim = incoming({ revisions: [{ id: 'r3', at: '2026-03-01' }] }) // trimmed + re-signed; same newest at
  ok(((applyRestore(liveFull, incTrim, 'recover', RH) as Rec).revisions as unknown[]).length === 3,
    'newestListWins resolves a tie to LIVE (never merges) — which is why a SIGNED list must NOT bind it')
  // the DEFAULT (no hook) follows the snapshot: the self-consistent trimmed+signed unit
  const def = (applyRestore(liveFull, incTrim, 'recover', { classes: CLASSES }) as Rec).revisions as Array<Rec>
  ok(def.length === 1 && def[0].id === 'r3', 'the default follows the snapshot — the self-consistent unit a signed list needs')
}

H('a recover hook is called ONLY when the snapshot HAS the field')
{
  let calls = 0
  const blind: RecoverHook = (_l, inc) => { calls++; return inc } // returns incoming (undefined if absent) blindly
  const RB: RestoreRules = { classes: CLASSES, recover: { revisions: blind } }
  // snapshot LACKS revisions → the hook must NOT run, live is kept untouched
  const inc = incoming(); delete inc.revisions
  const r = applyRestore(live(), inc, 'recover', RB) as Rec
  ok(calls === 0, 'the hook is not called when the snapshot lacks the field')
  ok(eq(r.revisions, live().revisions), 'and the live value is kept (a blind hook could not wipe it)')
  // snapshot HAS revisions → the hook runs
  applyRestore(live(), incoming(), 'recover', RB)
  ok(calls === 1, 'the hook runs when the snapshot has the field')
}

H('at is epoch-ms on both sides — a hook never compares a number to a string')
{
  // the caller normalises: live = Date.parse(doc.modified), incoming = snapshot.at (ms)
  const laterWins: RecoverHook = (lv, inc, at) => {
    ok(typeof at.incoming === 'number' && typeof at.live === 'number', 'the hook receives numeric times on both sides')
    return (at.incoming ?? 0) > (at.live ?? -Infinity) ? inc : lv
  }
  const RT: RestoreRules = { classes: CLASSES, recover: { revisions: laterWins } }
  const liveTime = Date.parse('2026-02-01T00:00:00Z')   // doc.modified normalised by the caller
  const snapNewer = Date.now()                           // Snapshot.at is ms
  const r1 = applyRestore(live(), incoming({ revisions: [{ id: 'z', at: 'x' }] }), 'recover', RT, { live: liveTime, incoming: snapNewer }) as Rec
  ok((r1.revisions as Array<Rec>)[0].id === 'z', 'a newer snapshot time wins, compared as numbers')
  const r2 = applyRestore(live(), incoming({ revisions: [{ id: 'z', at: 'x' }] }), 'recover', RT, { live: snapNewer, incoming: liveTime }) as Rec
  ok(eq(r2.revisions, live().revisions), 'an older snapshot time keeps live, compared as numbers')
}

H('a recovery snapshot cannot swap the prototype (__proto__ / constructor)')
{
  // JSON.parse gives an OWN __proto__ key — the snapshot is untrusted input
  const poison = JSON.parse('{"title":"x","__proto__":{"polluted":true},"constructor":{"c":1}}')
  const r = applyRestore(live(), poison, 'recover', RULES) as Rec
  ok(Object.getPrototypeOf(r) === Object.prototype, 'plain class map: the restored doc keeps a clean prototype')
  ok((r as Rec).polluted === undefined, 'no polluted field inherited')
  ok(({} as Rec).polluted === undefined, 'Object.prototype itself is untouched')
  // NULL-PROTO class map: the case that was safe only by an inherited lookup before
  const nullClasses = Object.assign(Object.create(null), CLASSES) as Record<string, FieldClass>
  const r2 = applyRestore(live(), poison, 'recover', { classes: nullClasses }) as Rec
  ok(Object.getPrototypeOf(r2) === Object.prototype, 'null-proto class map: still no prototype swap')
  ok((r2 as Rec).polluted === undefined, 'and no field leaks through')
}

H('the override floor: identity / mode / capability never follow a snapshot')
{
  // a hostile/buggy override trying to make capability + modes + identity follow
  const bad: RestoreRules = { classes: CLASSES, keepLive: { collab: 'follows', readonly: 'follows', docId: 'follows' } as Record<string, 'follows'> }
  const r = applyRestore(live(), incoming(), 'recover', bad) as Rec
  ok((r.collab as Rec)?.key === 'LIVE', 'a follows on collab (capability) is IGNORED — the room stays live')
  ok(r.readonly === false, 'a follows on readonly (mode) is ignored — the lock stays live')
  ok(r.docId === 'LIVE-ID', 'a follows on docId (identity) is ignored')
  const threw = (fn: () => void) => { try { fn(); return false } catch { return true } }
  ok(threw(() => validateRestoreRules(bad)), 'validateRestoreRules refuses a non-live override on a floor-class field')
  ok(!threw(() => validateRestoreRules(RULES)), 'and accepts a valid override (comments follows)')
}

// COMPILE-TIME floor: restoreOverrides constrains override keys to content/
// history fields. These must each be a type error (scripts are not type-checked
// in CI, so they document + locally verify; the real enforcement is at the app
// call sites — type/spaces build their rules with restoreOverrides under tsc).
// @ts-expect-error collab is capability, not content/history
restoreOverrides(CLASSES, { collab: 'follows' })
// @ts-expect-error docId is identity
restoreOverrides(CLASSES, { docId: 'live' })
// @ts-expect-error readonly is mode
restoreOverrides(CLASSES, { readonly: 'live' })
ok(restoreOverrides(CLASSES, { comments: 'follows' }).comments === 'follows',
  'restoreOverrides accepts a history field and constrains the rest at compile time')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
