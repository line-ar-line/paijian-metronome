(function () {
  'use strict';
  // These are fixed deployment addresses, never values from a query string,
  // hash or user-provided redirect. Local previews keep their normal behavior.
  const siteUrl = 'https://line-ar-line.github.io/paijian-metronome/';
  const communityUrl = 'https://fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com/paijian/community.html';
  const source = new URL('community.html', siteUrl);
  const destination = new URL(communityUrl);
  const here = window.location;
  const externalEntry = here.origin === source.origin && here.pathname === source.pathname;
  const hosted = here.origin === destination.origin && here.pathname === destination.pathname;
  window.PaijianCommunityEntry = Object.freeze({ externalEntry, hosted });

  const entry = document.getElementById('community-entry');
  const trial = document.getElementById('community-trial-label');
  if (entry) entry.hidden = !externalEntry;
  if (trial) trial.hidden = !hosted;

  if (externalEntry) {
    // The main site's auth domain is not enabled on this trial plan. Keep its
    // forms inert; community.js returns before subscribing or initializing.
    for (const control of document.querySelectorAll('form input, form textarea, form button, form fieldset')) control.disabled = true;
    for (const section of document.querySelectorAll('.community-layout, .together-card')) section.hidden = true;
    return;
  }
  if (hosted) {
    for (const link of document.querySelectorAll('a[href]')) {
      const match = /^\.\/(index|score|library|composer)\.html$/.exec(link.getAttribute('href'));
      if (match) link.href = new URL(`${match[1]}.html`, siteUrl).href;
    }
  }
})();
