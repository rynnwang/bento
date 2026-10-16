#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash SYNC INBOUND rig — a peer cannot set this copy's room, identity
// or permissions.
//
//   node scripts/test-dash-sync-inbound.ts
//
// WHY THIS EXISTS. The sync engine wrote ANY document-level key a remote
// `set` op named, and adopted any document-level register a snapshot carried.
// So a sender could make every receiver take on THE SENDER'S `collab` — room,
// keys and role — or its docId, or lock it read-only, and the receiver's next
// save wrote that into their own file. Senders: any writer through the relay,
// and, with no signature at all, any page on the same origin through the
// BroadcastChannel — which on file:// is every local document. Three routes,
// one row each: a relay op (the engine), a snapshot (the engine), and a frame
// injected on the BroadcastChannel into a real SyncSession.

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

// One in-process bus standing in for the browser's BroadcastChannel: any
// "page" that opens the same name receives what the others post.
const bus = new Map<string, Set<FakeChannel>>()
class FakeChannel {
  name: string
  onmessage: ((ev: { data: unknown }) => void) | null = null
  constructor(name: string) { this.name = name; (bus.get(name) ?? bus.set(name, new Set()).get(name)!).add(this) }
  postMessage(data: unknown) {
    for (const c of bus.get(this.name) ?? []) if (c !== this) c.onmessage?.({ data: JSON.parse(JSON.stringify(data)) })
  }
  close() { bus.get(this.name)?.delete(this) }
}
;(globalThis as { BroadcastChannel: unknown }).BroadcastChannel = FakeChannel

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { DashSync, SYNC_V, DOC_NODE, LOCAL_ONLY_DOC_KEYS, isUnsafeKey, colNode, shNode } = await import('../dash/src/sync/crdt.ts')
const { SyncSession } = await import('../dash/src/sync/session.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const MINE = { room: 'w-MINE', key: 'k-mine', on: true, owner: 'o-mine', ownerPriv: 'p-mine', v: 2 }
const EVIL = { room: 'w-EVIL', key: 'k-evil', on: true, owner: 'o-evil', ownerPriv: 'p-evil', v: 2 }
const fresh = (): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'doc-mine', title: 'Mine', collab: MINE,
    sheets: [{
      id: 'sh', kind: 'table', name: 'Data', rids: [[1, 1]], nextRid: 2,
      columns: [{ id: 'v', name: 'Value', type: 'number' }],
      data: { v: { enc: 'raw', v: [1] } }, steps: [],
    }],
  }))
  if (!r.ok) throw new Error('fixture')
  return r.doc
}
/** What the attacker tries to plant, one op per key, plus a legitimate title. */
const HOSTILE: Array<[string, unknown]> = [
  ['collab', EVIL], ['collab.room', 'w-EVIL'], ['docId', 'doc-EVIL'], ['readonly', true],
  ['template', true], ['format', 'bento/slides'], ['version', 99], ['policy', 'evil'],
  ['modified', '1999-01-01T00:00:00Z'], ['revisions', [{ evil: true }]], ['trail', [{ evil: true }]],
]
const intact = (d: DashDoc, where: string) => {
  const c = (d as { collab?: { room?: string; key?: string; ownerPriv?: string } }).collab
  ok(c?.room === 'w-MINE' && c?.key === 'k-mine' && c?.ownerPriv === 'p-mine', `${where}: my room and keys are still mine — got ${c?.room}`)
  ok(d.docId === 'doc-mine', `${where}: my docId — got ${d.docId}`)
  ok(!(d as { readonly?: boolean }).readonly && !(d as { template?: boolean }).template, `${where}: not locked, not turned into a template`)
  ok(d.format === 'bento/dash' && d.version === 1 && (d as { policy?: string }).policy === 'bento-dash-1', `${where}: format, version and policy untouched`)
  ok((d as { modified?: string }).modified !== '1999-01-01T00:00:00Z' && !('revisions' in d) && !('trail' in d),
    `${where}: modified, revisions and trail not written by the sender`)
  // A dotted key does not reach INTO collab (writeKey treats it as a literal
  // top-level name), but it would leave a junk "collab.room" key in the
  // document that the next save writes into the file.
  const stray = Object.keys(d).filter((k) => k.includes('.'))
  ok(stray.length === 0, `${where}: no stray dotted top-level keys — got ${stray.join(',') || 'none'}`)
}
const evilOps = (from = 1) => [
  ...HOSTILE.map(([k, v], i) => ({ op: 'set' as const, a: 'evil', s: from + i, l: 10_000 + i, k, v })),
  // control: an ordinary doc-level edit in the SAME batch still lands
  { op: 'set' as const, a: 'evil', s: from + HOSTILE.length, l: 20_000, k: 'title', v: 'Retitled by a peer' },
]

