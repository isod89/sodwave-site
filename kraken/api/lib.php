<?php
// SPDX-License-Identifier: GPL-3.0-only
// The Kraken hub, the shared parts: settings, database, answers, rate limits, signing in, text checks, YouTube
// links, countries, XP, levels and badges. index.php (the API), s.php (share pages) and thumb.php (thumbnails)
// include it. Nothing here runs on its own: opened directly, it does nothing (and .htaccess refuses it).
declare(strict_types=1);

if (!defined('KRAKEN_HUB')) { http_response_code(404); exit; }

const HUB_VERSION = 1;
const MAX_DATA = 524288;            // bytes of JSON an item's data may take (512 KB)
const MAX_BODY = 655360;            // bytes a request may send (the data and its description)
const KINDS = ['song', 'preset', 'plugin', 'template'];
const PRESET_KINDS = ['fx', 'chain', 'track'];
const REPORT_REASONS = ['spam', 'offensive', 'copyright', 'broken', 'other'];
// the levels: an ocean, from the smallest to the Kraken
const LEVELS = [[0, 'Plankton'], [100, 'Shrimp'], [300, 'Seahorse'], [700, 'Octopus'], [1500, 'Shark'], [3000, 'Orca'],
  [6000, 'Sperm whale'], [12000, 'Leviathan'], [25000, 'Kraken'], [50000, 'Legendary Kraken']];
const BADGES = ['first_song', 'first_plugin', 'likes_10', 'likes_100', 'countries_10', 'followers_10'];
// XP (the "How XP works" of the hub says the same)
const XP_PUBLISH = 50, XP_PUBLISH_PER_DAY = 3, XP_YOUTUBE = 20, XP_YOUTUBE_PER_DAY = 3, XP_LIKE = 10, XP_DOWNLOAD = 2,
  XP_DOWNLOAD_CAP = 100, XP_LIKE_GIVEN = 1, XP_LIKE_GIVEN_CAP = 20, XP_FOLLOWER = 5;
// ISO 3166-1 alpha-2 (and XK, Kosovo, as most services have it)
const COUNTRIES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  . 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE '
  . 'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR '
  . 'KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI '
  . 'NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS '
  . 'ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW';

// ------------------------------------------------------------------ settings ---
// config.php: outside the web folder first (next to public_html), else beside this file; KRAKEN_HUB_CONFIG (tests)
function cfg(?string $key = null) {
  static $c = null;
  if ($c === null) {
    $paths = array_filter([getenv('KRAKEN_HUB_CONFIG') ?: null, dirname(__DIR__, 2) . '/kraken-hub-config.php', __DIR__ . '/config.php']);
    $found = null;
    foreach ($paths as $p) if (is_file($p)) { $found = $p; break; }
    if (!$found) { send_json(['error' => 'not_configured'], 503); }
    $c = (require $found) + [
      'db_host' => 'localhost', 'db_port' => 3306, 'db_socket' => null, 'site_url' => '', 'mail_from' => '', 'mail_from_name' => 'Kraken hub',
      'admins' => [], 'report_threshold' => 3, 'secret' => '', 'cache_dir' => __DIR__ . '/cache', 'dev_return_link' => false,
      'trust_proxy' => false, 'min_account_age' => 3600, 'privacy_url' => '', 'terms_url' => '', 'thumb_url' => 'https://i.ytimg.com/vi/%s/hqdefault.jpg', 'rate' => [],
    ];
  }
  return $key === null ? $c : ($c[$key] ?? null);
}

// ------------------------------------------------------------------ answers ---
function send_json($data, int $status = 200): void {
  if (!headers_sent()) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
  }
  echo is_string($data) ? $data : json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
// an error the page can say (it knows each code's sentence, in English and French)
function fail(string $code, int $status = 400, array $extra = []): void { send_json(['error' => $code] + $extra, $status); }

// nothing technical ever reaches the visitor: the details go to the server's error log
function hub_errors(): void {
  ini_set('display_errors', '0');
  error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);    // (a newer PHP's deprecation notes: never fatal)
  set_error_handler(function ($no, $str, $file, $line) {
    if (!(error_reporting() & $no)) return false;
    throw new ErrorException($str, 0, $no, $file, $line);
  });
  set_exception_handler(function (Throwable $e) {
    error_log('kraken hub: ' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    send_json(['error' => 'server'], 500);
  });
}

