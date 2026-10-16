// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Fields a COPY of a document treats specially — the two sides of "not ordinary
// content." Every Bento app shares these lists, so a field added in one place is
// handled everywhere and a new secret fails CLOSED instead of leaking.
//
//   1. Identity/capability kept LIVE across undo/redo and every whole-document
//      restore (FROM_LIVE) — never resurrected from a snapshot.
//   2. Capabilities/secrets STRIPPED when a copy is exported or shared
//      (CAP_FIELDS at the top level; COLLAB_READER_KEEP — an ALLOWLIST — within
//      a kept collab block).
//
// The helpers operate on plain objects: each app's doc/collab shape is a
// superset of the kernel's, so this module stays app-agnostic and imports
// nothing.

type Obj = Record<string, unknown>

// --- identity (kept live on undo/redo + whole-doc restore) ------------------

/** Top-level fields that are identity or capability, never undoable content.
 *  undo/redo and every whole-document restore keep the LIVE value, not the
 *  snapshot's — so nothing can resurrect an old docId, a stale sharing flag, a
 *  dropped read-only mode or a cleared template flag. SUPERSET across apps: a
 *  field absent from a given app's doc makes keeping it live a no-op. */
export const FROM_LIVE = ['docId', 'collab', 'readonly', 'template'] as const

/** After a restore has replaced `doc` with a snapshot, put identity back from
 *  the LIVE doc — or delete it where live lacks it, so the snapshot's value can
 *  never leak through. Mutates `restored` in place. */
export function keepLiveIdentity(restored: Obj, live: Obj): void {
  for (const k of FROM_LIVE) {
    if (Object.hasOwn(live, k) && live[k] !== undefined) restored[k] = live[k]
    else delete restored[k]
  }
}

// --- whole-document restore: undo / redo / version restore / crash recovery ---
// The class-driven generalisation of keepLiveIdentity. keepLiveIdentity pins a
// hard-coded identity list live; applyRestore decides PER FIELD from its class,
// with per-field overrides, because a field's COPY class and its RESTORE
// behaviour can diverge (type's comments are class 'history' for copy reasons
// but must be undoable/restorable). It is additive: apps keep keepLiveIdentity
// until they adopt this.

/** How a field behaves under undo/redo and whole-document restore.
 *  - 'follows': take the restored / incoming value, like ordinary content.
 *  - 'live':    keep the LIVE value; the restored value is ignored. */
export type KeepLive = 'live' | 'follows'

/** Default by class: content (and an unknown field) FOLLOWS; identity,
 *  capability, mode and history stay LIVE — a restore never rolls back identity
 *  or modes, and history is file-local bookkeeping a version restore must not
 *  discard. Apps override per field (type's comments → 'follows'). */
export function defaultKeepLive(cls: FieldClass | undefined): KeepLive {
  return cls === undefined || cls === 'content' ? 'follows' : 'live'
}

/** Which way a restore goes.
 *  - 'back':    undo/redo and version restore — going BACK in time. A 'live'
 *               field keeps the live value (identity and history don't roll back).
 *  - 'recover': crash recovery — `incoming` is a NEWER copy of THIS document.
 *               A 'live' HISTORY field is reconciled with it (a revision made
 *               just before the crash must survive), the rest still keep live. */
export type RestoreDirection = 'back' | 'recover'

/** A per-field recover hook: given the live value, the incoming value and the
 *  two whole-doc times, return the value to keep. Consulted ONLY for a 'live'
 *  history field under 'recover', and ONLY when `incoming` HAS the field — a key
 *  absent from the snapshot keeps the live value before any hook runs, so a hook
 *  never sees `incoming === undefined`.
 *
 *  `at` is EPOCH MILLISECONDS on both sides, which the CALLER normalises so a
 *  hook never compares a number against a string: `live` = the live doc's
 *  modified time as ms (`Date.parse(doc.modified)`), `incoming` = the snapshot's
 *  own time (already ms). Either is `undefined` when unknown — an old file with
 *  no `modified` gives `live: undefined`, which a hook should treat as OLDER. */
export type RecoverHook = (
  live: unknown, incoming: unknown, at: { live?: number; incoming?: number },
) => unknown

