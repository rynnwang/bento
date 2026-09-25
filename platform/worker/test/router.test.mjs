#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// End-to-end smoke test against the BUNDLED worker (dist/worker.js) with
// in-memory R2/D1 mocks standing in for the real Cloudflare bindings — this
// is what proves the full flow actually works as one system, not just that
// each module typechecks in isolation. Covers the auth flow (setup, login,
// session-cookie gating, logout) end to end, then the deck/compile flow
// authenticated via the session the login step produced. Run after
// `npm run build`:
//
//   node test/router.test.mjs

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distPath = join(here, '..', 'dist', 'worker.js')

let worker
try {
  worker = (await import(pathToFileURL(distPath).href)).default
} catch (e) {
  console.error(`✗ could not import ${distPath}: ${e.message}`)
  console.error('  run `npm run build` in platform/worker/ first')
  process.exit(2)
}

// --- in-memory mocks for R2Bucket / D1Database -----------------------------

function makeR2() {
  const objects = new Map()
  return {
    async put(key, value, opts) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
      objects.set(key, { bytes: new Uint8Array(bytes), httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata })
    },
    async get(key) {
      const obj = objects.get(key)
      if (!obj) return null
      return {
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
        body: obj.bytes,
        async text() {
          return new TextDecoder().decode(obj.bytes)
        },
        async arrayBuffer() {
          return obj.bytes.buffer.slice(obj.bytes.byteOffset, obj.bytes.byteOffset + obj.bytes.byteLength)
        },
      }
    },
    async list(opts) {
      const prefix = opts?.prefix ?? ''
      const objectsList = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }))
      return { objects: objectsList, truncated: false }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
    _objects: objects, // test-only escape hatch, not part of the real R2Bucket API
  }
}

// Table-aware: covers exactly the statements auth.ts and store.ts issue.
// Pattern-matched on the SQL prefix rather than a real parser — enough to
// exercise the real query shapes those modules send without pulling in a
// SQL engine for a test double.
function makeD1() {
  let configRow = null
  const sessions = new Map()
  const decks = new Map()
  const projects = new Map()

  return {
    prepare(sql) {
      let boundArgs = []
      const stmt = {
        bind(...args) {
          boundArgs = args
          return stmt
        },
        async run() {
          if (sql.startsWith('INSERT INTO config')) {
            const [username, password_hash, password_salt, password_iterations, created_at] = boundArgs
            configRow = { username, password_hash, password_salt, password_iterations, created_at }
          } else if (sql.startsWith('INSERT INTO sessions')) {
            const [id, created_at, expires_at] = boundArgs
            sessions.set(id, { id, created_at, expires_at })
          } else if (sql.startsWith('UPDATE sessions')) {
            const [expires_at, id] = boundArgs
            const row = sessions.get(id)
            if (row) row.expires_at = expires_at
          } else if (sql.startsWith('DELETE FROM sessions')) {
            const [id] = boundArgs
            sessions.delete(id)
          } else if (sql.startsWith('DELETE FROM decks')) {
            const [id] = boundArgs
            decks.delete(id)
          } else if (sql.startsWith('INSERT INTO decks')) {
            const [id, title, created_at, updated_at, edit_token_hash, shell_version, doc_bytes, access, search_text] = boundArgs
            const kind = sql.includes("'html',") ? 'html' : sql.includes("'md',") ? 'md' : 'bento'
            decks.set(id, {
              id, title, created_at, updated_at, edit_token_hash, shell_version, doc_bytes, access, kind,
              pinned: 0, project_id: null, search_text,
              share_password_hash: null, share_password_salt: null, share_password_iterations: null,
            })
          } else if (sql.startsWith('UPDATE decks SET access')) {
            const [access, id] = boundArgs
            const row = decks.get(id)
            if (row) row.access = access
          } else if (sql.startsWith('UPDATE decks SET pinned')) {
            const [pinned, id] = boundArgs
            const row = decks.get(id)
            if (row) row.pinned = pinned
          } else if (sql.startsWith('UPDATE decks SET share_password_hash = NULL')) {
            // setDeckSharePassword's clear branch — must be matched BEFORE
            // the set branch below (same "NULL-literal vs. bound-params"
            // prefix trick as deleteProject's unassign step).
            const [id] = boundArgs
            const row = decks.get(id)
            if (row) Object.assign(row, { share_password_hash: null, share_password_salt: null, share_password_iterations: null })
          } else if (sql.startsWith('UPDATE decks SET share_password_hash')) {
            const [share_password_hash, share_password_salt, share_password_iterations, id] = boundArgs
            const row = decks.get(id)
            if (row) Object.assign(row, { share_password_hash, share_password_salt, share_password_iterations })
          } else if (sql.startsWith('UPDATE decks SET project_id = NULL WHERE project_id')) {
            // deleteProject's unassign step — must be matched BEFORE the
            // single-deck 'UPDATE decks SET project_id = ? WHERE id' branch
            // below (that one binds a deck id, not a project id).
            const [projectId] = boundArgs
            for (const row of decks.values()) {
              if (row.project_id === projectId) row.project_id = null
            }
          } else if (sql.startsWith('UPDATE decks SET project_id')) {
            const [projectId, id] = boundArgs
            const row = decks.get(id)
            if (row) row.project_id = projectId
          } else if (sql.startsWith('UPDATE decks SET title = ?, updated_at = ? WHERE')) {
            // renameHtmlDeck — 3 params, no doc_bytes (distinct from replaceDeckDoc's
            // 4-param UPDATE below; matched by the exact absent-doc_bytes prefix).
            const [title, updated_at, id] = boundArgs
            const row = decks.get(id)
            if (row) Object.assign(row, { title, updated_at })
          } else if (sql.startsWith('UPDATE decks')) {
            // replaceDeckDoc / replaceHtmlDeck — 4 params + id (search_text
            // joined the doc_bytes-carrying UPDATE when search became a
            // feature; still distinct from renameHtmlDeck's 3-param branch
            // above by the presence of doc_bytes/search_text at all).
            const [title, updated_at, doc_bytes, search_text, id] = boundArgs
            const row = decks.get(id)
            if (row) Object.assign(row, { title, updated_at, doc_bytes, search_text })
          } else if (sql.startsWith('INSERT INTO projects')) {
            const [id, name, created_at, updated_at] = boundArgs
            projects.set(id, { id, name, created_at, updated_at })
          } else if (sql.startsWith('UPDATE projects')) {
            const [name, updated_at, id] = boundArgs
            const row = projects.get(id)
            if (row) Object.assign(row, { name, updated_at })
          } else if (sql.startsWith('DELETE FROM projects')) {
            const [id] = boundArgs
            projects.delete(id)
          }
          return { success: true }
        },
        async first() {
          if (sql.startsWith('SELECT username, password_hash')) return configRow
          if (sql.startsWith('SELECT expires_at FROM sessions')) {
            const row = sessions.get(boundArgs[0])
            return row ? { expires_at: row.expires_at } : null
          }
          if (sql.includes('FROM projects')) return projects.get(boundArgs[0]) ?? null
          if (sql.includes('FROM decks')) return decks.get(boundArgs[0]) ?? null
          return null
        },
        async all() {
          if (sql.includes('FROM decks')) {
            let rows = [...decks.values()]
            // searchDecks (WHERE present) vs. listDecks (no WHERE at all).
            // boundArgs for search = [titlePattern, contentPattern] * N terms,
            // then a trailing LIMIT — each pair shares one '%term%' pattern
            // (store.ts binds the identical pattern to both sides of each
            // term's OR), so only the even-indexed half needs reading.
            if (sql.includes('WHERE')) {
              const limit = boundArgs[boundArgs.length - 1]
              const patterns = boundArgs.slice(0, -1)
              const needles = []
              for (let i = 0; i < patterns.length; i += 2) needles.push(patterns[i].slice(1, -1))
              rows = rows.filter((d) => {
                const title = (d.title || '').toLowerCase()
                const text = d.search_text || ''
                return needles.every((n) => title.includes(n) || text.includes(n))
              })
              rows = rows.sort((a, b) => (b.pinned - a.pinned) || (b.updated_at - a.updated_at)).slice(0, limit)
            } else {
              rows = rows.sort((a, b) => (b.pinned - a.pinned) || (b.updated_at - a.updated_at))
            }
            return { results: rows, success: true }
          }
          if (sql.includes('FROM projects')) {
            const results = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))
            return { results, success: true }
          }
          return { results: [], success: true }
        },
      }
      return stmt
    },
  }
}

