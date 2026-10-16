#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash room-snapshot + inbound rig.
//
//   node scripts/test-dash-snapshot-collab.ts
//
// dash runs its OWN sync engine (dash/src/sync), so the kernel's fixes don't
// reach it. Three properties, mirroring the kernel's:
//   1. A room snapshot (relay upload + fork snap frame) never carries the
//      never-synced fields — the collab block first. A reader decrypts the
//      snapshot with its own key and finds no private-key material.
//   2. A remote op or snapshot can't ADOPT those fields (identity, modes,
//      capability, history) into an open workbook.
//   3. No prototype-shaped name off the wire reaches any object, and a
//      prototype-named actor can't throw in the frame handler.
//
// Mutations (verified by editing dash/src/sync and re-running; each fails by
// EXIT CODE): restore the whole-doc clone in snapshot(); drop the NEVER_SYNCED
// refusal in applySet; drop the prototype guards.

(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: () => {},
}
;(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {} }

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { SyncSession } = await import('../dash/src/sync/session.ts')
const { SYNC_V } = await import('../dash/src/sync/crdt.ts')
const { collabForReader } = await import('../kernel/src/docfields.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type Rec = Record<string, unknown>

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const H = (s: string) => console.log(`\n=== ${s} ===`)
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

const thrown: string[] = []
process.on('uncaughtException', (e) => { thrown.push(String((e as Error)?.message ?? e)) })

const roomKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const SECRETS = ['OWNER-PRIV-SECRET', 'INVITE-PRIV-SECRET']
const leaks = (x: unknown) => SECRETS.filter((s) => JSON.stringify(x).includes(s))

function book(id: string): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: id, title: 'Book',
    collab: {
      room: 'wOWNER', key: roomKey, owner: 'OWNER-PUB', writerPub: 'WP', on: true, v: 2,
      ownerPriv: { d: 'OWNER-PRIV-SECRET' }, invite: { role: 'writer', priv: { d: 'INVITE-PRIV-SECRET' } },
    },
    sheets: [{
      id: 'sh', kind: 'table', name: 'Data', rids: [[1, 1]], nextRid: 2,
      columns: [{ id: 'v', name: 'Value', type: 'number' }],
      data: { v: { enc: 'raw', v: [1] } }, steps: [],
    }],
  }))
  if (!r.ok) throw new Error('fixture')
  return r.doc
}

async function throughRoom(plain: unknown, readKey: string): Promise<unknown> {
  const k = (s: string) => crypto.subtle.importKey('raw', new Uint8Array(Buffer.from(s, 'base64url')), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await k(roomKey), new TextEncoder().encode(JSON.stringify(plain)))
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await k(readKey), ct)))
}

const session = (s: unknown) => s as {
  snapshot: () => { doc: Rec; state: { v: number; regs: Record<string, Record<string, unknown>> } }
  applySnapshot: (d: unknown, st: unknown) => void
  onFrame: (f: unknown) => void
  shipSnapshot: () => void
  addTransport: (mk: (docId: string, onFrame: (f: unknown) => void) => unknown) => unknown
  state: { vv: Rec }
  stop?: () => void
}
// A throw out of a frame handler is recorded and fails the rig by exit code; it
// must not abort the script (open channels would then keep the process alive).
const frame = (s: ReturnType<typeof session>, f: Rec) => {
  try { s.onFrame(f) } catch (e) { thrown.push(String((e as Error)?.message ?? e)) }
}
const snapApply = (s: ReturnType<typeof session>, d: unknown, st: unknown) => {
  try { s.applySnapshot(d, st) } catch (e) { thrown.push(String((e as Error)?.message ?? e)) }
}
process.on('unhandledRejection', (e) => { thrown.push(String((e as Error)?.message ?? e)) })

H('relay upload: the snapshot a READER decrypts carries no collab')
{
  const store = new Store(book(`d-${Math.random()}`))
  const s = session(new SyncSession(store))
  await settle(40)
  ok(leaks(store.doc).length > 0, 'control — the live workbook DOES hold its secrets')
  const snap = s.snapshot()
  const readerKey = (collabForReader(store.doc.collab as unknown as Rec) as { key: string }).key
  const seen = await throughRoom(snap, readerKey) as { doc: Rec }
  ok(!('collab' in seen.doc) && leaks(seen).length === 0, `decrypted with the reader key: no collab, no private keys (${leaks(seen).join(',') || 'none'})`)
  ok(!('docId' in seen.doc) && !('format' in seen.doc), 'identity / encoding fields are not in the snapshot either')
  ok(Array.isArray(seen.doc.sheets) && seen.doc.title === 'Book', 'content still rides the snapshot')
  s.stop?.()
}

H('fork snap frame: carries no collab')
{
  const store = new Store(book(`d-${Math.random()}`))
  const s = session(new SyncSession(store))
  const sent: Rec[] = []
  s.addTransport(() => ({ send: (f: Rec) => sent.push(f), close() {} }))
  await settle(40)
  s.shipSnapshot()
  const snaps = sent.filter((f) => f.t === 'snap')
  ok(snaps.length >= 1, `the fork snap was sent (${snaps.length})`)
  ok(snaps.every((f) => !('collab' in (f.doc as Rec)) && leaks(f).length === 0), 'no snap frame carries collab or private keys')
  s.stop?.()
}