ok([...LOCAL_ONLY_DOC_KEYS].sort().join() === 'collab,docId,format,modified,policy,readonly,revisions,template,trail,version',
  'ten keys belong to the copy, not the room; adding or removing one is a decision')

console.log('\n1. a relay op (any writer) — the engine')
{
  const doc = fresh()
  const st = new DashSync('victim')
  st.adopt(doc)
  st.apply(doc, evilOps())
  intact(doc, 'relay op')
  ok(doc.title === 'Retitled by a peer', 'the ordinary title edit in the same batch still applied — the refusal is per key, not per batch')
  ok(st.vv.evil === HOSTILE.length + 1, `delivery still advanced past the refused ops (vv ${st.vv.evil}) — no gap, no "need" storm`)
}

console.log('\n2. a snapshot carrying registers for them — the engine')
{
  const doc = fresh()
  const st = new DashSync('victim')
  st.adopt(doc)
  const rdoc = { ...fresh(), collab: EVIL, docId: 'doc-EVIL', readonly: true, template: true, title: 'Retitled by a snapshot' } as DashDoc
  const regs: Record<string, [number, string]> = { title: [30_000, 'evil'] }
  for (const [k] of HOSTILE) regs[k] = [30_000, 'evil']
  st.mergeSnapshot(doc, rdoc, { v: SYNC_V, lamport: 30_000, vv: { evil: 1 }, regs: { [DOC_NODE]: regs } } as never)
  intact(doc, 'snapshot')
  ok(doc.title === 'Retitled by a snapshot', 'the snapshot\'s ordinary title register still merged')
}

console.log('\n3. BroadcastChannel injection — another local page, no signature, into a real session')
{
  const store = new Store(fresh())
  new SyncSession(store)
  const evilPage = new FakeChannel('bento-sync-doc-mine')
  // `pv` is the protocol version every frame carries; a hostile page sets it too
  evilPage.postMessage({ pv: SYNC_V, t: 'ops', a: 'evil', ops: evilOps() })
  await new Promise((r) => setTimeout(r, 150))
  intact(store.doc, 'BroadcastChannel ops')
  ok(store.doc.title === 'Retitled by a peer', 'and the channel really delivered: the title in the same frame landed')
  const rdoc = { ...fresh(), collab: EVIL, docId: 'doc-EVIL', readonly: true, title: 'Snap title' } as DashDoc
  const regs: Record<string, [number, string]> = { title: [40_000, 'evil2'] }
  for (const [k] of HOSTILE) regs[k] = [40_000, 'evil2']
  evilPage.postMessage({ pv: SYNC_V, t: 'snap', a: 'evil2', doc: rdoc, state: { v: SYNC_V, lamport: 40_000, vv: { evil2: 1 }, regs: { [DOC_NODE]: regs } } })
  await new Promise((r) => setTimeout(r, 150))
  intact(store.doc, 'BroadcastChannel snapshot')
  ok(store.doc.title === 'Snap title', 'and the snapshot frame really merged: its title landed')
}

