#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Room-snapshot rig: a snapshot never carries the uploader's collab block.
//
//   node scripts/test-sync-snapshot-collab.ts
//
// A room snapshot is encrypted under the ROOM key and readable by every holder
// of it — readers included (their copy keeps collab.key). The live doc carries
// this device's whole collab block: ownerPriv on the owner, writerPriv on a v1
// writer, invite material. So every path that sends a snapshot must strip it:
// the relay upload (snapshot()), the fork broadcast (hello()), the re-snap a
// fork sends a new peer, and the flush-time fork snap. This rig decrypts a real
// snapshot with the READER's key and asserts no secret is in it, drives the two
// frame paths through a capturing transport, checks a joiner still converges
// from the stripped snapshot without losing its own collab, and pins that every
// snap frame in session.ts is built by the one helper.
//
// Mutations (verified by editing kernel/src/sync/session.ts and re-running):
// restore the whole-doc clone in snapshotDoc() → the decrypt + frame rows red;
// drop snapshotState()'s register filter → the "no stale register" row reds.

const listeners: Record<string, Array<() => void>> = {};
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn); },
};
(globalThis as unknown as { document: unknown }).document = { hidden: false, addEventListener() {} };

const { register } = await import('node:module');
register('./lib/ts-resolve-hooks.mjs', import.meta.url);
const { readFileSync } = await import('node:fs');

const { Store } = await import('../slides/src/store.ts');
const { SyncSession } = await import('../slides/src/sync/session.ts');
const { newDoc } = await import('../slides/src/model.ts');
const { SYNC_V } = await import('../kernel/src/sync/crdt.ts');
const { collabForReader } = await import('../kernel/src/docfields.ts');

