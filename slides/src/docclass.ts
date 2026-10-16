// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// How each TOP-LEVEL field of a bento/slides document is classed — the deck's
// row in the kernel's field classification (kernel/src/docfields.ts).
//
// Bound into the sync shape (sync/crdt.ts SLIDES_SHAPE), it makes live
// collaboration sync doc-level keys by ALLOWLIST: this peer emits only keys
// classed 'content' (plus the per-key maps), refuses a non-content key from a
// peer whatever the peer claims, and applies-but-never-re-emits a key it does
// not know (a newer build's). The kernel's skipDoc set stays the floor in both
// directions and beats a 'content' classification here (so `format`,
// `version`, `modified` and the `slides` array itself are never synced as
// doc-level values, exactly as before).
//
// THE MAP IS EXHAUSTIVE, and the compiler holds it to that: `satisfies` over
// BentoDoc's keys fails tsc on a key missing here and on one that is not a
// field, so a new field cannot start syncing (or stop) without somebody
// deciding what it is.

import type { FieldClass, ModeFieldsOk } from '../../kernel/src/docfields.ts'
import type { BentoDoc } from './model'

export const SLIDES_FIELDS = {
  // identity — never synced, never adopted from a peer
  docId: 'identity',
  // mode — file modes; a peer can never lock, unlock or template a deck
  readonly: 'mode',
  template: 'mode',
  // capability — every field under it is a bearer key
  collab: 'capability',
  // content — the deck itself (the ones skipDoc also lists stay unsynced)
  format: 'content',
  version: 'content',
  modified: 'content',
  title: 'content',
  meta: 'content',
  size: 'content',
  theme: 'content',
  present: 'content',
  slides: 'content',
  layouts: 'content',
  fonts: 'content',
  // the per-key maps
  assets: 'content',
  blobs: 'content',
} satisfies Record<keyof BentoDoc, FieldClass>

/** tsc fails here if the fields classed 'mode' stop being exactly the
 *  kernel's two (readonly, template). */
const _modeOk: ModeFieldsOk<typeof SLIDES_FIELDS> = true
void _modeOk
