/* LiveSiteLink: the ONE place a live-site URL becomes markup (FDY-360).
 *
 * Both surfaces use it, so they cannot drift apart:
 *   - the status board (index.html) loads this file as <script src="live-link.js">
 *   - the Admin Panel (api/_admin/shell.js) prints this same file into the page ahead of client.js
 * The URL itself comes from ONE column, app_registry.live_url. This file only draws it.
 *
 * Rules: https only. Anything else (null, "", http:, javascript:, a bare host) is "no URL" and is
 * never drawn as an anchor. External links always open in a new tab with rel="noopener noreferrer".
 * Keep this file self-contained and ES5-safe: no require, no imports, no outer variables.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** The URL when it is an https URL with a host, else null. Never throws. */
  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    if (!/^https:\/\/[^\s/?#]+/i.test(s) || /[\s<>"']/.test(s)) return null;
    return s;
  }

  /**
   * opts: { url, name, variant }
   *   variant 'pill'   (default) the board pill: "LIVE SITE ↗", or the muted "NO LIVE URL" when there is no URL
   *   variant 'inline' the Admin Panel Links-row link: "Live site ↗", or '' when there is no URL
   */
  function html(opts) {
    var o = opts || {};
    var url = safeUrl(o.url);
    var name = String(o.name == null ? '' : o.name).trim();
    var inline = o.variant === 'inline';
    if (!url) {
      return inline ? '' : '<span class="olink none" title="No verified live URL for this app">NO LIVE URL</span>';
    }
    var label = 'Open ' + (name || 'the') + ' live site';
    return '<a class="' + (inline ? 'livesite' : 'olink') + '" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"'
      + ' aria-label="' + esc(label) + '" title="' + esc(url) + '">' + (inline ? 'Live site ↗' : 'LIVE SITE ↗') + '</a>';
  }

  var api = { safeUrl: safeUrl, html: html };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LiveSiteLink = api;
})(typeof window !== 'undefined' ? window : this);