console.log('\n5. PROTOTYPE KEYS: __proto__, constructor and prototype are never keys')
// `target[k] = v` with k "__proto__" REPLACES the prototype: doc.readonly would
// read true and doc.collab the sender's room through inheritance, with nothing
// on the document to show it. And `map[node] ??= {}` with node "constructor"
// resolves to the inherited Object function, so the write lands on Object for
// the whole page. JSON.parse is how a frame arrives, and it makes "__proto__"
// an OWN key, which is exactly the shape a real attacker sends.
{
  const clean = () => {
    ok(Object.getPrototypeOf({}) === Object.prototype && !('readonly' in Object.prototype) && !('collab' in Object.prototype)
      && !('room' in Object.prototype) && (Object as unknown as { pwned?: unknown }).pwned === undefined,
      'nothing on Object or Object.prototype was touched')
  }
  const protoIntact = (d: DashDoc, where: string) => {
    ok(Object.getPrototypeOf(d) === Object.prototype, `${where}: the document's prototype is still Object.prototype`)
    ok((d as { readonly?: unknown }).readonly === undefined, `${where}: doc.readonly does not read true through inheritance`)
    const c = (d as { collab?: { room?: string } }).collab
    ok(c?.room === 'w-MINE', `${where}: doc.collab is still mine — got ${c?.room}`)
  }
  const evilPayload = { readonly: true, collab: EVIL, pwned: true }
  const hostile = JSON.parse(JSON.stringify([
    { op: 'set', a: 'evil', s: 1, l: 50_000, k: '__proto__', v: evilPayload },
    { op: 'set', a: 'evil', s: 2, l: 50_001, k: 'names.__proto__', v: evilPayload },
    { op: 'set', a: 'evil', s: 3, l: 50_002, n: 'constructor', k: 'pwned', v: true },
    { op: 'set', a: 'evil', s: 4, l: 50_003, n: shNode('sh'), k: 'prototype', v: evilPayload },
    { op: 'cell', a: 'evil', s: 5, l: 50_004, sh: 'sh', col: '__proto__', rids: [1], v: [1] },
    { op: 'ovr', a: 'evil', s: 6, l: 50_005, sh: 'sh', keys: ['__proto__:1'], v: [evilPayload], m: [0] },
    { op: 'title-control' },
  ]).replace('{"op":"title-control"}', JSON.stringify({ op: 'set', a: 'evil', s: 7, l: 50_006, k: 'title', v: 'After the bad ops' })))
  // an op from an actor CALLED __proto__ — keys `vv` and `gap` before anything else
  const badActor = JSON.parse('[{"op":"set","a":"__proto__","s":1,"l":1,"k":"title","v":"x"},{"op":"set","a":"constructor","s":1,"l":1,"k":"title","v":"x"}]')
  // a node payload with an OWN "__proto__" key, as JSON.parse delivers it
  const badIns = JSON.parse(JSON.stringify({ op: 'ins', a: 'evil', s: 8, l: 50_007, n: colNode('sh', 'z'), ord: 'V', node: { id: 'z', name: 'Z', type: 'number' } })
    .replace('"type":"number"', '"type":"number","__proto__":{"readonly":true}'))
  ok(Object.prototype.hasOwnProperty.call(badIns.node, '__proto__'), 'the fixture really carries an OWN __proto__ key, as a parsed frame would')

  {
    // CONTROL for the ins row: the same op without the __proto__ key inserts
    const d0 = fresh(); const s0 = new DashSync('victim'); s0.adopt(d0)
    s0.apply(d0, [{ op: 'ins', a: 'ok', s: 1, l: 1, n: colNode('sh', 'z'), ord: 'V', node: { id: 'z', name: 'Z', type: 'number' } } as never])
    ok((d0.sheets[0] as { columns: Array<{ id: string }> }).columns.some((c) => c.id === 'z'),
      'CONTROL — a clean column insert through the same path does land (so the refusal below is not vacuous)')
  }
  const doc = fresh()
  const st = new DashSync('victim')
  st.adopt(doc)
  st.apply(doc, [...hostile, badIns])
  let actorThrew: unknown = null
  try { st.apply(doc, badActor) } catch (e) { actorThrew = e }
  ok(actorThrew === null, `ops from actors named __proto__/constructor do not crash apply${actorThrew ? ' — threw ' + (actorThrew as Error).message : ''}`)
  // an OUT-OF-ORDER op from an actor called "constructor": the gap buffer is
  // `this.gap[a] ??= []`, which for that name resolves to the inherited Object
  // function — and `.some` on it throws, taking the whole apply down
  let threw: unknown = null
  try { st.apply(doc, JSON.parse('[{"op":"set","a":"constructor","s":5,"l":2,"k":"title","v":"x"}]')) } catch (e) { threw = e }
  ok(threw === null, `an out-of-order op from actor "constructor" does not crash apply${threw ? ' — threw ' + (threw as Error).message : ''}`)
  ok(!Object.prototype.hasOwnProperty.call(st.vv, 'constructor') && !Object.prototype.hasOwnProperty.call(st.vv, '__proto__'),
    `and neither name became a version-vector entry, which is saved into the file and sent to every peer — vv keys: ${Object.keys(st.vv).join(',')}`)
  protoIntact(doc, 'relay ops')
  ok(doc.title === 'After the bad ops', 'the ordinary op after them still landed — refused ops still count as delivered')
  ok(st.vv.evil === 8, `delivery advanced through all eight (vv ${st.vv.evil}), so no gap and no "need" storm`)
  ok(!('__proto__' in st.vv && Object.prototype.hasOwnProperty.call(st.vv, '__proto__')) && st.vv.constructor === Object,
    'an actor named __proto__ or constructor never became a version-vector entry')
  const sheet = doc.sheets[0] as { columns: Array<{ id: string }>; data: Record<string, unknown> }
  ok(Object.getPrototypeOf(sheet.data) === Object.prototype && !sheet.columns.some((c) => c.id === 'z'),
    'the column with an own __proto__ key was not inserted, and the sheet\'s data map keeps its prototype')
  clean()

  // snapshots: a register named __proto__, a doc with an own __proto__ key,
  // a node id "constructor" in the state — each refuses the whole snapshot
  for (const [what, rdocJson, regs] of [
    ['a __proto__ register', JSON.stringify({ ...fresh(), title: 'Snap' }).replace('"title"', '"title"'), JSON.parse('{"@doc":{"__proto__":[60000,"evil"],"title":[60000,"evil"]}}')],
    ['a document with an own __proto__ key', JSON.stringify({ ...fresh(), title: 'Snap' }).replace('{', '{"__proto__":{"readonly":true,"collab":{"room":"w-EVIL"}},'), { [DOC_NODE]: { title: [60_000, 'evil'] } }],
    ['a node id "constructor"', JSON.stringify({ ...fresh(), title: 'Snap' }), { constructor: { pwned: [60_000, 'evil'] }, [DOC_NODE]: { title: [60_000, 'evil'] } }],
  ] as const) {
    const d = fresh()
    const s2 = new DashSync('victim')
    s2.adopt(d)
    const state = JSON.parse(JSON.stringify({ v: SYNC_V, lamport: 60_000, vv: { evil: 1 }, regs }))
    s2.mergeSnapshot(d, JSON.parse(rdocJson), state)
    protoIntact(d, `snapshot with ${what}`)
    ok(d.title === 'Mine', `snapshot with ${what}: refused whole — not even its title merged`)
  }
  clean()

  // and through the BroadcastChannel into a real session
  const store = new Store(fresh())
  new SyncSession(store)
  const page = new FakeChannel('bento-sync-doc-mine')
  page.postMessage({ pv: SYNC_V, t: 'ops', a: 'evil3', ops: hostile.map((o: { a: string }) => ({ ...o, a: 'evil3' })) })
  await new Promise((r) => setTimeout(r, 150))
  protoIntact(store.doc, 'BroadcastChannel')
  ok(store.doc.title === 'After the bad ops', 'and the channel delivered: the ordinary op landed')
  clean()

  ok(isUnsafeKey('a.__proto__') && isUnsafeKey('c\u001fconstructor') && !isUnsafeKey('Constructor') && !isUnsafeKey('my_prototype_x'),
    'segments are matched exactly — "Constructor" and "my_prototype_x" are ordinary names')
}

