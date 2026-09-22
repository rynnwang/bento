// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Cloudflare bindings this Worker expects. The primary deploy path is
// Workers Builds, driven by wrangler.toml in this directory (auto-deploys on
// every push to main — see that file's own header); the "paste dist/
// worker.js into the CF dashboard Quick Edit editor" path documented in
// platform/README.md is a manual fallback, and bindings added there must be
// added BY HAND (Worker → Settings → Bindings) since that path never reads
// wrangler.toml. Either way, binding names must match the property names
// below verbatim.
import type { BrowserWorker } from '@cloudflare/puppeteer'

export interface Env {
  /** R2 bucket: deck doc JSON + uploaded asset blobs. Binding name: DOCS. */
  DOCS: R2Bucket
  /** D1 database: deck metadata + edit-token hashes. Binding name: DB. */
  DB: D1Database
  /** Browser Rendering: a real, Cloudflare-managed headless Chromium this
   *  Worker can drive via @cloudflare/puppeteer — see pdf.ts. Binding name:
   *  BROWSER. Free-tier limited (10 browser-minutes/day, 3 concurrent,
   *  60s/session as of this writing — developers.cloudflare.com/browser-run/
   *  limits/) — pdf.ts's R2 caching exists specifically to stay well inside
   *  that budget regardless of how many times a deck's PDF is downloaded. */
  BROWSER: BrowserWorker
}
