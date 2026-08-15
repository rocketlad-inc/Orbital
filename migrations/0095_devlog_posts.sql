-- Devlog posts, editable at runtime.
--
-- The changelog page shipped as a compiled constant: publishing an
-- update meant editing a .tsx file, rebuilding and redeploying the whole
-- client. That makes the devlog a developer task rather than an author
-- task, and it means a typo in a published post costs a deploy.
--
-- Posts live here now. The compiled copy in src/content/devlogPosts.js
-- survives as the SEED for an empty table and as the offline fallback
-- when the API cannot be reached, so the page can never render blank.
--
-- `sort_index` orders the page (DESC), rather than trusting `date`,
-- which is a free-text display string ("July 2026") on purpose — no
-- timezone arithmetic on a page whose only job is to be read.
CREATE TABLE IF NOT EXISTS devlog_posts (
  id           TEXT PRIMARY KEY,
  -- URL anchor. UNIQUE because it is the thing people link to: two
  -- posts sharing one would make an old link silently land on the wrong
  -- update.
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  date         TEXT NOT NULL DEFAULT '',
  lede         TEXT NOT NULL DEFAULT '',
  html         TEXT NOT NULL DEFAULT '',
  -- Render the combat matrix charts under this post. A flag rather than
  -- a hard-coded component, so the charts belong to the post that
  -- discusses them instead of to whichever post is last on the page.
  charts       INTEGER NOT NULL DEFAULT 0,
  -- Drafts are invisible to the public endpoint but returned to admins,
  -- so an update can be written across several sittings before it goes
  -- out.
  published    INTEGER NOT NULL DEFAULT 1,
  sort_index   INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);

-- The public read is "published, newest first" and nothing else, so it
-- gets the index.
CREATE INDEX IF NOT EXISTS idx_devlog_published
  ON devlog_posts(published, sort_index DESC);