// ------------------------------------------------------------------ database ---
function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $c = cfg();
  $dsn = $c['db_socket'] ? "mysql:unix_socket={$c['db_socket']};dbname={$c['db_name']};charset=utf8mb4"
    : "mysql:host={$c['db_host']};port=" . (int) $c['db_port'] . ";dbname={$c['db_name']};charset=utf8mb4";
  try {
    $pdo = new PDO($dsn, $c['db_user'], $c['db_pass'], [
      PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false,
      PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
  } catch (PDOException $e) {
    error_log('kraken hub: database: ' . $e->getMessage());
    send_json(['error' => 'database'], 503);
  }
  $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
  $pdo->exec("SET time_zone = '+00:00'");                         // (every time is UTC; MySQL 8 and MariaDB alike)
  return $pdo;
}
// a query with its values (always prepared: nothing typed by anyone is ever part of the SQL itself)
function q(string $sql, array $args = []): PDOStatement { $st = db()->prepare($sql); $st->execute($args); return $st; }
function one(string $sql, array $args = []): ?array { $r = q($sql, $args)->fetch(); return $r === false ? null : $r; }
function all(string $sql, array $args = []): array { return q($sql, $args)->fetchAll(); }
function val(string $sql, array $args = []) { $r = q($sql, $args)->fetchColumn(); return $r === false ? null : $r; }
function now(): string { return gmdate('Y-m-d H:i:s'); }
function iso(?string $t): ?string { return $t ? str_replace(' ', 'T', $t) . 'Z' : null; }

// ------------------------------------------------------------------ the visitor ---
function client_ip(): string {
  $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
  if (cfg('trust_proxy') && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) $ip = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
  return $ip;
}
// an address or a person blurred with the secret: counted, never kept as it is
function blur(string $s): string { return hash_hmac('sha256', $s, (string) cfg('secret')); }

// ------------------------------------------------------------------ rate limits ---
// at most $limit times per $seconds for this action and this address (or person); the defaults can be changed in
// config.php: 'rate' => ['login_ip' => [5, 900]]
const RATES = [
  'read_ip' => [600, 60], 'login_ip' => [8, 900], 'login_email' => [4, 900], 'exchange_ip' => [30, 900], 'publish_user' => [20, 3600],
  'like_user' => [150, 3600], 'follow_user' => [60, 3600], 'report_user' => [30, 86400], 'edit_user' => [60, 3600], 'download_ip' => [300, 3600],
  'thumb_ip' => [120, 60], 'profile_user' => [30, 3600], 'admin_user' => [600, 3600],
];
function rate(string $name, string $who): void {
  [$limit, $seconds] = cfg('rate')[$name] ?? RATES[$name];
  $win = intdiv(time(), $seconds) * $seconds;
  $k = blur("$name|$who");
  q('INSERT INTO hub_rate (k, win, n) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE n = n + 1', [$k, $win]);
  $n = (int) val('SELECT n FROM hub_rate WHERE k = ? AND win = ?', [$k, $win]);
  if (mt_rand(1, 200) === 1) q('DELETE FROM hub_rate WHERE win < ?', [time() - 86400 * 2]);    // (old windows: cleared now and then)
  if ($n > $limit) { header('Retry-After: ' . ($win + $seconds - time())); fail('rate_limited', 429, ['retry_after' => $win + $seconds - time()]); }
}

// ------------------------------------------------------------------ signing in ---
function bearer(): ?string {
  $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
  if (!$h && function_exists('getallheaders')) foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) $h = $v;
  if (preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim((string) $h), $m)) return strtolower($m[1]);
  // (some hosts drop Authorization on its way to PHP: the page sends the token in this header too)
  $x = $_SERVER['HTTP_X_KRAKEN_TOKEN'] ?? '';
  return preg_match('/^[a-f0-9]{64}$/i', $x) ? strtolower($x) : null;
}
function current_user(): ?array {
  static $done = false, $u = null;
  if ($done) return $u;
  $done = true;
  $t = bearer();
  if (!$t) return null;
  $u = one('SELECT u.*, s.id AS session_id, s.last_used FROM hub_sessions s JOIN hub_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()', [hash('sha256', $t)]);
  if ($u && strtotime($u['last_used'] . ' UTC') < time() - 600) {      // (used: kept 180 days from now)
    q('UPDATE hub_sessions SET last_used = UTC_TIMESTAMP(), expires_at = UTC_TIMESTAMP() + INTERVAL 180 DAY WHERE id = ?', [$u['session_id']]);
    q('UPDATE hub_users SET last_seen = UTC_TIMESTAMP() WHERE id = ?', [$u['id']]);
  }
  return $u;
}
function need_user(): array { $u = current_user(); if (!$u) fail('login_required', 401); return $u; }
// a person who may act (publish, like, follow, report): signed in and not banned
function need_member(): array { $u = need_user(); if ($u['banned']) fail('banned', 403); return $u; }
function is_admin(?array $u): bool {
  if (!$u || $u['banned']) return false;
  foreach ((array) cfg('admins') as $a) if (strcasecmp(trim((string) $a), $u['email']) === 0) return true;
  return false;
}
function need_admin(): array { $u = need_user(); if (!is_admin($u)) fail('forbidden', 403); return $u; }

