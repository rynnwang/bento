// SPDX-License-Identifier: MIT
// Canonicalization + the signature chain, for bento/type.
//
// WHY THIS IS THE HIGH-RISK SMALL PIECE. A signature is over BYTES. If two
// honest parties can serialize the same document to different bytes, every
// signature is worthless; if two DIFFERENT documents can serialize to the same
// bytes, every signature is a forgery waiting to happen. Neither failure is
// visible until someone is in a dispute, which is the worst possible time.
//
// The rule set here is RFC 8785 (JSON Canonicalization Scheme) plus two
// deliberate additions, both of which JCS leaves open and both of which bite a
// word processor specifically:
//
//   1. UNICODE NORMALIZATION. JCS canonicalizes structure, not text. "é" as
//      U+00E9 and as U+0065 U+0301 are different byte strings and identical
//      documents — and a Mac and a Windows machine will genuinely produce
//      different ones from the same keystrokes. We normalize to NFC.
//   2. AN EXPLICIT EXCLUDE LIST, not an include list. Volatile fields
//      (modified, sync state, cached previews) must not enter the signature or
//      merely opening a file breaks it. An exclude list fails SAFE: a new
//      content field added by a later version is signed by default, whereas a
//      forgotten include would silently leave new content unsigned.
//
// `slides/src/autosave.ts` already computes a content key on this principle
// ("excludes volatile fields ... that churn without a real edit"). This is the
// same idea made exact enough to sign.

import type { Signature } from './model.ts';
import { TYPE_FIELDS } from './docclass.ts';

/**
 * What a signature's HISTORY commitment says about the history this copy holds.
 *   matches       the copy's revisions are exactly the ones that were signed
 *   changed       the copy holds revisions, and they are not the signed ones
 *   missing       an EDITABLE document has lost the history the signature
 *                 committed to (revisions or the salt deleted) — a WARNING:
 *                 otherwise deleting `revisions` would turn "changed" into a
 *                 neutral grey
 *   not-included  a READER-TIER copy (readonly) never carries history; neutral
 */
export type HistoryState = 'matches' | 'changed' | 'missing' | 'not-included';
export interface ChainEntry { ok: boolean; why: string | null; linked: boolean; name: string; history: HistoryState }
export interface ChainResult { ok: boolean; entries: ChainEntry[] }

/**
 * Fields that never enter a signature. Everything else is signed — including
 * `revisions`, deliberately: signatures cover content AND history, so trimming
 * history on a signed document is a re-sign by the signer, never a silent fold.
 *
 * This set answers ONE question — what may a signature not cover — and must
 * not be reused to answer "what counts as unsaved work". A signature excludes
 * itself, but losing a signature on crash recovery is still lost work. The
 * recovery key has its own set (autosave.ts NOT_EDIT); reusing this one there
 * is exactly how signatures became invisible to recovery.
 */
export const VOLATILE = new Set([
  'modified',      // touched by every save
  'sync',          // CRDT state, per-replica
  'collab',        // credentials + room state
  'preview',       // cached first-page render
  'signatures',    // the chain itself — a signature cannot cover itself
  'autosave',
]);

/**
 * Every top-level field the CONTENT digest leaves out — v2.
 *
 * The digest attests the document's CONTENT: every field the class map
 * (docclass.ts) calls content or identity, plus any field it does not declare
 * at all (fail-safe: a field a later build adds is signed by default). It
 * excludes:
 *   - VOLATILE above (bookkeeping, credentials, and `signatures` itself);
 *   - every field classed history, capability or mode — DERIVED from the map,
 *     never hand-listed, so a field classified later moves with its class.
 * History is not dropped from what a signature covers: it is covered by the
 * separate COMMITMENT (historyCommitment), which is what lets a view-only copy,
 * which carries no history and is read-only, still verify. Mode is excluded
 * because a reader-tier copy SETS readonly:true; were it signed, every
 * view-only copy would read "changed".
 *
 * Today that leaves, at the top level: format version docId title subtitle
 * meta page body footnotes layout styles type optical track merge fonts
 * assets — and anything undeclared. scripts/test-type-canon.ts derives the
 * same list from the map and checks each one moves the digest.
 *
 * Like VOLATILE, it applies at EVERY level of the document: a nested key with
 * one of these names (an embedded document's own `revisions`, say) is left out
 * too. Embedded documents are carried, not attested.
 */
