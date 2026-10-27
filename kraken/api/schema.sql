-- SPDX-License-Identifier: GPL-3.0-only
-- The Kraken hub's database: import it once in phpMyAdmin (Import > this file). It only creates what is missing
-- (CREATE TABLE IF NOT EXISTS): importing it again later does no harm and erases nothing.
-- MySQL 8 or MariaDB 10.3+, InnoDB, utf8mb4 (every language, emoji included). Every time is UTC.

SET NAMES utf8mb4;

-- the people: an email (never shown to others), a name, an optional country and YouTube channel, their XP
CREATE TABLE IF NOT EXISTS hub_users (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email       VARCHAR(190) NOT NULL,
  name        VARCHAR(40)  NOT NULL,
  bio         VARCHAR(400) NOT NULL DEFAULT '',
  country     CHAR(2)      NULL,
  youtube     VARCHAR(200) NULL,
  xp          INT          NOT NULL DEFAULT 0,
  banned      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL,
  last_seen   DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email (email),
  KEY k_country (country),
  KEY k_xp (xp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- the links mailed to sign in: only their SHA-256 is kept, valid 15 minutes, once
CREATE TABLE IF NOT EXISTS hub_login_tokens (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email       VARCHAR(190) NOT NULL,
  token_hash  CHAR(64)     NOT NULL,
  created_at  DATETIME     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  used_at     DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token_hash),
  KEY k_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- the window that asked for a link: signed in when the link is opened anywhere, or by the email's 6-digit code
-- (the API also makes this table itself on first use, for a hub installed before it)
CREATE TABLE IF NOT EXISTS hub_login_waits (
  token_hash  CHAR(64)         NOT NULL,
  wait_hash   CHAR(64)         NOT NULL,
  code_hash   CHAR(64)         NOT NULL,
  email       VARCHAR(190)     NOT NULL,
  tries       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  approved    TINYINT(1)       NOT NULL DEFAULT 0,
  claimed     TINYINT(1)       NOT NULL DEFAULT 0,
  created_at  DATETIME         NOT NULL,
  expires_at  DATETIME         NOT NULL,
  PRIMARY KEY (token_hash),
  UNIQUE KEY uq_wait (wait_hash),
  KEY k_email (email),
  KEY k_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- a signed-in browser: only the SHA-256 of its token is kept
CREATE TABLE IF NOT EXISTS hub_sessions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  CHAR(64)     NOT NULL,
  created_at  DATETIME     NOT NULL,
  last_used   DATETIME     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token_hash),
  KEY k_user (user_id),
  CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES hub_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- what people publish: songs, presets, plugins (LAB patches), templates. Their data (JSON) is in hub_item_data.
CREATE TABLE IF NOT EXISTS hub_items (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED  NOT NULL,
  kind          VARCHAR(10)   NOT NULL,              -- song, preset, plugin, template
  subkind       VARCHAR(16)   NULL,                  -- a preset's kind: fx, chain, track
  title         VARCHAR(80)   NOT NULL,
  description   TEXT          NOT NULL,
  genre         VARCHAR(40)   NOT NULL DEFAULT '',
  tags          VARCHAR(255)  NOT NULL DEFAULT '',   -- ,tag,tag, (commas around each: exact search)
  bpm           DECIMAL(6,2)  NULL,
  youtube       CHAR(11)      NULL,                  -- a YouTube video id
  yt_xp         TINYINT(1)    NOT NULL DEFAULT 0,    -- the XP for the YouTube link was given
  has_audio     TINYINT(1)    NOT NULL DEFAULT 0,    -- it plays audio files that were not published
  audio_count   SMALLINT      NOT NULL DEFAULT 0,
  size          INT           NOT NULL DEFAULT 0,
  data_hash     CHAR(64)      NOT NULL DEFAULT '',   -- SHA-256 of the data: the same thing is not published twice
  likes         INT           NOT NULL DEFAULT 0,
  downloads     INT           NOT NULL DEFAULT 0,
  reports       INT           NOT NULL DEFAULT 0,    -- reports not yet reviewed
  status        VARCHAR(10)   NOT NULL DEFAULT 'visible',   -- visible, hidden
  hidden_reason VARCHAR(16)   NULL,                  -- reports, admin
  created_at    DATETIME      NOT NULL,
  updated_at    DATETIME      NOT NULL,
  PRIMARY KEY (id),
  KEY k_status_created (status, created_at),
  KEY k_user (user_id, data_hash),
  KEY k_kind (kind),
  KEY k_genre (genre),
  KEY k_likes (likes),
  CONSTRAINT fk_item_user FOREIGN KEY (user_id) REFERENCES hub_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hub_item_data (
  item_id     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT   NOT NULL,
  PRIMARY KEY (item_id),
  CONSTRAINT fk_data_item FOREIGN KEY (item_id) REFERENCES hub_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- one like per person per item; the liker's country then (for "liked in N countries"); the XP it gave
CREATE TABLE IF NOT EXISTS hub_likes (
  user_id     INT UNSIGNED NOT NULL,
  item_id     INT UNSIGNED NOT NULL,
  country     CHAR(2)      NULL,
  xp_owner    TINYINT(1)   NOT NULL DEFAULT 0,
  xp_liker    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL,
  PRIMARY KEY (user_id, item_id),
  KEY k_item (item_id, created_at),
  CONSTRAINT fk_like_user FOREIGN KEY (user_id) REFERENCES hub_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_like_item FOREIGN KEY (item_id) REFERENCES hub_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- downloads, counted once per person (or address) per item per day; who: a hash, never the address itself
CREATE TABLE IF NOT EXISTS hub_downloads (
  item_id     INT UNSIGNED NOT NULL,
  who         CHAR(64)     NOT NULL,
  day         DATE         NOT NULL,
  user_id     INT UNSIGNED NULL,
  PRIMARY KEY (item_id, who, day),
  CONSTRAINT fk_dl_item FOREIGN KEY (item_id) REFERENCES hub_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hub_follows (
  follower_id INT UNSIGNED NOT NULL,
  followee_id INT UNSIGNED NOT NULL,
  xp          TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  KEY k_followee (followee_id),
  CONSTRAINT fk_fol_a FOREIGN KEY (follower_id) REFERENCES hub_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fol_b FOREIGN KEY (followee_id) REFERENCES hub_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- one report per person per item; resolved once a moderator looked at it
CREATE TABLE IF NOT EXISTS hub_reports (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id     INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  reason      VARCHAR(16)  NOT NULL,
  note        VARCHAR(300) NOT NULL DEFAULT '',
  resolved    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_item_user (item_id, user_id),
  KEY k_resolved (resolved, created_at),
  CONSTRAINT fk_rep_item FOREIGN KEY (item_id) REFERENCES hub_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_rep_user FOREIGN KEY (user_id) REFERENCES hub_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- every XP gained or taken back (the audit, the daily caps, the "+10 XP" said at the next visit)
CREATE TABLE IF NOT EXISTS hub_xp_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  amount      INT          NOT NULL,
  reason      VARCHAR(24)  NOT NULL,
  item_id     INT UNSIGNED NULL,
  actor_id    INT UNSIGNED NULL,
  seen        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY k_user_time (user_id, created_at),
  KEY k_user_reason (user_id, reason, created_at),
  KEY k_user_seen (user_id, seen),
  CONSTRAINT fk_xp_user FOREIGN KEY (user_id) REFERENCES hub_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hub_badges (
  user_id     INT UNSIGNED NOT NULL,
  badge       VARCHAR(24)  NOT NULL,
  created_at  DATETIME     NOT NULL,
  PRIMARY KEY (user_id, badge),
  CONSTRAINT fk_badge_user FOREIGN KEY (user_id) REFERENCES hub_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- rate limits: k is a hash of what is counted (an action and an address or a person), win the window's start
CREATE TABLE IF NOT EXISTS hub_rate (
  k           CHAR(64)     NOT NULL,
  win         INT UNSIGNED NOT NULL,
  n           INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (k, win),
  KEY k_win (win)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
