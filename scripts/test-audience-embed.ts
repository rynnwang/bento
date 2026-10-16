#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// An audience never receives an embedded deck's envelope (slides/src/audience.ts).
//
//   node scripts/test-audience-embed.ts
//   node scripts/test-audience-embed.ts --mutate   (must FAIL: the negative control)
//
// WHAT THIS PROVES. An `embed` element's `doc` is another deck's JSON and can
// carry that deck's ENVELOPE — `collab` (room, read key, writer/owner private
// keys, an invite's private half) and `docId`. Every copy for someone else must
// drop it (envelope.ts). The audience gets content by three routes, and each is
// RUN here on a presenter deck whose embeds carry a full envelope — on a slide,
// an interactive state and a custom layout:
//   1. the handout, `projectDoc` ("Save audience copy…");
//   2. the live snapshot (`audsnap`), which the editor builds with the same
//      `projectDoc` — pinned by name, since the editor needs a DOM;
//   3. live edits, `projectOp`, on ops the REAL engine emits mid-show: an embed
//      inserted, an embed's document replaced, a slide carrying one inserted,
//      and "Save slide as layout" (one whole-value `layouts` register).
// Controls: the embedded CONTENT still arrives; the presenter's deck and the
// ops sent to the real room are not modified (projection is copy-on-write);
// a plain embed with no envelope passes through as the same object.
// --mutate swaps the module's envelope rule for a no-op and every leak row
// must go red.

import { readFileSync } from 'node:fs'
import { projectDoc, projectOp } from '../slides/src/audience.ts'
import { SyncState } from '../slides/src/sync/crdt.ts'
import type { BentoDoc, Slide } from '../slides/src/model.ts'
import type { Op } from '../kernel/src/sync/crdt.ts'

const MUTATE = process.argv.includes('--mutate')
let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

// the embedded deck's envelope: every value must stay out of what the audience gets
const INNER = {
  docId: 'INNER-DOCID-0001',
  collab: { room: 'wINNER-ROOM', key: 'INNER-ROOM-KEY', on: true, v: 2, owner: 'INNER-OWNER-PUB',
    ownerPriv: 'INNER-OWNER-PRIV', writerPub: 'INNER-WRITER-PUB', writerPriv: 'INNER-WRITER-PRIV',
    invite: { pub: 'INNER-INV-PUB', priv: 'INNER-INV-PRIV', role: 'writer', sig: 'INNER-SIG' }, sync: { v: 2, marker: 'INNER-SYNC' } },
}
const NEEDLES = ['INNER-DOCID-0001', 'wINNER-ROOM', 'INNER-ROOM-KEY', 'INNER-OWNER-PRIV', 'INNER-WRITER-PRIV', 'INNER-INV-PRIV', 'INNER-SYNC']
const leaks = (o: unknown) => NEEDLES.filter((n) => JSON.stringify(o).includes(n))
const innerDoc = (title: string) => ({ format: 'bento/slides', version: 1, title, slides: [{ id: 'inner-s1', elements: [] }], ...JSON.parse(JSON.stringify(INNER)) })
const embed = (id: string, title: string) => ({ id, type: 'embed', x: 0, y: 0, w: 400, h: 300, rotation: 0, opacity: 1, app: 'slides', doc: innerDoc(title) })
const slide = (o: Partial<Slide> & { id: string }): Slide => ({ background: '#fff', transition: 'fade', elements: [], notes: '', ...o } as Slide)

const presenter = (): BentoDoc => ({
  format: 'bento/slides', version: 1, docId: 'PRESENTER-DOCID', title: 'talk', size: { w: 1280, h: 720 },
  theme: {}, assets: {},
  collab: { room: 'wPRESENTER-ROOM', key: 'PRESENTER-ROOM-KEY', on: true, v: 2, owner: 'OWNERPUB', ownerPriv: 'PRESENTER-OWNER-PRIV' },
  slides: [
    slide({ id: 's1', elements: [embed('e1', 'on a slide') as never] }),
    slide({ id: 's1-state', stateOf: 's1', elements: [embed('e2', 'on a state') as never] } as never),
    slide({ id: 's2', elements: [{ id: 't1', type: 'text', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, html: 'hi' } as never] }),
  ],
  layouts: [slide({ id: 'L1', elements: [embed('e3', 'on a layout') as never] })],
} as unknown as BentoDoc)
const ticket = { invite: { pub: 'AUDPUB', priv: 'AUDPRIV', role: 'audience' as const, sig: 'SIG' }, key: 'SHOW-KEY' }

// the negative control: make the module's envelope rule a no-op, keep everything else
if (MUTATE) {
  const env = await import('../slides/src/envelope.ts') as { EMBED_ENVELOPE: string[] }
  ;(env.EMBED_ENVELOPE as unknown as string[]).length = 0
}

