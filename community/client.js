(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) root.PaijianCommunity = api.createCommunityClient(root.PAIJIAN_COMMUNITY_CONFIG);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DEFAULT_TIMEOUT = 15000;
  const STORAGE_WARNING = '浏览器未允许保存登录状态；本次登录仅在当前页面有效，刷新后需要重新登录。';

  function userError(message, code) {
    const error = new Error(message);
    error.name = 'CommunityError';
    error.code = code;
    return error;
  }

  function configuration(config) {
    const rawUrl = typeof config?.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
    const key = typeof config?.supabasePublishableKey === 'string' ? config.supabasePublishableKey.trim() : '';
    const invalid = error => ({ configured: false, error, url: '', key: '' });
    if (!rawUrl || !key) return invalid('社区尚未连接服务，请先配置 Supabase 项目地址和公开密钥。');
    let url;
    try { url = new URL(rawUrl); } catch (_) { return invalid('社区服务地址无效，请检查 Supabase 项目地址。'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      return invalid('社区服务地址须使用 HTTPS 项目根地址；本地开发可使用 HTTP 回环地址。');
    }
    if (/^sb_secret_/i.test(key) || /service_role/i.test(key)) {
      return invalid('不能在网页中使用服务端密钥，请改用 Supabase publishable 或 anon 公开密钥。');
    }
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
      try {
        const parts = key.split('.');
        if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
        const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(root.atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
        if (payload.role !== 'anon') throw new Error();
      } catch (_) {
        return invalid('社区公开密钥无效。请使用 Supabase publishable 或 anon 密钥，勿使用用户令牌或服务端密钥。');
      }
    }
    return { configured: true, error: '', url: url.origin, key };
  }

  function readableError(error, action) {
    if (error?.name === 'CommunityError') return error;
    const code = typeof error?.code === 'string' ? error.code : '';
    const status = Number(error?.status);
    const message = String(error?.message || '');
    if (['otp_expired', 'otp_disabled'].includes(code)) return userError('验证码不正确或已过期，请重新获取后再试。', 'invalid_otp');
    if (['over_email_send_rate_limit', 'over_request_rate_limit'].includes(code) || status === 429) return userError('操作太频繁，请稍等片刻后再试；邮箱里已有的验证码仍可尝试。', 'rate_limited');
    if (['email_address_invalid', 'email_address_not_authorized'].includes(code)) return userError('暂时无法向这个邮箱发送验证码，请检查邮箱地址或联系站点管理员。', 'invalid_email');
    if (['email_provider_disabled', 'signup_disabled'].includes(code)) return userError('邮箱登录暂未开放，请联系站点管理员检查邮件登录配置。', 'auth_unavailable');
    if (['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt'].includes(code) || status === 401 || code === 'PGRST301') return userError('登录已失效，请重新使用邮箱验证码登录。', 'session_expired');
    if (code === 'PGRST202' || code === '42883') return userError('社区服务尚未初始化，请先应用社区数据库配置。', 'backend_unavailable');
    if (code === '42501') return userError('登录状态无效，请重新使用邮箱验证码登录。', 'not_authenticated');
    if (code === '22023' || code === '22P02') return userError('填写内容不符合要求，请检查昵称、练习时长和打卡内容后重试。', 'invalid_input');
    if (code === 'P0002') return userError('没有找到这一天的打卡记录，请刷新记录后重试。', 'not_found');
    if (status === 403) return userError('当前登录没有权限完成这项操作，请重新登录后重试。', 'forbidden');
    if (error?.name === 'AbortError' || /timed?\s*out|timeout/i.test(message)) return userError('连接社区超时，请检查网络后重试。', 'timeout');
    if (error?.name === 'TypeError' || /fetch|network|offline|load failed/i.test(message)) return userError('暂时无法连接社区，请检查网络后重试。', 'network');
    return userError(`${action}失败，请稍后重试。`, 'request_failed');
  }

  function createCommunityClient(config, dependencies = {}) {
    const settings = configuration(config);
    const timeoutMs = Number.isFinite(dependencies.timeoutMs) && dependencies.timeoutMs > 0 ? dependencies.timeoutMs : DEFAULT_TIMEOUT;
    const setTimer = dependencies.setTimeout || root.setTimeout.bind(root);
    const clearTimer = dependencies.clearTimeout || root.clearTimeout.bind(root);
    const subscribers = new Set();
    let client = null;
    let session = null;
    let authRevision = 0;
    let initialization = null;
    let notificationQueued = false;
    let storageWarning = '';

    function notify() {
      if (notificationQueued) return;
      notificationQueued = true;
      // Supabase holds its auth lock while invoking onAuthStateChange. Deliver
      // callbacks on a later task, so subscribers may safely request RPC data.
      setTimer(() => {
        notificationQueued = false;
        for (const callback of [...subscribers]) {
          if (!subscribers.has(callback)) continue;
          try { callback(session); } catch (_) { /* One view must not stop other subscribers. */ }
        }
      }, 0);
    }

    function storageAdapter() {
      const memory = new Map();
      let persistent;
      try {
        persistent = Object.prototype.hasOwnProperty.call(dependencies, 'storage') ? dependencies.storage : root.localStorage;
        if (!persistent) throw new Error();
        const probe = `paijian-auth-probe-${Math.random().toString(36).slice(2)}`;
        persistent.setItem(probe, '1');
        persistent.removeItem(probe);
      } catch (_) {
        persistent = null;
        storageWarning = STORAGE_WARNING;
      }
      function fallback() { persistent = null; storageWarning = STORAGE_WARNING; }
      return {
        getItem(key) {
          if (persistent) {
            try {
              const value = persistent.getItem(key);
              if (value === null) memory.delete(key); else memory.set(key, value);
              return value;
            } catch (_) { fallback(); }
          }
          return memory.get(key) ?? null;
        },
        setItem(key, value) {
          memory.set(key, value);
          if (persistent) { try { persistent.setItem(key, value); } catch (_) { fallback(); } }
        },
        removeItem(key) {
          memory.delete(key);
          if (persistent) { try { persistent.removeItem(key); } catch (_) { fallback(); } }
        }
      };
    }

    function deadline(promise) {
      let timer;
      const expiration = new Promise((_, reject) => {
        timer = setTimer(() => reject(userError('连接社区超时，请检查网络后重试。', 'timeout')), timeoutMs);
      });
      return Promise.race([promise, expiration]).finally(() => clearTimer(timer));
    }

    function timedFetch(input, options = {}) {
      const fetcher = dependencies.fetch || root.fetch?.bind(root);
      if (!fetcher) return Promise.reject(userError('当前浏览器不支持网络连接，请使用新版浏览器。', 'network'));
      const controller = new root.AbortController();
      const previousSignal = options.signal;
      const abort = () => controller.abort(previousSignal?.reason);
      if (previousSignal?.aborted) abort();
      else previousSignal?.addEventListener('abort', abort, { once: true });
      const timer = setTimer(() => controller.abort(), timeoutMs);
      return deadline(Promise.resolve().then(() => fetcher(input, { ...options, signal: controller.signal })))
        .finally(() => {
          clearTimer(timer);
          previousSignal?.removeEventListener('abort', abort);
        });
    }

    function getClient() {
      if (!settings.configured) throw userError(settings.error, 'not_configured');
      if (client) return client;
      const createClient = dependencies.createClient || root.supabase?.createClient;
      if (typeof createClient !== 'function') throw userError('登录组件加载失败，请刷新页面后重试。', 'sdk_unavailable');
      try {
        client = createClient(settings.url, settings.key, {
          auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, debug: false, storage: storageAdapter() },
          global: { fetch: timedFetch }
        });
        client.auth.onAuthStateChange((_event, nextSession) => {
          authRevision += 1;
          session = nextSession || null;
          notify();
        });
      } catch (error) {
        client = null;
        throw readableError(error, '初始化登录');
      }
      return client;
    }

    async function perform(action, operation) {
      try {
        const result = await deadline(Promise.resolve().then(operation));
        if (result?.error) throw result.error;
        return result?.data;
      } catch (error) { throw readableError(error, action); }
    }

    function init() {
      if (initialization) return initialization.then(() => session);
      const revision = authRevision;
      initialization = perform('恢复登录', () => getClient().auth.getSession()).then(data => {
        if (revision === authRevision) session = data?.session || null;
        notify();
        return session;
      }).catch(error => {
        initialization = null;
        throw error;
      });
      return initialization;
    }

    function emailAddress(value) {
      const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw userError('请输入有效的邮箱地址。', 'invalid_email');
      return email;
    }

    async function requireSession() {
      await init();
      if (!session?.user?.id) throw userError('请先使用邮箱验证码登录。', 'not_authenticated');
    }

    async function rpc(name, args, action) {
      await requireSession();
      return perform(action, () => getClient().rpc(name, args));
    }

    return {
      get configured() { return settings.configured; },
      getConfiguration() { return { configured: settings.configured, error: settings.error, storageWarning }; },
      init,
      subscribe(callback) {
        if (typeof callback !== 'function') throw new TypeError('登录订阅需要一个回调函数。');
        subscribers.add(callback);
        notify();
        return () => subscribers.delete(callback);
      },
      async sendCode(value) {
        const email = emailAddress(value);
        await perform('发送验证码', () => getClient().auth.signInWithOtp({ email, options: { shouldCreateUser: true } }));
      },
      async verifyCode(value, code) {
        const email = emailAddress(value);
        const token = typeof code === 'string' ? code.replace(/\s/g, '') : '';
        if (!/^\d{6,10}$/.test(token)) throw userError('请输入邮件中的 6–10 位数字验证码。', 'invalid_otp');
        const data = await perform('验证邮箱', () => getClient().auth.verifyOtp({ email, token, type: 'email' }));
        if (!data?.session) throw userError('未能取得登录状态，请重新获取验证码后再试。', 'session_missing');
        authRevision += 1;
        session = data.session;
        notify();
        return session;
      },
      async signOut() {
        await perform('退出登录', () => getClient().auth.signOut({ scope: 'local' }));
        authRevision += 1;
        session = null;
        initialization = null;
        notify();
      },
      dashboard() { return rpc('community_dashboard', undefined, '加载社区'); },
      updateProfile(nickname) {
        const value = typeof nickname === 'string' ? nickname.trim() : '';
        if ([...value].length < 2 || [...value].length > 24) return Promise.reject(userError('昵称需要填写 2–24 个字符。', 'invalid_profile'));
        if (/[@\p{Cc}]/u.test(value)) return Promise.reject(userError('昵称不能包含 @ 或控制字符，请使用便于琴友辨认的称呼。', 'invalid_profile'));
        return rpc('community_update_profile', { p_nickname: value }, '保存昵称');
      },
      checkIn({ minutes, piece = '', note = '', isPublic = false } = {}) {
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) return Promise.reject(userError('练习时长需要填写 1–720 之间的整数分钟。', 'invalid_checkin'));
        if (typeof piece !== 'string' || typeof note !== 'string' || typeof isPublic !== 'boolean') return Promise.reject(userError('打卡内容格式不正确，请检查后重试。', 'invalid_checkin'));
        if ([...piece.trim()].length > 100) return Promise.reject(userError('曲名最多填写 100 个字符。', 'invalid_checkin'));
        if ([...note.trim()].length > 280) return Promise.reject(userError('练习随笔最多填写 280 个字符。', 'invalid_checkin'));
        if (/\p{Cc}/u.test(piece.trim())) return Promise.reject(userError('曲名不能包含换行或控制字符。', 'invalid_checkin'));
        if (/\p{Cc}/u.test(note.trim().replace(/[\r\n\t]/g, ''))) return Promise.reject(userError('练习随笔中含有无效控制字符，请删除后重试。', 'invalid_checkin'));
        return rpc('community_check_in', { p_minutes: minutes, p_piece: piece.trim(), p_note: note.trim(), p_is_public: isPublic }, '保存打卡');
      },
      setCheckinPublic(day, isPublic) {
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || typeof isPublic !== 'boolean') {
          return Promise.reject(userError('打卡日期或公开状态不正确，请刷新后重试。', 'invalid_checkin'));
        }
        return rpc('community_set_checkin_public', { p_day: day, p_is_public: isPublic }, '修改打卡公开状态');
      }
    };
  }

  return { createCommunityClient };
});
