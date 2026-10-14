# sodwave.com

The website of SLOOP, the live groovebox firmware for the M-VAVE FM-1: https://www.sodwave.com

A static site (HTML, CSS, a little JavaScript, no build step), deployed by Hostinger from this repository.
The installer and the web editor stay on GitHub Pages (https://isod89.github.io/sloop-fm1/), always the latest release;
the version shown on the page is read from the latest GitHub release.

- `index.html` the page, `legal.html` legal notice and privacy, `404.html`
- `assets/css/site.css`, `assets/js/site.js`
- `assets/img/screens/` SLOOP's own screens, rendered from its source (2x, pixels kept sharp)
- `assets/img/editor/` the web editor
- `assets/fonts/terminus.woff2` the screen font (Terminus, SIL OFL 1.1: `assets/fonts/Terminus-LICENSE.txt`)
- `.htaccess` https and www, security headers, caching, the 404 page

SLOOP is not affiliated with M-VAVE. SLOOP is free software under the GPL-3.0: https://github.com/isod89/sloop-fm1
