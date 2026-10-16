#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inbound doc-field rig: a remote op or snapshot can't rewrite identity,
// capability, modes or history in an open deck.
//
//   node scripts/test-sync-inbound-docfields.ts
//
// The engine's doc-level apply used to write ANY key a remote op named. A
// writer over the relay, or any page on the unsigned same-machine channel,
// could replace the room keys, rewrite docId, or flip readonly / template in a
// victim's open deck, and the next save would write it to the file. The never-
// synced set (crdt.ts skipDoc) is now also the RECEIVE filter: applySet and
// mergeSnapshot refuse it. This rig sends a hostile frame per field over the
// real BroadcastChannel and straight into the session, then a hostile snapshot
// with a VALID state, against both the slides and spaces bindings; content
// still applies on every path.
//
// Mutations (verified by editing kernel/src/sync/crdt.ts and re-running):
// remove the applySet refusal → the ops rows red; remove the mergeSnapshot
// refusal → the snapshot rows red.

(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: () => {},
};
(globalThis as unknown as { document: unknown }).document = { hidden: false, addEventListener() {} };

const { register } = await import('node:module');
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { Store } = await import('../slides/src/store.ts');
const { SyncSession } = await import('../slides/src/sync/session.ts');
const { newDoc } = await import('../slides/src/model.ts');
const { SYNC_V } = await import('../kernel/src/sync/crdt.ts');