export const SIGNED_EXCLUDE: ReadonlySet<string> = new Set([
  ...VOLATILE,
  ...Object.entries(TYPE_FIELDS)
    .filter(([, c]) => c === 'history' || c === 'capability' || c === 'mode')
    .map(([k]) => k),
]);

/** RFC 8785 number serialization: ECMAScript Number::toString, with -0 → 0. */
function num(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`non-finite number in document: ${n}`);
  if (Object.is(n, -0)) return '0';
  return String(n);
}

/**
 * RFC 8785 string serialization: minimal escaping, NFC-normalized.
 *
 * LONE SURROGATES ARE ESCAPED, and that is not a detail. `JSON.parse('"\\ud800"')`
 * succeeds, so a document really can carry an unpaired surrogate — and
 * TextEncoder maps EVERY one of them to U+FFFD. Emitted literally, "a\uD800b",
 * "a\uDC00b" and "a�b" would be three different documents sharing ONE
 * digest, so a signature over any of them verifies against the other two. That
 * is a collision, which is to say a forgery. Escaping them — what ES2019's
 * well-formed JSON.stringify does, and what RFC 8785 §3.2.2.2 points at — keeps
 * the map from documents to bytes injective. Well-formed pairs are still
 * emitted literally; `for…of` yields those as one code point above 0xFFFF.
 */
function str(s: string): string {
  const t = s.normalize('NFC');
  let out = '"';
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0xd800 && c <= 0xdfff) out += '\\u' + c.toString(16).padStart(4, '0');
    else if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * Canonical JSON. Keys sorted by UTF-16 code unit (RFC 8785 §3.2.3), volatile
 * fields dropped at EVERY level, no insignificant whitespace.
 *
 * KEYS ARE NORMALIZED BEFORE THEY ARE SORTED. Rule 1 at the top of this file
 * normalizes text to NFC, and a key is text. Normalizing on the way out but
 * sorting on the way in is the worst of both: "é" spelled U+00E9 sorts after
 * "z" while the same key spelled U+0065 U+0301 sorts before it, so one document
 * digests two ways depending on which keyboard produced the field name — the
 * exact determinism failure rule 1 exists to prevent. Sorting the normalized
 * form also makes the collision visible instead of silent: two keys that
 * normalize alike would otherwise emit an object with DUPLICATE keys, in
 * insertion order, which is neither valid JSON nor deterministic. That is
 * refused rather than serialized.
 */
export function canonicalize(value: unknown,
  { volatile = VOLATILE }: { volatile?: ReadonlySet<string> } = {}): string {
  const go = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return num(v);
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return '[' + v.map(go).join(',') + ']';
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const src = new Map<string, string>();      // normalized key -> as written
      for (const k of Object.keys(o)) {
        const n = k.normalize('NFC');
        if (volatile.has(n) || o[k] === undefined) continue;
        if (src.has(n)) throw new TypeError(`duplicate key after NFC normalization: ${n}`);
        src.set(n, k);
      }
      const keys = [...src.keys()].sort();        // UTF-16 code-unit order
      return '{' + keys.map(k => str(k) + ':' + go(o[src.get(k)!])).join(',') + '}';
    }
    throw new TypeError(`cannot canonicalize ${typeof v}`);
  };
  return go(value);
}

const enc = new TextEncoder();

// base64url, isomorphic. The first version used Node's Buffer, which passes
// every test under `node` and throws "Buffer is not defined" the moment the
// same module is loaded in a browser — where this code actually has to run.
// btoa/atob exist in both.
const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** The CONTENT digest a v2 signature attests (see SIGNED_EXCLUDE). */
export async function digest(doc: unknown): Promise<string> {
  const bytes = enc.encode(canonicalize(doc, { volatile: SIGNED_EXCLUDE }));
  return b64u(await crypto.subtle.digest('SHA-256', bytes));
}

// ---------------------------------------------------------------- history commitment

/** Domain tag: a commitment made here can never be replayed as another
 *  protocol's hash of the same bytes. */
const HISTORY_TAG = 'bento-type-history.v1';

/**
 * A fresh 128-bit history salt, base64url.
 *
 * WHY A SALT AT ALL. The commitment travels in every signature — into the room
 * and into view-only copies that carry no history. Without a secret, someone
 * holding a copy who knows the current text and suspects a small edit ("30
 * days" against "60 days") could brute-force the earlier draft. Revision ids do
 * NOT supply that secret: uid() keeps 8 hex chars of a UUID, 32 bits, and the
 * timestamps are guessable. So a per-document salt, kept only with the full
 * history (class 'history': dropped from every copy for someone else, never
 * synced), makes the commitment reveal nothing.
 *
 * NEVER ROTATED: every signature commits to history UNDER this salt, so a new
 * salt would orphan all of them. Salts are per-replica by design — history
 * does not sync — so two replicas' commitments to similar histories differ.
 */
