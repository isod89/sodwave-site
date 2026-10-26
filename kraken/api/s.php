<?php
// SPDX-License-Identifier: GPL-3.0-only
// An item's public link: s.php?id=ID. A small page that social networks and chat apps read (Open Graph, Twitter
// card: the title, the creator and their level, the YouTube thumbnail, the description), and that sends a person on
// to Kraken itself, at /?hub=ID, where the hub opens that item.
declare(strict_types=1);
define('KRAKEN_HUB', true);
require __DIR__ . '/lib.php';
hub_errors();
set_exception_handler(function (Throwable $e) {
  error_log('kraken hub: share page: ' . $e->getMessage());
  page(null, 500);
});

$id = is_string($_GET['id'] ?? null) && ctype_digit($_GET['id']) ? (int) $_GET['id'] : 0;
rate('read_ip', client_ip());
$r = $id ? one("SELECT i.id, i.kind, i.title, i.description, i.genre, i.bpm, i.youtube, i.likes, u.name, u.country, u.xp FROM hub_items i
  JOIN hub_users u ON u.id = i.user_id WHERE i.id = ? AND i.status = 'visible' AND u.banned = 0", [$id]) : null;
page($r, $r ? 200 : 404);

function site(): string {
  $s = rtrim((string) cfg('site_url'), '/');
  if ($s !== '') return $s;
  $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
  return $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . rtrim(dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/api/s.php')), '/');
}
function e(?string $s): string { return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8'); }
function page(?array $r, int $status): void {
  http_response_code($status);
  header('Content-Type: text/html; charset=utf-8');
  header('Cache-Control: public, max-age=300');
  header('X-Content-Type-Options: nosniff');
  header("Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  $site = site();
  $to = $r ? $site . '/?hub=' . (int) $r['id'] : $site . '/';
  $kinds = ['song' => 'Song', 'preset' => 'Preset', 'plugin' => 'Plugin', 'template' => 'Template'];
  if ($r) {
    $lv = level_of((int) $r['xp']);
    $title = $r['title'] . ' · ' . $r['name'];
    $bits = array_filter([$kinds[$r['kind']] ?? '', $r['genre'], $r['bpm'] ? rtrim(rtrim(number_format((float) $r['bpm'], 2, '.', ''), '0'), '.') . ' BPM' : '',
      $r['likes'] ? $r['likes'] . ' ♥' : '']);
    $desc = 'By ' . $r['name'] . ' (' . $lv['name'] . ', level ' . $lv['level'] . ') on the Kraken hub · ' . implode(' · ', $bits)
      . ($r['description'] !== '' ? ' — ' . mb_substr(preg_replace('/\s+/u', ' ', $r['description']), 0, 220) : '');
    $img = $r['youtube'] ? $site . '/api/thumb.php?v=' . $r['youtube'] : $site . '/assets/icon-512.png';
  } else {
    $title = 'Kraken hub';
    $desc = 'Songs, presets and plugins made with Kraken, the free DAW by Sodwave.';
    $img = $site . '/assets/icon-512.png';
  }
  $card = $r && $r['youtube'] ? 'summary_large_image' : 'summary';
  echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    . '<title>' . e($title) . '</title>'
    . '<meta name="description" content="' . e($desc) . '">'
    . '<meta property="og:type" content="' . ($r && $r['kind'] === 'song' ? 'music.song' : 'website') . '">'
    . '<meta property="og:site_name" content="Kraken hub">'
    . '<meta property="og:title" content="' . e($title) . '">'
    . '<meta property="og:description" content="' . e($desc) . '">'
    . '<meta property="og:image" content="' . e($img) . '">'
    . '<meta property="og:url" content="' . e($site . '/api/s.php?id=' . ($r ? (int) $r['id'] : 0)) . '">'
    . '<meta name="twitter:card" content="' . $card . '">'
    . '<meta name="twitter:title" content="' . e($title) . '">'
    . '<meta name="twitter:description" content="' . e($desc) . '">'
    . '<meta name="twitter:image" content="' . e($img) . '">'
    . '<link rel="canonical" href="' . e($to) . '">'
    . '<meta http-equiv="refresh" content="0;url=' . e($to) . '">'
    . '<style>body{background:#0b0c0d;color:#dfe2de;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box;text-align:center}a{color:#ff5b14}</style>'
    . '</head><body><main><h1>' . e($r ? $r['title'] : 'Kraken hub') . '</h1><p>' . e($desc) . '</p>'
    . '<p><a href="' . e($to) . '">Open in Kraken</a></p></main>'
    . '<script>location.replace(' . json_encode($to, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES) . ')</script>'
    . '</body></html>';
  exit;
}