const env = { DOCS: makeR2(), DB: makeD1() }

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ✗ ${name}: ${e.stack ?? e.message}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
// Date.now()'s 1ms resolution is coarse enough that two decks created
// back-to-back in this in-memory mock can land in the same millisecond —
// tests asserting most-recently-touched ORDER need a real gap, not just an
// await, to avoid flaking on a genuine timestamp tie.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Reads the body exactly once (a Response body can only be consumed once)
// and hands back both the parsed JSON (if any) and the raw text, so a check
// can assert on status AND inspect the body without a second read — and
// without the classic bug of an eagerly-evaluated assert() message consuming
// the body before the "real" read runs.
async function readBody(res) {
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  return { text, data }
}

function sessionCookie(res) {
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] // "bento_session=<id>"
}

// Same shape as sessionCookie but for any Set-Cookie header (e.g. a deck's
// bento_unlock_<id> cookie from POST /api/decks/:id/unlock) — the fetch()
// Headers implementation folds a single response's headers together, so
// this only handles the "one Set-Cookie in this response" case, same as
// every route in this app ever emits.
function cookieHeader(res) {
  return res.headers.get('set-cookie') ?? ''
}

console.log('platform worker router smoke test')

// --- auth flow --------------------------------------------------------------

await check('GET / redirects to /setup before any account exists', async () => {
  const res = await worker.fetch(new Request('https://platform.example/'), env)
  assert(res.status === 302, `expected 302, got ${res.status}`)
  assert(res.headers.get('location') === '/setup', `expected redirect to /setup, got ${res.headers.get('location')}`)
})

await check('GET /setup renders the setup form before any account exists', async () => {
  const res = await worker.fetch(new Request('https://platform.example/setup'), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes('id="username"') && text.includes('id="password"'), 'setup form fields missing')
})

await check('GET /login redirects to /setup before any account exists', async () => {
  const res = await worker.fetch(new Request('https://platform.example/login'), env)
  assert(res.status === 302, `expected 302, got ${res.status}`)
  assert(res.headers.get('location') === '/setup', `expected redirect to /setup, got ${res.headers.get('location')}`)
})

await check('POST /api/setup rejects a short password', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'short' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

let ownerCookie
await check('POST /api/setup creates the account and starts a session', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  ownerCookie = sessionCookie(res)
  assert(ownerCookie.startsWith('bento_session='), `expected a session cookie, got ${ownerCookie}`)
})

await check('POST /api/setup refuses a second account (409)', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone-else', password: 'another long password' }),
    }),
    env,
  )
  assert(res.status === 409, `expected 409, got ${res.status}`)
})

await check('GET /setup now redirects to /login (already configured)', async () => {
  const res = await worker.fetch(new Request('https://platform.example/setup'), env)
  assert(res.status === 302, `expected 302, got ${res.status}`)
  assert(res.headers.get('location') === '/login', `expected redirect to /login, got ${res.headers.get('location')}`)
})

await check('GET / without a session redirects to /login', async () => {
  const res = await worker.fetch(new Request('https://platform.example/'), env)
  assert(res.status === 302, `expected 302, got ${res.status}`)
  assert(res.headers.get('location') === '/login', `expected redirect to /login, got ${res.headers.get('location')}`)
})

await check('POST /api/login rejects a wrong password', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'not the password' }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('POST /api/login succeeds with the right credentials and starts a session', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  ownerCookie = sessionCookie(res)
  assert(ownerCookie.startsWith('bento_session='), `expected a session cookie, got ${ownerCookie}`)
})

await check('GET / with a valid session renders the wizard and deck history sidebar', async () => {
  const res = await worker.fetch(new Request('https://platform.example/', { headers: { cookie: ownerCookie } }), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes('id="promptText"'), 'wizard page did not render')
  assert(text.includes('id="deckList"'), 'sidebar deck list missing — template structure likely broken')
  assert(text.includes("getElementById('newDeck')"), 'new-deck button wiring missing')
  assert(text.includes("fetch('/api/decks')"), 'sidebar fetch wiring missing')
})

// --- deck + compile flow, authenticated with the session above --------------

const exampleDoc = {
  format: 'bento/slides',
  version: 1,
  title: 'Router test deck',
  size: { width: 1280, height: 720 },
  theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E', fontFamily: 'system-ui' },
  slides: [
    {
      id: 's1',
      background: '#0D1B2E',
      transition: 'none',
      notes: '',
      elements: [
        {
          id: 'headline',
          type: 'text',
          x: 96,
          y: 260,
          w: 1088,
          h: 200,
          html: 'Router test',
          fontSize: 96,
          fontFamily: 'system-ui',
          fontWeight: 900,
          color: '#F5F7FA',
          align: 'left',
          valign: 'top',
          lineHeight: 1,
          rotation: 0,
          opacity: 1,
        },
      ],
    },
  ],
  // a doc that arrives already carrying collab must have it stripped on ingest
  collab: { on: true, key: 'should-be-stripped' },
}

let deckId

await check('POST /api/decks without a session is rejected', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: exampleDoc }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('POST /api/decks creates a deck and strips collab', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: exampleDoc }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  assert(data?.id, 'response missing id')
  deckId = data.id
})

await check('POST /api/decks rejects an svg element', async () => {
  const doc = { ...exampleDoc, slides: [{ ...exampleDoc.slides[0], elements: [{ id: 'x', type: 'svg', markup: '<svg/>' }] }] }
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc }),
    }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 422, `expected 422, got ${res.status}: ${text}`)
})

await check('POST /api/decks rejects a javascript: image src', async () => {
  const doc = {
    ...exampleDoc,
    slides: [{ ...exampleDoc.slides[0], elements: [{ id: 'x', type: 'image', src: 'javascript:alert(1)' }] }],
  }
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc }),
    }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 422, `expected 422, got ${res.status}: ${text}`)
})

await check('GET /d/:id serves a spliced .bento.html containing the doc and no live collab (no auth needed)', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${deckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(text.includes('Router test'), 'spliced page does not contain the deck title/content')
  assert(!text.includes('should-be-stripped'), 'collab key leaked into the spliced output')
  assert(text.match(/id="bento-doc"/g)?.length === 1, 'expected exactly one #bento-doc block')
})

await check('GET /d/:id announces server-side PDF rendering to the booting app (window.__bentoHost), right after <head>', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${deckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes(`window.__bentoHost={ops:["pdf-download"],pdfUrl:"/d/${deckId}/pdf"}`), 'expected the host announcement pointing at this deck\'s /pdf URL')
  assert(text.indexOf('__bentoHost') < text.indexOf('id="bento-doc"'), 'the announcement must run before the app bundle, not after')
})

// Must match pdf.ts's PDF_RENDER_VERSION — the test can't import it directly
// (only the bundled worker's default {fetch} export is reachable here), so
// this is re-declared, same as the `pdf/<id>.pdf` key shape a few lines down.
const CURRENT_PDF_RENDER_VERSION = '4'

let pdfCacheDeckId
await check('GET /d/:id/pdf serves a cached render directly, without touching Browser Rendering at all', async () => {
  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'PDF cache test deck' } }),
    }),
    env,
  )
  pdfCacheDeckId = (await readBody(createRes)).data.id

  // env.BROWSER is deliberately absent from this test harness (Browser
  // Rendering can't be simulated locally) — so a CACHE MISS here would throw,
  // not just render wrong. Seeding R2's cache entry directly and asserting
  // a clean 200 is what proves the cache-hit path short-circuits before ever
  // reaching pdf.ts's puppeteer.launch(env.BROWSER).
  const listRes = await worker.fetch(new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }), env)
  const { data: listData } = await readBody(listRes)
  const meta = listData.decks.find((d) => d.id === pdfCacheDeckId)
  assert(meta, 'expected the deck to be listed')
  const fakePdfBytes = new TextEncoder().encode('%PDF-1.7 fake cached bytes')
  env.DOCS._objects.set(`pdf/${pdfCacheDeckId}.pdf`, {
    bytes: fakePdfBytes,
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { updatedAt: String(meta.updatedAt), renderVersion: CURRENT_PDF_RENDER_VERSION },
  })
  const res = await worker.fetch(new Request(`https://platform.example/d/${pdfCacheDeckId}/pdf`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(res.headers.get('content-type') === 'application/pdf', 'expected an application/pdf content-type')
  const cd = res.headers.get('content-disposition') ?? ''
  assert(cd.includes('attachment'), 'expected an attachment disposition')
  assert(/filename="[^"]+-\d{8}-\d{6}\.pdf"/.test(cd), `expected {name}-{YYYYMMDD-HHmmss}.pdf, got ${cd}`)
  assert(/filename\*=UTF-8''[^;]+-\d{8}-\d{6}\.pdf$/.test(cd), `expected a UTF-8 filename*, got ${cd}`)
  assert(text === '%PDF-1.7 fake cached bytes', 'expected the exact cached bytes back, not a fresh render')
})