let failures = 0, checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`);
}
const H = (s: string) => console.log(`\n=== ${s} ===`);
const settle = (ms = 260) => new Promise(r => setTimeout(r, ms));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const SECRETS = ['OWNER-PRIV-SECRET', 'INVITE-PRIV-SECRET', 'WRITER-PRIV-SECRET'];
const leaks = (x: unknown) => SECRETS.filter((s) => JSON.stringify(x).includes(s));

// a real 32-byte room key, base64url — the reader's copy keeps it verbatim
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const roomKey = b64u(crypto.getRandomValues(new Uint8Array(32)));

/** AES-GCM under the room key, as the relay upload does; decrypt with `readKey`. */
async function throughRoom(plain: unknown, readKey: string): Promise<unknown> {
  const k = (s: string) => crypto.subtle.importKey('raw', unb64u(s), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await k(roomKey), new TextEncoder().encode(JSON.stringify(plain)));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await k(readKey), ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// The collab blocks a live doc holds on three kinds of device.
const COLLABS: Record<string, Record<string, unknown>> = {
  'v2 owner': {
    room: 'wOWNERROOM', key: roomKey, owner: 'OWNER-PUB', writerPub: 'WP', on: true, v: 2,
    ownerPriv: { kty: 'EC', d: 'OWNER-PRIV-SECRET' },
    invite: { role: 'writer', priv: { d: 'INVITE-PRIV-SECRET' } },
  },
  'v2 writer (invitee)': {
    room: 'wOWNERROOM', key: roomKey, owner: 'OWNER-PUB', writerPub: 'WP', on: true, v: 2, role: 'writer',
    invite: { role: 'writer', priv: { d: 'INVITE-PRIV-SECRET' } },
  },
  'v1 writer (legacy room)': {
    room: 'rLEGACY', key: roomKey, writerPub: 'WP', on: true,
    writerPriv: { kty: 'EC', d: 'WRITER-PRIV-SECRET' },
  },
};

function docWith(collab: Record<string, unknown>) {
  const d = newDoc();
  d.docId = `snap-${Math.random().toString(36).slice(2, 8)}`;
  d.title = 'shared deck';
  (d as unknown as { collab: unknown }).collab = clone(collab);
  return d;
}

H('relay upload: the snapshot a READER decrypts carries no collab');
for (const [label, collab] of Object.entries(COLLABS)) {
  const store = new Store(docWith(collab));
  const s = new SyncSession(store);
  await settle(40);
  ok(leaks(store.doc).length > 0, `${label}: control — the live doc DOES hold its secrets`);
  const snap = (s as unknown as { snapshot: () => { doc: Record<string, unknown>; state: unknown } }).snapshot();
  const readerKey = (collabForReader(store.doc.collab as unknown as Record<string, unknown>) as { key: string }).key;
  const seen = await throughRoom(snap, readerKey) as { doc: Record<string, unknown> };
  ok(!('collab' in seen.doc), `${label}: decrypted with the reader key, the snapshot doc has NO collab block`);
  ok(leaks(seen).length === 0, `${label}: and no ownerPriv / writerPriv / invite anywhere in doc or state (${leaks(seen).join(',') || 'none'})`);
  ok(seen.doc.title === 'shared deck', `${label}: content still rides the snapshot`);
  s.stop?.();
}

H('frame paths: the fork broadcast and the re-snap carry no collab');
{
  // a saved fork file (offline edits + stamped state), on the owner's device
  const base = docWith(COLLABS['v2 owner']);
  const seed = new Store(clone(base));
  const sseed = new SyncSession(seed);
  seed.commit(() => { seed.doc.title = 'forked offline'; });
  await settle();
  (sseed as unknown as { stampInto: (d: unknown) => void }).stampInto(seed.doc);
  sseed.stop?.();
  const forkFile = clone(seed.doc);

  const A = new Store(clone(forkFile));
  const sA = new SyncSession(A);
  const sent: Array<{ t: string; doc?: Record<string, unknown> }> = [];
  sA.addTransport(() => ({ send: (f: { t: string }) => sent.push(f as never), close() {} }) as never);
  // fork broadcast (hello() with forkPending) and a new peer's hello (re-snap)
  (sA as unknown as { hello: () => void }).hello();
  (sA as unknown as { onFrame: (f: unknown) => void }).onFrame({ t: 'hello', a: 'late-tab', vv: {}, p: {}, pv: SYNC_V });
  const snaps = sent.filter((f) => f.t === 'snap');
  ok(snaps.length >= 1, `the fork sent snapshot frames (${snaps.length})`);
  ok(snaps.every((f) => f.doc && !('collab' in f.doc)), 'no snap frame carries a collab block');
  ok(snaps.every((f) => leaks(f).length === 0), 'no snap frame carries ownerPriv / invite material');
  ok(snaps.some((f) => f.doc?.title === 'forked offline'), 'the frames still carry the fork’s content');
  sA.stop?.();

  H('a joiner converges from the stripped snapshot and keeps its own collab');
  const B = new Store(clone(base));
  const sB = new SyncSession(B);
  await settle(40);
  const bCollabBefore = JSON.stringify(B.doc.collab);
  const snap = snaps[snaps.length - 1] as unknown as { doc: unknown; state: unknown };
  (sB as unknown as { applySnapshot: (d: unknown, s: unknown) => void }).applySnapshot(snap.doc, snap.state);
  ok(B.doc.title === 'forked offline', 'the joiner merged the fork’s content');
  ok(JSON.stringify(B.doc.collab) === bCollabBefore, 'the joiner’s own collab is untouched (a stripped key is not a delete)');
  sB.stop?.();
}

H('no stale register: a stripped key never reaches a receiver as a delete');
{
  // A pre-allowlist state may hold a doc-level register for a never-synced
  // field (revisions, emitted by an older client). snapshotDoc() strips the
  // value; the register must go too, or mergeSnapshot reads it as a delete.
  const store = new Store(docWith(COLLABS['v2 owner']));
  (store.doc as unknown as { revisions: unknown }).revisions = [{ id: 'r1', at: 't', body: {} }];
  const s = new SyncSession(store);
  await settle(40);
  const eng = (s as unknown as { state: { regs: Record<string, [number, string]> } }).state;
  eng.regs['@doc revisions'] = [999, 'old-client'];
  const snap = (s as unknown as { snapshot: () => { doc: Record<string, unknown>; state: { regs: Record<string, unknown> } } }).snapshot();
  ok(!('revisions' in snap.doc), 'the snapshot doc drops revisions (a skipDoc field)');
  ok(!('@doc revisions' in (snap.state.regs ?? {})), 'and the snapshot state drops its register');
  const R = new Store(docWith(COLLABS['v2 writer (invitee)']));
  (R.doc as unknown as { revisions: unknown }).revisions = [{ id: 'mine', at: 't', body: {} }];
  const sR = new SyncSession(R);
  await settle(40);
  (sR as unknown as { applySnapshot: (d: unknown, s: unknown) => void }).applySnapshot(snap.doc, snap.state);
  const rRev = (R.doc as unknown as { revisions?: Array<{ id: string }> }).revisions;
  ok(!!rRev && rRev[0]?.id === 'mine', 'the receiver keeps its own revisions (not deleted by a dangling register)');
  s.stop?.(); sR.stop?.();
}

H('every snap frame in session.ts is built by the one helper');
{
  const src = readFileSync(new URL('../kernel/src/sync/session.ts', import.meta.url), 'utf8');
  // every object literal that opens a snap frame
  const frameSites = src.split('\n').filter((l) => /\{ t: 'snap'/.test(l));
  ok(frameSites.length >= 3, `found the snap frame sites (${frameSites.length})`);
  ok(frameSites.every((l) => /snapshotPair\(\)|doc: s\.doc, state: s\.state/.test(l)),
    'each builds from snapshotPair() or from snapshot() (which returns snapshotPair())');
  ok(/this\.flush\(\)\s*\n\s*return this\.snapshotPair\(\)/.test(src), 'snapshot() returns snapshotPair()');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