console.log('\n6. OUTBOUND: the snapshot every reader receives carries none of them')
// session.snapshot() is the one builder for the relay upload and the fork
// `snap` frame. A reader holds the room key and can decrypt it, so the owner's
// collab block (ownerPriv) must not be in it. The doc REGISTERS go too: a
// register with no value beside it reads as a DELETE to an older client that
// lacks the inbound refusal, which would strip that client's own room.
{
  const store = new Store(fresh())
  const sess = new SyncSession(store) as unknown as { snapshot(): { doc: Record<string, unknown>; state: { regs?: Record<string, Record<string, unknown>> } }; state: { regs: Record<string, Record<string, unknown>> } }
  // plant registers for local-only keys the way a tampered or future state could hold them
  ;(sess.state.regs[DOC_NODE] ??= {}).collab = [1, 'x']
  sess.state.regs[DOC_NODE].docId = [1, 'x']
  sess.state.regs[DOC_NODE].title = [1, 'x']
  const snap = sess.snapshot()
  const leaked = [...LOCAL_ONLY_DOC_KEYS].filter((k) => k in snap.doc)
  ok(leaked.length === 0, `the snapshot document carries none of the local-only fields — leaked: ${leaked.join(',') || 'none'}`)
  ok(!JSON.stringify(snap).includes('p-mine'), 'the owner\'s private key appears nowhere in the snapshot, at any depth')
  const regs = snap.state.regs?.[DOC_NODE] ?? {}
  ok(!('collab' in regs) && !('docId' in regs), 'nor do their registers, which an older client would read as a delete')
  ok('title' in regs && Array.isArray((snap.doc as { sheets?: unknown[] }).sheets), 'content and ordinary registers are still there')
  ok((store.doc as { collab?: { ownerPriv?: string } }).collab?.ownerPriv === 'p-mine', 'and the LIVE workbook keeps its own keys — only the outbound copy is stripped')
}

console.log('\n4. the outbound guard does not block ordinary doc-level edits')
// The emitter's guard (`localOne`'s push) has NO reachable trigger today: the
// only doc-level ops dash emits are `title` and `measures.*`. It is defence for
// a future patch kind, so this row checks only that it costs nothing — it is
// deliberately not counted as coverage of the guard.
{
  const doc = fresh()
  const st = new DashSync('me')
  st.adopt(doc)
  const ops = [
    ...st.local(doc, [{ op: 'setMeasure', name: 'm', measure: { expr: '1' } }] as never),
    ...st.local(doc, [{ op: 'setTitle', title: 'x' }] as never),
  ]
  ok(ops.map((o) => (o as { k?: string }).k).join() === 'measures.m,title', 'measures and title still go out')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
// a SyncSession keeps heartbeat timers; exit explicitly so a clean run is not a hang
process.exit(failures ? 1 : 0)