export interface RestoreRules {
  readonly classes: Record<string, FieldClass>
  /** Per-field keep-live override, beside the class default (e.g. comments
   *  'follows' though class history). */
  readonly keepLive?: Readonly<Record<string, KeepLive>>
  /** Per-field recover hook — used only for a 'live' history field on 'recover'.
   *  A field with no hook follows incoming when present, keeps live when absent. */
  readonly recover?: Readonly<Record<string, RecoverHook>>
  /** Is `incoming` a WHOLE document (the default) or a PROJECTION of one? Every
   *  app's recovery snapshot is whole — `putRecovery` stores `contentOnly(doc)`,
   *  the full document minus capability — so on 'recover' an absent CONTENT (or
   *  unknown) field means the user DELETED it before the crash, and it stays
   *  removed. A PROJECTION snapshot — one that legitimately omits fields it still
   *  has — MUST pass FALSE: forget it and those fields are REMOVED, so its failure
   *  is data loss, not exposure. Under FALSE an absent field keeps the live
   *  value. This keys on the EFFECTIVE keepLive, not the class: a history field an
   *  app OVERRODE to 'follows' (e.g. comments) is treated as content, so a deleted
   *  comment stays deleted. A history field left at its default 'live' keep
   *  (revisions, signatures) keeps live when absent either way, and the
   *  identity/mode/capability floor is unchanged. Only 'recover' is affected —
   *  'back' already drops an absent field. (maintainer ruling 2026-10-15: whole is
   *  the default.) */
  readonly wholeSnapshot?: boolean
}

/** Resolve a whole-document restore and return the doc to INSTALL.
 *  Over the union of live + incoming keys:
 *   - a 'follows' field takes `incoming` ('back': absent means dropped; 'recover':
 *     absent means dropped too for a WHOLE snapshot — the default, since a
 *     recovery snapshot is contentOnly(doc) and an absent field was deleted — but
 *     absent keeps live for a PROJECTION (wholeSnapshot:false). This covers a
 *     history field OVERRIDDEN to 'follows' (e.g. comments): it restores like
 *     content, so a deleted one stays deleted on a whole snapshot;
 *   - a 'live' field keeps the live value, EXCEPT a 'live' history field on
 *     'recover', which uses its recover hook, or (no hook) follows incoming when
 *     present and keeps live when absent.
 *  `at` carries the whole-doc timestamps (live.modified vs the snapshot's time),
 *  passed to recover hooks; it is not otherwise inspected here. */
/** Keys that address an object's PROTOTYPE. A recovery snapshot is foreign input
 *  (JSON from a shared-origin IndexedDB on file://), and `JSON.parse` gives it an
 *  OWN `__proto__` key — then `out[k] = I[k]` would swap the restored doc's
 *  prototype (a `readonly` getter could read true). Never processed. */
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Classes whose keepLive is ALWAYS 'live' — a restore may never adopt a
 *  snapshot's identity, modes or capabilities (its room, docId, lock). A
 *  keepLive override naming one is ignored here and refused by
 *  validateRestoreRules / restoreOverrides. */
const FLOOR_CLASSES: ReadonlySet<FieldClass> = new Set(['identity', 'mode', 'capability'])

/** Own-property read — a null-prototype class map must not fall through to
 *  Object.prototype (where `classes['constructor']` would read a function). */
const ownGet = <V>(o: Record<string, V> | undefined, k: string): V | undefined =>
  o && Object.hasOwn(o, k) ? o[k] : undefined

