<?php
// SPDX-License-Identifier: GPL-3.0-only
// A YouTube video's thumbnail, served from this site: thumb.php?v=VIDEOID. Kraken's pages are cross-origin isolated
// (multi-core audio), so they may not show an image from another site: the server fetches it once from YouTube,
// keeps it (cache folder), and serves it as its own. When YouTube cannot be reached: a plain picture instead.
declare(strict_types=1);
define('KRAKEN_HUB', true);
require __DIR__ . '/lib.php';
hub_errors();

$v = is_string($_GET['v'] ?? null) ? $_GET['v'] : '';
if (!preg_match('/^[A-Za-z0-9_-]{11}$/', $v)) { http_response_code(404); exit; }
header('Cross-Origin-Resource-Policy: same-origin');
header('X-Content-Type-Options: nosniff');

$dir = rtrim((string) cfg('cache_dir'), '/') . '/thumbs';
$file = "$dir/$v.jpg";
if (is_file($file) && filesize($file) > 0 && filemtime($file) > time() - 86400 * 30) serve($file);

// not kept yet: fetched (a few per minute per visitor at most)
rate('thumb_ip', client_ip());
$jpeg = fetch(sprintf((string) cfg('thumb_url'), $v));
if ($jpeg !== null) {
  try {
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    $tmp = "$file." . bin2hex(random_bytes(4));
    if (file_put_contents($tmp, $jpeg) === strlen($jpeg)) rename($tmp, $file); else @unlink($tmp);
  } catch (Throwable $e) { error_log('kraken hub: thumbnail cache: ' . $e->getMessage()); }
  if (is_file($file)) serve($file);
  header('Content-Type: image/jpeg'); header('Cache-Control: public, max-age=86400');
  echo $jpeg; exit;
}
// YouTube out of reach (or no such video): a dark picture with a play sign, not kept long
header('Content-Type: image/svg+xml');
header('Cache-Control: public, max-age=300');
echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
  . '<stop offset="0" stop-color="#14323f"/><stop offset="1" stop-color="#0b0c0d"/></linearGradient></defs><rect width="480" height="360" fill="url(#g)"/>'
  . '<circle cx="240" cy="180" r="44" fill="#ff5b14"/><path d="M226 156v48l40-24z" fill="#1a0b03"/></svg>';
exit;

function serve(string $file): void {
  header('Content-Type: image/jpeg');
  header('Cache-Control: public, max-age=2592000, immutable');
  header('Content-Length: ' . filesize($file));
  readfile($file);
  exit;
}
// the picture (a JPEG of at most 1 MB), or null
function fetch(string $url): ?string {
  $body = null; $type = '';
  try {
    if (function_exists('curl_init')) {
      $ch = curl_init($url);
      curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 6, CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_MAXFILESIZE => 1048576, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP, CURLOPT_USERAGENT => 'Kraken hub thumbnails']);
      $res = curl_exec($ch);
      $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
      $type = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
      curl_close($ch);
      if (is_string($res) && $code === 200) $body = $res;
    } elseif (ini_get('allow_url_fopen')) {
      $ctx = stream_context_create(['http' => ['timeout' => 6, 'follow_location' => 0, 'user_agent' => 'Kraken hub thumbnails']]);
      $res = @file_get_contents($url, false, $ctx, 0, 1048577);
      foreach ($http_response_header ?? [] as $h) if (stripos($h, 'content-type:') === 0) $type = trim(substr($h, 13));
      if (is_string($res) && strpos($http_response_header[0] ?? '', ' 200') !== false) $body = $res;
    }
  } catch (Throwable $e) { return null; }
  if ($body === null || strlen($body) < 100 || strlen($body) > 1048576) return null;
  if (stripos($type, 'image/jpeg') === false && substr($body, 0, 3) !== "\xFF\xD8\xFF") return null;
  return substr($body, 0, 3) === "\xFF\xD8\xFF" ? $body : null;
}
