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
    if (config.enabled !== true) return invalid('社区服务正在准备，完成账号登录与数据库配置后即可开放。');
    return { configured: true, error: '', envId: config.envId, region: config.region };
  }
  function readableError(error, action) {
    if (error?.name === 'CommunityError') return error;
    const code = String(error?.code || error?.error || '').toLowerCase();
    const category = String(error?.category || '').toLowerCase();
    if (action === '登录' && (['invalid_credentials', 'user_not_found'].includes(category) || ['invalid_username_or_password', 'invalid_credentials', 'wrong_password', 'invalid_password', 'user_not_found', 'unauthenticated', 'not_found', 'invalid_grant'].includes(code))) return userError('用户名或密码不正确，请检查后重试。', 'invalid_credentials');
    if (['unauthenticated', 'not_authenticated', 'session_expired', 'invalid_grant', '42501', 'pgrst301'].includes(code)) return userError('登录已失效，请重新登录。', 'not_authenticated');
    if (['resource_exhausted', 'rate_limited'].includes(code) || category === 'rate_limited') return userError('操作太频繁，请稍等片刻后再试。', 'rate_limited');
    if (category === 'provider_not_enabled' || ['provider_not_enabled', 'login_method_disabled', 'login_type_disabled', 'auth_unavailable'].includes(code)) return userError('账号登录暂未开放，请稍后再试。', 'auth_unavailable');
    if (['already_exists', 'username_taken'].includes(code)) return userError('这个用户名已被使用，请换一个。', 'username_taken');
    if (['weak_password', 'invalid_password_strength'].includes(code)) return userError('密码需为 8–32 位，以字母或数字开头，大写、小写、数字和允许的符号中至少包含三类。', 'invalid_password');
    if (code === 'invalid_username') return userError('用户名需为 3–32 位，以字母开头、字母或数字结尾，中间可用字母、数字、_ 和 -。', 'invalid_username');
    if (code === 'registration_unavailable') return userError('注册服务暂时不可用，请稍后再试。', 'registration_unavailable');
    if (['captcha_required', 'captcha_invalid'].includes(code) || category.startsWith('captcha_')) return userError('登录验证未完成，请稍后重试。', 'verification_required');
    if (['user_blocked', 'invalid_status', 'user_pending'].includes(code) || category === 'user_status_abnormal') return userError('当前账号暂时无法登录，请联系站点管理员。', 'account_unavailable');
    if (['invalid_argument', 'invalid_input', 'invalid_profile', 'invalid_checkin', '22023', '22p02'].includes(code)) return userError('填写内容不符合要求，请检查后重试。', 'invalid_input');
    if (code === 'not_found' || code === 'p0002') return userError('没有找到这一天的打卡记录，请刷新后重试。', 'not_found');
    if (['permission_denied', 'forbidden'].includes(code)) return userError('当前账号没有权限完成这项操作，请重新登录后重试。', 'forbidden');
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
    let revision = 0;
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
      if (!value?.user?.id || value.user.is_anonymous === true) return null;
      const info = await deadline(auth.getCurrentUser(false));
      if (!info || info.is_anonymous === true || info.isAnonymous === true || String(info.loginType || '').toLowerCase() === 'anonymous') return null;
      const id = info.sub || info.uid;
      if (id !== value.user.id) return null;
      const username = typeof info.username === 'string' ? info.username : '';
      const claimedUsername = value.user.username || value.user.user_metadata?.username;
      if (claimedUsername && claimedUsername !== username) return null;
      // Preserve the original identity and credentials, including existing
      // email accounts; SDK 3.11 nests username inside user_metadata.
      return { ...value, user: { ...value.user, username } };
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
    function credentials(username, password) {
      username = typeof username === 'string' ? username.trim() : '';
      if (!username || username.length > 254 || /[\s\p{Cc}]/u.test(username)) throw userError('请输入有效的用户名。', 'invalid_username');
      if (typeof password !== 'string' || !password || password.length > 256) throw userError('请输入密码。', 'invalid_password');
      return { username, password };
    }
    async function signIn(username, password) {
      const input = credentials(username, password);
      const data = await perform('登录', () => { getApp(); return auth.signInWithPassword(input); });
      const accepted = await verifiedSession(data?.session);
      if (!accepted) throw userError('未能确认登录状态，请重新登录。', 'invalid_session');
      revision += 1;
      session = accepted;
      initialization = Promise.resolve(session);
      notify();
      return session;
    }
    async function signUp(username, password) {
      const input = credentials(username, password);
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,30}[A-Za-z0-9]$/.test(input.username)) throw readableError({ code: 'invalid_username' }, '注册');
      if (!/^[A-Za-z0-9][A-Za-z0-9()!@#$%^&*|?><_-]{7,31}$/.test(password) || [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length < 3) throw readableError({ code: 'weak_password' }, '注册');
      if (!settings.configured) throw userError(settings.error, 'not_configured');
      let endpoint;
      try {
        endpoint = new URL(config.registrationUrl);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('invalid');
      } catch (_) { throw userError('注册服务暂时不可用，请稍后再试。', 'registration_unavailable'); }
      const fetch = dependencies.fetch || root.fetch?.bind(root);
      if (typeof fetch !== 'function') throw userError('浏览器无法连接注册服务，请更新浏览器后再试。', 'registration_unavailable');
      const controller = new root.AbortController();
      const timer = setTimer(() => controller.abort(), timeoutMs);
      try {
        await perform('注册', async () => {
          const response = await fetch(endpoint.href, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
            mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal
          });
          let body;
          try { body = await response.json(); }
          catch (_) { throw userError('注册服务返回了无效响应，请稍后重试。', 'registration_unavailable'); }
          if (body?.error) throw { code: body.error.code };
          if (![200, 201].includes(response.status) || body?.ok !== true) throw userError('注册服务暂时不可用，请稍后再试。', 'registration_unavailable');
          // Registration only creates the account. Never adopt a user or token
          // returned by this endpoint; authenticate with the official SDK.
          return { data: null };
        });
      } finally { clearTimer(timer); }
      try { return await signIn(input.username, input.password); }
      catch (_) { throw userError('账号已创建，请用该用户名登录。', 'account_created'); }
    }
    async function rpc(name, args, label) {
      await init();
      if (!session?.user?.id) throw userError('请先登录账号。', 'not_authenticated');
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
      signIn,
      signUp,
      async signOut() {
        await perform('退出登录', () => { getApp(); return auth.signOut(); });
        revision += 1;
        session = null; initialization = null;
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