await check('GET /d/:id/pdf ignores a cache entry from an OLDER render version, even with a matching updated_at', async () => {
  // Simulates exactly the bug this version bump exists to prevent: a
  // rendering-logic fix ships, but the deck's own content (and so its
  // updated_at) never changed — without also checking renderVersion, the
  // cache would keep serving bytes produced by the OLD, now-wrong logic
  // forever. A stale-version entry must be rejected exactly like a
  // stale-updated_at one — see the test right after this.
  const listRes = await worker.fetch(new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }), env)
  const { data: listData } = await readBody(listRes)
  const meta = listData.decks.find((d) => d.id === pdfCacheDeckId)
  env.DOCS._objects.set(`pdf/${pdfCacheDeckId}.pdf`, {
    bytes: new TextEncoder().encode('%PDF-1.7 stale-version bytes from an old renderer'),
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { updatedAt: String(meta.updatedAt), renderVersion: '1' }, // deliberately not CURRENT_PDF_RENDER_VERSION
  })
  const res = await worker.fetch(new Request(`https://platform.example/d/${pdfCacheDeckId}/pdf`), env)
  assert(res.status === 500, `expected the version-stale cache to be rejected and fall through to a (failing, in this harness) render attempt — got ${res.status}`)
})

await check('GET /d/:id/pdf re-renders once the deck changes (a stale cache entry, by updated_at, must not be served)', async () => {
  // Uses its OWN dedicated deck (pdfCacheDeckId), not the shared `deckId`
  // fixture other tests assert a specific title against — this test's
  // whole point is to mutate a deck's title, which must not leak into
  // unrelated tests. The cache entry seeded above is now stale; this
  // SHOULD fall through to a fresh render attempt, which this harness can't
  // complete (no real env.BROWSER — see pdf.ts), and index.ts's own
  // top-level try/catch turns that into a 500, not a thrown error. That 500
  // IS the assertion: it proves staleness was correctly detected (the
  // alternative failure mode — silently serving the old cached bytes —
  // would show up as a clean 200 with the STALE content instead).
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pdfCacheDeckId}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ title: 'Retitled to invalidate the PDF cache' }),
    }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const pdfRes = await worker.fetch(new Request(`https://platform.example/d/${pdfCacheDeckId}/pdf`), env)
  assert(pdfRes.status === 500, `expected the stale cache to be rejected and fall through to a (failing, in this harness) render attempt — got ${pdfRes.status}`)
})

await check('GET /d/:id/download sets a Content-Disposition attachment header', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${deckId}/download`), env)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(res.headers.get('content-disposition')?.includes('attachment'), 'missing attachment disposition')
})

await check('GET /d/:id/download does NOT carry the __bentoHost announcement — a portable file must not point at a URL relative to this deployment', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${deckId}/download`), env)
  const { text } = await readBody(res)
  assert(!text.includes('__bentoHost'), 'a downloaded standalone file should not announce a platform-specific host capability')
})

await check('GET /d/:id for an unknown id is 404', async () => {
  const res = await worker.fetch(new Request('https://platform.example/d/does-not-exist'), env)
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('GET /api/decks/:id without a session is 401', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/api/decks/${deckId}`), env)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('GET /api/decks/:id with a valid session succeeds', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.doc.title === 'Router test deck', 'unexpected doc content')
})

await check('PATCH /api/decks/:id without a session is rejected', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Hijacked' } }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('PATCH /api/decks/:id with a valid session updates the doc', async () => {
  const updated = { ...exampleDoc, title: 'Updated title' }
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: updated }),
    }),
    env,
  )
  const { text: patchText } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${patchText}`)
  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${deckId}`), env)
  const { text: viewText } = await readBody(viewRes)
  assert(viewText.includes('Updated title'), 'view did not reflect the PATCHed doc')
})

await check('POST /api/decks/:id/assets stores an image and it is fetchable', async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', cookie: ownerCookie },
      body: pngBytes,
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  assert(data.path.startsWith(`/a/${deckId}/`), `unexpected asset path ${data.path}`)
  const assetRes = await worker.fetch(new Request(`https://platform.example${data.path}`), env)
  assert(assetRes.status === 200, `asset fetch expected 200, got ${assetRes.status}`)
  assert(assetRes.headers.get('content-type') === 'image/png', 'wrong content-type on stored asset')
})

await check('GET /api/decks without a session is rejected', async () => {
  const res = await worker.fetch(new Request('https://platform.example/api/decks'), env)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

let secondDeckId
await check('GET /api/decks lists decks most-recently-updated first', async () => {
  // deckId was PATCHed ("Updated title") earlier in this run; create a
  // second, untouched deck so there are two rows with a clear order.
  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Second deck' } }),
    }),
    env,
  )
  const { data: created } = await readBody(createRes)
  secondDeckId = created.id

  const res = await worker.fetch(new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }), env)
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(Array.isArray(data.decks) && data.decks.length >= 2, 'expected at least two decks listed')
  const ids = data.decks.map((d) => d.id)
  assert(ids.indexOf(secondDeckId) < ids.indexOf(deckId), 'the more-recently-created/updated deck should sort first')
  const listed = data.decks.find((d) => d.id === secondDeckId)
  assert(listed.title === 'Second deck', 'listed deck has the wrong title')
  assert(typeof listed.updatedAt === 'number' && typeof listed.createdAt === 'number', 'listed deck missing timestamps')
  assert(listed.access === 'edit', 'a freshly created deck should default to edit access')
})

// --- per-deck access level (private / view / edit) -------------------------

let viewDeckId
await check('POST /api/decks with access:"view" creates a view-only deck', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'View-only deck' }, access: 'view' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  viewDeckId = data.id

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === viewDeckId)
  assert(listed?.access === 'view', 'the sidebar listing should report the deck as view-only')
})

await check('POST /api/decks rejects an unknown access value', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: exampleDoc, access: 'public' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('GET /d/:id for a view-only deck serves a read-only doc to an anonymous viewer', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${viewDeckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(text.includes('"readonly":true'), 'expected readonly:true spliced into the anonymous view')
})

await check('GET /d/:id for a view-only deck still serves the full editable doc to its owner', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/d/${viewDeckId}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(!text.includes('"readonly":true'), 'the owner should never be handed the read-only copy of their own deck')
})

await check('GET /d/:id for an edit-access deck never carries readonly:true, owner or not', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${deckId}`), env)
  const { text } = await readBody(res)
  assert(!text.includes('"readonly":true'), 'an edit-access deck should not be marked readonly for anonymous viewers')
})

let privateDeckId
await check('POST /api/decks with access:"private" creates a private deck', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Private deck' }, access: 'private' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  privateDeckId = data.id
})

await check('GET /d/:id for a private deck is 404 for an anonymous viewer', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${privateDeckId}`), env)
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('GET /d/:id/download for a private deck is 404 for an anonymous viewer', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${privateDeckId}/download`), env)
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('GET /d/:id/pdf for a private deck is 404 for an anonymous viewer (same gate as the live view, before any render is attempted)', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${privateDeckId}/pdf`), env)
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('GET /d/:id for a private deck still serves the owner', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/d/${privateDeckId}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(text.includes('Private deck'), 'owner should still see the real deck content')
})

