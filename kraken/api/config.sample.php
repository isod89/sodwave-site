<?php
// SPDX-License-Identifier: GPL-3.0-only
// The Kraken hub's settings. Copy this file to config.php and fill it in (docs/HUB-INSTALLATION.md, in French).
//
// Where to put config.php, best first:
//   1. OUTSIDE the web folder, next to public_html, named kraken-hub-config.php
//      (on Hostinger: /home/uXXXXXXX/domains/your-domain/kraken-hub-config.php, beside public_html):
//      nobody can ever download it from the web;
//   2. here, as public_html/api/config.php: .htaccess refuses it to the web, and PHP would only run it anyway.
// Never put real passwords in config.sample.php: it is public (it ships with Kraken).

return [
  // ---- the database (hPanel > Databases > MySQL Databases)
  'db_host' => 'localhost',
  'db_port' => 3306,
  'db_name' => 'u123456789_kraken',
  'db_user' => 'u123456789_kraken',
  'db_pass' => 'CHANGE-ME',
  // 'db_socket' => '/path/to/mysqld.sock',     // (only if your host gives a socket instead of a host)

  // ---- the site: where Kraken itself is (the sign-in links and share pages point there), no slash at the end
  'site_url' => 'https://example.com',

  // ---- the sign-in emails (hPanel > Emails: create this address first, e.g. hub@example.com)
  'mail_from' => 'hub@example.com',
  'mail_from_name' => 'Kraken hub',

  // ---- the moderators: their emails (they see the MODERATION tab once signed in)
  'admins' => ['you@example.com'],

  // ---- your privacy policy and terms of use (docs/HUB-INSTALLATION.md, section 12): shown where people sign in
  'privacy_url' => '',
  'terms_url' => '',

  // ---- moderation: an item reported by this many different people is hidden until a moderator looks at it
  'report_threshold' => 3,

  // ---- a long random text, used to blur addresses (download counts) and IPs (rate limits): type anything long
  'secret' => 'CHANGE-ME-to-a-long-random-text-0123456789abcdef',

  // ---- the YouTube thumbnails, kept on the server (the folder must be writable; it is refused to the web)
  // 'cache_dir' => __DIR__ . '/cache',

  // ---- FOR TESTS ONLY, never on a real site: the sign-in link is given back by the API instead of only mailed
  'dev_return_link' => false,
];
