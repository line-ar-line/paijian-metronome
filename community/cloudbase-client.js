(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CloudBaseCommunity = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const STORAGE_WARNING = '浏览器未允许保存登录状态；本次登录仅在当前页面有效，刷新后需要重新登录。';
  function userError(message, code) {
    return Object.assign(new Error(message), { name: 'CommunityError', code });
  }
  function configuration(config = {}) {
    const invalid = error => ({ configured: false, error });
    if (['secretId', 'secretKey', 'sessionToken', 'privateKey'].some(key => config[key] || config.auth?.[key])) return invalid('网页配置不能包含腾讯云服务端密钥，请仅填写公开的环境信息。');
    if (!config.envId || !config.region) return invalid('社区尚未连接服务，请先配置 CloudBase 环境和地域。');
    if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(config.envId) || !/^[a-z]{2}-[a-z][a-z0-9-]*$/.test(config.region)) return invalid('社区环境配置无效，请检查环境 ID 和地域。');
    if (config.enabled !== true) return invalid('社区服务正在准备，完成邮箱登录与数据库配置后即可开放。');
    return { configured: true, error: '', envId: config.envId, region: config.region };
  }
  function readableError(error, action) {
    if (error?.name === 'CommunityError') return error;
    const code = String(error?.code || error?.error || '').toLowerCase();
    const category = String(error?.category || '').toLowerCase();
    if (['unauthenticated', 'not_authenticated', 'session_expired', 'invalid_grant', '42501', 'pgrst301'].includes(code)) return userError('登录已失效，请重新使用邮箱验证码登录。', 'not_authenticated');
    if (['resource_exhausted', 'rate_limited'].includes(code)) return userError('操作太频繁，请稍等片刻后再试。', 'rate_limited');
    if (category.includes('provider_not_enabled') || code === 'auth_unavailable') return userError('邮箱登录暂未开放，请联系站点管理员检查邮件登录配置。', 'auth_unavailable');
    if (['invalid_otp', 'invalid_two_factor'].includes(code) || (code === 'invalid_argument' && action === '验证邮箱')) return userError('验证码不正确或已过期，请重新获取后再试。', 'invalid_otp');
    if (['invalid_argument', 'invalid_input', 'invalid_profile', 'invalid_checkin', '22023', '22p02'].includes(code)) return userError('填写内容不符合要求，请检查后重试。', 'invalid_input');
    if (code === 'not_found' || code === 'p0002') return userError('没有找到这一天的打卡记录，请刷新后重试。', 'not_found');
    if (['permission_denied', 'forbidden'].includes(code)) return userError('当前账号没有权限完成这项操作，请重新登录后重试。', 'forbidden');
    if (code === 'email_unverified') return userError('请先通过邮箱验证码验证账号。', 'email_unverified');
    if (['42883', 'pgrst202', 'backend_unavailable'].includes(code)) return userError('社区服务尚未准备好，请稍后再试。', 'backend_unavailable');
    if (code === 'deadline_exceeded' || error?.name === 'AbortError' || /timeout|timed?\s*out/i.test(error?.message || '')) return userError('连接社区超时，请检查网络后重试。', 'timeout');
    if (['unreachable', 'network_error', 'unavailable'].includes(code) || error?.name === 'TypeError') return userError('暂时无法连接社区，请检查网络后重试。', 'network');
    return userError(`${action}失败，请稍后重试。`, 'request_failed');
  }

  function createCommunityClient(config, dependencies = {}) {
    const settings = configuration(config);
    const timeoutMs = Number.isFinite(dependencies.timeoutMs) && dependencies.timeoutMs > 0 ? dependencies.timeoutMs : 15000;
    const setTimer = dependencies.setTimeout || root.setTimeout.bind(root);
    const clearTimer = dependencies.clearTimeout || root.clearTimeout.bind(root);
    const subscribers = new Set();
    let app, auth, session = null, initialization = null;
    let revision = 0, sendVersion = 0, pendingCode = null;
    let notificationQueued = false, storageWarning = '';
    let pendingAuth = Promise.resolve();

    function notify() {
      if (notificationQueued) return;
      notificationQueued = true;
      setTimer(() => {
        notificationQueued = false;
        for (const callback of [...subscribers]) {
          if (!subscribers.has(callback)) continue;
          try { callback(session); } catch (_) { /* Isolate view subscribers. */ }
        }
      }, 0);
    }
    function deadline(promise) {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimer(() => reject(userError('连接社区超时，请检查网络后重试。', 'timeout')), timeoutMs);
      })]).finally(() => clearTimer(timer));
    }
    async function perform(action, operation) {
      try {
        const response = await deadline(Promise.resolve().then(operation));
        if (response?.error) throw response.error;
        return response?.data;
      } catch (error) { throw readableError(error, action); }
    }
    function storageAdapter() {
      const memory = new Map();
      let persistent;
      try {
        persistent = Object.prototype.hasOwnProperty.call(dependencies, 'storage') ? dependencies.storage : root.localStorage;
        const key = `paijian-cloudbase-probe-${Math.random().toString(36).slice(2)}`;
        persistent.setItem(key, '1'); persistent.removeItem(key);
      } catch (_) { persistent = null; storageWarning = STORAGE_WARNING; }
      const fallback = () => { persistent = null; storageWarning = STORAGE_WARNING; };
      const storage = {
        getItemSync(key) {
          if (persistent) {
            try {
              const value = persistent.getItem(key);
              if (value === null) memory.delete(key); else memory.set(key, value);
              return value;
            } catch (_) { fallback(); }
          }
          return memory.get(key) ?? null;
        },
        setItemSync(key, value) {
          memory.set(key, value);
          if (persistent) { try { persistent.setItem(key, value); } catch (_) { fallback(); } }
        },
        removeItemSync(key) {
          memory.delete(key);
          if (persistent) { try { persistent.removeItem(key); } catch (_) { fallback(); } }
        }
      };
      // CloudBase OAuth's SimpleStorage requires both async and sync methods.
      return Object.assign(storage, {
        async getItem(key) { return storage.getItemSync(key); },
        async setItem(key, value) { storage.setItemSync(key, value); },
        async removeItem(key) { storage.removeItemSync(key); }
      });
    }
    async function verifiedSession(value) {
      if (!value?.user?.id || !value.user.email || value.user.is_anonymous === true) return null;
      // SDK 3.11's email_confirmed_at is populated from created_at; check the
      // original user profile's verification flag instead of that timestamp.
      const info = await deadline(auth.getCurrentUser(false));
      if (!info || !(info.email_verified === true || info.emailVerified === true)) return null;
      const id = info.sub || info.uid;
      if (id !== value.user.id || String(info.email).toLowerCase() !== value.user.email.toLowerCase()) return null;
      return value;
    }
    function installMemoryPlatform(sdk, storage) {
      if (!storageWarning || typeof sdk.useAdapters !== 'function') return;
      // SDK 3.11's default browser platform reads window.localStorage during
      // construction, even with persistence:'none'. Use its public adapter API
      // in restricted browsers; do not replace any browser globals.
      class CommunityRequest {
        async fetch(options) {
          const controller = new root.AbortController();
          const abort = () => controller.abort();
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
          const timer = setTimer(abort, timeoutMs);
          try {
            const response = await root.fetch(options.url, { ...options, signal: controller.signal });
            const text = await response.text();
            let data = text;
            try { data = JSON.parse(text); } catch (_) { /* Preserve non-JSON error responses. */ }
            if (!response.ok && options.shouldThrowOnError !== false) throw data;
            return { data, statusCode: response.status, header: response.headers, response };
          } finally { clearTimer(timer); options.signal?.removeEventListener('abort', abort); }
        }
        request(options) {
          const method = String(options.method || 'GET').toUpperCase();
          const url = new URL(options.url, root.location.href);
          if (method === 'GET') for (const [key, value] of Object.entries(options.data || {})) url.searchParams.set(key, value);
          const body = options.body ?? (method !== 'GET' && options.data ? JSON.stringify(options.data) : undefined);
          return this.fetch({ ...options, url: url.href, method, body, shouldThrowOnError: false });
        }
        get(options) { return this.request({ ...options, method: 'GET' }); }
        post(options) { return this.request({ ...options, method: 'POST' }); }
      }
      sdk.useAdapters({
        runtime: 'web', isMatch: () => true,
        genAdapter: () => ({
          type: 'default', root, reqClass: CommunityRequest, wsClass: root.WebSocket, primaryStorage: 'none',
          localStorage: { getItem: storage.getItemSync, setItem: storage.setItemSync, removeItem: storage.removeItemSync }
        })
      });
    }
    function getApp() {
      if (!settings.configured) throw userError(settings.error, 'not_configured');
      if (app) return app;
      const sdk = dependencies.cloudbase || root.cloudbase;
      if (!sdk || typeof sdk.init !== 'function') throw userError('登录组件加载失败，请刷新页面后重试。', 'sdk_unavailable');
      const storage = storageAdapter();
      installMemoryPlatform(sdk, storage);
      app = sdk.init({ env: settings.envId, region: settings.region, timeout: timeoutMs, persistence: storageWarning ? 'none' : 'local', debug: false, auth: { detectSessionInUrl: false }, storage });
      auth = typeof app.auth === 'function' ? app.auth() : app.auth;
      auth.onAuthStateChange((_event, next, info) => {
        if (info?.error) return;
        const current = ++revision;
        if (!next) { session = null; notify(); return; }
        // Leave SDK credential locks before checking the original profile or
        // letting UI subscribers issue a database request.
        pendingAuth = new Promise(resolve => setTimer(resolve, 0)).then(async () => {
          const accepted = await verifiedSession(next);
          if (current === revision) { session = accepted; notify(); }
        }).catch(() => { if (current === revision) { session = null; notify(); } });
      });
      return app;
    }
    function init() {
      if (initialization) return initialization.then(() => session);
      const current = revision;
      initialization = (async () => {
        getApp();
        let data;
        try { data = await perform('恢复登录', () => auth.getSession()); }
        catch (error) { if (error.code !== 'not_authenticated') throw error; data = { session: null }; }
        const accepted = await verifiedSession(data?.session);
        if (current === revision) session = accepted;
        else await deadline(pendingAuth);
        notify();
        return session;
      })().catch(error => { initialization = null; throw readableError(error, '恢复登录'); });
      return initialization;
    }
    function emailAddress(value) {
      const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw userError('请输入有效的邮箱地址。', 'invalid_email');
      return email;
    }
    async function rpc(name, args, label) {
      await init();
      if (!session?.user?.id) throw userError('请先使用邮箱验证码登录。', 'not_authenticated');
      return perform(label, () => getApp().rdb().rpc(name, args));
    }

    return {
      get configured() { return settings.configured; },
      getConfiguration() { return { configured: settings.configured, error: settings.error, storageWarning }; },
      init,
      subscribe(callback) {
        if (typeof callback !== 'function') throw new TypeError('登录订阅需要一个回调函数。');
        subscribers.add(callback); notify();
        return () => subscribers.delete(callback);
      },
      async sendCode(value) {
        const email = emailAddress(value);
        const current = ++sendVersion;
        pendingCode = null;
        const data = await perform('发送验证码', () => { getApp(); return auth.signInWithOtp({ email, options: { shouldCreateUser: true } }); });
        if (typeof data?.verifyOtp !== 'function') throw userError('未能获取邮箱验证信息，请重新发送验证码。', 'invalid_response');
        if (current === sendVersion) pendingCode = { email, verify: data.verifyOtp };
      },
      async verifyCode(value, code) {
        const email = emailAddress(value);
        const token = typeof code === 'string' ? code.replace(/\s/g, '') : '';
        if (!/^\d{6,10}$/.test(token)) throw userError('请输入邮件中的数字验证码。', 'invalid_otp');
        const challenge = pendingCode;
        if (!challenge || challenge.email !== email) throw userError('请先向这个邮箱发送验证码；刷新页面后需要重新获取。', 'verification_required');
        const data = await perform('验证邮箱', () => challenge.verify({ token }));
        const accepted = await verifiedSession(data?.session);
        if (!accepted) throw userError('尚未取得已验证邮箱的登录状态，请重新获取验证码后再试。', 'email_unverified');
        revision += 1;
        session = accepted;
        if (pendingCode === challenge) pendingCode = null;
        initialization = Promise.resolve(session);
        notify();
        return session;
      },
      async signOut() {
        await perform('退出登录', () => { getApp(); return auth.signOut(); });
        revision += 1; sendVersion += 1;
        session = null; pendingCode = null; initialization = null;
        notify();
      },
      dashboard() { return rpc('community_dashboard', undefined, '加载社区'); },
      updateProfile(nickname) {
        const value = typeof nickname === 'string' ? nickname.trim() : '';
        if ([...value].length < 2 || [...value].length > 24 || /[@\p{Cc}]/u.test(value)) return Promise.reject(userError('昵称需为 2–24 个字符，不能包含 @ 或控制字符。', 'invalid_profile'));
        return rpc('community_update_profile', { p_nickname: value }, '保存昵称');
      },
      checkIn({ minutes, piece = '', note = '', isPublic = false } = {}) {
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) return Promise.reject(userError('练习时长需要填写 1–720 之间的整数分钟。', 'invalid_checkin'));
        if (typeof piece !== 'string' || typeof note !== 'string' || typeof isPublic !== 'boolean') return Promise.reject(userError('打卡内容格式不正确，请检查后重试。', 'invalid_checkin'));
        piece = piece.trim(); note = note.trim();
        if ([...piece].length > 100 || /\p{Cc}/u.test(piece)) return Promise.reject(userError('曲名最多 100 个字符，不能包含换行或控制字符。', 'invalid_checkin'));
        if ([...note].length > 280 || /\p{Cc}/u.test(note.replace(/[\r\n\t]/g, ''))) return Promise.reject(userError('随笔最多 280 个字符，不能包含无效控制字符。', 'invalid_checkin'));
        return rpc('community_check_in', { p_minutes: minutes, p_piece: piece, p_note: note, p_is_public: isPublic }, '保存打卡');
      },
      setCheckinPublic(day, isPublic) {
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || typeof isPublic !== 'boolean') return Promise.reject(userError('打卡日期或公开状态不正确，请刷新后重试。', 'invalid_checkin'));
        return rpc('community_set_checkin_public', { p_day: day, p_is_public: isPublic }, '修改打卡公开状态');
      }
    };
  }
  return { createCommunityClient };
});
