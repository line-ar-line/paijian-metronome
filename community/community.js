(function () {
  'use strict';

  if (window.PaijianCommunityEntry?.externalEntry) return;

  const $ = id => document.getElementById(id);
  const api = window.PaijianCommunity;
  let session = null;
  let data = null;
  let ready = false;
  let authBusy = false;
  let mutationBusy = false;
  let loading = false;
  let requestVersion = 0;
  let accountVersion = 0;
  let authMode = 'login';
  let lastRefresh = 0;

  function message(id, text, error = false) {
    const element = $(id);
    element.textContent = text || '';
    element.hidden = !text;
    element.classList.toggle('is-error', error);
  }

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }

  function chinaDay() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
  }

  function todayEntry() {
    return data?.checkins?.find(entry => entry.day === data.today);
  }

  function syncControls() {
    if (api?.getConfiguration().storageWarning) message('service-notice', '当前浏览器无法保存登录状态，刷新或关闭页面后需要重新登录。');
    $('login-fields').disabled = !ready || authBusy || Boolean(session) || authMode !== 'login';
    $('signup-fields').disabled = !ready || authBusy || Boolean(session) || authMode !== 'signup';
    $('tab-login').disabled = !ready || authBusy;
    $('tab-signup').disabled = !ready || authBusy;
    $('sign-in').textContent = authBusy && authMode === 'login' ? '正在登录…' : '登录';
    $('sign-up').textContent = authBusy && authMode === 'signup' ? '正在注册…' : '注册并登录';
    $('checkin-fields').disabled = !session || !data || loading || mutationBusy || Boolean(todayEntry());
    $('submit-checkin').textContent = mutationBusy ? '正在保存…' : todayEntry() ? '今天已打卡 ✓' : '完成今日打卡 ✓';
    $('refresh-community').disabled = !session || loading || mutationBusy;
    $('refresh-community').textContent = loading ? '正在刷新…' : '刷新记录';
    $('save-profile').disabled = !session || !data || mutationBusy;
    $('sign-out').disabled = authBusy || mutationBusy;
    for (const button of $('history-list').querySelectorAll('button')) button.disabled = mutationBusy || loading;
  }

  function renderCalendar() {
    const today = data?.today || chinaDay();
    const [year, month, day] = today.split('-').map(Number);
    $('today-label').textContent = `${month} 月 ${day} 日 · 练琴日常`;
    $('today-label').dateTime = today;
    $('calendar-month').textContent = `${year} 年 ${month} 月`;
    const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
    const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const checked = new Map((data?.checkins || []).map(entry => [entry.day, entry]));
    const cells = [];
    for (let index = 0; index < first; index++) {
      const blank = element('span');
      blank.setAttribute('aria-hidden', 'true');
      cells.push(blank);
    }
    for (let index = 1; index <= count; index++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(index).padStart(2, '0')}`;
      const entry = checked.get(date);
      const cell = element('span', 'calendar-day', index);
      cell.classList.toggle('is-today', date === today);
      cell.classList.toggle('is-future', date > today);
      cell.classList.toggle('is-checked', Boolean(entry));
      if (date === today) cell.setAttribute('aria-current', 'date');
      cell.title = `${month} 月 ${index} 日${entry ? ` · 已练琴 ${entry.minutes} 分钟` : ''}`;
      cell.setAttribute('aria-label', cell.title);
      cells.push(cell);
    }
    $('calendar-grid').replaceChildren(...cells);
  }

  function renderHistory() {
    const rows = (data?.checkins || []).map(entry => {
      const row = element('li', 'history-item');
      const text = element('p', '', `${entry.day} · ${entry.minutes} 分钟${entry.piece ? ` · ${entry.piece}` : ''}`);
      const button = element('button', 'secondary-action', entry.is_public ? '取消分享' : '分享这次练习');
      button.type = 'button';
      button.dataset.day = entry.day;
      button.dataset.public = String(entry.is_public);
      button.setAttribute('aria-label', `${entry.day} ${entry.is_public ? '取消分享' : '分享这次练习到动态和周榜'}`);
      row.append(text, button);
      return row;
    });
    $('history-list').replaceChildren(...(rows.length ? rows : [element('li', 'empty-copy', session ? '还没有记录，从今天开始吧。' : '登录后查看自己的练习记录。')]));
  }

  function renderCommunity() {
    const feed = (data?.feed || []).map(entry => {
      const row = element('li', 'feed-item');
      const avatar = element('span', 'avatar', Array.from(entry.nickname || '琴')[0]);
      avatar.setAttribute('aria-hidden', 'true');
      const content = element('div', 'feed-content');
      const heading = element('div', 'feed-heading');
      const date = element('time', '', entry.day);
      date.dateTime = entry.day;
      heading.append(element('strong', '', entry.nickname), date);
      content.append(heading, element('p', '', `练琴 ${entry.minutes} 分钟${entry.piece ? ` · ${entry.piece}` : ''}`));
      if (entry.note) content.append(element('p', 'practice-note', entry.note));
      row.append(avatar, content);
      return row;
    });
    $('feed-list').replaceChildren(...(feed.length ? feed : [element('li', 'empty-copy', data ? '还没有琴友分享练习。愿意的话，留下今天的第一声回响。' : session ? '等待载入琴友动态。' : '登录后，看看大家最近在练什么。')]));
    const ranks = (data?.leaderboard || []).map(entry => {
      const row = element('li', 'rank-item');
      const name = element('span', 'rank-name', entry.nickname);
      if (entry.is_self) name.append(element('span', 'self-tag', '我'));
      const days = element('span', 'rank-days', entry.days);
      days.append(element('small', '', '天'));
      row.append(element('span', 'rank-number', String(entry.rank).padStart(2, '0')), name, days, element('span', 'rank-minutes', `${entry.minutes} 分钟`));
      return row;
    });
    $('leaderboard-list').replaceChildren(...(ranks.length ? ranks : [element('li', 'empty-copy', data ? '本周还没有公开打卡。坚持从第一天开始。' : '登录后查看本周坚持榜。')]));
    $('ranking-period').textContent = data?.week_start ? `本周从 ${data.week_start} 开始 · 北京时间 · 每周一重新计榜` : '每周一重新开始，一起积累练习的日子。';
  }

  function render() {
    $('login-panel').hidden = Boolean(session);
    $('account-panel').hidden = !session;
    const nickname = data?.profile?.nickname || '琴友';
    $('account-name').textContent = nickname;
    $('account-avatar').textContent = Array.from(nickname)[0];
    $('account-username').textContent = session?.user?.username ? `用户名：${session.user.username}` : '';
    if (document.activeElement !== $('nickname')) $('nickname').value = data?.profile?.nickname || '';
    $('stat-streak').textContent = data?.stats?.current_streak ?? '—';
    $('stat-days').textContent = data?.stats?.total_days ?? '—';
    $('stat-minutes').textContent = data?.stats?.total_minutes ?? '—';
    const entry = todayEntry();
    $('checkin-hint').textContent = entry ? '今天的努力已经记下，明天再来。' : session ? '弹完后，记录一次完整的练习。' : '登录后，留下一次练习的足迹。';
    message('checkin-result', entry ? `今日已练琴 ${entry.minutes} 分钟${entry.piece ? ` · ${entry.piece}` : ''}。${entry.is_public ? '已分享到琴友动态和周榜。' : '这条记录仅自己可见。'}` : '');
    renderCalendar();
    renderHistory();
    renderCommunity();
    syncControls();
  }

  async function refresh() {
    if (!session) return false;
    const version = ++requestVersion;
    const owner = accountVersion;
    loading = true;
    message('community-message', '正在同步你的记录与琴友动态…');
    syncControls();
    try {
      const dashboard = await api.dashboard();
      if (owner !== accountVersion || version !== requestVersion) return false;
      if (!dashboard || !/^\d{4}-\d{2}-\d{2}$/.test(dashboard.today) || !dashboard.profile || !dashboard.stats || !Array.isArray(dashboard.checkins) || !Array.isArray(dashboard.feed) || !Array.isArray(dashboard.leaderboard)) throw new Error('记录暂时无法读取，请点击“刷新记录”重试。');
      data = dashboard;
      lastRefresh = Date.now();
      message('community-message', '');
      message('checkin-message', '');
      return true;
    } catch (error) {
      if (owner === accountVersion && version === requestVersion) {
        data = null;
        message('community-message', error.message || '同步失败，请点击“刷新记录”重试。', true);
        message('checkin-message', '记录同步失败，暂时不能打卡。请点击页面下方的“刷新记录”重试。', true);
      }
      return false;
    } finally {
      if (owner === accountVersion && version === requestVersion) {
        loading = false;
        render();
      }
    }
  }

  async function acceptSession(next) {
    if (session?.user?.id === next?.user?.id && Boolean(session) === Boolean(next)) {
      session = next;
      return;
    }
    ++accountVersion;
    ++requestVersion;
    session = next;
    data = null;
    authBusy = false;
    loading = false;
    mutationBusy = false;
    $('checkin-form').reset();
    $('profile-form').reset();
    $('history-details').open = false;
    message('community-message', '');
    message('checkin-message', '');
    message('auth-message', '');
    clearPasswords();
    render();
    if (next) await refresh();
  }

  function clearPasswords() {
    for (const id of ['login-password', 'signup-password', 'signup-password-confirm']) $(id).value = '';
  }

  const authTabs = [$('tab-login'), $('tab-signup')];
  function selectAuthMode(mode) {
    if (!ready || authBusy || session) return;
    authMode = mode;
    clearPasswords();
    message('auth-message', '');
    authTabs.forEach((tab, index) => {
      const active = (index === 0 ? 'login' : 'signup') === mode;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !active;
    });
    syncControls();
  }
  authTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectAuthMode(index === 0 ? 'login' : 'signup'));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || authBusy) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      selectAuthMode(next === 0 ? 'login' : 'signup');
      authTabs[next].focus();
    });
  });

  async function authenticate(event, mode) {
    event.preventDefault();
    if (!ready || authBusy || session || authMode !== mode) return;
    const form = $(mode + '-form');
    $(mode + '-username').value = $(mode + '-username').value.trim();
    if (!form.reportValidity()) return;
    const username = $(mode + '-username').value.trim();
    const password = $(mode + '-password').value;
    if (mode === 'signup' && password !== $('signup-password-confirm').value) {
      clearPasswords();
      message('auth-message', '两次输入的密码不一致，请重新确认。', true);
      $('signup-password').focus();
      return;
    }
    if (mode === 'signup' && (!/^[A-Za-z0-9][A-Za-z0-9()!@#$%^&*|?><_-]{7,31}$/.test(password)
      || [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length < 3)) {
      clearPasswords();
      message('auth-message', '密码须为 8–32 位，以字母或数字开头，并包含大写字母、小写字母、数字、允许的符号中的至少 3 种。', true);
      $('signup-password').focus();
      return;
    }
    const owner = accountVersion;
    authBusy = true;
    clearPasswords();
    message('auth-message', mode === 'signup' ? '正在创建账号…' : '正在登录…');
    syncControls();
    try {
      const next = await (mode === 'signup' ? api.signUp(username, password) : api.signIn(username, password));
      if (owner !== accountVersion) return;
      if (!next?.user?.id) throw new Error('尚未取得登录状态，请重新登录。');
      await acceptSession(next);
    } catch (error) {
      if (owner === accountVersion) {
        if (mode === 'signup' && error.code === 'account_created') {
          authBusy = false;
          $('login-username').value = username;
          selectAuthMode('login');
          message('auth-message', '账号已创建，请用该用户名和密码登录。');
          $('login-password').focus();
        } else {
          message('auth-message', error.message || (mode === 'signup' ? '注册未完成，请稍后重试。' : '登录失败，请检查用户名和密码。'), true);
        }
      }
    } finally {
      if (owner === accountVersion) { authBusy = false; syncControls(); }
    }
  }
  $('login-form').addEventListener('submit', event => authenticate(event, 'login'));
  $('signup-form').addEventListener('submit', event => authenticate(event, 'signup'));

  $('sign-out').addEventListener('click', async () => {
    if (authBusy || mutationBusy) return;
    const owner = accountVersion;
    authBusy = true;
    syncControls();
    try {
      await api.signOut();
      if (owner !== accountVersion && session) return;
      await acceptSession(null);
      $('login-form').reset();
      $('signup-form').reset();
      selectAuthMode('login');
      message('auth-message', '已退出登录。');
    } catch (error) { message('auth-message', error.message || '退出失败，请重试。', true); }
    finally { authBusy = false; syncControls(); }
  });

  $('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!session || !data || mutationBusy) return;
    const owner = accountVersion;
    mutationBusy = true;
    syncControls();
    try {
      const profile = await api.updateProfile($('nickname').value.trim());
      if (owner !== accountVersion) return;
      if (data) data.profile = profile;
      message('auth-message', '昵称已保存。');
      await refresh();
    } catch (error) { if (owner === accountVersion) message('auth-message', error.message || '昵称未保存，请重试。', true); }
    finally { if (owner === accountVersion) { mutationBusy = false; render(); } }
  });

  $('checkin-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!session || !data || mutationBusy || loading || todayEntry()) return;
    const minutes = Number($('practice-minutes').value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) return;
    const owner = accountVersion;
    mutationBusy = true;
    syncControls();
    message('community-message', '正在保存今日练习…');
    message('checkin-message', '正在保存今日练习…');
    try {
      const result = await api.checkIn({ minutes, piece: $('practice-piece').value.trim(), note: $('practice-note').value.trim(), isPublic: $('share-public').checked });
      if (owner !== accountVersion) return;
      if (result?.created !== false) window.dispatchEvent(new CustomEvent('paijian:checkin-saved'));
      const synced = await refresh();
      if (owner !== accountVersion) return;
      if (!synced) message('checkin-result', '打卡已保存，但列表刷新失败。点击“刷新记录”查看。');
      else if (result?.created === false) message('community-message', '你今天已经打卡了，已显示之前保存的记录。');
      else message('community-message', '今日打卡已保存，明天继续！');
    } catch (error) {
      if (owner === accountVersion) {
        const detail = error.message || '保存未完成，请检查网络后重试。';
        message('community-message', detail, true);
        message('checkin-message', detail, true);
      }
    } finally { if (owner === accountVersion) { mutationBusy = false; syncControls(); } }
  });

  $('history-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-day]');
    if (!button || !session || mutationBusy || loading) return;
    const owner = accountVersion;
    mutationBusy = true;
    syncControls();
    try {
      await api.setCheckinPublic(button.dataset.day, button.dataset.public !== 'true');
      if (owner !== accountVersion) return;
      const synced = await refresh();
      if (owner !== accountVersion) return;
      message('community-message', synced ? '分享设置已更新。' : '分享设置已保存，列表刷新失败，请重试。', !synced);
    } catch (error) { if (owner === accountVersion) message('community-message', error.message || '设置未保存，请重试。', true); }
    finally { if (owner === accountVersion) { mutationBusy = false; syncControls(); } }
  });

  $('refresh-community').addEventListener('click', () => refresh());
  const tabs = [$('tab-feed'), $('tab-ranking')];
  function selectTab(index) {
    tabs.forEach((tab, current) => {
      tab.setAttribute('aria-selected', String(index === current));
      tab.tabIndex = index === current ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = index !== current;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      selectTab(next);
      tabs[next].focus();
    });
  });

  function refreshIfNeeded() {
    if (!session || loading || mutationBusy || document.hidden) return;
    if (data?.today !== chinaDay() || Date.now() - lastRefresh > 60000) refresh();
  }
  document.addEventListener('visibilitychange', refreshIfNeeded);
  window.addEventListener('focus', refreshIfNeeded);
  window.addEventListener('online', refreshIfNeeded);
  setInterval(refreshIfNeeded, 60000);

  async function start() {
    render();
    if (!api) {
      message('service-notice', '登录组件未能加载，请刷新页面后再试。');
      return;
    }
    const config = api.getConfiguration();
    if (!config.configured) {
      message('service-notice', '练琴打卡正在准备中。账号服务开通后，就能登录、保存记录并与琴友一起打卡。');
      return;
    }
    if (config.storageWarning) message('service-notice', '当前浏览器无法保存登录状态，关闭页面后需要重新登录。');
    api.subscribe(next => { acceptSession(next); });
    try {
      const next = await api.init();
      ready = true;
      await acceptSession(next);
    } catch (error) {
      ready = true;
      message('auth-message', error.message || '登录状态读取失败，请重新登录。', true);
    }
    syncControls();
  }
  start();
})();