await check('GET /a/:id/:key for a private deck is 404 for an anonymous viewer, cache-safe', async () => {
  const uploadRes = await worker.fetch(
    new Request(`https://platform.example/api/decks/${privateDeckId}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', cookie: ownerCookie },
      body: new Uint8Array([1, 2, 3, 4]),
    }),
    env,
  )
  const { data: asset } = await readBody(uploadRes)
  const res = await worker.fetch(new Request(`https://platform.example${asset.path}`), env)
  assert(res.status === 404, `expected 404, got ${res.status}`)
  const ownerRes = await worker.fetch(
    new Request(`https://platform.example${asset.path}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  assert(ownerRes.status === 200, `owner expected 200, got ${ownerRes.status}`)
  assert(
    ownerRes.headers.get('cache-control') === 'private, no-store',
    "a private deck's asset must never be shared-cacheable, even for the owner's own request",
  )
})

await check('PATCH /api/decks/:id/access without a session is rejected', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${viewDeckId}/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'edit' }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('PATCH /api/decks/:id/access for an unknown deck is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks/does-not-exist/access', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ access: 'edit' }),
    }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('PATCH /api/decks/:id/access rejects an invalid value', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${viewDeckId}/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ access: 'nope' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('PATCH /api/decks/:id/access changes the level, unlocking the deck for anonymous viewers', async () => {
  const patchRes = await worker.fetch(
    new Request(`https://platform.example/api/decks/${viewDeckId}/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ access: 'edit' }),
    }),
    env,
  )
  const { data, text } = await readBody(patchRes)
  assert(patchRes.status === 200, `expected 200, got ${patchRes.status}: ${text}`)
  assert(data.access === 'edit', 'response should echo the new access level')

  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${viewDeckId}`), env)
  const { text: viewText } = await readBody(viewRes)
  assert(!viewText.includes('"readonly":true'), 'the deck should now serve as editable to anonymous viewers')
})

// --- rename ------------------------------------------------------------

await check('PATCH /api/decks/:id/title without a session is rejected', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hijacked title' }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('PATCH /api/decks/:id/title for an unknown deck is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks/does-not-exist/title', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ title: 'New name' }),
    }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('PATCH /api/decks/:id/title rejects a blank title', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ title: '   ' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('PATCH /api/decks/:id/title renames the deck (rewrites doc.title, not just a label)', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ title: 'Renamed from the sidebar' }),
    }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === deckId)
  assert(listed?.title === 'Renamed from the sidebar', 'sidebar listing should show the new title')

  const docRes = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: docData } = await readBody(docRes)
  assert(docData.doc.title === 'Renamed from the sidebar', "the deck's own doc.title must change, not a separate label")

  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${deckId}`), env)
  const { text: viewText } = await readBody(viewRes)
  assert(viewText.includes('Renamed from the sidebar'), 'the spliced view should reflect the new title too')
})

// --- delete --------------------------------------------------------------

let deleteMeDeckId
await check('DELETE /api/decks/:id without a session is rejected', async () => {
  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Delete me' } }),
    }),
    env,
  )
  const { data: created } = await readBody(createRes)
  deleteMeDeckId = created.id

  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deleteMeDeckId}`, { method: 'DELETE' }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('DELETE /api/decks/:id for an unknown deck is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks/does-not-exist', {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('DELETE /api/decks/:id removes the deck and its assets, and both become 404', async () => {
  const uploadRes = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deleteMeDeckId}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', cookie: ownerCookie },
      body: new Uint8Array([9, 9, 9]),
    }),
    env,
  )
  const { data: asset } = await readBody(uploadRes)
  const assetUrlBeforeDelete = await worker.fetch(new Request(`https://platform.example${asset.path}`, { headers: { cookie: ownerCookie } }), env)
  assert(assetUrlBeforeDelete.status === 200, 'sanity check: asset should exist before delete')

  const delRes = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deleteMeDeckId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    }),
    env,
  )
  assert(delRes.status === 200, `expected 200, got ${delRes.status}`)

  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${deleteMeDeckId}`), env)
  assert(viewRes.status === 404, `deleted deck's /d/:id expected 404, got ${viewRes.status}`)

  const assetRes = await worker.fetch(new Request(`https://platform.example${asset.path}`), env)
  assert(assetRes.status === 404, `deleted deck's asset expected 404, got ${assetRes.status}`)

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  assert(!listData.decks.some((d) => d.id === deleteMeDeckId), 'deleted deck should no longer be listed')
})

// --- 'html' decks (self-contained HTML uploaded/pasted directly) -----------

const exampleHtml = '<!doctype html><html><head><title>My Cool Deck</title></head><body><h1>Hi</h1><script>alert(1)</script></body></html>'

let htmlDeckId
await check('POST /api/decks with {html} creates an html-kind deck, title from <title>', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: exampleHtml }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  htmlDeckId = data.id

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === htmlDeckId)
  assert(listed?.title === 'My Cool Deck', `expected title from <title>, got ${listed?.title}`)
  assert(listed?.kind === 'html', 'listed deck should report kind:"html"')
  assert(listed?.access === 'view', 'html deck with no access specified should default to view, not edit')
})

await check('POST /api/decks coerces access:"edit" to "view" for an html deck', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: exampleHtml, access: 'edit' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === data.id)
  assert(listed?.access === 'view', `expected access:"edit" to be coerced to "view", got ${listed?.access}`)
})

await check('POST /api/decks rejects empty html', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: '   ' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('GET /d/:id for an html deck serves a sandboxed iframe wrapper, not the raw script directly', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${htmlDeckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes('<iframe'), 'expected an iframe wrapper')
  assert(text.includes('sandbox='), 'iframe must be sandboxed')
  assert(text.includes('allow-same-origin'), 'sandbox must include allow-same-origin (WebGL2/MapLibre fix — see docs/DECISIONS.md 2026-09-20 and index.ts htmlDeckWrapper)')
  assert(text.includes('srcdoc='), 'expected the deck content passed via srcdoc')
  // The raw <script>alert(1)</script> must be present only INSIDE the escaped
  // srcdoc attribute, never as live markup outside the iframe (which would
  // mean it runs at the platform's own origin instead of the sandboxed one).
  assert(!/<body>[\s\S]*<script>alert\(1\)<\/script>/.test(text.replace(/srcdoc="[^"]*"/, '')), 'script must not appear as live markup outside the sandboxed srcdoc')
})

await check('GET /d/:id for an html deck includes a Download PDF link to the server-rendered endpoint, outside the sandboxed iframe', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${htmlDeckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  // The link must live in the WRAPPER, not be something the untrusted deck
  // itself could forge — so it must appear outside the srcdoc attribute.
  const outsideSrcdoc = text.replace(/srcdoc="[^"]*"/, '')
  assert(outsideSrcdoc.includes('id="bento-pdf-btn"'), 'expected a Download PDF control in the wrapper')
  assert(outsideSrcdoc.includes(`href="/d/${htmlDeckId}/pdf"`), 'expected it to link to the server-rendered PDF endpoint, not trigger local print')
})

await check('GET /d/:id/download for an html deck serves the raw file, not the wrapper', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${htmlDeckId}/download`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(res.headers.get('content-disposition')?.includes('.html"'), 'expected a .html attachment filename')
  assert(text === exampleHtml, 'download should be the exact original bytes, unwrapped')
})

await check('GET /a/:id/:key for an html deck honors the same private/404 rule as a bento deck', async () => {
  const privRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: exampleHtml, access: 'private' }),
    }),
    env,
  )
  const { data: privDeck } = await readBody(privRes)
  const anonRes = await worker.fetch(new Request(`https://platform.example/d/${privDeck.id}`), env)
  assert(anonRes.status === 404, `private html deck expected 404 for anonymous, got ${anonRes.status}`)
  const ownerRes = await worker.fetch(
    new Request(`https://platform.example/d/${privDeck.id}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  assert(ownerRes.status === 200, `owner expected 200 on their own private html deck, got ${ownerRes.status}`)
})

await check('PATCH /api/decks/:id with {doc} against an html deck is a kind-mismatch 400', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${htmlDeckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: exampleDoc }),
    }),
    env,
  )
  assert(res.status === 400, `expected 400, got ${res.status}`)
})

await check('PATCH /api/decks/:id with {html} against a bento deck is a kind-mismatch 400', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${deckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: exampleHtml }),
    }),
    env,
  )
  assert(res.status === 400, `expected 400, got ${res.status}`)
})

await check('PATCH /api/decks/:id/access rejecting "edit" is NOT required, but "view"/"private" work for an html deck', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${htmlDeckId}/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ access: 'private' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.access === 'private', 'access should have changed to private')
})

await check('PATCH /api/decks/:id/title renames an html deck (D1 label only, bytes untouched)', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${htmlDeckId}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ title: 'Renamed HTML deck' }),
    }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === htmlDeckId)
  assert(listed?.title === 'Renamed HTML deck', 'title should have changed')

  // access was set to 'private' by the previous check, so use the owner
  // cookie to confirm the underlying bytes are exactly unchanged.
  const downloadRes = await worker.fetch(
    new Request(`https://platform.example/d/${htmlDeckId}/download`, { headers: { cookie: ownerCookie } }),
    env,
  )
  const { text: downloadedHtml } = await readBody(downloadRes)
  assert(downloadedHtml === exampleHtml, "renaming must not touch the deck's stored bytes")
})

await check('PATCH /api/decks/:id with {html} re-uploads an html deck, replacing bytes and re-deriving the title', async () => {
  const newHtml = '<!doctype html><html><head><title>Replaced Content</title></head><body>new</body></html>'
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${htmlDeckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: newHtml }),
    }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === htmlDeckId)
  assert(listed?.title === 'Replaced Content', `title should be re-derived from the new file, got ${listed?.title}`)

  const downloadRes2 = await worker.fetch(
    new Request(`https://platform.example/d/${htmlDeckId}/download`, { headers: { cookie: ownerCookie } }),
    env,
  )
  const { text: downloadedHtml2 } = await readBody(downloadRes2)
  assert(downloadedHtml2 === newHtml, 'download should reflect the newly uploaded bytes, not the original')
})

