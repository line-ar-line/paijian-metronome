(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NotationTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function events(text) {
    let bar = 0, event = 0;
    return [...text.matchAll(/\||~?\([^)]*\)(?::[^\s|]+)?~?|[^\s|]+/g)].map(match => {
      const entry = { text: match[0], start: match.index, end: match.index + match[0].length, bar, event };
      if (match[0] === '|') { bar++; event = 0; } else event++;
      return entry;
    });
  }
  function insert(text, start, end, token) {
    if (start === end) {
      const inside = events(text).find(entry => entry.start < start && start < entry.end);
      if (inside) start = end = inside.end;
    }
    const before = text.slice(0, start), after = text.slice(end);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const suffix = after && !/^\s/.test(after) ? ' ' : '';
    return { value: before + prefix + token + suffix + after, caret: start + prefix.length + token.length };
  }
  function locate(text, bar, event) { return events(text).find(entry => entry.text !== '|' && entry.bar === bar && entry.event === event); }
  return { events, insert, locate };
});
