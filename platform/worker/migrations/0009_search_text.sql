-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 The Bento authors
--
-- Migration 0009 — a precomputed, lowercase, plain-text extraction of each
-- deck's CONTENT (not its title — that's already the `title` column) for
-- the sidebar's search box. See searchText.ts for how it's built and
-- store.ts's searchDecks for how it's queried (a plain LIKE scan — this
-- project's declared scale doesn't need FTS5). Existing decks default to
-- '' (empty) — they simply aren't content-searchable until next saved;
-- there is no backfill migration, since populating it requires reading
-- each deck's bytes back out of R2, which a SQL migration file can't do.
--
-- Apply by hand in the CF dashboard: D1 → your database → Console tab, paste
-- this whole file, run — AFTER 0001-0008, once.

ALTER TABLE decks ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
