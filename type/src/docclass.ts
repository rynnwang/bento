// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// How each TOP-LEVEL field of a bento/type document is copied — this app's row
// in the kernel's field classification (kernel/src/docfields.ts).
//
// Not to be confused with fields.ts, which is `{{tokens}}` resolved at render.
// This file is about the document's own keys: which of them a copy handed to
// someone else may carry.
//
// THE MAP IS EXHAUSTIVE, and the compiler holds it to that. `satisfies` over the
// document's DECLARED keys fails tsc on a key missing here and on one that is
// not a field, so a new field cannot reach a copy without somebody deciding what
// it is. A field that arrives undeclared (a newer build's, an agent's) is
// unclassified, and the kernel drops it from every copy except the file itself
// and the owner's duplicate.
//
// Every copy for someone else is built by `projectForCopy(doc, TYPE_FIELDS,
// tier)` (share.ts; model.ts docForExport), which starts from an EMPTY object
// and carries a field only when the kernel's table says so for that tier.
//
// NOT bound into the sync shape (sync/crdt.ts TYPE_SHAPE) yet. Binding it
// changes live sync — `comments` is history-class here, and a bound map stops
// syncing a history key unless it is named in `syncHistory` — and whether live
// readers should see comments is awaiting a maintainer ruling. Today, unbound,
// type syncs by the engine's denylist exactly as before.

import type { FieldClass, FieldsOfClass, ModeFieldsOk } from '../../kernel/src/docfields.ts';
import type { TypeDoc } from './model.ts';

/** The keys TypeDoc declares — its index signature (`[extra: string]`) removed,
 *  which would otherwise make `keyof` plain `string` and the map exhaustive over
 *  nothing. Same helper as spaces/src/docclass.ts. */
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
};

export const TYPE_FIELDS = {
  // identity — re-minted on a duplicate, never on any other copy
  docId: 'identity',
  // mode — SET per copy by the kernel's MODE_FIELD_RULES (a reader copy is
  // readonly, a template copy a template), never simply stripped. In type the
  // only reader of `readonly` is autosave (a read-only copy has nothing of its
  // own to recover), so a reader copy now carrying readonly:true stops it
  // snapshotting content it cannot edit; nothing else changes.
  readonly: 'mode',
  template: 'mode',
  // capability — every field under it is a bearer key; projected through the
  // kernel's allowlists (collabForReader / collabForInvite), including `sync`
  collab: 'capability',
  // history — kept by the file and an invite (unless the inviter leaves it
  // out); dropped from every reader-tier copy, Copy document JSON and mail merge.
  //   revisions   each one is a WHOLE earlier draft: wording that was
  //               negotiated away is exactly what a view-only recipient must
  //               not receive.
  //   comments    internal discussion of the text, not the text.
  //   historySalt the secret that makes each signature's history commitment
  //               reveal nothing (canon.ts). Kept with the full history ONLY.
  revisions: 'history',
  comments: 'history',
  historySalt: 'history',
  // content — the document itself
  //   signatures  content: each signs the content plus a salted COMMITMENT to
  //               the history (canon.ts v2), so a view-only copy — no revisions,
  //               no salt — still verifies them, and they travel with it.
  signatures: 'content',
  format: 'content',
  version: 'content',
  title: 'content',
  subtitle: 'content',
  meta: 'content',
  page: 'content',
  body: 'content',
  footnotes: 'content',
  layout: 'content',
  styles: 'content',
  type: 'content',
  optical: 'content',
  track: 'content',
  merge: 'content',
  fonts: 'content',
  assets: 'content',
  // content, but NOT an edit: excluded from the recovery key (autosave.ts)
  modified: 'content',
} satisfies Record<DeclaredKeys<TypeDoc>, FieldClass>;

/** tsc fails here if the fields classed 'mode' stop being exactly the kernel's
 *  two (readonly, template). */
const _modeOk: ModeFieldsOk<typeof TYPE_FIELDS> = true;
void _modeOk;

/** The fields classed 'history', READ from the map rather than hand-listed, so
 *  a history field added later is covered by the invite's "Leave version
 *  history out" the day it is declared. */
export type HistoryField = FieldsOfClass<typeof TYPE_FIELDS, 'history'>;
export const HISTORY_CLASS: readonly HistoryField[] =
  (Object.keys(TYPE_FIELDS) as Array<keyof typeof TYPE_FIELDS>)
    .filter((k): k is HistoryField => TYPE_FIELDS[k] === 'history');

/**
 * A PASTED document never brings its own history: every history-class field
 * keeps the LIVE value, and one the live document lacks is removed from the
 * paste. For "Replace from JSON…" and its scripted twin `bento.loadDoc` only.
 *
 * History is this file's own log — earlier drafts, the comment threads, and
 * (once signatures commit to it) the salt every signature's commitment is
 * made under. A paste must not be able to forge it, swap it, or erase it.
 * Without this, the ordinary AI round trip was destructive: Copy document JSON
 * leaves history out (the copy table's 'copyJSON' tier), so pasting the result
 * straight back defaulted every history field to empty and silently deleted
 * the document's revisions and comments.
 *
 * Same rule as bento/spaces' keepLiveHistory, deliberately — but NOT applied to
 * every whole-document replace as spaces does: type's crash recovery restores a
 * NEWER copy of this same document, and there the snapshot's history is the
 * newer one and is meant to come back (scripts/test-type-autosave.ts).
 *
 * Read from the map, so a history field classified later is kept the same way.
 * Mutates and returns `next`; values are copied, never shared with `live`.
 */
export function keepLiveHistory<T extends object>(live: T, next: T): T {
  const n = next as Record<string, unknown>, l = live as Record<string, unknown>;
  for (const k of HISTORY_CLASS) {
    if (Object.hasOwn(l, k) && l[k] !== undefined) n[k] = structuredClone(l[k]);
    else delete n[k];
  }
  return next;
}
