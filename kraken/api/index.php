<?php
// SPDX-License-Identifier: GPL-3.0-only
// The Kraken hub's API: index.php?r=ROUTE, JSON in and out, on the same site as Kraken (no cookies: a signed-in page
// sends its token as "Authorization: Bearer …", so no other site can act for anyone).
//
// Reading needs no account: ping, items (the feeds), item, data (a download), user, world.
// Signing in: login (an email gets a link), exchange (the link's token -> a session), logout.
// Members: me (read, update), my_data (all the hub keeps about me), delete_me (my account and all it holds), publish,
// edit, delete, like, unlike, follow, unfollow, report.
// Moderators (config.php 'admins'): admin_reports, admin (hide, restore, delete, ban, unban).
declare(strict_types=1);
define('KRAKEN_HUB', true);
require __DIR__ . '/lib.php';
hub_errors();

$route = is_string($_GET['r'] ?? null) ? $_GET['r'] : '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') { http_response_code(204); exit; }

const GET_ROUTES = ['ping', 'items', 'item', 'data', 'user', 'me', 'my_data', 'world', 'people', 'admin_reports'];
const POST_ROUTES = ['login', 'exchange', 'login_code', 'login_wait', 'logout', 'me', 'delete_me', 'publish', 'edit', 'delete', 'like', 'unlike', 'follow', 'unfollow', 'report', 'admin'];
$routes = $method === 'POST' ? POST_ROUTES : ($method === 'GET' ? GET_ROUTES : []);
if (!in_array($route, $routes, true)) fail(in_array($route, array_merge(GET_ROUTES, POST_ROUTES), true) ? 'bad_method' : 'not_found', $routes ? 404 : 405);
if ($method === 'GET') rate('read_ip', client_ip());
$fn = 'r_' . $route . ($method === 'POST' && $route === 'me' ? '_save' : '');
$fn();

// ---------------------------------------------------------------------------------------------------- reading ---
function r_ping(): void {
  db();
  $url = fn ($k) => preg_match('~^https?://~', (string) cfg($k)) ? (string) cfg($k) : null;
  send_json(['ok' => true, 'hub' => 'kraken', 'version' => HUB_VERSION, 'limits' => ['data' => MAX_DATA, 'report_threshold' => (int) cfg('report_threshold')],
    'privacy_url' => $url('privacy_url'), 'terms_url' => $url('terms_url')]);
}

// the feeds: kind, genre, tag, country, q (search), user, following=1; sort trending | new | top; page
function r_items(): void {
  $me = current_user();
  $where = ["i.status = 'visible'", 'u.banned = 0'];
  $args = [];
  $kind = str_param('kind', 10);
  if ($kind !== '') { if (!in_array($kind, KINDS, true)) fail('bad_kind'); $where[] = 'i.kind = ?'; $args[] = $kind; }
  if (($g = str_param('genre', 40)) !== '') { $where[] = 'i.genre = ?'; $args[] = $g; }
  if (($t = tags(str_param('tag', 40))) ) { $where[] = 'i.tags LIKE ?'; $args[] = '%,' . like($t[0]) . ',%'; }
  if (($c = str_param('country', 2)) !== '') { $where[] = 'u.country = ?'; $args[] = country($c); }
  if (($uid = int_param('user')) > 0) { $where[] = 'i.user_id = ?'; $args[] = $uid; }
  if (($s = str_param('q', 80)) !== '') {
    $like = '%' . like($s) . '%';
    $where[] = '(i.title LIKE ? OR i.description LIKE ? OR i.tags LIKE ? OR i.genre LIKE ? OR u.name LIKE ?)';
    array_push($args, $like, $like, $like, $like, $like);
  }
  if (int_param('following') === 1) {
    $me = need_user();
    $where[] = 'i.user_id IN (SELECT followee_id FROM hub_follows WHERE follower_id = ?)';
    $args[] = $me['id'];
  }
  $sort = str_param('sort', 10) ?: 'trending';
  $limit = max(1, min(48, int_param('limit', 24)));
  $offset = max(0, min(10000, int_param('page', 0) * $limit));
  $join = '';
  // trending: each like counts less as it gets older (half a weight after about two days), and a new item gets a
  // little light of its own for its first days
  if ($sort === 'trending') {
    $join = 'LEFT JOIN (SELECT item_id, SUM(EXP(-TIMESTAMPDIFF(MINUTE, created_at, UTC_TIMESTAMP()) / 4320)) AS s FROM hub_likes
      WHERE created_at > UTC_TIMESTAMP() - INTERVAL 30 DAY GROUP BY item_id) tr ON tr.item_id = i.id';
    $order = 'COALESCE(tr.s, 0) + 0.02 * LEAST(i.downloads, 100) * EXP(-TIMESTAMPDIFF(MINUTE, i.created_at, UTC_TIMESTAMP()) / 10080)
      + EXP(-TIMESTAMPDIFF(MINUTE, i.created_at, UTC_TIMESTAMP()) / 2880) DESC, i.id DESC';
  } elseif ($sort === 'new') $order = 'i.created_at DESC, i.id DESC';
  elseif ($sort === 'top') $order = 'i.likes DESC, i.downloads DESC, i.id DESC';
  else fail('bad_sort');
  $rows = all(CARD_SQL . " FROM hub_items i JOIN hub_users u ON u.id = i.user_id $join WHERE " . implode(' AND ', $where)
    . " ORDER BY $order LIMIT " . ($limit + 1) . " OFFSET $offset", $args);
  $more = count($rows) > $limit;
  send_json(['items' => cards(array_slice($rows, 0, $limit), $me), 'more' => $more]);
}
function like(string $s): string { return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s); }