// ------------------------------------------------------------------ what is sent ---
function body(): object {
  static $b = null;
  if ($b !== null) return $b;
  if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BODY) fail('too_large', 413);
  $raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
  if ($raw === false || strlen($raw) > MAX_BODY) fail('too_large', 413);
  if ($raw === '') return $b = new stdClass();
  if (!mb_check_encoding($raw, 'UTF-8')) fail('bad_request');
  try { $b = json_decode($raw, false, 256, JSON_THROW_ON_ERROR); } catch (JsonException $e) { fail('bad_json'); }
  if (!is_object($b)) fail('bad_request');
  return $b;
}
// a text: valid UTF-8, no control characters, trimmed, at most $max characters (lines kept only when $lines)
function text($v, int $max, bool $lines = false): string {
  if ($v === null) return '';
  if (!is_string($v) && !is_int($v) && !is_float($v)) fail('bad_request');
  $s = (string) $v;
  if (!mb_check_encoding($s, 'UTF-8')) fail('bad_request');
  $s = $lines ? preg_replace('/[^\P{C}\n]+/u', '', str_replace(["\r\n", "\r"], "\n", $s)) : preg_replace('/\p{C}+/u', ' ', $s);
  $s = $lines ? preg_replace("/\n{3,}/", "\n\n", $s) : preg_replace('/\s+/u', ' ', $s);
  $s = trim($s);
  return mb_substr($s, 0, $max);
}
function int_param(string $k, int $def = 0): int { $v = $_GET[$k] ?? null; return is_string($v) && ctype_digit($v) && strlen($v) < 10 ? (int) $v : $def; }
// an id sent in a body: a whole number (or its digits), anything else is 0 (nothing has that id)
function id_of($v): int { return is_int($v) && $v > 0 ? $v : (is_string($v) && ctype_digit($v) && strlen($v) < 10 ? (int) $v : 0); }
function str_param(string $k, int $max = 100): string { $v = $_GET[$k] ?? ''; return is_string($v) ? text($v, $max) : ''; }

// ------------------------------------------------------------------ YouTube, countries ---
// a YouTube video link -> its 11-character id, or null. youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/,
// m., music. and www. alike; an id on its own too
function youtube_id($url): ?string {
  if (!is_string($url)) return null;
  $u = trim($url);
  if (preg_match('/^[A-Za-z0-9_-]{11}$/', $u)) return $u;
  if (!preg_match('~^(?:https?://)?([a-z0-9.-]+)(/[^\s]*)?$~i', $u, $m)) return null;
  $host = strtolower($m[1]); $rest = $m[2] ?? '';
  $path = parse_url('https://x' . $rest, PHP_URL_PATH) ?: '';
  $query = parse_url('https://x' . $rest, PHP_URL_QUERY) ?: '';
  $id = null;
  if ($host === 'youtu.be' || $host === 'www.youtu.be') $id = explode('/', ltrim($path, '/'))[0] ?? null;
  elseif (preg_match('/^(?:www\.|m\.|music\.)?youtube\.com$/', $host) || $host === 'youtube-nocookie.com' || $host === 'www.youtube-nocookie.com') {
    if ($path === '/watch') { parse_str($query, $qs); $id = is_string($qs['v'] ?? null) ? $qs['v'] : null; }
    elseif (preg_match('~^/(?:shorts|embed|live|v)/([^/]+)~', $path, $mm)) $id = $mm[1];
  }
  return $id !== null && preg_match('/^[A-Za-z0-9_-]{11}$/', $id) ? $id : null;
}
// a YouTube channel link (youtube.com/@handle or /channel/UC…) -> its clean address, or null
function youtube_channel($url): ?string {
  if (!is_string($url)) return null;
  if (!preg_match('~^(?:https?://)?(?:www\.|m\.)?youtube\.com/(@[A-Za-z0-9._-]{3,30}|channel/UC[A-Za-z0-9_-]{22})/?(?:[?#].*)?$~', trim($url), $m)) return null;
  return 'https://www.youtube.com/' . $m[1];
}
function country($c): ?string {
  if ($c === null || $c === '') return null;
  if (!is_string($c) || !preg_match('/^[A-Za-z]{2}$/', $c)) fail('bad_country');
  $c = strtoupper($c);
  if (!in_array($c, explode(' ', COUNTRIES), true)) fail('bad_country');
  return $c;
}

