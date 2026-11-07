(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.ScoreUserLibrary = api.createUserLibrary({ getStorage: () => root.localStorage, eventTarget: root });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'paijian.score-favorites.v1';
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(id);
  const readError = '暂时无法读取本机收藏，请检查浏览器是否允许保存网站数据后重试。';
  const damagedError = '本机收藏记录暂时无法读取，原记录未被覆盖。请刷新页面后重试。';
  const writeError = '收藏未能保存，可能是浏览器存储已满或禁止保存网站数据。请检查后重试。';

  function decode(raw) {
    if (raw === null) return new Set();
    let saved;
    try { saved = JSON.parse(raw); } catch { throw new Error(damagedError); }
    if (!saved || saved.version !== 1 || !Array.isArray(saved.ids) || saved.ids.length > 20000 || !saved.ids.every(validId)) throw new Error(damagedError);
    return new Set(saved.ids);
  }

  // IDs are shared by the catalog and score page. Writes first read the latest
  // saved list so a stale tab does not overwrite another tab's recent additions.
  function createUserLibrary({ storage, getStorage = () => storage, eventTarget } = {}) {
    let ids = new Set();
    let error = '';
    const listeners = new Set();
    const getState = () => ({ ids: [...ids], count: ids.size, error });
    const notify = () => { for (const listener of listeners) { try { listener(getState()); } catch { /* One UI subscriber must not prevent another from updating. */ } } };

    function read() {
      let target, raw;
      try {
        target = getStorage();
        if (!target || typeof target.getItem !== 'function' || typeof target.setItem !== 'function') throw new Error();
        raw = target.getItem(STORAGE_KEY);
      } catch { throw new Error(readError); }
      return { target, values: decode(raw) };
    }

    function refresh() {
      try { ids = read().values; error = ''; }
      catch (failure) { error = failure.message; }
      notify();
      return getState();
    }

    function change(id, desired) {
      if (!validId(id)) return { ok: false, favorite: false, error: '这份曲谱暂时没有可用的收藏编号。' };
      let latest;
      try { latest = read(); }
      catch (failure) {
        error = failure.message; notify();
        return { ok: false, favorite: ids.has(id), error };
      }
      const favorite = desired === undefined ? !latest.values.has(id) : desired;
      const changed = latest.values.has(id) !== favorite;
      if (favorite) latest.values.add(id); else latest.values.delete(id);
      if (changed) {
        try { latest.target.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ids: [...latest.values].sort() })); }
        catch {
          // Keep the last readable saved state; a failed write is never reported
          // as a successful favorite that would disappear after reloading.
          try { ids = read().values; } catch { /* Retain the last known snapshot. */ }
          error = writeError; notify();
          return { ok: false, favorite: ids.has(id), error };
        }
      }
      ids = latest.values; error = ''; notify();
      return { ok: true, favorite, error: '' };
    }

    function storageChanged(event) {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== getStorage()) return; } catch { /* refresh supplies the user-facing error. */ }
      refresh();
    }
    eventTarget?.addEventListener?.('storage', storageChanged);
    eventTarget?.addEventListener?.('pageshow', refresh);
    refresh();
    return Object.freeze({
      key: STORAGE_KEY,
      has: id => validId(id) && ids.has(id),
      getState,
      set: (id, favorite) => typeof favorite === 'boolean' ? change(id, favorite) : { ok: false, favorite: ids.has(id), error: '收藏状态须为开启或关闭。' },
      toggle: id => change(id),
      refresh,
      subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('收藏订阅须为函数。');
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      destroy() {
        listeners.clear();
        eventTarget?.removeEventListener?.('storage', storageChanged);
        eventTarget?.removeEventListener?.('pageshow', refresh);
      },
    });
  }

  return { STORAGE_KEY, createUserLibrary };
});