// an item shown to this visitor: visible, or theirs, or any for a moderator, except a private one: only its creator
// ever sees that (a backup, an idea kept to oneself: not even the moderators)
function item_row(int $id, ?array $me): array {
  $r = one(CARD_SQL . ', i.description, i.yt_xp, u.banned AS u_banned FROM hub_items i JOIN hub_users u ON u.id = i.user_id WHERE i.id = ?', [$id]);
  if (!$r) fail('not_found', 404);
  $mine = $me && (int) $r['user_id'] === (int) $me['id'];
  if ($r['status'] === 'private' && !$mine) fail('not_found', 404);
  $visible = $r['status'] === 'visible' && !$r['u_banned'];
  if (!$visible && !($mine || is_admin($me))) fail('not_found', 404);
  return $r;
}
function r_item(): void {
  $me = current_user();
  $r = item_row(int_param('id'), $me);
  $c = cards([$r], $me)[0];
  $c['description'] = $r['description'];
  $c['mine'] = $me && (int) $r['user_id'] === (int) $me['id'];
  $c['updated_at'] = iso($r['updated_at']);
  $c['liked_in'] = array_column(all('SELECT country, COUNT(*) AS n FROM hub_likes WHERE item_id = ? AND country IS NOT NULL GROUP BY country ORDER BY n DESC, country LIMIT 100', [$r['id']]), 'country');
  $c['user']['followers'] = (int) val('SELECT COUNT(*) FROM hub_follows WHERE followee_id = ?', [$r['user_id']]);
  $c['user']['followed'] = $me ? (bool) val('SELECT 1 FROM hub_follows WHERE follower_id = ? AND followee_id = ?', [$me['id'], $r['user_id']]) : false;
  $c['more'] = cards(all(CARD_SQL . " FROM hub_items i JOIN hub_users u ON u.id = i.user_id WHERE i.user_id = ? AND i.id <> ? AND i.status = 'visible'
    ORDER BY i.likes DESC, i.created_at DESC LIMIT 6", [$r['user_id'], $r['id']]), $me);
  if ($me && is_admin($me)) $c['report_list'] = all('SELECT r.reason, r.note, r.resolved, r.created_at, u.name FROM hub_reports r JOIN hub_users u ON u.id = r.user_id WHERE r.item_id = ? ORDER BY r.id DESC LIMIT 50', [$r['id']]);
  send_json(['item' => $c]);
}

// the data itself (dl=1: a download, counted once a day per person or address, and worth XP to its creator)
function r_data(): void {
  $me = current_user();
  $r = item_row(int_param('id'), $me);
  $id = (int) $r['id'];
  if (int_param('dl') === 1) {
    rate('download_ip', client_ip());
    $who = blur($me ? 'u:' . $me['id'] : 'ip:' . client_ip());
    $st = q('INSERT IGNORE INTO hub_downloads (item_id, who, day, user_id) VALUES (?, ?, UTC_DATE(), ?)', [$id, $who, $me['id'] ?? null]);
    if ($st->rowCount() === 1) {
      q('UPDATE hub_items SET downloads = downloads + 1 WHERE id = ?', [$id]);
      $owner = (int) $r['user_id'];
      if (!$me || (int) $me['id'] !== $owner) {                     // (your own downloads earn nothing)
        $left = XP_DOWNLOAD_CAP - xp_today($owner, ['download']);
        if ($left > 0) award($owner, min(XP_DOWNLOAD, $left), 'download', $id, $me['id'] ?? null);
      }
    }
  }
  $data = val('SELECT data FROM hub_item_data WHERE item_id = ?', [$id]);
  if ($data === null) fail('not_found', 404);
  send_json('{"id":' . $id . ',"kind":' . json_encode($r['kind']) . ',"title":' . json_encode($r['title'], JSON_UNESCAPED_UNICODE) . ',"data":' . $data . '}');
}

function profile(array $u, ?array $me): array {
  $p = ['id' => (int) $u['id'], 'name' => shown_name($u['name'], (int) $u['named'], (int) $u['id'], $me), 'country' => $u['country'], 'bio' => $u['bio'], 'youtube' => $u['youtube'],
    'level' => level_of((int) $u['xp']), 'created_at' => iso($u['created_at']),
    'badges' => array_column(all('SELECT badge FROM hub_badges WHERE user_id = ? ORDER BY created_at', [$u['id']]), 'badge'),
    'followers' => (int) val('SELECT COUNT(*) FROM hub_follows WHERE followee_id = ?', [$u['id']]),
    'following' => (int) val('SELECT COUNT(*) FROM hub_follows WHERE follower_id = ?', [$u['id']]),
    'likes' => (int) val('SELECT COALESCE(SUM(likes), 0) FROM hub_items WHERE user_id = ?', [$u['id']]),
    'countries' => (int) val('SELECT COUNT(DISTINCT l.country) FROM hub_likes l JOIN hub_items i ON i.id = l.item_id WHERE i.user_id = ? AND l.country IS NOT NULL', [$u['id']]),
  ];
  if ($me) $p['followed'] = (bool) val('SELECT 1 FROM hub_follows WHERE follower_id = ? AND followee_id = ?', [$me['id'], $u['id']]);
  if (is_admin($me)) $p['banned'] = (bool) $u['banned'];
  return $p;
}
function r_user(): void {
  $me = current_user();
  $u = one('SELECT * FROM hub_users WHERE id = ?', [int_param('id')]);
  $self = $u && $me && (int) $u['id'] === (int) $me['id'];
  if (!$u || ($u['banned'] && !$self && !is_admin($me))) fail('not_found', 404);
  $only = $self ? '' : (is_admin($me) ? " AND i.status <> 'private'" : " AND i.status = 'visible'");
  $items = all(CARD_SQL . ' FROM hub_items i JOIN hub_users u ON u.id = i.user_id WHERE i.user_id = ?' . $only
    . ' ORDER BY i.created_at DESC LIMIT 100', [$u['id']]);
  send_json(['user' => profile($u, $me), 'items' => cards($items, $me)]);
}

// the world: every member by country (published or not), and per country its creators, songs, items and likes
function r_world(): void {
  $rows = all("SELECT u.country, COUNT(*) AS members, SUM(s.n > 0) AS creators, COALESCE(SUM(s.n), 0) AS items, COALESCE(SUM(s.songs), 0) AS songs, COALESCE(SUM(s.likes), 0) AS likes
    FROM hub_users u LEFT JOIN (SELECT user_id, COUNT(*) AS n, SUM(kind = 'song') AS songs, SUM(likes) AS likes FROM hub_items WHERE status = 'visible' GROUP BY user_id) s ON s.user_id = u.id
    WHERE u.banned = 0 AND u.country IS NOT NULL GROUP BY u.country ORDER BY songs DESC, items DESC, members DESC, likes DESC, u.country LIMIT 300");
  $tot = one("SELECT COUNT(*) AS members, COUNT(DISTINCT u.country) AS countries,
    (SELECT COUNT(DISTINCT i.user_id) FROM hub_items i JOIN hub_users c ON c.id = i.user_id WHERE i.status = 'visible' AND c.banned = 0) AS creators,
    (SELECT COUNT(*) FROM hub_items i JOIN hub_users c ON c.id = i.user_id WHERE i.status = 'visible' AND c.banned = 0) AS items
    FROM hub_users u WHERE u.banned = 0");
  send_json(['countries' => array_map(fn ($r) => ['country' => $r['country'], 'members' => (int) $r['members'], 'creators' => (int) $r['creators'], 'items' => (int) $r['items'],
    'songs' => (int) $r['songs'], 'likes' => (int) $r['likes']], $rows),
    'total' => ['members' => (int) $tot['members'], 'creators' => (int) $tot['creators'], 'items' => (int) $tot['items'], 'countries' => (int) $tot['countries']]]);
}
// the people of the hub: how many, how many new, the newest members (published or not) and the most XP
function r_people(): void {
  $me = current_user();
  $tot = one("SELECT COUNT(*) AS members, SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY) AS week, SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS today,
    COUNT(DISTINCT country) AS countries, SUM(last_seen >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS active FROM hub_users WHERE banned = 0");
  $creators = (int) val("SELECT COUNT(DISTINCT i.user_id) FROM hub_items i JOIN hub_users u ON u.id = i.user_id WHERE i.status = 'visible' AND u.banned = 0");
  $row = fn ($u) => person($u, '', $me) + ['joined' => iso($u['created_at']), 'items' => (int) $u['items'], 'followers' => (int) $u['followers']];
  $sel = "SELECT u.id, u.name, u.named, u.country, u.xp, u.created_at,
    (SELECT COUNT(*) FROM hub_items i WHERE i.user_id = u.id AND i.status = 'visible') AS items,
    (SELECT COUNT(*) FROM hub_follows f WHERE f.followee_id = u.id) AS followers FROM hub_users u WHERE u.banned = 0";
  send_json([
    'total' => ['members' => (int) $tot['members'], 'week' => (int) $tot['week'], 'today' => (int) $tot['today'], 'countries' => (int) $tot['countries'],
      'active' => (int) $tot['active'], 'creators' => $creators],
    'newest' => array_map($row, all("$sel ORDER BY u.created_at DESC, u.id DESC LIMIT 36")),
    'top' => array_map($row, all("$sel AND u.xp > 0 ORDER BY u.xp DESC, u.id LIMIT 12")),
  ]);
}

// ---------------------------------------------------------------------------------------------------- signing in ---
// an email gets a link (valid 15 minutes, once); the answer is the same whether the address is known or not
function r_login(): void {
  $b = body();
  $email = strtolower(text($b->email ?? '', 190));
  if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190) fail('bad_email');
  rate('login_ip', client_ip());
  rate('login_email', $email);
  $token = bin2hex(random_bytes(32));
  // the browser that asked keeps a secret (wait): it is signed in as soon as the link is opened anywhere (the phone's
  // mail app, another browser), or when the 6-digit code of the email is typed into it
  $wait = bin2hex(random_bytes(32));
  $code = sprintf('%06d', random_int(0, 999999));
  q('INSERT INTO hub_login_tokens (email, token_hash, created_at, expires_at) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 15 MINUTE)', [$email, hash('sha256', $token)]);
  login_waits();
  q('INSERT INTO hub_login_waits (token_hash, wait_hash, code_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 15 MINUTE)',
    [hash('sha256', $token), hash('sha256', $wait), hash('sha256', $email . '|' . $code), $email]);
  if (mt_rand(1, 50) === 1) {
    q('DELETE FROM hub_login_tokens WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
    q('DELETE FROM hub_login_waits WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
  }
  // the hub's own page: light, no audio to start, it signs in at once (Kraken itself shares the session)
  $link = rtrim((string) cfg('site_url'), '/') . '/hub.html?hub_login=' . $token;
  $fr = ($b->lang ?? '') === 'fr';
  $spaced = substr($code, 0, 3) . ' ' . substr($code, 3);
  $subject = $fr ? "Connexion au hub Kraken : $spaced" : "Kraken hub sign-in: $spaced";
  $text = $fr
    ? "Bonjour,\n\nPour vous connecter au hub Kraken, ouvrez ce lien :\n\n$link\n\nOu tapez ce code dans la fenêtre où vous l'avez demandé :\n\n    $spaced\n\nLe lien et le code sont valables 15 minutes, une seule fois. La fenêtre où vous avez demandé la connexion se connecte aussi toute seule dès que le lien est ouvert, même sur un autre appareil.\n\nSi vous n'avez rien demandé, ignorez ce message : personne ne peut se connecter sans ce lien ou ce code.\n\nKraken, le DAW gratuit de Sodwave"
    : "Hello,\n\nTo sign in to the Kraken hub, open this link:\n\n$link\n\nOr type this code in the window where you asked for it:\n\n    $spaced\n\nThe link and the code work for 15 minutes, once. The window where you asked also signs in by itself as soon as the link is opened, even on another device.\n\nIf you did not ask for it, ignore this message: nobody can sign in without this link or this code.\n\nKraken, the free DAW by Sodwave";
  $sent = cfg('dev_return_link') ? true : send_mail($email, $subject, $text);
  if (!$sent) fail('mail_failed', 502);
  $out = ['ok' => true, 'wait' => $wait];
  if (cfg('dev_return_link')) { $out['dev_link'] = $link; $out['dev_code'] = $code; }
  send_json($out);
}
// (made on first use: a hub installed before it has no such table, and the site's database needs no new step)
function login_waits(): void {
  static $done = false;
  if ($done) return;
  $done = true;
  q('CREATE TABLE IF NOT EXISTS hub_login_waits (
    token_hash CHAR(64) NOT NULL, wait_hash CHAR(64) NOT NULL, code_hash CHAR(64) NOT NULL, email VARCHAR(190) NOT NULL,
    tries TINYINT UNSIGNED NOT NULL DEFAULT 0, approved TINYINT(1) NOT NULL DEFAULT 0, claimed TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL, expires_at DATETIME NOT NULL,
    PRIMARY KEY (token_hash), UNIQUE KEY uq_wait (wait_hash), KEY k_email (email), KEY k_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
}
// the account of an email (made at its first sign-in), and a new session for it: the answer of every way in
function sign_in(string $email): void {
  $u = one('SELECT * FROM hub_users WHERE email = ?', [$email]);
  $created = false;
  if (!$u) {
    q('INSERT INTO hub_users (email, name, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [$email, auto_name($email)]);
    $u = one('SELECT * FROM hub_users WHERE email = ?', [$email]);
    $created = true;
  }
  $session = bin2hex(random_bytes(32));
  q('INSERT INTO hub_sessions (user_id, token_hash, created_at, last_used, expires_at) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 180 DAY)',
    [$u['id'], hash('sha256', $session)]);
  session_cookie($session);
  send_json(['token' => $session, 'created' => $created, 'me' => me_of($u, false)]);
}
function send_mail(string $to, string $subject, string $text): bool {
  $from = (string) cfg('mail_from');
  if (!filter_var($from, FILTER_VALIDATE_EMAIL)) { error_log('kraken hub: mail_from is not set in config.php'); return false; }
  $name = preg_replace('/[^\w .-]/u', '', (string) cfg('mail_from_name')) ?: 'Kraken hub';
  $subject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
  // SMTP with the real mailbox when config.php has it (signed by the mail server: Gmail and co. take it); else PHP mail()
  if ((string) cfg('smtp_host') !== '' && (string) cfg('smtp_pass') !== '') return smtp_send($from, $name, $to, $subject, $text);
  $headers = ['From' => "$name <$from>", 'Reply-To' => $from, 'MIME-Version' => '1.0', 'Content-Type' => 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding' => '8bit', 'X-Mailer' => 'Kraken hub'];
  try { return mail($to, $subject, $text, $headers, '-f' . $from); }
  catch (Throwable $e) { error_log('kraken hub: mail: ' . $e->getMessage()); return false; }
}

// one message through the mailbox's SMTP server: port 465 TLS from the start, 587 STARTTLS; AUTH LOGIN.
// The log never gets the password (each step is logged by its name only).
function smtp_send(string $from, string $name, string $to, string $subject, string $text): bool {
  $host = (string) cfg('smtp_host');
  $port = (int) (cfg('smtp_port') ?: 465);
  $user = (string) (cfg('smtp_user') ?: $from);
  $tls_now = $port === 465;
  $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host]]);
  $s = @stream_socket_client(($tls_now ? 'ssl://' : 'tcp://') . $host . ':' . $port, $errno, $err, 15, STREAM_CLIENT_CONNECT, $ctx);
  if (!$s) { error_log("kraken hub: smtp: no connection to $host:$port ($err)"); return false; }
  stream_set_timeout($s, 20);
  $step = function (?string $line, array $want, string $what) use ($s): bool {
    if ($line !== null && fwrite($s, $line . "\r\n") === false) { error_log("kraken hub: smtp: $what: write failed"); return false; }
    $code = 0; $msg = '';
    while (($l = fgets($s, 2048)) !== false) {
      $msg .= $l; $code = (int) substr($l, 0, 3);
      if (strlen($l) < 4 || $l[3] !== '-') break;
    }
    if (!in_array($code, $want, true)) { error_log("kraken hub: smtp: $what: " . trim($msg ?: 'no answer')); return false; }
    return true;
  };
  $me = parse_url((string) cfg('site_url'), PHP_URL_HOST) ?: 'localhost';
  $ok = $step(null, [220], 'greeting') && $step("EHLO $me", [250], 'EHLO');
  if ($ok && !$tls_now) {
    $ok = $step('STARTTLS', [220], 'STARTTLS');
    if ($ok && !stream_socket_enable_crypto($s, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) { error_log('kraken hub: smtp: STARTTLS failed'); $ok = false; }
    $ok = $ok && $step("EHLO $me", [250], 'EHLO');
  }
  $ok = $ok && $step('AUTH LOGIN', [334], 'AUTH') && $step(base64_encode($user), [334], 'AUTH user')
    && $step(base64_encode((string) cfg('smtp_pass')), [235], 'AUTH password (smtp_user / smtp_pass in config.php)')
    && $step("MAIL FROM:<$from>", [250], 'MAIL FROM') && $step("RCPT TO:<$to>", [250, 251], 'RCPT TO') && $step('DATA', [354], 'DATA');
  if ($ok) {
    $domain = substr((string) strrchr($from, '@'), 1);
    $head = 'Date: ' . date(DATE_RFC2822) . "\r\n" . "From: $name <$from>\r\n" . "To: <$to>\r\n" . "Reply-To: $from\r\n"
      . "Subject: $subject\r\n" . 'Message-ID: <' . bin2hex(random_bytes(12)) . "@$domain>\r\n"
      . "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\nX-Mailer: Kraken hub\r\n";
    $ok = $step($head . "\r\n" . chunk_split(base64_encode($text), 76, "\r\n") . '.', [250], 'message');
  }
  @fwrite($s, "QUIT\r\n");
  fclose($s);
  return $ok;
}

// the link's token -> a session (an account is made at the first sign-in)
function r_exchange(): void {
  rate('exchange_ip', client_ip());
  $t = body()->token ?? '';
  if (!is_string($t) || !preg_match('/^[a-f0-9]{64}$/', $t)) fail('bad_token');
  $row = one('SELECT * FROM hub_login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [hash('sha256', $t)]);
  if (!$row) fail('bad_token', 400);
  if (q('UPDATE hub_login_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [$row['id']])->rowCount() !== 1) fail('bad_token');
  login_waits();
  q('UPDATE hub_login_waits SET approved = 1 WHERE token_hash = ? AND claimed = 0', [hash('sha256', $t)]);   // (the asking window: in too)
  sign_in($row['email']);
}
// the 6-digit code of the email, typed into the window that asked (5 tries, then a new email)
function r_login_code(): void {
  rate('exchange_ip', client_ip());
  $b = body();
  $wait = $b->wait ?? '';
  $code = preg_replace('/\D+/', '', (string) ($b->code ?? ''));
  if (!is_string($wait) || !preg_match('/^[a-f0-9]{64}$/', $wait) || strlen($code) !== 6) fail('bad_code');
  login_waits();
  $w = one('SELECT * FROM hub_login_waits WHERE wait_hash = ? AND claimed = 0 AND expires_at > UTC_TIMESTAMP()', [hash('sha256', $wait)]);
  if (!$w) fail('bad_token');
  if ((int) $w['tries'] >= 5) fail('code_tries', 429);
  if (!hash_equals($w['code_hash'], hash('sha256', $w['email'] . '|' . $code))) {
    q('UPDATE hub_login_waits SET tries = tries + 1 WHERE token_hash = ?', [$w['token_hash']]);
    fail('bad_code');
  }
  if (q('UPDATE hub_login_waits SET claimed = 1 WHERE token_hash = ? AND claimed = 0', [$w['token_hash']])->rowCount() !== 1) fail('bad_token');
  q('UPDATE hub_login_tokens SET used_at = COALESCE(used_at, UTC_TIMESTAMP()) WHERE token_hash = ?', [$w['token_hash']]);   // (the link: no longer needed)
  sign_in($w['email']);
}
// the window that asked, every few seconds: still waiting, or the link was opened (anywhere): signed in here too
function r_login_wait(): void {
  rate('wait_ip', client_ip());
  $wait = body()->wait ?? '';
  if (!is_string($wait) || !preg_match('/^[a-f0-9]{64}$/', $wait)) fail('bad_token');
  login_waits();
  $w = one('SELECT * FROM hub_login_waits WHERE wait_hash = ? AND claimed = 0 AND expires_at > UTC_TIMESTAMP() - INTERVAL 5 MINUTE', [hash('sha256', $wait)]);
  if (!$w) fail('bad_token');
  if (!$w['approved']) send_json(['waiting' => true]);
  if (q('UPDATE hub_login_waits SET claimed = 1 WHERE token_hash = ? AND claimed = 0', [$w['token_hash']])->rowCount() !== 1) fail('bad_token');
  sign_in($w['email']);
}
function r_logout(): void {
  $t = bearer();
  if ($t) q('DELETE FROM hub_sessions WHERE token_hash = ?', [hash('sha256', $t)]);
  session_cookie(null);
  send_json(['ok' => true]);
}

// ---------------------------------------------------------------------------------------------------- me ---
// my profile, what I can still earn today, and what happened since my last visit (said once: then marked seen)
function me_of(array $u, bool $news = true): array {
  $me = array_diff_key(profile($u, $u), ['followed' => 1]) + ['email' => $u['email'], 'admin' => is_admin($u), 'banned' => (bool) $u['banned'],
    'today' => ['publishes' => count_today((int) $u['id'], 'publish'), 'publish_max' => XP_PUBLISH_PER_DAY,
      'youtube' => count_today((int) $u['id'], 'youtube'), 'youtube_max' => XP_YOUTUBE_PER_DAY]];
  if ($news) {
    $ev = all('SELECT reason, COUNT(*) AS n, SUM(amount) AS xp FROM hub_xp_events WHERE user_id = ? AND seen = 0 GROUP BY reason', [$u['id']]);
    $me['news'] = array_map(fn ($e) => ['reason' => $e['reason'], 'n' => (int) $e['n'], 'xp' => (int) $e['xp']], $ev);
    if ($ev) q('UPDATE hub_xp_events SET seen = 1 WHERE user_id = ? AND seen = 0', [$u['id']]);
  }
  return $me;
}
function r_me(): void {
  $u = need_user();
  $out = ['me' => me_of($u)];
  if (via_cookie()) { $out['token'] = bearer(); session_cookie($out['token']); }   // (the page's lost copy, and 180 more days)
  send_json($out);
}
function r_me_save(): void {
  $u = need_user();
  rate('profile_user', (string) $u['id']);
  $b = body();
  $name = text($b->name ?? $u['name'], 32);
  if (mb_strlen($name) < 2) fail('bad_name');
  $yt = text($b->youtube ?? '', 200);
  $channel = $yt === '' ? null : youtube_channel($yt);
  if ($yt !== '' && !$channel) fail('bad_channel');
  q('UPDATE hub_users SET name = ?, named = GREATEST(named, ?), bio = ?, country = ?, youtube = ? WHERE id = ?',
    [$name, isset($b->name) ? 1 : 0, text($b->bio ?? '', 280, true), country($b->country ?? null), $channel, $u['id']]);
  send_json(['me' => me_of(one('SELECT * FROM hub_users WHERE id = ?', [$u['id']]), false)]);
}

// everything the hub keeps about me (the right of access: Québec's Law 25, the GDPR), as one JSON file
function r_my_data(): void {
  $u = need_user();
  $id = (int) $u['id'];
  $items = all('SELECT i.id, i.kind, i.subkind, i.title, i.description, i.genre, i.tags, i.bpm, i.youtube, i.likes, i.downloads, i.status, i.created_at, i.updated_at, d.data
    FROM hub_items i JOIN hub_item_data d ON d.item_id = i.id WHERE i.user_id = ? ORDER BY i.id', [$id]);
  foreach ($items as &$it) $it['data'] = json_decode($it['data']);
  send_json(['exported_at' => iso(now()), 'account' => ['email' => $u['email'], 'name' => $u['name'], 'bio' => $u['bio'], 'country' => $u['country'], 'youtube' => $u['youtube'],
    'xp' => (int) $u['xp'], 'banned' => (bool) $u['banned'], 'created_at' => iso($u['created_at']), 'last_seen' => iso($u['last_seen'])],
    'badges' => all('SELECT badge, created_at FROM hub_badges WHERE user_id = ?', [$id]),
    'items' => $items,
    'likes_given' => all('SELECT item_id, country, created_at FROM hub_likes WHERE user_id = ?', [$id]),
    'following' => all('SELECT followee_id, created_at FROM hub_follows WHERE follower_id = ?', [$id]),
    'followers' => (int) val('SELECT COUNT(*) FROM hub_follows WHERE followee_id = ?', [$id]),
    'reports_made' => all('SELECT item_id, reason, note, created_at FROM hub_reports WHERE user_id = ?', [$id]),
    'xp_events' => all('SELECT amount, reason, item_id, created_at FROM hub_xp_events WHERE user_id = ? ORDER BY id', [$id]),
    'sessions' => all('SELECT created_at, last_used, expires_at FROM hub_sessions WHERE user_id = ?', [$id])]);
}
// my account and everything it holds, for good: what I published, my likes, follows, reports and sessions (the
// counts on other people's items follow)
function r_delete_me(): void {
  $u = need_user();
  if ((body()->confirm ?? '') !== 'DELETE') fail('bad_request');
  $id = (int) $u['id'];
  $pdo = db();
  $pdo->beginTransaction();
  q('UPDATE hub_items i JOIN hub_likes l ON l.item_id = i.id SET i.likes = GREATEST(0, i.likes - 1) WHERE l.user_id = ?', [$id]);
  q('UPDATE hub_items i JOIN hub_reports r ON r.item_id = i.id SET i.reports = GREATEST(0, i.reports - 1) WHERE r.user_id = ? AND r.resolved = 0', [$id]);
  q('DELETE FROM hub_users WHERE id = ?', [$id]);
  $pdo->commit();
  send_json(['ok' => true]);
}

// ---------------------------------------------------------------------------------------------------- publishing ---
function r_publish(): void {
  $u = need_member();
  rate('publish_user', (string) $u['id']);
  $b = body();
  $kind = is_string($b->kind ?? null) ? $b->kind : '';
  if (!in_array($kind, KINDS, true)) fail('bad_kind');
  $data = $b->data ?? null;
  if (($err = check_shape($kind, $data))) fail($err);
  $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
  if ($json === false) fail('bad_json');
  if (strlen($json) > MAX_DATA) fail('too_large', 413, ['max' => MAX_DATA]);
  $title = text($b->title ?? '', 80);
  if (mb_strlen($title) < 1) fail('bad_title');
  $hash = hash('sha256', $kind . '|' . $json);
  if (val('SELECT id FROM hub_items WHERE user_id = ? AND data_hash = ?', [$u['id'], $hash])) fail('duplicate', 409);
  $yt = null;
  if (isset($b->youtube) && text($b->youtube, 300) !== '') { $yt = youtube_id(text($b->youtube, 300)); if (!$yt) fail('bad_youtube'); }
  $bpm = ($kind === 'song' || $kind === 'template') && isset($data->bpm) && (is_int($data->bpm) || is_float($data->bpm)) ? max(20, min(300, round((float) $data->bpm, 2))) : null;
  $audio = count(audio_ids($kind === 'preset' ? $data->data : $data));
  $subkind = $kind === 'preset' ? $data->kind : null;
  $private = ($b->private ?? false) === true;                       // only its creator sees it: a backup on the hub
  $pdo = db();
  $pdo->beginTransaction();
  q('INSERT INTO hub_items (user_id, kind, subkind, title, description, genre, tags, bpm, youtube, has_audio, audio_count, size, data_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
    [$u['id'], $kind, $subkind, $title, text($b->description ?? '', 2000, true), text($b->genre ?? '', 40), tag_field(tags($b->tags ?? [])), $bpm, $yt,
      $audio ? 1 : 0, min($audio, 9999), strlen($json), $hash, $private ? 'private' : 'visible']);
  $id = (int) $pdo->lastInsertId();
  q('INSERT INTO hub_item_data (item_id, data) VALUES (?, ?)', [$id, $json]);
  $gained = $private ? [] : public_xp($u, $id, $kind, (bool) $yt);  // (XP is for what is shared: a private item earns it once made public)
  check_badges((int) $u['id']);
  $pdo->commit();
  respond_item($id, $u, $gained);
}
// the XP for sharing an item with everyone: publishing (once per item, a few a day) and its YouTube link
function public_xp(array $u, int $id, string $kind, bool $yt): array {
  $gained = [];
  if (!val("SELECT 1 FROM hub_xp_events WHERE user_id = ? AND reason = 'publish' AND item_id = ? LIMIT 1", [$u['id'], $id])
    && count_today((int) $u['id'], 'publish') < XP_PUBLISH_PER_DAY) $gained[] = ['publish', award((int) $u['id'], XP_PUBLISH, 'publish', $id, null, true)];
  if ($yt) $gained = array_merge($gained, youtube_xp($u, $id, $kind));
  return $gained;
}
function tag_field(array $tags): string { return $tags ? ',' . implode(',', $tags) . ',' : ''; }
// +20 for a YouTube link on a song: once per song, for three songs a day
function youtube_xp(array $u, int $id, string $kind): array {
  if ($kind !== 'song' || count_today((int) $u['id'], 'youtube') >= XP_YOUTUBE_PER_DAY) return [];
  if (q('UPDATE hub_items SET yt_xp = 1 WHERE id = ? AND yt_xp = 0', [$id])->rowCount() !== 1) return [];
  return [['youtube', award((int) $u['id'], XP_YOUTUBE, 'youtube', $id, null, true)]];
}
function respond_item(int $id, array $u, array $gained): void {
  $me = one('SELECT * FROM hub_users WHERE id = ?', [$u['id']]);
  $r = one(CARD_SQL . ' FROM hub_items i JOIN hub_users u ON u.id = i.user_id WHERE i.id = ?', [$id]);
  send_json(['item' => card($r, $me), 'xp' => ['gained' => array_map(fn ($g) => ['reason' => $g[0], 'xp' => $g[1]], $gained),
    'total' => array_sum(array_column($gained, 1)), 'level' => level_of((int) $me['xp'])]]);
}

// change what is said about an item (its data stays as published)
function r_edit(): void {
  $u = need_member();
  rate('edit_user', (string) $u['id']);
  $b = body();
  $r = one('SELECT * FROM hub_items WHERE id = ?', [id_of($b->id ?? 0)]);
  $mine = $r && (int) $r['user_id'] === (int) $u['id'];
  if (!$r || (!$mine && (!is_admin($u) || $r['status'] === 'private'))) fail('not_found', 404);
  $set = []; $args = [];
  // private or shared with everyone: its creator's choice, any time (an item a moderator hid stays hidden)
  $going = null;
  if (isset($b->private) && is_bool($b->private) && $mine) {
    if ($r['status'] === 'hidden') fail('hidden', 403);
    $going = $b->private ? 'private' : 'visible';
    if ($going !== $r['status']) { $set[] = 'status = ?'; $args[] = $going; } else $going = null;
  }
  if (isset($b->title)) { $t = text($b->title, 80); if ($t === '') fail('bad_title'); $set[] = 'title = ?'; $args[] = $t; }
  if (isset($b->description)) { $set[] = 'description = ?'; $args[] = text($b->description, 2000, true); }
  if (isset($b->genre)) { $set[] = 'genre = ?'; $args[] = text($b->genre, 40); }
  if (isset($b->tags)) { $set[] = 'tags = ?'; $args[] = tag_field(tags($b->tags)); }
  $yt = null;
  if (property_exists($b, 'youtube')) {
    $raw = text($b->youtube ?? '', 300);
    $yt = $raw === '' ? null : youtube_id($raw);
    if ($raw !== '' && !$yt) fail('bad_youtube');
    $set[] = 'youtube = ?'; $args[] = $yt;
  }
  $gained = [];
  if ($set) {
    q('UPDATE hub_items SET ' . implode(', ', $set) . ', updated_at = UTC_TIMESTAMP() WHERE id = ?', array_merge($args, [$r['id']]));
    $status = $going ?? $r['status'];
    if ($mine && $going === 'visible') $gained = public_xp($u, (int) $r['id'], $r['kind'], (bool) ($yt ?? (property_exists($b, 'youtube') ? null : $r['youtube'])));
    elseif ($yt && $mine && $status !== 'private') $gained = youtube_xp($u, (int) $r['id'], $r['kind']);
    if ($going) check_badges((int) $u['id']);
  }
  respond_item((int) $r['id'], $u, $gained);
}
function r_delete(): void {
  $u = need_user();
  $r = one('SELECT * FROM hub_items WHERE id = ?', [id_of(body()->id ?? 0)]);
  if (!$r || ((int) $r['user_id'] !== (int) $u['id'] && (!is_admin($u) || $r['status'] === 'private'))) fail('not_found', 404);
  q('DELETE FROM hub_items WHERE id = ?', [$r['id']]);
  send_json(['ok' => true]);
}

// ---------------------------------------------------------------------------------------------------- likes, follows ---
// one like per person per item, never your own. The creator gets +10 (from an account at least an hour old), the
// liker +1 (20 a day at most); unliking takes back what the like gave
function r_like(): void {
  $u = need_member();
  rate('like_user', (string) $u['id']);
  $r = one("SELECT i.* FROM hub_items i JOIN hub_users o ON o.id = i.user_id WHERE i.id = ? AND i.status = 'visible' AND o.banned = 0", [id_of(body()->id ?? 0)]);
  if (!$r) fail('not_found', 404);
  $owner = (int) $r['user_id'];
  if ($owner === (int) $u['id']) fail('self_like');
  $pdo = db();
  $pdo->beginTransaction();
  $gained = [];
  if (q('INSERT IGNORE INTO hub_likes (user_id, item_id, country, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())', [$u['id'], $r['id'], $u['country']])->rowCount() === 1) {
    q('UPDATE hub_items SET likes = likes + 1 WHERE id = ?', [$r['id']]);
    $xo = old_enough($u) ? award($owner, XP_LIKE, 'like', (int) $r['id'], (int) $u['id']) : 0;
    $xl = xp_today((int) $u['id'], ['like_given', 'like_given_back']) < XP_LIKE_GIVEN_CAP ? award((int) $u['id'], XP_LIKE_GIVEN, 'like_given', (int) $r['id'], null, true) : 0;
    q('UPDATE hub_likes SET xp_owner = ?, xp_liker = ? WHERE user_id = ? AND item_id = ?', [$xo ? 1 : 0, $xl ? 1 : 0, $u['id'], $r['id']]);
    if ($xl) $gained[] = ['like_given', $xl];
    check_badges($owner);
  }
  $pdo->commit();
  like_answer((int) $r['id'], $u, true, $gained);
}
function r_unlike(): void {
  $u = need_member();
  rate('like_user', (string) $u['id']);
  $id = id_of(body()->id ?? 0);
  $pdo = db();
  $pdo->beginTransaction();
  $l = one('SELECT l.*, i.user_id AS owner FROM hub_likes l JOIN hub_items i ON i.id = l.item_id WHERE l.user_id = ? AND l.item_id = ? FOR UPDATE', [$u['id'], $id]);
  $gained = [];
  if ($l) {
    q('DELETE FROM hub_likes WHERE user_id = ? AND item_id = ?', [$u['id'], $id]);
    q('UPDATE hub_items SET likes = GREATEST(0, likes - 1) WHERE id = ?', [$id]);
    if ($l['xp_owner']) award((int) $l['owner'], -XP_LIKE, 'like_back', $id, (int) $u['id']);
    if ($l['xp_liker']) $gained[] = ['like_given_back', award((int) $u['id'], -XP_LIKE_GIVEN, 'like_given_back', $id, null, true)];
  }
  $pdo->commit();
  like_answer($id, $u, false, $gained);
}
function like_answer(int $id, array $u, bool $liked, array $gained): void {
  $me = one('SELECT xp FROM hub_users WHERE id = ?', [$u['id']]);
  send_json(['liked' => $liked, 'likes' => (int) val('SELECT likes FROM hub_items WHERE id = ?', [$id]),
    'countries' => (int) val('SELECT COUNT(DISTINCT country) FROM hub_likes WHERE item_id = ? AND country IS NOT NULL', [$id]),
    'xp' => ['gained' => array_map(fn ($g) => ['reason' => $g[0], 'xp' => $g[1]], $gained), 'total' => array_sum(array_column($gained, 1)), 'level' => level_of((int) $me['xp'])]]);
}
// a follower: +5 to the person followed (from an account at least an hour old), taken back on unfollow
function r_follow(): void {
  $u = need_member();
  rate('follow_user', (string) $u['id']);
  $them = one('SELECT * FROM hub_users WHERE id = ? AND banned = 0', [id_of(body()->user ?? 0)]);
  if (!$them) fail('not_found', 404);
  if ((int) $them['id'] === (int) $u['id']) fail('self_follow');
  if (q('INSERT IGNORE INTO hub_follows (follower_id, followee_id, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [$u['id'], $them['id']])->rowCount() === 1 && old_enough($u)) {
    award((int) $them['id'], XP_FOLLOWER, 'follower', null, (int) $u['id']);
    q('UPDATE hub_follows SET xp = 1 WHERE follower_id = ? AND followee_id = ?', [$u['id'], $them['id']]);
    check_badges((int) $them['id']);
  }
  send_json(['followed' => true, 'followers' => (int) val('SELECT COUNT(*) FROM hub_follows WHERE followee_id = ?', [$them['id']])]);
}
function r_unfollow(): void {
  $u = need_member();
  rate('follow_user', (string) $u['id']);
  $id = id_of(body()->user ?? 0);
  $f = one('SELECT * FROM hub_follows WHERE follower_id = ? AND followee_id = ?', [$u['id'], $id]);
  if ($f) {
    q('DELETE FROM hub_follows WHERE follower_id = ? AND followee_id = ?', [$u['id'], $id]);
    if ($f['xp']) award($id, -XP_FOLLOWER, 'follower_back', null, (int) $u['id']);
  }
  send_json(['followed' => false, 'followers' => (int) val('SELECT COUNT(*) FROM hub_follows WHERE followee_id = ?', [$id])]);
}

// ---------------------------------------------------------------------------------------------------- moderation ---
// a report (one per person per item); reported by report_threshold people, an item is hidden until reviewed
function r_report(): void {
  $u = need_member();
  rate('report_user', (string) $u['id']);
  $b = body();
  $reason = is_string($b->reason ?? null) && in_array($b->reason, REPORT_REASONS, true) ? $b->reason : fail('bad_reason');
  $r = one('SELECT * FROM hub_items WHERE id = ?', [id_of($b->id ?? 0)]);
  if (!$r || $r['status'] !== 'visible') fail('not_found', 404);
  if ((int) $r['user_id'] === (int) $u['id']) fail('self_report');
  if (q('INSERT IGNORE INTO hub_reports (item_id, user_id, reason, note, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
    [$r['id'], $u['id'], $reason, text($b->note ?? '', 300, true)])->rowCount() === 1) {
    q('UPDATE hub_items SET reports = reports + 1 WHERE id = ?', [$r['id']]);
    q("UPDATE hub_items SET status = 'hidden', hidden_reason = 'reports' WHERE id = ? AND status = 'visible' AND reports >= ?", [$r['id'], max(1, (int) cfg('report_threshold'))]);
  }
  send_json(['ok' => true]);
}
// the moderators' list: items with reports to review, items hidden, people banned
function r_admin_reports(): void {
  $me = need_admin();
  $rows = all(CARD_SQL . ", i.description FROM hub_items i JOIN hub_users u ON u.id = i.user_id
    WHERE (i.reports > 0 OR i.status = 'hidden') AND i.status <> 'private' ORDER BY (i.status = 'hidden' AND i.hidden_reason = 'reports') DESC, i.reports DESC, i.updated_at DESC LIMIT 200");
  $items = cards($rows, $me);
  foreach ($items as &$c) $c['report_list'] = all('SELECT r.reason, r.note, r.resolved, r.created_at, u.name FROM hub_reports r JOIN hub_users u ON u.id = r.user_id WHERE r.item_id = ? ORDER BY r.id DESC LIMIT 20', [$c['id']]);
  $banned = array_map(fn ($u) => ['id' => (int) $u['id'], 'name' => $u['name'], 'country' => $u['country'], 'level' => level_of((int) $u['xp'])],
    all('SELECT id, name, country, xp FROM hub_users WHERE banned = 1 ORDER BY name LIMIT 200'));
  send_json(['items' => $items, 'banned' => $banned]);
}
function r_admin(): void {
  $me = need_admin();
  rate('admin_user', (string) $me['id']);
  $b = body();
  $act = is_string($b->action ?? null) ? $b->action : '';
  if (in_array($act, ['hide', 'restore', 'delete'], true)) {
    $id = id_of($b->id ?? 0);
    if (!val("SELECT id FROM hub_items WHERE id = ? AND status <> 'private'", [$id])) fail('not_found', 404);
    if ($act === 'hide') q("UPDATE hub_items SET status = 'hidden', hidden_reason = 'admin' WHERE id = ?", [$id]);
    if ($act === 'restore') {                                      // (reviewed: its reports closed)
      q("UPDATE hub_items SET status = 'visible', hidden_reason = NULL, reports = 0 WHERE id = ?", [$id]);
      q('UPDATE hub_reports SET resolved = 1 WHERE item_id = ?', [$id]);
    }
    if ($act === 'delete') q('DELETE FROM hub_items WHERE id = ?', [$id]);
  } elseif ($act === 'ban' || $act === 'unban') {
    $u = one('SELECT * FROM hub_users WHERE id = ?', [id_of($b->user ?? 0)]);
    if (!$u) fail('not_found', 404);
    if ($act === 'ban' && is_admin($u)) fail('forbidden', 403);    // (a moderator is never banned from here)
    q('UPDATE hub_users SET banned = ? WHERE id = ?', [$act === 'ban' ? 1 : 0, $u['id']]);
  } else fail('bad_action');
  send_json(['ok' => true]);
}