// ------------------------------------------------------------------ levels, XP, badges ---
function level_of(int $xp): array {
  $i = 0;
  foreach (LEVELS as $k => [$min]) if ($xp >= $min) $i = $k;
  $floor = LEVELS[$i][0]; $next = LEVELS[$i + 1][0] ?? null;
  return ['level' => $i + 1, 'name' => LEVELS[$i][1], 'xp' => $xp, 'floor' => $floor, 'next' => $next,
    'progress' => $next === null ? 1 : round(($xp - $floor) / ($next - $floor), 4)];
}
// XP given (or taken back): kept in hub_xp_events (the audit, the caps), added to the person's total
function award(int $uid, int $amount, string $reason, ?int $item = null, ?int $actor = null, bool $seen = false): int {
  if ($amount === 0) return 0;
  q('INSERT INTO hub_xp_events (user_id, amount, reason, item_id, actor_id, seen, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
    [$uid, $amount, $reason, $item, $actor, $seen ? 1 : 0]);
  q('UPDATE hub_users SET xp = GREATEST(0, xp + ?) WHERE id = ?', [$amount, $uid]);
  return $amount;
}
// today's XP for these reasons (UTC day): what the daily caps look at
function xp_today(int $uid, array $reasons): int {
  $in = implode(',', array_fill(0, count($reasons), '?'));
  return (int) val("SELECT COALESCE(SUM(amount), 0) FROM hub_xp_events WHERE user_id = ? AND reason IN ($in) AND created_at >= UTC_DATE()", array_merge([$uid], $reasons));
}
function count_today(int $uid, string $reason): int {
  return (int) val('SELECT COUNT(*) FROM hub_xp_events WHERE user_id = ? AND reason = ? AND amount > 0 AND created_at >= UTC_DATE()', [$uid, $reason]);
}
// an account old enough for its likes and follows to give XP (a new account made to farm gives none)
function old_enough(array $u): bool { return strtotime($u['created_at'] . ' UTC') <= time() - (int) cfg('min_account_age'); }
// the badges a person has newly earned (each once, forever); said like XP, at the next visit
function check_badges(int $uid): void {
  $have = array_column(all('SELECT badge FROM hub_badges WHERE user_id = ?', [$uid]), 'badge');
  $want = [];
  $kinds = array_column(all('SELECT DISTINCT kind FROM hub_items WHERE user_id = ?', [$uid]), 'kind');
  if (in_array('song', $kinds, true)) $want[] = 'first_song';
  if (in_array('plugin', $kinds, true)) $want[] = 'first_plugin';
  $likes = (int) val('SELECT COUNT(*) FROM hub_likes l JOIN hub_items i ON i.id = l.item_id WHERE i.user_id = ?', [$uid]);
  if ($likes >= 10) $want[] = 'likes_10';
  if ($likes >= 100) $want[] = 'likes_100';
  if ($likes >= 10 && (int) val('SELECT COUNT(DISTINCT l.country) FROM hub_likes l JOIN hub_items i ON i.id = l.item_id WHERE i.user_id = ? AND l.country IS NOT NULL', [$uid]) >= 10) $want[] = 'countries_10';
  if ((int) val('SELECT COUNT(*) FROM hub_follows WHERE followee_id = ?', [$uid]) >= 10) $want[] = 'followers_10';
  foreach (array_diff($want, $have) as $b) {
    q('INSERT IGNORE INTO hub_badges (user_id, badge, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [$uid, $b]);
    q("INSERT INTO hub_xp_events (user_id, amount, reason, seen, created_at) VALUES (?, 0, ?, 0, UTC_TIMESTAMP())", [$uid, 'badge:' . $b]);
  }
}

// ------------------------------------------------------------------ the data people publish ---
// the audio files a song or a preset plays (their ids), found anywhere in it: the files themselves are never published.
// gen-…: the sounds Kraken makes by itself (gensounds.js), the same everywhere
function audio_ids($node, array &$ids = [], int $depth = 0): array {
  if ($depth > 40) return $ids;
  if (is_object($node) || is_array($node)) {
    foreach ($node as $k => $v) {
      if (($k === 'src' || $k === 'orig') && is_string($v) && $v !== '' && strncmp($v, 'gen-', 4) !== 0 && strlen($v) < 200) $ids[$v] = true;
      elseif (is_object($v) || is_array($v)) audio_ids($v, $ids, $depth + 1);
    }
  }
  return $ids;
}
// the shape each kind must have (anything else is refused): a song or a template is a Kraken project; a preset is
// { kind, type?, name?, data }; a plugin is a LAB patch, { lab: {…} }
function check_shape(string $kind, $data): ?string {
  if (!is_object($data)) return 'bad_shape';
  if ($kind === 'song' || $kind === 'template') {
    if (!isset($data->kraken) || !is_int($data->kraken) || $data->kraken < 1 || $data->kraken > 99) return 'bad_shape';
    if (!isset($data->tracks) || !is_array($data->tracks) || count($data->tracks) > 512) return 'bad_shape';
    foreach ($data->tracks as $t) if (!is_object($t)) return 'bad_shape';
    return null;
  }
  if ($kind === 'preset') {
    if (!isset($data->kind) || !in_array($data->kind, PRESET_KINDS, true)) return 'bad_shape';
    if (!isset($data->data) || !is_object($data->data)) return 'bad_shape';
    if (isset($data->type) && (!is_string($data->type) || strlen($data->type) > 24)) return 'bad_shape';
    foreach (array_keys(get_object_vars($data)) as $k) if (!in_array($k, ['kind', 'type', 'name', 'data'], true)) return 'bad_shape';
    return null;
  }
  if ($kind === 'plugin') {
    $keys = array_keys(get_object_vars($data));
    return $keys === ['lab'] && is_object($data->lab) ? null : 'bad_shape';
  }
  return 'bad_kind';
}
// tags: up to 8 words or short phrases, letters, digits, spaces and dashes; stored as ,a,b, (an exact search)
function tags($v): array {
  $list = is_array($v) ? $v : (is_string($v) ? explode(',', $v) : []);
  $out = [];
  foreach ($list as $t) {
    if (!is_string($t)) continue;
    $t = mb_strtolower(trim(preg_replace('/[^\p{L}\p{N} &+#-]+/u', '', text($t, 40))));
    $t = mb_substr(preg_replace('/\s+/u', ' ', $t), 0, 24);
    if ($t !== '' && !in_array($t, $out, true)) $out[] = $t;
    if (count($out) >= 8) break;
  }
  return $out;
}

// ------------------------------------------------------------------ what is shown ---
function person(array $r, string $p = 'u_'): array {
  return ['id' => (int) $r[$p . 'id'], 'name' => $r[$p . 'name'], 'country' => $r[$p . 'country'], 'level' => level_of((int) $r[$p . 'xp'])];
}
const CARD_SQL = 'SELECT i.id, i.kind, i.subkind, i.title, i.genre, i.tags, i.bpm, i.youtube, i.has_audio, i.audio_count, i.likes, i.downloads,
  i.status, i.hidden_reason, i.reports, i.created_at, i.updated_at, i.user_id, u.id AS u_id, u.name AS u_name, u.country AS u_country, u.xp AS u_xp,
  (SELECT COUNT(DISTINCT l.country) FROM hub_likes l WHERE l.item_id = i.id AND l.country IS NOT NULL) AS countries';
function card(array $r, ?array $me = null): array {
  $c = [
    'id' => (int) $r['id'], 'kind' => $r['kind'], 'subkind' => $r['subkind'], 'title' => $r['title'], 'genre' => $r['genre'],
    'tags' => array_values(array_filter(explode(',', $r['tags']))), 'bpm' => $r['bpm'] === null ? null : (float) $r['bpm'],
    'youtube' => $r['youtube'], 'has_audio' => (bool) $r['has_audio'], 'audio_count' => (int) $r['audio_count'],
    'likes' => (int) $r['likes'], 'downloads' => (int) $r['downloads'], 'countries' => (int) $r['countries'],
    'created_at' => iso($r['created_at']), 'user' => person($r),
  ];
  if ($me && ((int) $r['user_id'] === (int) $me['id'] || is_admin($me))) {
    $c['status'] = $r['status']; $c['hidden_reason'] = $r['hidden_reason'];
    if (is_admin($me)) $c['reports'] = (int) $r['reports'];
  }
  return $c;
}
// the items of a list, with "liked" for the person looking
function cards(array $rows, ?array $me): array {
  $out = array_map(fn ($r) => card($r, $me), $rows);
  if ($me && $out) {
    $ids = array_column($out, 'id');
    $liked = array_flip(array_map('intval', array_column(all('SELECT item_id FROM hub_likes WHERE user_id = ? AND item_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')', array_merge([$me['id']], $ids)), 'item_id')));
    foreach ($out as &$c) $c['liked'] = isset($liked[$c['id']]);
  }
  return $out;
}