console.log('\n1 · the handout (projectDoc)\n')
const src = presenter()
const before = JSON.stringify(src)
const { doc: aud } = projectDoc(src, ticket)
ok(leaks(aud).length === 0, `no embedded envelope value survives (${leaks(aud).join(', ') || 'none'})`)
const titles = JSON.stringify(aud)
ok(['on a slide', 'on a state', 'on a layout'].every((t) => titles.includes(t)), 'the embedded content still arrives — slide, state and layout')
ok(JSON.stringify(src) === before, "the presenter's deck is untouched (copy-on-write)")
ok(!JSON.stringify(aud).includes('PRESENTER-OWNER-PRIV') && !JSON.stringify(aud).includes('PRESENTER-ROOM-KEY'), "control: the presenter's own secrets were already absent")

console.log('\n2 · the live snapshot (audsnap)\n')
const editor = readFileSync('slides/src/editor/editor.ts', 'utf8').replace(/^\s*\/\/.*$/gm, '')
ok(/snapshot:\s*\(\)\s*=>\s*\(\{\s*doc:\s*projectDoc\(this\.store\.doc,\s*ticket\)\.doc\s*\}\)/.test(editor),
  "the editor's audience snapshot is projectDoc's output — the handout rows above cover it")
const { doc: snap } = projectDoc(presenter(), ticket)
ok(leaks(snap).length === 0, 'the snapshot built that way carries no embedded envelope value')

console.log('\n3 · live edits (projectOp on real engine ops)\n')
const engineOps = (edit: (d: BentoDoc) => void) => {
  const a = presenter()
  const engine = new SyncState('presenter')
  engine.adopt(a as never)
  const b = JSON.parse(JSON.stringify(a)) as BentoDoc
  edit(b)
  return engine.diff(a as never, b as never, { text: true }) as Op[]
}
const cases: [string, (d: BentoDoc) => void][] = [
  ['an embed inserted mid-show', (d) => { (d.slides[2].elements as unknown[]).push(embed('e9', 'inserted')) }],
  ["an embed's document replaced", (d) => { (d.slides[2].elements as unknown[]).push(embed('e8', 'x')); (d.slides[0].elements[0] as { doc: unknown }).doc = innerDoc('replaced') }],
  ['a slide carrying an embed inserted', (d) => { d.slides.push(slide({ id: 's3', elements: [embed('e7', 'new slide') as never] })) }],
  ['Save slide as layout (the layouts register)', (d) => { d.layouts = [...(d.layouts ?? []), slide({ id: 'L2', elements: [embed('e6', 'new layout') as never] })] }],
]
for (const [name, edit] of cases) {
  const ops = engineOps(edit)
  const carrying = ops.filter((o) => leaks(o).length)
  const sent = JSON.stringify(ops)
  const out = ops.map(projectOp).filter((o): o is Op => o !== null)
  ok(carrying.length > 0, `${name}: the engine's ops DO carry the envelope (${carrying.map((o) => `${o.op}${(o as { kind?: string }).kind ? ':' + (o as { kind?: string }).kind : ''}${(o as { k?: string }).k ? ':' + (o as { k?: string }).k : ''}`).join(', ')}) — the row is not vacuous`)
  ok(leaks(out).length === 0, `${name}: none of it reaches the audience (${leaks(out).join(', ') || 'none'})`)
  ok(out.length === ops.length, `${name}: every op still streams (${out.length}/${ops.length})`)
  ok(JSON.stringify(ops) === sent, `${name}: the ops sent to the real room are not modified`)
}

console.log('\ncontrols\n')
const plain: Op = { op: 'set', sl: 's1', el: 'e1', k: 'doc', v: { title: 'no envelope' } } as unknown as Op
ok(projectOp(plain) === plain, 'an embed doc with no envelope passes through as the same op')
const asset: Op = { op: 'set', sl: 's1', el: 'e1', k: 'doc', v: 'asset:abc' } as unknown as Op
ok(projectOp(asset) === asset, 'an asset-ref embed source passes through')

// ---- 4 · DEEP: documents nested inside the embedded document ---------------
// The envelope rule is deep (envelope.ts stripEnvelope): every document nested
// inside an embed — of any Bento app, at any depth up to ENVELOPE_MAX_DEPTH —
// loses its envelope; deeper ones are dropped. Run through all three routes the
// rule serves here: the handout, a live op, and the export strip every other
// copy uses (stripEmbeddedEnvelopes).
console.log('\n4 · deep — documents nested inside the embed\n')
const { stripEnvelope, stripEmbeddedEnvelopes, ENVELOPE_MAX_DEPTH } = await import('../slides/src/envelope.ts') as {
  stripEnvelope: <T>(v: T) => T; stripEmbeddedEnvelopes: (d: BentoDoc) => number; ENVELOPE_MAX_DEPTH: number }
const env = (tag: string) => ({ docId: `${tag}-DOCID`, collab: { room: `w${tag}-ROOM`, key: `${tag}-ROOM-KEY`, v: 2,
  ownerPriv: `${tag}-OWNER-PRIV`, writerPriv: `${tag}-WRITER-PRIV`, invite: { pub: 'p', priv: `${tag}-INV-PRIV`, role: 'writer', sig: 's' } } })