await check('PATCH /api/decks/:id with {html} rejects empty content on re-upload', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${htmlDeckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: '   ' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('DELETE /api/decks/:id removes an html deck (D1 row + doc.html)', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${htmlDeckId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const viewRes = await worker.fetch(
    new Request(`https://platform.example/d/${htmlDeckId}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  assert(viewRes.status === 404, `deleted html deck expected 404, got ${viewRes.status}`)
})

// --- pinning ---------------------------------------------------------------

let pinDeckOldId, pinDeckNewId
await check('PATCH /api/decks/:id/pin without a session is rejected', async () => {
  const olderRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Pin me (older)' } }),
    }),
    env,
  )
  pinDeckOldId = (await readBody(olderRes)).data.id
  await sleep(5) // guarantee a distinct updated_at from pinDeckNewId below

  // A second, more-recently-created deck so ordering has something to prove.
  const newerRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Not pinned (newer)' } }),
    }),
    env,
  )
  pinDeckNewId = (await readBody(newerRes)).data.id

  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pinDeckOldId}/pin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('PATCH /api/decks/:id/pin for an unknown deck is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks/does-not-exist/pin', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ pinned: true }),
    }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('PATCH /api/decks/:id/pin rejects a non-boolean value', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pinDeckOldId}/pin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ pinned: 'yes' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('PATCH /api/decks/:id/pin pins the OLDER deck and it sorts ahead of the newer, unpinned one', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pinDeckOldId}/pin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ pinned: true }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.pinned === true, 'response should echo pinned:true')

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const ids = listData.decks.map((d) => d.id)
  assert(
    ids.indexOf(pinDeckOldId) < ids.indexOf(pinDeckNewId),
    'the pinned-but-older deck should sort ahead of the newer, unpinned one',
  )
  const listedOld = listData.decks.find((d) => d.id === pinDeckOldId)
  assert(listedOld?.pinned === true, 'listed deck should report pinned:true')
  const listedNew = listData.decks.find((d) => d.id === pinDeckNewId)
  assert(listedNew?.pinned === false, 'an unpinned deck should report pinned:false, not undefined')
})

await check('PATCH /api/decks/:id/pin unpins a deck, restoring normal most-recently-touched order', async () => {
  // Touch the "newer" deck's updated_at explicitly rather than relying on
  // wall-clock creation order — pinning/unpinning deliberately never bumps
  // updated_at (see store.ts's setDeckPinned), so pinDeckOldId's timestamp
  // is still whatever it was at creation; an explicit sleep + rename here
  // guarantees pinDeckNewId's is strictly later, not just probably later.
  await sleep(5)
  await worker.fetch(
    new Request(`https://platform.example/api/decks/${pinDeckNewId}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ title: 'Not pinned (newer, touched)' }),
    }),
    env,
  )

  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pinDeckOldId}/pin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ pinned: false }),
    }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const ids = listData.decks.map((d) => d.id)
  assert(
    ids.indexOf(pinDeckNewId) < ids.indexOf(pinDeckOldId),
    'once unpinned, the more-recently-touched deck should sort first again',
  )
})

// --- share passwords ---------------------------------------------------------

let pwDeckId
await check('PATCH /api/decks/:id/password without a session is rejected', async () => {
  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Password-protected deck' } }),
    }),
    env,
  )
  pwDeckId = (await readBody(createRes)).data.id

  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pwDeckId}/password`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2trombone' }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('GET /d/:id serves the deck normally BEFORE a password is set', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${pwDeckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(!text.includes('Password required'), 'an unprotected deck should not show the password gate')
})

await check('PATCH /api/decks/:id/password for an unknown deck is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks/does-not-exist/password', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ password: 'whatever12345' }),
    }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('PATCH /api/decks/:id/password rejects an empty-string password', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pwDeckId}/password`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ password: '   ' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('PATCH /api/decks/:id/password sets a password, listed decks report hasPassword:true', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pwDeckId}/password`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ password: 'hunter2trombone' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.hasPassword === true, 'response should echo hasPassword:true')

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === pwDeckId)
  assert(listed?.hasPassword === true, 'listed deck should report hasPassword:true')
})

await check('GET /d/:id shows the password gate to an anonymous viewer once a password is set', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${pwDeckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes('Password required'), 'expected the password gate page')
  assert(!text.includes('Password-protected deck'), 'the gate must never leak the deck title/content')
})

await check('GET /d/:id still serves the OWNER the real deck regardless of the password', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${pwDeckId}`, { headers: { cookie: ownerCookie } }), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(!text.includes('Password required'), "the owner's own session must bypass the password gate")
})

await check('GET /d/:id/pdf shows the password gate too, redirecting post-unlock to /pdf (not the live view)', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${pwDeckId}/pdf`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes('Password required'), 'expected the password gate page')
  assert(text.includes(`/d/${pwDeckId}/pdf`), 'expected the gate to redirect back to the /pdf URL after unlock, not /d/:id')
})

await check('GET /a/:id/:key 401s for an anonymous viewer of a password-protected deck', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/a/${pwDeckId}/deadbeef.png`), env)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('POST /api/decks/:id/unlock rejects a wrong password', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pwDeckId}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-guess' }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('POST /api/decks/:id/unlock for an unknown deck also 401s (no existence oracle)', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks/does-not-exist/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'whatever' }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

let unlockCookie
await check('POST /api/decks/:id/unlock accepts the right password and sets an unlock cookie', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pwDeckId}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2trombone' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.ok === true, 'expected {ok:true}')
  const setCookie = cookieHeader(res)
  assert(setCookie.includes(`bento_unlock_${pwDeckId}=`), `expected a bento_unlock_${pwDeckId} cookie, got ${setCookie}`)
  unlockCookie = setCookie.split(';')[0]
})

await check('GET /d/:id serves the real deck once the unlock cookie is presented', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${pwDeckId}`, { headers: { cookie: unlockCookie } }), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(!text.includes('Password required'), 'a valid unlock cookie should bypass the gate')
})

await check('GET /a/:id/:key no longer 401s once the unlock cookie is presented', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/a/${pwDeckId}/deadbeef.png`, { headers: { cookie: unlockCookie } }),
    env,
  )
  // The asset itself doesn't exist in this test (never uploaded) — a 404 is
  // the expected "past the password gate, but no such asset" outcome; 401
  // would mean the unlock cookie was rejected.
  assert(res.status === 404, `expected 404 (unlocked, asset missing), got ${res.status}`)
})

await check('PATCH /api/decks/:id/password with password:null removes protection, and invalidates the old unlock cookie', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${pwDeckId}/password`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ password: null }),
    }),
    env,
  )
  const { data } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(data.hasPassword === false, 'response should echo hasPassword:false')

  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${pwDeckId}`), env)
  const { text } = await readBody(viewRes)
  assert(!text.includes('Password required'), 'with the password removed, anyone should see the real deck again')
})

