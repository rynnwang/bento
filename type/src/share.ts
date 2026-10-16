// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// SHARE COPIES — the documents bento/type writes for someone ELSE to open: an
// editor invite ("Invite to edit…") and a view-only reader ("View-only
// copy…"). Minted in one place, DOM-free, so the copy that ships is the copy
// the rigs inspect.
//
// It used to be built inline in collab.ts with a hand list of fields to delete
// that dropped ownerPriv and the invite but NOT a legacy writer key. bento/type
// never mints a writer key — its rooms are v2, owner-keyed — but `parseDoc`
// carries `collab` through verbatim, so a document that ARRIVED holding a legacy
// writer key (an older file, a pasted JSON) handed that key to every view-only
// copy made from it: a "reader" holding a private key that writes, which defeats
// the read-only tier at the relay. The kernel ALLOWLIST closes that whole class —
// a copy keeps only what is on the list, so an arrived-with field it does not
// know is dropped, not carried.
//
// Every copy is now built FROM EMPTY by the kernel's copy table
// (`projectForCopy`, kernel/src/docfields.ts) using type's field-class map
// (docclass.ts). A field reaches a copy only when its class's cell for that tier
// says so: the private halves of `collab` go through the kernel's allowlists,
// and history — every revision (a WHOLE earlier draft), every comment, every
// signature — stays out of a view-only copy. The copies used to be a deep clone
// with only `collab` rewritten, so they carried all of it.

import { mintInvite } from './sync/online.ts';
import { projectForCopy } from '../../kernel/src/docfields.ts';
import { withoutEmbeddedCaps, type TypeDoc } from './model.ts';
import { TYPE_FIELDS, HISTORY_CLASS } from './docclass.ts';

// Every share copy starts here, so every one is embed-safe: an embedded
// document never carries its own sharing keys out of this file, however it got
// in (an older file, a pasted JSON — not only through embed.ts's intake).
const clone = (doc: TypeDoc): TypeDoc => withoutEmbeddedCaps(JSON.parse(JSON.stringify(doc)) as TypeDoc);

/**
 * An EDITOR copy: joins live with edit access through its own owner-signed
 * invite, which the owner can revoke. The allowlist keeps room/read-key/public
 * keys + sync and drops every private half; the fresh invite and the top-level
 * role come from mintInvite, never from the source — so a legacy writer key or a
 * source invite can never ride along.
 */
export interface InviteOpts {
  /**
   * Keep the history class in the copy — the kernel's invite rule, and the
   * default. `false` is the inviter's "Leave version history out": the copy is
   * the invite tier exactly, minus every field classed 'history'. History
   * remembers text that was deleted, and an invite is a file for someone else.
   */
  withHistory?: boolean;
}

export async function inviteCopy(doc: TypeDoc, ownerPriv: string, opts: InviteOpts = {}): Promise<TypeDoc> {
  const invite = await mintInvite(ownerPriv, 'writer');
  // Tier 'invite': collab through collabForInvite (room, read key, public keys,
  // sync, the FRESH invite — never a private half), the modes dropped (a
  // template:true copy would open as a roomless new document), history kept,
  // and any key this build does not declare left behind.
  const out = projectForCopy(clone(doc), TYPE_FIELDS, 'invite', { invite });
  if (out.collab) out.collab.on = true;
  // The inviter chose to leave history out: drop it by CLASS, never by name.
  if (opts.withHistory === false) {
    for (const k of HISTORY_CLASS) delete (out as unknown as Record<string, unknown>)[k];
  }
  return out;
}

/**
 * A VIEW-ONLY copy: follows the live session and never writes. The allowlist
 * keeps the room and the public keys, forces role:'reader', and drops every
 * private key, the sync stamp AND anything unknown; the relay drops anything it
 * tries to send.
 */
export function readerCopy(doc: TypeDoc): TypeDoc {
  // Tier 'reader': collab through collabForReader, readonly SET true, and every
  // history field — revisions, comments, signatures — dropped.
  const out = projectForCopy(clone(doc), TYPE_FIELDS, 'reader');
  if (out.collab) out.collab.on = true;
  return out;
}
