(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) root.RecentPractice = api.createRecentPractice(() => root.localStorage);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const key = 'paijian.recent-practice.v1';
  const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(id);
  function createRecentPractice(getStorage) {
    function read() {
      const raw = getStorage().getItem(key);
      if (raw === null) return [];
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.ids) || data.ids.length > 20 || !data.ids.every(valid)) throw new Error('invalid recent list');
      return [...new Set(data.ids)];
    }
    return {
      key,
      getState() {
        try { return { ids: read(), error: '' }; }
        catch { return { ids: [], error: '最近练习记录暂时无法读取，请检查浏览器存储设置。' }; }
      },
      record(id) {
        if (!valid(id)) return false;
        try { const ids = [id, ...read().filter(item => item !== id)].slice(0, 20); getStorage().setItem(key, JSON.stringify({ version: 1, ids })); return true; }
        catch { return false; }
      },
    };
  }
  return { createRecentPractice };
});