await check('a re-set password invalidates a stale unlock cookie earned under the OLD password', async () => {
  // Re-protect the deck with a different password than before.
  await worker.fetch(
    new Request(`https://platform.example/api/decks/${pwDeckId}/password`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ password: 'a-completely-different-password' }),
    }),
    env,
  )
  // The cookie earned earlier (under 'hunter2trombone', now stale) must NOT
  // still work — its digest was derived from a password hash that no
  // longer matches what's stored.
  const res = await worker.fetch(new Request(`https://platform.example/d/${pwDeckId}`, { headers: { cookie: unlockCookie } }), env)
  const { text } = await readBody(res)
  assert(text.includes('Password required'), 'a cookie earned under a since-changed password must be rejected')
})

// --- projects (sidebar folders) ---------------------------------------------

await check('GET /api/projects without a session is rejected', async () => {
  const res = await worker.fetch(new Request('https://platform.example/api/projects'), env)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('POST /api/projects without a session is rejected', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('POST /api/projects rejects an empty name', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ name: '  ' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

let projectId
await check('POST /api/projects creates a project', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ name: 'Q3 launch' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  assert(typeof data.id === 'string' && data.id, 'response should include an id')
  projectId = data.id
})

await check('GET /api/projects lists the created project', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/projects', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const found = data.projects.find((p) => p.id === projectId)
  assert(found?.name === 'Q3 launch', 'created project should be listed with its name')
})

await check('PATCH /api/projects/:id renames a project', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ name: 'Q3 launch (renamed)' }),
    }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const listRes = await worker.fetch(
    new Request('https://platform.example/api/projects', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data } = await readBody(listRes)
  const found = data.projects.find((p) => p.id === projectId)
  assert(found?.name === 'Q3 launch (renamed)', 'project name should be updated')
})

await check('PATCH /api/projects/:id for an unknown project is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/projects/does-not-exist', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ name: 'Whatever' }),
    }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

let projectDeckId
await check('PATCH /api/decks/:id/project files a deck under a project', async () => {
  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: { ...exampleDoc, title: 'Filed under a project' } }),
    }),
    env,
  )
  projectDeckId = (await readBody(createRes)).data.id

  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${projectDeckId}/project`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ projectId }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.projectId === projectId, 'response should echo the assigned projectId')

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === projectDeckId)
  assert(listed?.projectId === projectId, 'listed deck should report its projectId')
})

await check('PATCH /api/decks/:id/project rejects a non-string, non-null value', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${projectDeckId}/project`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ projectId: 42 }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('PATCH /api/decks/:id/project for an unknown deck is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks/does-not-exist/project', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ projectId }),
    }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

await check('PATCH /api/decks/:id/project with projectId:null unfiles a deck', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/decks/${projectDeckId}/project`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ projectId: null }),
    }),
    env,
  )
  const { data } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(data.projectId === null, 'response should echo projectId:null')

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === projectDeckId)
  assert(listed?.projectId === null, 'unfiled deck should report projectId:null')

  // Re-file it for the deleteProject test below.
  await worker.fetch(
    new Request(`https://platform.example/api/decks/${projectDeckId}/project`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ projectId }),
    }),
    env,
  )
})

await check('DELETE /api/projects/:id deletes the project WITHOUT deleting its decks', async () => {
  const res = await worker.fetch(
    new Request(`https://platform.example/api/projects/${projectId}`, { method: 'DELETE', headers: { cookie: ownerCookie } }),
    env,
  )
  assert(res.status === 200, `expected 200, got ${res.status}`)

  const projectsRes = await worker.fetch(
    new Request('https://platform.example/api/projects', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: projectsData } = await readBody(projectsRes)
  assert(!projectsData.projects.some((p) => p.id === projectId), 'deleted project should no longer be listed')

  const deckRes = await worker.fetch(
    new Request(`https://platform.example/api/decks/${projectDeckId}`, { headers: { cookie: ownerCookie } }),
    env,
  )
  assert(deckRes.status === 200, 'the deck itself must survive deleting its project')

  const listRes = await worker.fetch(
    new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: listData } = await readBody(listRes)
  const listed = listData.decks.find((d) => d.id === projectDeckId)
  assert(listed?.projectId === null, 'the deck should be unassigned (projectId:null), not deleted, once its project is gone')
})

await check('DELETE /api/projects/:id for an unknown project is 404', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/projects/does-not-exist', { method: 'DELETE', headers: { cookie: ownerCookie } }),
    env,
  )
  assert(res.status === 404, `expected 404, got ${res.status}`)
})

const exampleOutline = {
  title: 'Compiled deck',
  theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E' },
  slides: [
    { layout: 'title', heading: 'From an outline', subheading: 'via POST /api/compile' },
    { layout: 'stat', value: 42, label: 'The answer' },
  ],
}

await check('POST /api/compile without a session is rejected', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outline: exampleOutline }),
    }),
    env,
  )
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('POST /api/compile turns an outline into a doc, without storing anything', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ outline: exampleOutline }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  assert(data.doc.format === 'bento/slides', 'compiled doc has the wrong format')
  assert(data.doc.slides.length === 2, 'compiled doc has the wrong slide count')
})

await check('POST /api/compile rejects an invalid outline with field errors', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ outline: { slides: [{ layout: 'title' }] } }), // missing title + heading
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 422, `expected 422, got ${res.status}: ${text}`)
  assert(Array.isArray(data.errors) && data.errors.length >= 2, 'expected multiple field errors')
})

await check('a compiled doc round-trips through POST /api/decks and renders in the spliced view', async () => {
  const compileRes = await worker.fetch(
    new Request('https://platform.example/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ outline: exampleOutline }),
    }),
    env,
  )
  const { data: compiled } = await readBody(compileRes)

  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: compiled.doc }),
    }),
    env,
  )
  const { data: created, text: createText } = await readBody(createRes)
  assert(createRes.status === 201, `expected 201, got ${createRes.status}: ${createText}`)

  const viewRes = await worker.fetch(new Request(`https://platform.example/d/${created.id}`), env)
  const { text: viewText } = await readBody(viewRes)
  assert(viewRes.status === 200, `expected 200, got ${viewRes.status}`)
  assert(viewText.includes('From an outline'), 'compiled title text missing from the spliced view')
  assert(viewText.includes('42'), 'compiled stat value missing from the spliced view')
})

// --- logout -------------------------------------------------------------

// --- search ---------------------------------------------------------------

await check('GET /api/search without a session is rejected', async () => {
  const res = await worker.fetch(new Request('https://platform.example/api/search?q=whatever'), env)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await check('GET /api/search without q is a 400', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/search', { headers: { cookie: ownerCookie } }),
    env,
  )
  assert(res.status === 400, `expected 400, got ${res.status}`)
})

const searchDoc = (title, contentHtml) => ({
  ...exampleDoc,
  title,
  slides: [{ ...exampleDoc.slides[0], elements: [{ ...exampleDoc.slides[0].elements[0], html: contentHtml }] }],
})

let searchDeckAlphaId, searchDeckBetaId, searchDeckGammaId
await check('POST /api/decks seeds three searchable decks (title vs. content matches)', async () => {
  const create = async (doc) => {
    const res = await worker.fetch(
      new Request('https://platform.example/api/decks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ doc }),
      }),
      env,
    )
    return (await readBody(res)).data.id
  }
  searchDeckAlphaId = await create(searchDoc('Alpha Quarterly Review', 'revenue growth strategy'))
  searchDeckBetaId = await create(searchDoc('Beta Notes', 'alpha testing feedback'))
  searchDeckGammaId = await create(searchDoc('Gamma', 'totally unrelated filler'))
  assert(searchDeckAlphaId && searchDeckBetaId && searchDeckGammaId, 'all three decks should have been created')
})

await check('GET /api/search matches a term against EITHER title or content', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/search?q=alpha', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}: ${text}`)
  const ids = data.decks.map((d) => d.id)
  assert(ids.includes(searchDeckAlphaId), 'title match ("Alpha...") should be included')
  assert(ids.includes(searchDeckBetaId), 'content match ("alpha testing...") should be included')
  assert(!ids.includes(searchDeckGammaId), 'a deck matching neither title nor content should be excluded')
})