export function applyRestore<T extends object>(
  live: T, incoming: T, direction: RestoreDirection, rules: RestoreRules,
  at: { live?: number; incoming?: number } = {},
): T {
  const L = live as Obj, I = incoming as Obj
  const whole = rules.wholeSnapshot ?? true // incoming is a whole document unless told otherwise
  const out: Obj = {}
  for (const k of new Set([...Object.keys(L), ...Object.keys(I)])) {
    if (PROTO_KEYS.has(k)) continue // never assign a prototype key from an untrusted snapshot
    const cls = ownGet(rules.classes, k)
    // The floor: identity / mode / capability ALWAYS keep live; a keepLive
    // override is honoured only for content / history / unknown.
    const override = cls && FLOOR_CLASSES.has(cls) ? undefined : ownGet(rules.keepLive, k)
    const kl = override ?? defaultKeepLive(cls)
    if (kl === 'follows') {
      if (I[k] !== undefined) out[k] = I[k]
      // On 'recover', an absent follows-field keeps live ONLY for a PROJECTION
      // snapshot (wholeSnapshot:false). This keys on the EFFECTIVE keepLive, not
      // the class: a field reaches here because it behaves like content for
      // restore — content, unknown, AND a history field an app OVERRODE to
      // 'follows' (e.g. comments). In a WHOLE snapshot (the default) its absence
      // means the user DELETED it, so it stays removed — not resurrected. (A
      // history field left at its default 'live' keep is handled below, where
      // absent keeps live either way.)
      else if (direction === 'recover' && L[k] !== undefined && !whole) out[k] = L[k]
      continue
    }
    // 'live'
    if (direction === 'recover' && cls === 'history') {
      // A missing key keeps live BEFORE any hook runs — so absent-never-wipes
      // does not depend on each hook remembering it, and a hook never sees an
      // undefined incoming.
      const hook = I[k] !== undefined ? ownGet(rules.recover, k) : undefined
      if (hook) { const v = hook(L[k], I[k], at); if (v !== undefined) out[k] = v; continue }
      if (I[k] !== undefined) out[k] = I[k]
      else if (L[k] !== undefined) out[k] = L[k] // absent never wipes a history field on recover
      continue
    }
    if (L[k] !== undefined) out[k] = L[k]
  }
  return out as T
}

/** Throw if a keepLive override names an identity / mode / capability field with
 *  anything but 'live' — the override floor, checked once when rules are built
 *  (the compile-time half is `restoreOverrides`). applyRestore also enforces it,
 *  so a slipped override is SAFE, not merely caught. */
export function validateRestoreRules(rules: RestoreRules): void {
  const kl = rules.keepLive
  if (!kl) return
  for (const k of Object.keys(kl)) {
    if (PROTO_KEYS.has(k)) continue
    const cls = ownGet(rules.classes, k)
    if (cls && FLOOR_CLASSES.has(cls) && ownGet(kl, k) !== 'live') {
      throw new Error(`keepLive override for "${k}" (class ${cls}) must be 'live' — identity, mode and capability fields never follow a restore`)
    }
  }
}

/** Build a keepLive override map with a COMPILE-TIME guarantee that only content
 *  or history fields are named — naming an identity / mode / capability field is
 *  a type error (the override floor's compile half; applyRestore and
 *  validateRestoreRules enforce it at runtime). */
export function restoreOverrides<M extends Record<string, FieldClass>>(
  _classes: M,
  overrides: Partial<Record<FieldsOfClass<M, 'content'> | FieldsOfClass<M, 'history'>, KeepLive>>,
): Record<string, KeepLive> {
  return overrides as Record<string, KeepLive>
}

/** A recover hook for a revision-style list: keep whichever whole list holds the
 *  most recent entry (by its `at`), ties to LIVE; the lists are NEVER merged, so
 *  a signer's trim survives. OPTIONAL and for an UNSIGNED list only — a SIGNED
 *  list must use the default (follow incoming), because a tie can otherwise pair
 *  a signature with history it never signed (bento/type's finding). */
export const newestListWins: RecoverHook = (live, incoming) => {
  const newest = (x: unknown): string =>
    Array.isArray(x) ? x.reduce<string>((m, e) => {
      const a = (e as { at?: unknown })?.at
      return typeof a === 'string' && a > m ? a : m
    }, '') : ''
  const lv = Array.isArray(live) ? live : undefined
  const iv = Array.isArray(incoming) ? incoming : undefined
  if (!iv) return lv
  if (!lv) return iv
  return newest(iv) > newest(lv) ? iv : lv // tie → live
}

// --- capabilities / secrets (stripped on export) ----------------------------

/** Top-level fields that carry a write/owner capability or secret. A copy that
 *  does NOT keep the live room drops these entirely. A new top-level secret is
 *  closed by adding it here, beside where capabilities are minted. (Top level is
 *  a denylist: most top-level fields are content and cannot be allowlisted.) */
export const CAP_FIELDS = ['collab'] as const

/** A shallow copy of `doc` with every capability field removed. */
export function withoutCaps<T extends object>(doc: T): T {
  const out = { ...(doc as Obj) }
  for (const k of CAP_FIELDS) delete out[k]
  return out as T
}