let failures = 0, checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`);
}
const H = (s: string) => console.log(`\n=== ${s} ===`);
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// what a hostile peer would like to put into the victim's open deck
const HOSTILE: Record<string, unknown> = {
  collab: { room: 'wEVIL', key: 'EVIL-KEY', ownerPriv: { d: 'EVIL' }, on: true, v: 2 },
  docId: 'EVIL-DOC-ID',
  readonly: true,
  template: true,
  revisions: [{ id: 'forged', at: 't', body: {} }],
  trail: [{ forged: true }],
  modified: '1999-01-01',
  format: 'evil/format',
  version: 999,
  // an unknown policy freezes the document read-only on its next open
  policy: 'evil-policy-freezes-on-open',
};
const FIELDS = Object.keys(HOSTILE);

function victimDoc() {
  const d = newDoc();
  d.docId = `victim-${Math.random().toString(36).slice(2, 8)}`;
  d.title = 'mine';
  (d as unknown as { collab: unknown }).collab = { room: 'wMINE', key: 'MY-KEY', ownerPriv: { d: 'MINE' }, on: true, v: 2 };
  return d;
}
type Rec = Record<string, unknown>;
const pick = (d: Rec) => Object.fromEntries(FIELDS.map((f) => [f, d[f]]));
/** Did field `f` resist the peer? `modified` is re-stamped with the RECEIVER's
 *  own clock on every remote change (session afterRemoteChange, by design), so
 *  for it the test is that the peer's value never lands; every other field must
 *  be exactly what it was. */
const held = (f: string, before: Rec, after: Rec) =>
  f === 'modified' ? after[f] !== HOSTILE.modified : JSON.stringify(after[f]) === JSON.stringify(before[f]);

/** ops a hostile actor `a` sends: one set per never-synced field, then a content set */
function hostileOps(a: string) {
  const ops = FIELDS.map((k, i) => ({ a, s: i + 1, l: 100000 + i, op: 'set', k, v: clone(HOSTILE[k]) }));
  ops.push({ a, s: FIELDS.length + 1, l: 100000 + FIELDS.length, op: 'set', k: 'title', v: 'retitled by peer' });
  return ops;
}

H('a hostile ops frame, straight into the session, adopts nothing never-synced');
{
  const store = new Store(victimDoc());
  const s = new SyncSession(store);
  await settle(40);
  const before = clone(pick(store.doc as unknown as Rec));
  (s as unknown as { onFrame: (f: unknown) => void }).onFrame({ t: 'ops', a: 'evil', ops: hostileOps('evil'), pv: SYNC_V });
  await settle(40);
  const after = pick(store.doc as unknown as Rec);
  for (const f of FIELDS) ok(held(f, before, after), `${f}: unchanged by a remote set`);
  ok(store.doc.title === 'retitled by peer', 'a CONTENT set in the same frame still applies');
  s.stop?.();
}

H('the same frame over the real BroadcastChannel (a page on this machine)');
{
  const store = new Store(victimDoc());
  const s = new SyncSession(store);
  await settle(80);
  const before = clone(pick(store.doc as unknown as Rec));
  const ch = new BroadcastChannel(`bento-sync-${store.doc.docId}`);
  ch.postMessage({ t: 'ops', a: 'evil-tab', ops: hostileOps('evil-tab'), pv: SYNC_V });
  await settle(200);
  const after = pick(store.doc as unknown as Rec);
  ok(FIELDS.every((f) => held(f, before, after)),
    `no never-synced field changed (${FIELDS.filter((f) => !held(f, before, after)).join(',') || 'none'})`);
  ok(store.doc.title === 'retitled by peer', 'the content set still applies over the channel');
  ch.close(); s.stop?.();
}

H('a prototype-shaped name cannot reach any object, at any level');
{
  const doc = victimDoc();
  const sl = (doc as unknown as { slides: Array<{ id: string; elements: Rec[] }> }).slides[0];
  sl.elements.push({ id: 'e1', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'hi' });
  doc.assets = { logo: 'data:,x' } as never;
  const store = new Store(doc);
  const s = new SyncSession(store);
  await settle(40);
  const send = (a: string, ops: Rec[]) => (s as unknown as { onFrame: (f: unknown) => void }).onFrame({ t: 'ops', a, ops, pv: SYNC_V });
  const EVIL = { readonly: true, template: true, collab: { room: 'rEVIL' } };
  let n = 0;
  const op = (fields: Rec) => ({ a: 'proto', s: ++n, l: 200000 + n, op: 'set', ...fields });
  send('proto', [
    op({ k: '__proto__', v: EVIL }),                                   // doc level
    op({ k: 'constructor', v: EVIL }),
    op({ k: 'prototype', v: EVIL }),
    op({ k: 'assets.__proto__', v: EVIL }),                            // dotted map sub-key
    op({ sl: sl.id, k: '__proto__', v: EVIL }),                        // slide level
    op({ el: `${sl.id}\u001fe1`, k: '__proto__', v: EVIL }),           // element level
    op({ k: 'subtitle', v: JSON.parse('{"__proto__":{"readonly":true}}') }), // a payload KEY
    op({ k: 'subtitle2', v: (() => {                                   // a NAMED key on an array
      const a: unknown[] = [1, 2, 3];                                  // (structured clone keeps one)
      Object.defineProperty(a, '__proto__', { value: { readonly: true }, enumerable: true, configurable: true, writable: true });
      return a;
    })() }),
    op({ k: 'subtitle3', v: (() => {                                   // a named NON-proto array key
      const a = [1, 2, 3] as unknown[] & { x?: unknown };              // whose VALUE carries one
      a.x = JSON.parse('{"__proto__":{"readonly":true}}');
      return a;
    })() }),
    op({ k: 'deep', v: (() => {                                        // __proto__ 70 levels down —
      let o: unknown = JSON.parse('{"__proto__":{"readonly":true}}');  // past the scan's depth cap,
      for (let i = 0; i < 70; i++) o = { n: o };                       // which must REFUSE, not pass
      return o;
    })() }),
  ]);
  // the same sender's next op must still deliver — the guard consumes, never stalls
  send('proto', [op({ k: 'title', v: 'after the hostile ops' })]);
  // and an actor id that is itself a prototype name is ignored without throwing
  let threw = false;
  try { send('__proto__', [{ a: '__proto__', s: 1, l: 1, op: 'set', k: 'title', v: 'from __proto__' }]); } catch { threw = true; }
  await settle(40);
  const d = store.doc as unknown as Rec;
  const slide = (d.slides as Array<Rec>)[0];
  const el = (slide.elements as Rec[]).find((e) => e.id === 'e1')!;
  ok(Object.getPrototypeOf(d) === Object.prototype, 'the doc keeps its plain prototype');
  ok(d.readonly !== true && d.template !== true && (d.collab as Rec)?.room !== 'rEVIL', 'readonly/template/collab do not appear through inheritance');
  ok(!Object.hasOwn(d, 'constructor') && !Object.hasOwn(d, 'prototype'), 'no own constructor/prototype field was written');
  ok(Object.getPrototypeOf(d.assets) === Object.prototype, 'the assets map keeps its prototype (dotted sub-key refused)');
  ok(Object.getPrototypeOf(slide) === Object.prototype, 'the slide keeps its prototype');
  ok(Object.getPrototypeOf(el) === Object.prototype, 'the element keeps its prototype');
  ok(d.subtitle === undefined, 'an op whose payload carries a __proto__ KEY is refused');
  ok(d.subtitle2 === undefined, 'an array payload with a NAMED __proto__ key is refused (arrays are walked by element)');
  ok(d.subtitle3 === undefined, 'an array whose named NON-proto key holds a __proto__ key is refused (named keys are walked)');
  ok(d.deep === undefined, 'a __proto__ key nested past the depth cap is refused (the cap fails closed)');
  ok(d.title === 'after the hostile ops', 'the sender’s next op still delivered (consumed, not stalled)');
  ok(!threw && d.title !== 'from __proto__', 'a prototype-named actor is ignored, without throwing');
  s.stop?.();
}

H('prototype-named actor and node ids: no throw, no pollution, vv clean');
{
  // An uncaught throw inside a frame handler (BroadcastChannel delivers async)
  // must FAIL this rig by exit code, not slip past as a log line.
  const thrown: string[] = [];
  const onUncaught = (e: unknown) => { thrown.push(String((e as Error)?.message ?? e)); };
  process.on('uncaughtException', onUncaught);
  const objProtoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(',');

  const doc = victimDoc();
  const sl = (doc as unknown as { slides: Array<{ id: string; elements: Rec[] }> }).slides[0];
  const store = new Store(doc);
  const s = new SyncSession(store);
  await settle(80);
  const direct = (f: Rec) => { try { (s as unknown as { onFrame: (f: unknown) => void }).onFrame({ pv: SYNC_V, ...f }); } catch (e) { thrown.push(String((e as Error).message)); } };
  const ch = new BroadcastChannel(`bento-sync-${store.doc.docId}`);
  for (const name of ['constructor', '__proto__', 'prototype']) {
    // actor id: in order AND out of order (s=2 first reaches the gap buffer)
    const actorOps = [{ a: name, s: 2, l: 500002, op: 'set', k: 'title', v: `gap from ${name}` },
      { a: name, s: 1, l: 500001, op: 'set', k: 'title', v: `from ${name}` }];
    direct({ t: 'ops', a: name, ops: actorOps });
    ch.postMessage({ t: 'ops', a: name, ops: actorOps, pv: SYNC_V });
    // node ids, from a clean actor, out of order so `pending` is reached
    const clean = `clean-${name.replace(/_/g, '')}`;
    direct({ t: 'ops', a: clean, ops: [
      { a: clean, s: 1, l: 510001, op: 'set', sl: name, k: 'title', v: 'x' },
      { a: clean, s: 2, l: 510002, op: 'set', el: `${sl.id}\u001f${name}`, k: 'x', v: 1 },
      { a: clean, s: 3, l: 510003, op: 'set', el: `${name}\u001fe9`, k: 'x', v: 1 },
      { a: clean, s: 4, l: 510004, op: 'del', kind: 'slide', id: name },
    ] });
  }
  // the clean control still applies
  direct({ t: 'ops', a: 'control', ops: [{ a: 'control', s: 1, l: 600000, op: 'set', k: 'title', v: 'control applied' }] });
  await settle(250);
  process.off('uncaughtException', onUncaught);
  ch.close();

  const d = store.doc as unknown as Rec;
  const vv = (s as unknown as { state: { vv: Rec } }).state.vv;
  ok(thrown.length === 0, `no throw from any frame (${thrown.join(' | ') || 'none'})`);
  ok(Object.getOwnPropertyNames(Object.prototype).sort().join(',') === objProtoBefore, 'Object.prototype gained nothing');
  ok(Object.getPrototypeOf(d) === Object.prototype, 'the doc keeps its prototype');
  ok(!['constructor', '__proto__', 'prototype'].some((n) => Object.hasOwn(vv, n)), 'no prototype-named actor entered the version vector');
  ok(d.title === 'control applied', 'a clean control op still applies afterwards');
  s.stop?.();
}

H('the named-array-key and depth edges also hold over the real BroadcastChannel');
{
  // structured clone is what can deliver a NAMED array key, so prove that path
  const store = new Store(victimDoc());
  const s = new SyncSession(store);
  await settle(80);
  const arr = [1, 2, 3] as unknown[] & { x?: unknown };
  arr.x = JSON.parse('{"__proto__":{"readonly":true}}');
  let deep: unknown = JSON.parse('{"__proto__":{"readonly":true}}');
  for (let i = 0; i < 70; i++) deep = { n: deep };
  const ch = new BroadcastChannel(`bento-sync-${store.doc.docId}`);
  ch.postMessage({ t: 'ops', a: 'bc-edge', pv: SYNC_V, ops: [
    { a: 'bc-edge', s: 1, l: 700001, op: 'set', k: 'namedArr', v: arr },
    { a: 'bc-edge', s: 2, l: 700002, op: 'set', k: 'deepBC', v: deep },
    { a: 'bc-edge', s: 3, l: 700003, op: 'set', k: 'title', v: 'bc control' },
  ] });
  await settle(200);
  const d = store.doc as unknown as Rec;
  ok(d.namedArr === undefined && d.deepBC === undefined, 'over the channel: both edge payloads refused');
  ok(d.title === 'bc control' && Object.getPrototypeOf(d) === Object.prototype, 'the control applied; the doc keeps its prototype');
  ch.close(); s.stop?.();
}

H('a snapshot carrying a prototype-shaped key is refused whole');
{
  const store = new Store(victimDoc());
  const s = new SyncSession(store);
  await settle(40);
  const peer = new Store(clone(store.doc));
  const sp = new SyncSession(peer);
  await settle(40);
  const snap = (sp as unknown as { snapshot: () => { doc: Rec; state: { regs: Rec } } }).snapshot();
  const rstate = clone(snap.state);
  rstate.regs['@doc __proto__'] = [400000, 'evil'];
  rstate.regs['@doc title'] = [400001, 'evil'];
  const rdoc: Rec = { ...clone(snap.doc), title: 'retitled by a poisoned snapshot' };
  Object.defineProperty(rdoc, '__proto__', { value: { readonly: true }, enumerable: true, configurable: true, writable: true });
  (s as unknown as { applySnapshot: (d: unknown, st: unknown) => void }).applySnapshot(rdoc, rstate);
  const d = store.doc as unknown as Rec;
  ok(Object.getPrototypeOf(d) === Object.prototype && d.readonly !== true, 'the doc keeps its prototype; readonly does not appear');
  ok(d.title === 'mine', 'nothing from the poisoned snapshot landed — not even its content register');
  s.stop?.(); sp.stop?.();
}

H('a hostile SNAPSHOT with a valid state adopts nothing never-synced');
{
  const store = new Store(victimDoc());
  const s = new SyncSession(store);
  await settle(40);
  const before = clone(pick(store.doc as unknown as Rec));
  // a real, valid state from a real session on the same document, then winning
  // registers forged for every never-synced field (and for title, as a control)
  const peer = new Store(clone(store.doc));
  const sp = new SyncSession(peer);
  await settle(40);
  const snap = (sp as unknown as { snapshot: () => { doc: Rec; state: { v: number; regs: Rec } } }).snapshot();
  ok(snap.state.v === SYNC_V, 'the hostile snapshot carries a VALID state (current SYNC_V), not a stub');
  const rdoc: Rec = { ...clone(snap.doc), ...clone(HOSTILE), title: 'retitled by snapshot' };
  const rstate = clone(snap.state);
  for (const [i, f] of [...FIELDS, 'title'].entries()) rstate.regs[`@doc ${f}`] = [300000 + i, 'evil'];
  (s as unknown as { applySnapshot: (d: unknown, st: unknown) => void }).applySnapshot(rdoc, rstate);
  const after = pick(store.doc as unknown as Rec);
  for (const f of FIELDS) ok(held(f, before, after), `${f}: unchanged by a remote snapshot`);
  ok(store.doc.title === 'retitled by snapshot', 'a content register in the same snapshot still applies');
  s.stop?.(); sp.stop?.();
}

H('the spaces binding shares the engine, and the filter');
{
  const { Store: SStore } = await import('../spaces/src/store.ts');
  const { SyncSession: SSession } = await import('../spaces/src/sync/session.ts');
  const { FORMAT, FORMAT_VERSION, defaultTheme } = await import('../spaces/src/model.ts');
  const d: Rec = {
    format: FORMAT, version: FORMAT_VERSION,
    docId: `victim-sp-${Math.random().toString(36).slice(2, 8)}`,
    title: 'mine', theme: defaultTheme(), home: 'home',
    collab: { room: 'wMINE', key: 'MY-KEY', ownerPriv: { d: 'MINE' }, on: true, v: 2 },
    pages: [{ id: 'home', title: 'Home', blocks: [{ id: 'b1', type: 'p', html: 'hello' }] }],
  };
  const store = new SStore(d as never);
  const s = new SSession(store as never);
  await settle(40);
  const live = (store as unknown as { doc: Rec }).doc;
  const before = clone(pick(live));
  (s as unknown as { onFrame: (f: unknown) => void }).onFrame({ t: 'ops', a: 'evil', ops: hostileOps('evil'), pv: SYNC_V });
  await settle(40);
  const after = pick((store as unknown as { doc: Rec }).doc);
  ok(FIELDS.every((f) => held(f, before, after)),
    `spaces: no never-synced field changed (${FIELDS.filter((f) => !held(f, before, after)).join(',') || 'none'})`);
  s.stop?.();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