await check('GET /api/search with multiple space-separated terms ANDs them, each independently against title-or-content', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/search?q=' + encodeURIComponent('alpha revenue'), {
      headers: { cookie: ownerCookie },
    }),
    env,
  )
  const { data } = await readBody(res)
  const ids = data.decks.map((d) => d.id)
  assert(ids.includes(searchDeckAlphaId), '"alpha" (title) AND "revenue" (content) should both be satisfied by the Alpha deck')
  assert(
    !ids.includes(searchDeckBetaId),
    'the Beta deck has "alpha" in its content but no "revenue" anywhere, so it should NOT match the two-term AND query',
  )
})

await check('GET /api/search returns an empty list for a query matching nothing', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/search?q=zzzznomatchzzzz', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data } = await readBody(res)
  assert(Array.isArray(data.decks) && data.decks.length === 0, 'expected zero results')
})

await check('GET /api/search finds content in an html-kind deck (tag-stripped)', async () => {
  const html = '<!doctype html><html><head><title>Html Search Deck</title></head><body><h1>uniquehtmlkeyword lives here</h1></body></html>'
  const createRes = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html }),
    }),
    env,
  )
  const htmlDeckId = (await readBody(createRes)).data.id

  const res = await worker.fetch(
    new Request('https://platform.example/api/search?q=uniquehtmlkeyword', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data } = await readBody(res)
  assert(data.decks.some((d) => d.id === htmlDeckId), 'expected the html deck to be found by its stripped-tag body content')
})

await check('PATCH /api/decks/:id (content replace) re-derives search_text — old content stops matching, new content starts', async () => {
  const patchRes = await worker.fetch(
    new Request(`https://platform.example/api/decks/${searchDeckGammaId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ doc: searchDoc('Gamma', 'freshly replaced wording') }),
    }),
    env,
  )
  assert(patchRes.status === 200, `expected 200, got ${patchRes.status}`)

  const oldRes = await worker.fetch(
    new Request('https://platform.example/api/search?q=unrelated', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data: oldData } = await readBody(oldRes)
  assert(!oldData.decks.some((d) => d.id === searchDeckGammaId), 'the OLD content keyword should no longer match after replace')

  const newRes = await worker.fetch(
    new Request('https://platform.example/api/search?q=' + encodeURIComponent('freshly replaced'), {
      headers: { cookie: ownerCookie },
    }),
    env,
  )
  const { data: newData } = await readBody(newRes)
  assert(newData.decks.some((d) => d.id === searchDeckGammaId), 'the NEW content should match after replace')
})

await check('GET /api/search caps results at 10', async () => {
  for (let i = 0; i < 11; i++) {
    await worker.fetch(
      new Request('https://platform.example/api/decks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ doc: searchDoc('Capacity test deck ' + i, 'capacitytestcontent') }),
      }),
      env,
    )
  }
  const res = await worker.fetch(
    new Request('https://platform.example/api/search?q=capacitytestcontent', { headers: { cookie: ownerCookie } }),
    env,
  )
  const { data } = await readBody(res)
  assert(data.decks.length === 10, `expected exactly 10 results, got ${data.decks.length}`)
})

// ——— 'md' decks: raw Markdown stored, rendered (never passed through) at view time
const MD_SOURCE = '---\ntitle: "Front Matter Title"\n---\n\n# Roadmap 路线图\n\nSome **bold** text and a [link](https://example.com).\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
let mdDeckId
await check('POST /api/decks with {md} creates an md-kind deck, title from front matter, edit coerced to view', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ md: MD_SOURCE, access: 'edit' }),
    }),
    env,
  )
  const { data, text } = await readBody(res)
  assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
  mdDeckId = data.id
  const listRes = await worker.fetch(new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }), env)
  const listed = (await readBody(listRes)).data.decks.find((d) => d.id === mdDeckId)
  assert(listed.kind === 'md', `expected kind md, got ${listed.kind}`)
  assert(listed.access === 'view', `expected edit coerced to view, got ${listed.access}`)
  assert(listed.title === 'Front Matter Title', `expected front-matter title, got ${listed.title}`)
})

await check('POST /api/decks rejects empty md', async () => {
  const res = await worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ md: '   \n' }),
    }),
    env,
  )
  assert(res.status === 422, `expected 422, got ${res.status}`)
})

await check('GET /d/:id for an md deck serves the sandboxed wrapper around RENDERED html — raw html/js in the source is inert', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${mdDeckId}`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text.includes('sandbox='), 'md deck must be served through the sandboxed iframe wrapper')
  assert(text.includes(`href="/d/${mdDeckId}/pdf"`), 'expected the Download PDF control, same as an html deck')
  // srcdoc is attribute-escaped; unescape the entities to inspect the page inside it
  const srcdoc = /srcdoc="([^"]*)"/.exec(text)?.[1]?.replace(/&quot;/g, '"').replace(/&amp;/g, '&') ?? ''
  assert(srcdoc.includes('<h1 id="roadmap-路线图">Roadmap 路线图</h1>'), 'expected the rendered heading')
  assert(srcdoc.includes('<strong>bold</strong>'), 'expected rendered emphasis')
  assert(srcdoc.includes('<table>'), 'expected a rendered table')
  assert(!srcdoc.includes('<script>alert(1)'), 'raw <script> from the source must never reach the page as markup')
  assert(srcdoc.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'raw <script> should be visible as escaped text')
  assert(!/href="javascript:/i.test(srcdoc), 'javascript: link must not become a live href')
  assert(!srcdoc.includes('title: "Front Matter Title"'), 'front matter must not be rendered')
})

await check('GET /d/:id/download for an md deck returns the exact original Markdown as an attachment', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/d/${mdDeckId}/download`), env)
  const { text } = await readBody(res)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(text === MD_SOURCE, 'download must be byte-for-byte the uploaded source')
  assert((res.headers.get('content-type') ?? '').startsWith('text/markdown'), 'expected text/markdown')
  assert(res.headers.get('content-disposition')?.includes('.md"'), 'expected a .md filename')
})

await check('GET /api/decks/:id for an md deck returns { kind, md }', async () => {
  const res = await worker.fetch(new Request(`https://platform.example/api/decks/${mdDeckId}`, { headers: { cookie: ownerCookie } }), env)
  const { data } = await readBody(res)
  assert(data.kind === 'md' && data.md === MD_SOURCE, 'expected the stored source back')
})

await check('PATCH /api/decks/:id with {md} re-uploads and re-derives the title; {html}/{doc} against an md deck is a 400', async () => {
  const bad = await worker.fetch(
    new Request(`https://platform.example/api/decks/${mdDeckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ html: '<!doctype html><p>x</p>' }),
    }),
    env,
  )
  assert(bad.status === 400, `expected 400 for a kind mismatch, got ${bad.status}`)
  const ok = await worker.fetch(
    new Request(`https://platform.example/api/decks/${mdDeckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ md: '# Second Version\n\nmarkdowndeckneedle' }),
    }),
    env,
  )
  assert(ok.status === 200, `expected 200, got ${ok.status}`)
  const listRes = await worker.fetch(new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }), env)
  const listed = (await readBody(listRes)).data.decks.find((d) => d.id === mdDeckId)
  assert(listed.title === 'Second Version', `expected re-derived title, got ${listed.title}`)
})

await check('{md} against a bento or html deck is a 400, not a silent no-op', async () => {
  // fresh decks — the shared fixtures are already deleted by earlier tests
  const mk = async (body) => {
    const r = await worker.fetch(
      new Request('https://platform.example/api/decks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify(body),
      }),
      env,
    )
    return (await readBody(r)).data.id
  }
  const freshBento = await mk({ doc: exampleDoc })
  const freshHtml = await mk({ html: '<!doctype html><title>t</title><p>x</p>' })
  for (const id of [freshBento, freshHtml]) {
    const res = await worker.fetch(
      new Request(`https://platform.example/api/decks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ md: '# x' }),
      }),
      env,
    )
    assert(res.status === 400, `expected 400, got ${res.status}`)
  }
})

await check('GET /api/search finds md content (syntax stripped), and rename touches only the label', async () => {
  const found = await worker.fetch(new Request('https://platform.example/api/search?q=markdowndeckneedle', { headers: { cookie: ownerCookie } }), env)
  assert((await readBody(found)).data.decks.some((d) => d.id === mdDeckId), 'expected the md deck in search results')
  const rn = await worker.fetch(
    new Request(`https://platform.example/api/decks/${mdDeckId}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ title: 'Renamed MD' }),
    }),
    env,
  )
  assert(rn.status === 200, `expected 200, got ${rn.status}`)
  const dl = await worker.fetch(new Request(`https://platform.example/d/${mdDeckId}/download`), env)
  assert((await readBody(dl)).text === '# Second Version\n\nmarkdowndeckneedle', 'rename must not touch the stored source')
})