export function newHistorySalt(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * sha256("bento-type-history.v1" || salt || canonical(revisions)), base64url.
 * The salt is fixed-length (16 bytes), so the concatenation is unambiguous; the
 * tag in front separates the domain. Absent revisions commit as an empty list.
 */
export async function historyCommitment(revisions: unknown, salt: string): Promise<string> {
  const tag = enc.encode(HISTORY_TAG);
  const s = unb64u(salt);
  if (s.length !== 16) throw new TypeError('historySalt must be 16 bytes');
  const body = enc.encode(canonicalize(revisions ?? []));
  const all = new Uint8Array(tag.length + s.length + body.length);
  all.set(tag, 0); all.set(s, tag.length); all.set(body, tag.length + s.length);
  return b64u(await crypto.subtle.digest('SHA-256', all));
}

// ---------------------------------------------------------------- signatures
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

export const newKey = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(EC, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
export const exportPub = async (k: CryptoKeyPair): Promise<string> =>
  b64u(await crypto.subtle.exportKey('raw', k.publicKey));

/**
 * The bytes a signature is taken over (v2).
 *
 *     bento-type-sig.v2|<docId>|<content digest>|<history commitment>|<prev sig or "">|<name>
 *
 * v2 REPLACES v1 (bento/type was unreleased, so no v1 signature exists to
 * honour). v1 signed one digest of content AND history together, so a
 * view-only copy — which must not carry the history, because every revision
 * is a whole earlier draft — could never verify. v2 signs the content digest
 * and a salted COMMITMENT to the history separately: the copy carries the
 * commitment (inside each signature) and no drafts, and still verifies.
 *
 * THE NAME IS IN HERE, and it was not always. `name` is self-asserted — the
 * signer chooses it and no crypto makes it true — but "self-asserted" has to
 * mean asserted BY THE SIGNER, and while the name sat outside the signed text
 * it was asserted by whoever held the file last: anyone could take a valid
 * signature, rewrite `name` to somebody else's, and the Signatures panel would
 * print that name beside a green ✓ valid. A claim the signature does not
 * support is exactly what the panel warns about; it must not be one the panel
 * itself manufactures. Bound in before bento/type's first release, so no
 * shipped signature is invalidated.
 *
 * `at` is deliberately NOT in here. It is a self-asserted wall clock that can
 * be backdated freely, the panel does not render it, and the model says it
 * proves nothing — signing it would only lend it the credibility it must not
 * have.
 *
 * docId and name are emitted through `str()` — quoted, escaped and
 * NFC-normalized — because they are the two variable-length fields a document
 * controls. Unquoted, a docId of `x|<digest>|<sig>` could shift every field
 * right and make one signature's text collide with another's. The digests
 * between them are fixed-alphabet base64url and cannot. Normalizing also means
 * a name typed on a Mac verifies on Windows, which is rule 1 again.
 */
const sigText = (docId: string, content: string, history: string, prev: string, name: string) =>
  `bento-type-sig.v2|${str(docId)}|${content}|${history}|${prev}|${str(name)}`;

/**
 * Sign a revision, chaining to the previous signature.
 *
 * Chaining is what buys ORDER without a trusted clock. A self-asserted
 * timestamp can be backdated freely, so it is carried for display and
 * deliberately NOT relied on; what cannot be faked is that signature n commits
 * to signature n-1, so the sequence is tamper-evident even though the times
 * are not. The UI should say "signed after B's revision", never "signed at
 * 14:32" — see type-design.md §3.3.
 */
type Signable = { docId: string; revisions?: unknown; historySalt?: string; readonly?: boolean };

/**
 * Sign, committing to the content AND the history, chaining to `prev`.
 *
 * The document MUST already carry its historySalt: the salt is part of the
 * document (it has to be, to recompute the commitment later), so minting it is
 * the caller's store edit, not something a signature may do behind the
 * document's back. See newHistorySalt.
 */
export async function sign(
  doc: Signable,
  key: CryptoKeyPair,
  { name = '', prev = null }: { name?: string; prev?: { sig: string } | null } = {},
): Promise<Signature> {
  if (!doc.historySalt) throw new Error('sign: the document has no historySalt — mint one first');
  const content = await digest(doc);
  const history = await historyCommitment(doc.revisions, doc.historySalt);
  const prevSig = prev ? prev.sig : '';
  const text = sigText(doc.docId, content, history, prevSig, name);
  const sig = b64u(await crypto.subtle.sign(SIG, key.privateKey, enc.encode(text)));
  return { alg: 'ES256', pub: await exportPub(key), name, content, history, prev: prevSig, sig };
}

/**
 * Two separate answers, never folded into one.
 *
 * ATTESTATION (`ok`, `why`) — the signature is valid over its own fields, and
 * the copy's CONTENT is what was signed. This works anywhere, including a
 * view-only copy, because neither half needs the history.
 *
 * HISTORY (`history`) — what the commitment says about the history THIS copy
 * holds. Reported, not folded into `ok`: a valid attestation over a copy whose
 * history changed is a different fact from a forgery, and the panel must be
 * able to say which. A forged or edited `history` field is not a history
 * state: it is in the signed text, so it breaks `ok`.
 */
export async function verify(doc: Signable, entry: Signature):
  Promise<{ ok: boolean; why: string | null; history: HistoryState }> {
  const history = await historyState(doc, entry);
  const content = await digest(doc);
  if (content !== entry.content) return { ok: false, why: 'content-changed', history };
  if (typeof entry.history !== 'string') return { ok: false, why: 'bad-signature', history };
  const pub = await crypto.subtle.importKey('raw', unb64u(entry.pub), EC, false, ['verify']);
  const text = sigText(doc.docId, entry.content, entry.history, entry.prev, entry.name ?? '');
  const ok = await crypto.subtle.verify(SIG, pub, unb64u(entry.sig), enc.encode(text));
  return { ok, why: ok ? null : 'bad-signature', history };
}

async function historyState(doc: Signable, entry: Signature): Promise<HistoryState> {
  const holds = Array.isArray(doc.revisions) && typeof doc.historySalt === 'string' && doc.historySalt !== '';
  if (!holds) return doc.readonly === true ? 'not-included' : 'missing';
  let mine: string;
  try { mine = await historyCommitment(doc.revisions, doc.historySalt!); }
  catch { return 'missing'; }                     // a malformed salt is a lost one
  return mine === entry.history ? 'matches' : 'changed';
}

/** Verify a whole chain: every signature valid, and correctly linked. */
export async function verifyChain(doc: Signable, chain: Signature[]): Promise<ChainResult> {
  const out: ChainEntry[] = [];
  let expectedPrev = '';
  for (const entry of chain) {
    const r = await verify(doc, entry);
    const linked = entry.prev === expectedPrev;
    out.push({ ...r, linked, name: entry.name });
    expectedPrev = entry.sig;
  }
  return { ok: out.every(r => r.ok && r.linked), entries: out };
}

/**
 * How the Signatures panel presents a history state — maintainer ruling (8),
 * 2026-10-15.
 *
 * History is compared and SHOWN only where this replica can actually know it:
 * for a signature made with THIS device's key, or where the replica demonstrably
 * holds the signed history (`matches`). Every other signature was made on
 * another replica, whose revisions this one never receives (history does not
 * sync), so "changed" or "missing" there is the EXPECTED condition — and a check
 * that routinely warns on an expected condition trains people to ignore it, then
 * miss a real alteration. Those read as the ruling's neutral line instead.
 * Attestation (the signature, the content) is checked for every signature
 * regardless; this governs only the history line.
 *
 * Returns a CODE and a tone, never display text: the panel maps each code to a
 * literal t('…') call, which is what the i18n sweep can find. Never "verified":
 * neutral lines state a fact about this copy, never that something is safe.
 *   elsewhere  someone else's signature whose history this replica cannot see
 */
export type HistoryTone = 'ok' | 'warn' | 'neutral';
export type HistoryLine = 'matches' | 'not-included' | 'elsewhere' | 'changed' | 'missing';
export function historyDisplay(state: HistoryState, mine: boolean): { tone: HistoryTone; line: HistoryLine } {
  if (state === 'matches') return { tone: 'ok', line: 'matches' };
  if (state === 'not-included') return { tone: 'neutral', line: 'not-included' };
  if (!mine) return { tone: 'neutral', line: 'elsewhere' };
  return { tone: 'warn', line: state };            // 'changed' | 'missing', on THIS device's own signature
}