/** Within a KEPT collab block, the fields a reader/viewer copy may carry. This
 *  is an ALLOWLIST: anything not listed — writerPriv, ownerPriv, invite,
 *  audience, the CRDT `sync` stamp, any link records, and any field added later —
 *  is dropped, so a new secret fails CLOSED. `sync` is deliberately excluded: a
 *  reader does not contribute, so it adopts fresh and converges from the room,
 *  and carrying no stamp removes stale-stamp risk (writer/invite copies keep sync
 *  through their own builders). `key` (the symmetric READ cap) and `room` stay —
 *  a reader needs them to decrypt and join. `role` is NOT copied from the source
 *  (a writer's collab must never project as a writer — the #588 class);
 *  collabForReader sets it to 'reader' itself. */
export const COLLAB_READER_KEEP =
  ['room', 'key', 'owner', 'writerPub', 'on', 'v'] as const

/** Project a collab block down to what a reader/viewer copy may hold: a new
 *  object with only the allowlisted fields that are present, and role forced to
 *  'reader' — never the source's role. */
export function collabForReader(collab: object): Obj {
  const src = collab as Obj
  const out: Obj = {}
  for (const k of COLLAB_READER_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  out.role = 'reader'
  return out
}

/** Within a kept collab, the fields an INVITE (edit/comment) copy may carry: the
 *  reader allowlist PLUS the CRDT `sync` stamp (an invite copy contributes, so it
 *  forks from the stamp) and the owner-signed `invite` delegation. Still an
 *  ALLOWLIST — ownerPriv, writerPriv, audience, any link records, and any field
 *  added later are dropped. The role rides inside `invite` (invite.role), not the
 *  top level, so collabForInvite sets no top-level role. */
export const COLLAB_INVITE_KEEP = [...COLLAB_READER_KEEP, 'sync'] as const

/** Project a collab block to what an invite copy may hold, then attach the
 *  FRESHLY-MINTED `invite` and set the top-level role FROM it. The source's own
 *  invite, links and role are never carried (they are not in the allowlist, and
 *  invite + role come only from the parameter), so a commenter invite opens
 *  locked (role:'commenter') and a writer invite editable — never the source's
 *  chrome. */
export function collabForInvite(collab: object, invite: { role: string }): Obj {
  const src = collab as Obj
  const out: Obj = {}
  for (const k of COLLAB_INVITE_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  out.invite = invite
  out.role = invite.role
  return out
}

/** On a key rotation ("Reset access…") the collab is rebuilt with FRESH keys —
 *  that is the revocation. These sub-fields are carried from the old block onto
 *  the fresh one: the CRDT `sync` stamp (so the document's collab history
 *  survives the reset) and `links` (published-link records survive a reset — the
 *  maintainer's ruling). To make Reset REVOKE links instead, drop 'links' here —
 *  a one-line change. */
export const COLLAB_ROTATE_KEEP = ['sync', 'links'] as const

/** Build the rotated collab: the freshly-minted block with the rotate-survivor
 *  sub-fields carried over from `old`. Returns a new object; `fresh`'s type is
 *  preserved. */
export function carryThroughRotation<T extends object>(fresh: T, old: object | undefined): T {
  if (!old) return fresh
  const out = { ...(fresh as Obj) }
  const src = old as Obj
  for (const k of COLLAB_ROTATE_KEEP) if (Object.hasOwn(src, k) && src[k] !== undefined) out[k] = src[k]
  return out as T
}

// ============================================================================
// Field classification v2 — the single typed source for how each document field
// is COPIED. Every app declares an EXHAUSTIVE Record<keyof Doc, FieldClass>
// (tsc fails on a new field), and projectForCopy builds a copy FROM EMPTY using
// only the rule tables below — so a field is carried only if a table cell says
// so, and a new field fails CLOSED (dropped from every outward copy) until it is
// classified. This generalizes the identity/capability lists above; those
// helpers remain and implement the capability projection.
// ============================================================================

/** The five classes. See CLASS_RULES for what each does per copy tier.
 *  - content:    ordinary document data. Kept in every copy.
 *  - identity:   docId. Kept; RESET (re-minted at load) on a new-identity copy.
 *  - mode:       readonly/template file modes. The builder SETS them per tier
 *                (MODE_FIELD_RULES) — never stripped, which would turn a
 *                read-only copy editable (the fail-open this class exists to stop).
 *  - capability: collab — the ONLY stripped/projected class (via the allowlists).
 *  - history:    revisions/trail. File-local; dropped from reader-tier copies,
 *                kept in the file, duplicates and invites. */
export type FieldClass = 'content' | 'identity' | 'mode' | 'capability' | 'history'

/** The copy tiers. `file` is the full saved document (the owner's round-trip);
 *  `duplicate` is "Duplicate as new deck" (new identity, still the owner's own
 *  copy). The rest are copies handed to someone else. */
export type Tier =
  | 'file' | 'duplicate' | 'invite' | 'reader' | 'audience'
  | 'package' | 'link' | 'template' | 'copyJSON' | 'merge'

export const TIERS: readonly Tier[] =
  ['file', 'duplicate', 'invite', 'reader', 'audience', 'package', 'link', 'template', 'copyJSON', 'merge']

/** The 'merge' tier: one complete document per recipient (type's mail merge) —
 *  a file for SOMEONE ELSE, so content is kept, identity is reset (a fresh
 *  docId, minted by the builder after projection), and capability, history,
 *  modes (readonly/template) and unknown keys are all dropped. Distinct from
 *  'duplicate' (keeps history, re-mints owner creds) and 'copyJSON' (keeps the
 *  docId). NOTE: projectForCopy does NOT recurse into embedded documents, so a
 *  caller that merges a doc carrying embeds must pre-strip them
 *  (withoutEmbeddedCaps/withoutCaps) exactly as the other export tiers do. */

/** What a copy does with one field in one tier.
 *  - keep:   copy the live value as-is.
 *  - drop:   omit the field.
 *  - reset:  omit it so it is re-minted at load (a fresh docId) / re-minted fresh
 *            (new collab creds on a duplicate). The caller mints; projectForCopy
 *            only omits — builders never post-edit identity/capability.
 *  - {set}:  force a fixed value (reader copy -> readonly=true).
 *  - {allowlist}: project a capability block through a tier allowlist.
 *  NOTE: 'per-field' is DELIBERATELY not a Rule — it is allowed ONLY in the mode
 *  row of CLASS_RULES (see its type), so no other class can defer to a per-field
 *  table and the mode row can hold nothing else. */
export type Rule =
  | 'keep'
  | 'drop'
  | 'reset'
  | { readonly set: unknown }
  | { readonly allowlist: 'reader' | 'invite' | 'audience' }

/** The deferral literal — only the mode row of CLASS_RULES may hold it. */
type PerField = 'per-field'

/** Per-class x per-tier rules. The `mode` row is EXACTLY PerField in every tier
 *  (it can only defer to MODE_FIELD_RULES); every other row is Rule and cannot
 *  hold 'per-field'. The object type is written out (no index signature, no
 *  default) so adding a FieldClass or a Tier fails tsc until every cell exists. */
export const CLASS_RULES: {
  readonly content: Record<Tier, Rule>
  readonly identity: Record<Tier, Rule>
  readonly mode: Record<Tier, PerField>
  readonly capability: Record<Tier, Rule>
  readonly history: Record<Tier, Rule>
} = {
  content: {
    file: 'keep', duplicate: 'keep', invite: 'keep', reader: 'keep', audience: 'keep',
    package: 'keep', link: 'keep', template: 'keep', copyJSON: 'keep', merge: 'keep',
  },
  identity: {
    file: 'keep', duplicate: 'reset', invite: 'keep', reader: 'keep', audience: 'keep',
    package: 'keep', link: 'keep', template: 'keep', copyJSON: 'keep', merge: 'reset',
  },
  mode: {
    file: 'per-field', duplicate: 'per-field', invite: 'per-field', reader: 'per-field',
    audience: 'per-field', package: 'per-field', link: 'per-field', template: 'per-field',
    copyJSON: 'per-field', merge: 'per-field',
  },
  capability: {
    file: 'keep', duplicate: 'reset', invite: { allowlist: 'invite' }, reader: { allowlist: 'reader' },
    audience: { allowlist: 'audience' }, package: 'drop', link: { allowlist: 'reader' },
    template: 'drop', copyJSON: 'drop', merge: 'drop',
  },
  history: {
    file: 'keep', duplicate: 'keep', invite: 'keep', reader: 'drop', audience: 'drop',
    package: 'drop', link: 'drop', template: 'drop', copyJSON: 'drop', merge: 'drop',
  },
}

/** Per-mode-FIELD x per-tier rules — the only place the mode row defers to. The
 *  two mode fields diverge within a tier (a reader copy SETS readonly=true but
 *  keeps template; a template copy is the reverse), which a single mode cell
 *  cannot express. ModeField is DERIVED from these keys (below), so classifying a
 *  third field 'mode' without adding its rules here fails tsc. */
export const MODE_FIELD_RULES = {
  // readonly is DROPPED from the template copy: instantiating a template does not
  // clear readonly, so a template that carried it would make every instance
  // read-only.
  readonly: {
    file: 'keep', duplicate: 'keep', invite: 'drop', reader: { set: true }, audience: { set: true },
    package: { set: true }, link: { set: true }, template: 'drop', copyJSON: 'drop', merge: 'drop',
  },
  // template is kept ONLY by the owner's own round-trips and set by the template
  // copy. parseDoc treats template:true as "this open IS a new document" (fresh
  // docId, collab deleted), so any copy meant to stay in its room — invite,
  // reader, audience, package, link — must never carry it, or it forks on open
  // and silently loses the room.
  template: {
    file: 'keep', duplicate: 'keep', invite: 'drop', reader: 'drop', audience: 'drop',
    package: 'drop', link: 'drop', template: { set: true }, copyJSON: 'drop', merge: 'drop',
  },
} satisfies Record<string, Record<Tier, Rule>>

/** The fields that may be classed 'mode' — derived from MODE_FIELD_RULES, not a
 *  hand-written union, so a rule must exist before a field can be a mode field. */
export type ModeField = keyof typeof MODE_FIELD_RULES

/** Unknown / unclassified top-level key: kept only in the file itself and in the
 *  owner's own duplicate; dropped from every outward copy INCLUDING invite (an
 *  invite is a file for another person — a future secret/history-like field must
 *  not ride it). This is the fail-closed default for anything not in the map. */
const UNKNOWN_RULE: Record<Tier, Rule> = {
  file: 'keep', duplicate: 'keep', invite: 'drop', reader: 'drop', audience: 'drop',
  package: 'drop', link: 'drop', template: 'drop', copyJSON: 'drop', merge: 'drop',
}

/** Extract the field names an app's class map assigns to class C. */
export type FieldsOfClass<M, C extends FieldClass> =
  { [K in keyof M]: M[K] extends C ? K : never }[keyof M]

/** A per-app guard: the fields classed 'mode' must be EXACTLY the kernel's mode
 *  fields (readonly, template). Assign `true` to a value of this type in the app
 *  (const _ok: ModeFieldsOk<AppMap> = true); a third field classed mode, or a
 *  missing one, makes the type a diagnostic string and the assignment fails tsc. */
export type ModeFieldsOk<M> =
  [FieldsOfClass<M, 'mode'>] extends [ModeField]
    ? ([ModeField] extends [FieldsOfClass<M, 'mode'>] ? true
        : 'a kernel mode field is missing from this map')
    : 'a field is classed mode but has no MODE_FIELD_RULES entry'

export interface ProjectOpts {
  /** A freshly-minted invite keypair, required for the invite tier's collab projection. */
  readonly invite?: { role: string }
  /** App projection of a collab block for the audience tier (slides' audience.ts). */
  readonly projectAudience?: (collab: Obj) => Obj
}

/** Build a copy of `doc` for `tier`, FROM EMPTY, using only the rule tables and
 *  the app's class map. A field is carried only if its cell says so; anything not
 *  in `classes` follows UNKNOWN_RULE (fail-closed). Builders must NOT post-edit
 *  identity/mode afterwards — the tables are the single source. */
export function projectForCopy<T extends object>(
  doc: T, classes: Record<string, FieldClass>, tier: Tier, opts: ProjectOpts = {},
): T {
  const src = doc as Obj
  const out: Obj = {}
  for (const key of Object.keys(src)) {
    const v = src[key]
    if (v === undefined) continue
    const cls = classes[key]
    const rule: Rule =
      cls === undefined ? UNKNOWN_RULE[tier]
        : cls === 'mode' ? ((MODE_FIELD_RULES[key as ModeField]?.[tier] as Rule | undefined) ?? UNKNOWN_RULE[tier])
          : (CLASS_RULES[cls][tier] as Rule)
    applyRule(out, key, v, rule, opts)
  }
  // A {set} mode cell is a property of the TIER, not of the source: a reader copy
  // is read-only and a template copy is a template whether or not the source
  // carried the field at all. The walk above only visits the source's keys, and
  // most documents have neither readonly nor template — so without this pass a
  // doc with no `readonly` key produced an EDITABLE reader copy (fail-open).
  for (const field of Object.keys(MODE_FIELD_RULES) as ModeField[]) {
    const rule = MODE_FIELD_RULES[field][tier] as Rule
    if (typeof rule === 'object' && 'set' in rule) out[field] = rule.set
  }
  return out as T
}

function applyRule(out: Obj, key: string, v: unknown, rule: Rule, opts: ProjectOpts): void {
  if (rule === 'keep') { out[key] = v; return }
  if (rule === 'drop' || rule === 'reset') return // omit; a reset field is re-minted at load / by the builder
  if ('set' in rule) { out[key] = rule.set; return }
  // capability projection via a tier allowlist
  const block = v as Obj
  const projected =
    rule.allowlist === 'reader' ? collabForReader(block)
      : rule.allowlist === 'invite' ? (opts.invite ? collabForInvite(block, opts.invite) : undefined)
        : opts.projectAudience ? opts.projectAudience(block) : undefined
  if (projected !== undefined) out[key] = projected
}

/** Fields that do NOT count as unsaved work (excluded from docContentKey), kept
 *  SEPARATE from any signing-exclusion set: conflating the two silently drops a
 *  field (e.g. a signature) from crash recovery. Apps extend this with their own
 *  bookkeeping fields. Capability fields are already excluded (a key/secret is
 *  not a content edit); everything else — content, history, mode, identity, AND
 *  an unknown field — counts, so recovery is conservative and never loses data. */
export const DEFAULT_NOT_EDIT: ReadonlySet<string> = new Set(['modified', 'preview', 'autosave'])

/** A stable key over the fields that count as unsaved work, for crash-recovery
 *  comparison. ABSENT fields never change the key (skipped, never null-padded),
 *  so a document without a newer field keys identically on an older build.
 *
 *  THE RULE for what counts: a field an app writes only at SAVE TIME belongs in
 *  its notEdit set; anything written while EDITING counts. History counts by
 *  default (a revision made or a trail row recorded mid-edit is unsaved work and
 *  must survive a crash); an app exempts only what it writes at save time (e.g.
 *  a revisions list appended in the save queue → notEdit), or a reopened
 *  download-save shows a phantom recovery banner. Fail-safe: a missed exemption
 *  costs a spurious banner, a wrong default costs data. */
export function docContentKey(
  doc: object, classes: Record<string, FieldClass>, notEdit: ReadonlySet<string> = DEFAULT_NOT_EDIT,
): string {
  const src = doc as Obj
  const picked: Obj = {}
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue
    if (notEdit.has(key)) continue
    if (classes[key] === 'capability') continue // secrets/keys are not a content edit
    picked[key] = src[key]
  }
  return JSON.stringify(picked)
}

/** The shared version-history entry. `body` is APP-DEFINED (a whole snapshot for
 *  type, a structural patch for spaces); the kernel treats it as opaque. `label`
 *  is OPTIONAL — an app-minted label is frozen in the saver's UI language, so a
 *  summary is DERIVED from the body at render when absent. Lives under
 *  doc.revisions. */
export interface Revision<Body = unknown> {
  readonly id: string
  readonly at: string
  readonly label?: string
  readonly body: Body
}

/** Envelope-only validation (id/at/label?/body present). Body validation is the
 *  app's hook. Call this instead of a bare cast so a malformed entry can't crash
 *  a reader. */
export function validateRevision(x: unknown): x is Revision {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Obj
  return typeof r.id === 'string'
    && typeof r.at === 'string'
    && (r.label === undefined || typeof r.label === 'string')
    && 'body' in r
}