await check('an md deck honors private/404 for anonymous viewers, on view, download and pdf alike', async () => {
  const set = await worker.fetch(
    new Request(`https://platform.example/api/decks/${mdDeckId}/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ access: 'private' }),
    }),
    env,
  )
  assert(set.status === 200, `expected 200, got ${set.status}`)
  for (const path of ['', '/download', '/pdf']) {
    const res = await worker.fetch(new Request(`https://platform.example/d/${mdDeckId}${path}`), env)
    assert(res.status === 404, `expected 404 for anonymous /d/:id${path}, got ${res.status}`)
  }
})

await check('DELETE removes an md deck: row and stored source both gone', async () => {
  const del = await worker.fetch(new Request(`https://platform.example/api/decks/${mdDeckId}`, { method: 'DELETE', headers: { cookie: ownerCookie } }), env)
  assert(del.status === 200, `expected 200, got ${del.status}`)
  assert(!env.DOCS._objects.has(`docs/${mdDeckId}/doc.md`), 'doc.md must be deleted from R2')
  const gone = await worker.fetch(new Request(`https://platform.example/d/${mdDeckId}`, { headers: { cookie: ownerCookie } }), env)
  assert(gone.status === 404, `expected 404 after delete, got ${gone.status}`)
})

// ——— web clip: POST /api/decks {url} fetches + converts to an 'md' deck
const clipPost = (body) =>
  worker.fetch(
    new Request('https://platform.example/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify(body),
    }),
    env,
  )
const CLIP_HTML = `<html><head><title>Clipped Story</title></head><body><nav>NAVJUNK</nav><article><h1>Clipped Story</h1><p>${'Genuine article sentence, with commas and enough words to count. '.repeat(8)}</p><img src="/pic.png" alt="pic"><p>${'More genuine article sentence, with commas and words. '.repeat(6)}</p></article></body></html>`
const realFetch = globalThis.fetch
let clipDeckId
await check('POST /api/decks {url} clips the page into an md deck (media stays online)', async () => {
  const seen = []
  globalThis.fetch = async (u) => {
    seen.push(String(u))
    return new Response(CLIP_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  try {
    const res = await clipPost({ url: 'https://news.example.com/a/b?x=1', access: 'edit' })
    const { data, text } = await readBody(res)
    assert(res.status === 201, `expected 201, got ${res.status}: ${text}`)
    assert(data.title === 'Clipped Story', `title: ${data.title}`)
    assert(seen.length === 1 && seen[0] === 'https://news.example.com/a/b?x=1', `fetched: ${seen}`)
    clipDeckId = data.id
    const md = new TextDecoder().decode(env.DOCS._objects.get(`docs/${clipDeckId}/doc.md`).bytes)
    assert(md.includes('![pic](https://news.example.com/pic.png)'), `md: ${md.slice(0, 300)}`)
    assert(md.includes('Source: [news.example.com]'), 'source line missing')
    assert(!md.includes('NAVJUNK'), 'nav leaked into the clip')
    const listed = (await readBody(await worker.fetch(new Request('https://platform.example/api/decks', { headers: { cookie: ownerCookie } }), env))).data.decks.find((d) => d.id === clipDeckId)
    assert(listed.kind === 'md' && listed.access === 'view', `kind/access: ${listed.kind}/${listed.access}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('POST /api/decks {url} runs the optional AI cleanup (drops the blocks it names) and survives an AI failure', async () => {
  globalThis.fetch = async () => new Response(CLIP_HTML.replace('<p>More', '<p>SWITCHER €$£</p><p>More'), { status: 200, headers: { 'content-type': 'text/html' } })
  try {
    let prompt = ''
    env.AI = {
      run: async (_m, input) => {
        prompt = input.messages[1].content
        const idx = prompt.split('\n').findIndex((l) => l.includes('SWITCHER'))
        return { response: JSON.stringify({ drop: [idx] }) }
      },
    }
    const ok = await readBody(await clipPost({ url: 'https://ai.example.com/a' }))
    assert(ok.data.id, `create failed: ${ok.text}`)
    const md = new TextDecoder().decode(env.DOCS._objects.get(`docs/${ok.data.id}/doc.md`).bytes)
    assert(!md.includes('SWITCHER') && md.includes('More genuine'), `cleanup result: ${md.slice(0, 400)}`)
    env.AI = { run: async () => { throw new Error('quota exhausted') } }
    const failed = await readBody(await clipPost({ url: 'https://ai.example.com/a' }))
    const md2 = new TextDecoder().decode(env.DOCS._objects.get(`docs/${failed.data.id}/doc.md`).bytes)
    assert(md2.includes('SWITCHER'), 'AI failure must leave the heuristic clip untouched')
  } finally {
    delete env.AI
    globalThis.fetch = realFetch
  }
})

await check('POST /api/decks {url} rejects bad / private URLs without fetching, and non-HTML / HTTP errors cleanly', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })
  }
  try {
    for (const bad of ['nonsense', 'file:///etc/passwd', 'http://localhost/x', 'http://192.168.0.1/', 'https://platform.example/d/abc']) {
      const r = await clipPost({ url: bad })
      assert(r.status === 422, `${bad}: expected 422, got ${r.status}`)
    }
    assert(calls === 0, 'must not fetch a rejected URL')
    const pdf = await clipPost({ url: 'https://files.example.com/a.pdf' })
    assert(pdf.status === 415, `pdf: expected 415, got ${pdf.status}`)
    globalThis.fetch = async () => new Response('nope', { status: 403 })
    const denied = await clipPost({ url: 'https://blocked.example.com/' })
    assert(denied.status === 502, `403 site: expected 502, got ${denied.status}`)
    globalThis.fetch = async () => new Response('<html><body><div id="root"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    const spa = await clipPost({ url: 'https://spa.example.com/' })
    assert(spa.status === 422, `spa: expected 422, got ${spa.status}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('POST /api/decks {url} follows redirects but re-validates each hop', async () => {
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
  }
  try {
    const r = await clipPost({ url: 'https://redir.example.com/' })
    assert(r.status === 422, `expected 422 for a redirect to loopback, got ${r.status}`)
    assert(n === 1, `should stop at the first hop, fetched ${n}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('POST /api/decks {url} requires the owner session', async () => {
  const r = await worker.fetch(
    new Request('https://platform.example/api/decks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/' }) }),
    env,
  )
  assert(r.status === 401, `expected 401, got ${r.status}`)
})

await check('POST /api/logout ends the session, further owner requests are rejected', async () => {
  const logoutRes = await worker.fetch(
    new Request('https://platform.example/api/logout', { method: 'POST', headers: { cookie: ownerCookie } }),
    env,
  )
  assert(logoutRes.status === 200, `expected 200, got ${logoutRes.status}`)

  const res = await worker.fetch(new Request('https://platform.example/', { headers: { cookie: ownerCookie } }), env)
  assert(res.status === 302, `expected 302 after logout, got ${res.status}`)
  assert(res.headers.get('location') === '/login', `expected redirect to /login, got ${res.headers.get('location')}`)
})

// --- favicon -----------------------------------------------------------

await check('GET /favicon.png serves the site icon, publicly, immutably cached', async () => {
  const res = await worker.fetch(new Request('https://platform.example/favicon.png'), env)
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(res.headers.get('content-type') === 'image/png', `expected image/png, got ${res.headers.get('content-type')}`)
  assert(
    (res.headers.get('cache-control') ?? '').includes('immutable'),
    `expected an immutable cache-control, got ${res.headers.get('cache-control')}`,
  )
  const bytes = new Uint8Array(await res.arrayBuffer())
  // PNG magic number — cheap sanity check that this is real image bytes,
  // not e.g. an accidentally-base64-encoded-twice string.
  assert(
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
    'expected a valid PNG signature',
  )
})

await check('GET /login references /favicon.png', async () => {
  const res = await worker.fetch(new Request('https://platform.example/login'), env)
  const { text } = await readBody(res)
  assert(text.includes('href="/favicon.png"'), 'expected the login page to link the favicon')
})

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