H('a joiner converges from the stripped snapshot and keeps its own collab')
{
  const base = book(`d-${Math.random()}`)
  const A = new Store(clone(base)), sA = session(new SyncSession(A))
  const B = new Store(clone(base)), sB = session(new SyncSession(B))
  await settle(40)
  A.commit({ op: 'setTitle', title: 'retitled on A' } as never)
  await settle(40)
  const bCollab = JSON.stringify(B.doc.collab)
  const snap = sA.snapshot()
  sB.applySnapshot(snap.doc, snap.state)
  ok(B.doc.title === 'retitled on A', 'the joiner merged the content')
  ok(JSON.stringify(B.doc.collab) === bCollab, 'its own collab is untouched (a stripped key is not a delete)')
  sA.stop?.(); sB.stop?.()
}

H('a remote op or snapshot adopts no never-synced field')
{
  const HOSTILE: Rec = {
    collab: { room: 'wEVIL', key: 'EVIL' }, docId: 'EVIL-ID', readonly: true, template: true,
    revisions: [{ id: 'forged' }], trail: [1], format: 'evil', version: 999,
  }
  const F = Object.keys(HOSTILE)
  const store = new Store(book(`d-${Math.random()}`))
  const s = session(new SyncSession(store))
  await settle(40)
  const before = clone(Object.fromEntries(F.map((f) => [f, (store.doc as unknown as Rec)[f]])))
  const ops = F.map((k, i) => ({ a: 'evil', s: i + 1, l: 900000 + i, op: 'set', k, v: HOSTILE[k] }))
  ops.push({ a: 'evil', s: F.length + 1, l: 900000 + F.length, op: 'set', k: 'title', v: 'retitled by peer' })
  frame(s, { t: 'ops', a: 'evil', ops, pv: SYNC_V })
  await settle(40)
  const d = store.doc as unknown as Rec
  for (const f of F) ok(JSON.stringify(d[f]) === JSON.stringify(before[f]), `${f}: unchanged by a remote set`)
  ok(d.title === 'retitled by peer', 'a content set in the same frame still applies')

  // a snapshot with a VALID state and winning forged registers
  const peer = new Store(clone(store.doc)), sp = session(new SyncSession(peer))
  await settle(40)
  const snap = sp.snapshot()
  ok(snap.state.v === SYNC_V, 'the hostile snapshot carries a valid state')
  const rstate = clone(snap.state)
  rstate.regs['@doc'] ??= {}
  for (const [i, f] of [...F, 'title'].entries()) rstate.regs['@doc'][f] = [950000 + i, 'evil']
  const rdoc = { ...clone(snap.doc), ...clone(HOSTILE), title: 'retitled by snapshot' }
  snapApply(s, rdoc, rstate)
  for (const f of F) ok(JSON.stringify(d[f]) === JSON.stringify(before[f]), `${f}: unchanged by a remote snapshot`)
  ok(d.title === 'retitled by snapshot', 'a content register in the same snapshot still applies')
  s.stop?.(); sp.stop?.()
}

H('no prototype-shaped name reaches any object; prototype-named actors cannot throw')
{
  const objProtoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(',')
  const store = new Store(book(`d-${Math.random()}`))
  const s = session(new SyncSession(store))
  await settle(40)
  const EVIL = { readonly: true, collab: { room: 'rEVIL' } }
  let n = 0
  const op = (f: Rec) => ({ a: 'proto', s: ++n, l: 990000 + n, op: 'set', ...f })
  frame(s, { t: 'ops', a: 'proto', pv: SYNC_V, ops: [
    op({ k: '__proto__', v: EVIL }), op({ k: 'constructor', v: EVIL }), op({ k: 'measures.__proto__', v: EVIL }),
    op({ k: 'subtitle', v: JSON.parse('{"__proto__":{"readonly":true}}') }),
  ] })
  frame(s, { t: 'ops', a: 'proto', pv: SYNC_V, ops: [op({ k: 'title', v: 'after the hostile ops' })] })
  // actor ids, in and out of order (s=2 first reaches the gap buffer)
  for (const name of ['constructor', '__proto__', 'prototype']) {
    frame(s, { t: 'ops', a: name, pv: SYNC_V, ops: [
      { a: name, s: 2, l: 1, op: 'set', k: 'title', v: `gap ${name}` }, { a: name, s: 1, l: 1, op: 'set', k: 'title', v: name },
    ] })
  }
  // a poisoned snapshot is refused whole
  const peer = new Store(clone(store.doc)), sp = session(new SyncSession(peer))
  await settle(40)
  const snap = sp.snapshot()
  const rstate = clone(snap.state)
  ;(rstate.regs['@doc'] ??= {})['__proto__'] = [999999, 'evil']
  snapApply(s, { ...clone(snap.doc), title: 'poisoned' }, rstate)
  await settle(40)
  const d = store.doc as unknown as Rec
  ok(thrown.length === 0, `no throw from any frame (${thrown.join(' | ') || 'none'})`)
  ok(Object.getOwnPropertyNames(Object.prototype).sort().join(',') === objProtoBefore, 'Object.prototype gained nothing')
  ok(Object.getPrototypeOf(d) === Object.prototype && d.readonly !== true, 'the doc keeps its prototype; readonly does not appear')
  ok(!Object.hasOwn(d, 'constructor') && d.subtitle === undefined, 'no constructor field; a payload carrying a __proto__ key is refused')
  ok(!d.measures || Object.getPrototypeOf(d.measures) === Object.prototype, 'the measures map keeps its prototype')
  ok(!['constructor', '__proto__', 'prototype'].some((x) => Object.hasOwn(s.state.vv, x)), 'no prototype-named actor in the version vector')
  ok(d.title === 'after the hostile ops', 'the sender’s next op still delivered; the poisoned snapshot changed nothing')
  s.stop?.(); sp.stop?.()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