const envNeedles = (tag: string) => [`${tag}-DOCID`, `w${tag}-ROOM`, `${tag}-ROOM-KEY`, `${tag}-OWNER-PRIV`, `${tag}-WRITER-PRIV`, `${tag}-INV-PRIV`]
const has = (o: unknown, needles: string[]) => needles.filter((n) => JSON.stringify(o).includes(n))
/** a slides deck carrying `inner` (if any) in an embed, with its own envelope tagged `tag` */
const slidesDeck = (tag: string, inner?: unknown) => ({ format: 'bento/slides', version: 1, title: `deck ${tag}`, ...env(tag),
  slides: [{ id: `${tag}-s`, elements: inner === undefined ? [] : [{ id: `${tag}-e`, type: 'embed', app: 'slides', doc: inner }] }] })
const carrying = (inner: unknown): BentoDoc => {
  const d = presenter(); (d.slides[2].elements as unknown[]).push({ id: 'deep', type: 'embed', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, app: 'slides', doc: inner }); return d
}
const routes = (inner: unknown) => {
  const hand = projectDoc(carrying(inner), ticket).doc
  const op = projectOp({ op: 'set', sl: 's2', el: 'deep', k: 'doc', v: inner } as unknown as Op)
  const exp = JSON.parse(JSON.stringify(carrying(inner))) as BentoDoc; stripEmbeddedEnvelopes(exp)
  return { hand, op, exp }
}
const deepCase = (name: string, inner: unknown, tags: string[], content: string[]) => {
  const needles = tags.flatMap(envNeedles)
  ok(has(inner, needles).length === needles.length, `${name}: the fixture carries every level's envelope (${tags.join(', ')})`)
  const r = routes(inner)
  for (const [route, out] of [['handout', r.hand], ['live op', r.op], ['export strip', r.exp]] as const)
    ok(has(out, needles).length === 0, `${name} — ${route}: no level's envelope survives (${has(out, needles).join(', ') || 'none'})`)
  ok(content.every((c) => JSON.stringify(r.hand).includes(c)), `${name}: every level's content still arrives`)
}
deepCase('doubly nested slides-in-slides', slidesDeck('L1', slidesDeck('L2')), ['L1', 'L2'], ['deck L1', 'deck L2'])
deepCase('triply nested slides-in-slides', slidesDeck('L1', slidesDeck('L2', slidesDeck('L3'))), ['L1', 'L2', 'L3'], ['deck L1', 'deck L2', 'deck L3'])
// a bento/type document nested in a slides embed, found by its FORMAT: it sits
// under an ordinary key (not `doc`), in an array
const typeDoc = { format: 'bento/type', version: 1, title: 'a type report', ...env('TY'), body: [{ p: 'text' }] }
const slidesWithType = { ...slidesDeck('L1'), attachments: [{ label: 'report', file: typeDoc }] }
deepCase('a type doc nested in a slides embed', slidesWithType, ['L1', 'TY'], ['deck L1', 'a type report'])

// the depth bound: a chain of 20 nested decks — documents past ENVELOPE_MAX_DEPTH are dropped
{
  let chain: unknown = slidesDeck('D20')
  for (let i = 19; i >= 1; i--) chain = slidesDeck(`D${i}`, chain)
  const out = stripEnvelope(chain)
  const s = JSON.stringify(out)
  ok(ENVELOPE_MAX_DEPTH === 16, `the bound is 16 documents deep (${ENVELOPE_MAX_DEPTH})`)
  ok(s.includes('"deck D16"') && !s.includes('"deck D17"'), 'depth bound: the 16th nested document is kept, the 17th and below are DROPPED')
  const all = Array.from({ length: 20 }, (_, i) => `D${i + 1}`).flatMap(envNeedles)
  ok(has(out, all).length === 0, `depth bound: no envelope from any level survives, kept or dropped (${has(out, all).length} found)`)
  ok(JSON.stringify(chain).includes('"deck D20"'), 'depth bound: the input chain itself is untouched')
}

// identity: a clean nested deck (no envelope anywhere) comes back as the SAME object,
// so projectElement/projectOp report "nothing changed" and stream the original
{
  const clean = { format: 'bento/slides', version: 1, title: 'clean', slides: [{ id: 'c', elements: [{ id: 'ce', type: 'embed', doc: { format: 'bento/type', title: 'clean inner', body: [] } }] }] }
  ok(stripEnvelope(clean) === clean, 'a clean nested deck is returned by identity')
  const op = { op: 'set', sl: 's2', el: 'deep', k: 'doc', v: clean } as unknown as Op
  ok(projectOp(op) === op, 'and its live op passes through as the same op')
  const inner = slidesDeck('ID', slidesDeck('ID2'))
  const out = stripEnvelope(inner) as { slides: { elements: unknown[] }[] }
  ok(out !== inner && JSON.stringify(inner).includes('ID2-ROOM-KEY'), 'a dirty one is copied, and the input is not modified')
}

console.log(`\n${checks - failures}/${checks} checks passed${MUTATE ? ' (mutated: failures expected)' : ''}`)
process.exit(failures ? 1 : 0)
