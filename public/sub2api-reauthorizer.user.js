// ==UserScript==
// @name         Sub2API OpenAI Reauthorizer Panel
// @namespace    https://github.com/Piiiiiger/codex-roxy-reauthorizer
// @version      0.1.7
// @description  Inject an OpenAI reauthorization panel into the Sub2API admin UI.
// @match        http://127.0.0.1:8317/*
// @match        http://127.0.0.1:8319/*
// @match        http://localhost:8317/*
// @match        http://localhost:8319/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_BASE_URL = __PLUGIN_BASE_URL__;
  const DEFAULT_BASE_URLS = __PLUGIN_BASE_URLS__;
  const SAME_ORIGIN_BASE_URL = `${window.location.origin}/_reauth_plugin`;
  const DEFAULT_TOKEN = __PLUGIN_ACCESS_TOKEN__;
  const STORAGE_PREFIX = 'sub2apiReauthPlugin.';
  const state = {
    baseUrl: localStorage.getItem(`${STORAGE_PREFIX}baseUrl`) || SAME_ORIGIN_BASE_URL || DEFAULT_BASE_URL,
    token: localStorage.getItem(`${STORAGE_PREFIX}token`) || DEFAULT_TOKEN,
    open: localStorage.getItem(`${STORAGE_PREFIX}open`) === '1',
    activeTab: localStorage.getItem(`${STORAGE_PREFIX}tab`) || 'scan',
    candidates: [],
    selectedIds: new Set(),
    status: null,
    jobs: [],
    activeJob: null,
    logs: [],
    config: null,
    filters: {
      email: '',
      plan: '',
      group: '',
      groupId: '',
      preferGroup: '',
      preferGroupId: '',
    },
    busy: false,
    message: '',
    error: '',
    pollTimer: null,
    bodyScrollTop: 0,
    logScrollTop: 0,
    logFollow: true,
  };

  const css = `
    #s2r-root {
      position: fixed;
      right: 18px;
      top: 92px;
      z-index: 2147483000;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172026;
      font-size: 13px;
    }
    #s2r-root * { box-sizing: border-box; letter-spacing: 0; }
    .s2r-launch {
      width: 42px;
      height: 42px;
      border: 1px solid #b9c4cf;
      border-radius: 8px;
      background: #f8fafc;
      color: #172026;
      box-shadow: 0 12px 32px rgba(15, 23, 42, .18);
      cursor: pointer;
      display: grid;
      place-items: center;
      font-weight: 700;
    }
    .s2r-panel {
      width: min(520px, calc(100vw - 32px));
      height: min(760px, calc(100vh - 112px));
      display: flex;
      flex-direction: column;
      background: #ffffff;
      border: 1px solid #c9d3dd;
      border-radius: 8px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, .22);
      overflow: hidden;
    }
    .s2r-head {
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px 0 16px;
      border-bottom: 1px solid #e1e7ee;
      background: #f7f9fb;
    }
    .s2r-title { font-weight: 700; font-size: 14px; }
    .s2r-head-actions { display: flex; align-items: center; gap: 8px; }
    .s2r-icon-btn, .s2r-btn {
      border: 1px solid #b9c4cf;
      background: #fff;
      color: #172026;
      border-radius: 6px;
      height: 30px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }
    .s2r-icon-btn { width: 30px; font-size: 16px; }
    .s2r-btn { padding: 0 10px; font-size: 12px; font-weight: 600; }
    .s2r-btn.primary { background: #126e82; border-color: #126e82; color: #fff; }
    .s2r-btn.danger { background: #b42318; border-color: #b42318; color: #fff; }
    .s2r-btn:disabled { opacity: .52; cursor: not-allowed; }
    .s2r-status {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid #e1e7ee;
      background: #fbfcfd;
    }
    .s2r-pill {
      min-width: 0;
      border: 1px solid #d9e1e8;
      border-radius: 6px;
      padding: 7px 8px;
      background: #fff;
    }
    .s2r-pill-label { color: #53616f; font-size: 11px; }
    .s2r-pill-value { margin-top: 2px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .s2r-tabs {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border-bottom: 1px solid #e1e7ee;
      background: #fff;
    }
    .s2r-tab {
      height: 38px;
      border: 0;
      border-right: 1px solid #e1e7ee;
      background: #fff;
      color: #53616f;
      cursor: pointer;
      font-weight: 700;
    }
    .s2r-tab.active {
      color: #0f5968;
      box-shadow: inset 0 -2px 0 #0f5968;
    }
    .s2r-body {
      flex: 1;
      overflow: auto;
      padding: 14px;
      background: #f4f7f9;
    }
    .s2r-section {
      background: #fff;
      border: 1px solid #dce4eb;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .s2r-section-title {
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 10px;
      color: #29343d;
    }
    .s2r-section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .s2r-section-head .s2r-section-title { margin-bottom: 0; }
    .s2r-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .s2r-field { min-width: 0; }
    .s2r-check-field {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding-top: 18px;
    }
    .s2r-check-field input { margin: 0; }
    .s2r-label {
      display: block;
      color: #53616f;
      font-size: 11px;
      margin-bottom: 4px;
    }
    .s2r-input, .s2r-select, .s2r-textarea {
      width: 100%;
      border: 1px solid #bac6d1;
      border-radius: 6px;
      background: #fff;
      color: #172026;
      padding: 7px 8px;
      outline: none;
      min-height: 32px;
      font-size: 12px;
    }
    .s2r-textarea { min-height: 66px; resize: vertical; }
    .s2r-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .s2r-message, .s2r-error {
      padding: 9px 10px;
      border-radius: 6px;
      margin-bottom: 10px;
      line-height: 1.4;
    }
    .s2r-message { background: #e8f4f2; border: 1px solid #b8d9d3; color: #174f46; }
    .s2r-error { background: #fff1f0; border: 1px solid #f1b8b4; color: #8f1d15; }
    .s2r-list {
      display: grid;
      gap: 8px;
    }
    .s2r-row {
      display: grid;
      grid-template-columns: 24px 1fr auto;
      gap: 8px;
      align-items: start;
      border: 1px solid #dde5ec;
      border-radius: 8px;
      padding: 9px;
      background: #fff;
    }
    .s2r-row-main { min-width: 0; }
    .s2r-row-title {
      font-weight: 800;
      overflow-wrap: anywhere;
    }
    .s2r-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 5px;
    }
    .s2r-tag {
      min-height: 22px;
      display: inline-flex;
      align-items: center;
      border-radius: 6px;
      border: 1px solid #d6e0e7;
      padding: 2px 6px;
      color: #53616f;
      background: #f8fafc;
      font-size: 11px;
    }
    .s2r-row-error {
      color: #8f1d15;
      margin-top: 6px;
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .s2r-log {
      height: 260px;
      overflow: auto;
      background: #101820;
      color: #d7e2ea;
      border-radius: 8px;
      padding: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .s2r-log .warn { color: #ffd37a; }
    .s2r-log .error { color: #ff9b95; }
    .s2r-empty {
      color: #667684;
      padding: 12px;
      text-align: center;
      border: 1px dashed #cbd6df;
      border-radius: 8px;
      background: #fff;
    }
    @media (max-width: 640px) {
      #s2r-root { right: 8px; top: 64px; }
      .s2r-panel { width: calc(100vw - 16px); height: calc(100vh - 80px); }
      .s2r-grid, .s2r-status { grid-template-columns: 1fr; }
      .s2r-row { grid-template-columns: 24px 1fr; }
      .s2r-row > .s2r-btn { grid-column: 2; justify-self: start; }
    }
  `;

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    });
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function isScrolledToBottom(node) {
    if (!node) return true;
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 16;
  }

  function captureScrollState() {
    const body = document.querySelector('#s2r-root .s2r-body');
    if (body) state.bodyScrollTop = body.scrollTop;

    const log = document.querySelector('#s2r-root .s2r-log');
    if (log) {
      state.logScrollTop = log.scrollTop;
      state.logFollow = isScrolledToBottom(log);
    }
  }

  function restoreScrollState() {
    if (!state.open) return;
    requestAnimationFrame(() => {
      const body = document.querySelector('#s2r-root .s2r-body');
      if (body) body.scrollTop = state.bodyScrollTop;

      const log = document.querySelector('#s2r-root .s2r-log');
      if (!log) return;
      if (state.logFollow) {
        log.scrollTop = log.scrollHeight;
      } else {
        log.scrollTop = Math.min(state.logScrollTop, log.scrollHeight);
      }
    });
  }

  function rememberBodyScroll(event) {
    state.bodyScrollTop = event.currentTarget.scrollTop;
  }

  function rememberLogScroll(event) {
    const node = event.currentTarget;
    state.logScrollTop = node.scrollTop;
    state.logFollow = isScrolledToBottom(node);
  }

  function scrollLogToBottom() {
    state.logFollow = true;
    const log = document.querySelector('#s2r-root .s2r-log');
    if (log) {
      log.scrollTop = log.scrollHeight;
      state.logScrollTop = log.scrollTop;
    }
  }

  function setBusy(value) {
    state.busy = value;
    render();
  }

  function setMessage(message, error = '') {
    state.message = message || '';
    state.error = error || '';
    render();
  }

  function saveUiSettings() {
    localStorage.setItem(`${STORAGE_PREFIX}baseUrl`, state.baseUrl);
    localStorage.setItem(`${STORAGE_PREFIX}token`, state.token);
    localStorage.setItem(`${STORAGE_PREFIX}open`, state.open ? '1' : '0');
    localStorage.setItem(`${STORAGE_PREFIX}tab`, state.activeTab);
  }

  function apiUrl(path) {
    return `${state.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  function apiUrls(path) {
    const configuredBases = Array.isArray(DEFAULT_BASE_URLS) && DEFAULT_BASE_URLS.length
      ? DEFAULT_BASE_URLS
      : [DEFAULT_BASE_URL];
    const mirrorLocalHosts = (base) => {
      const value = String(base || '');
      return [
        value,
        value.includes('127.0.0.1') ? value.replace('127.0.0.1', 'localhost') : '',
        value.includes('localhost') ? value.replace('localhost', '127.0.0.1') : '',
      ];
    };
    const bases = [
      SAME_ORIGIN_BASE_URL,
      state.baseUrl,
      ...configuredBases,
      ...mirrorLocalHosts(state.baseUrl),
      ...configuredBases.flatMap(mirrorLocalHosts),
    ]
      .map((base) => String(base || '').replace(/\/+$/, ''))
      .filter(Boolean);
    return Array.from(new Set(bases)).map((base) => ({ base, url: `${base}${path}` }));
  }

  function xhrRequest(requestFn, request) {
    return new Promise((resolve, reject) => {
      requestFn({
        ...request,
        responseType: 'json',
        onload: (response) => {
          const payload = response.response || tryParseJson(response.responseText);
          if (response.status >= 200 && response.status < 300) resolve(payload);
          else {
            const error = new Error(payload?.error || `HTTP ${response.status}`);
            error.httpStatus = response.status;
            reject(error);
          }
        },
        onerror: () => reject(new Error('插件服务连接失败')),
        ontimeout: () => reject(new Error('插件服务请求超时')),
      });
    });
  }

  async function apiRequest(path, options = {}) {
    const method = options.method || 'GET';
    const headers = {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    };
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const requestFn = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest.bind(GM) : null);
    let lastError = null;

    for (const candidate of apiUrls(path)) {
      try {
        const payload = requestFn
          ? await xhrRequest(requestFn, {
            method,
            url: candidate.url,
            headers,
            data: body,
            timeout: options.timeout || 60000,
          })
          : await fetch(candidate.url, { method, headers, body }).then(async (response) => {
            const text = await response.text();
            const payload = tryParseJson(text);
            if (!response.ok) {
              const error = new Error(payload?.error || `HTTP ${response.status}`);
              error.httpStatus = response.status;
              throw error;
            }
            return payload;
          });
        if (candidate.base !== state.baseUrl.replace(/\/+$/, '')) {
          state.baseUrl = candidate.base;
          localStorage.setItem(`${STORAGE_PREFIX}baseUrl`, state.baseUrl);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (error?.httpStatus) throw error;
      }
    }

    throw new Error(`${lastError?.message || '插件服务连接失败'}。已尝试 127.0.0.1 和 localhost，请确认脚本管理器已更新到最新版 userscript。`);
  }

  function tryParseJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function inputValue(name) {
    const node = document.querySelector(`#s2r-root [name="${name}"]`);
    return node ? node.value.trim() : '';
  }

  function rememberFiltersFromInputs() {
    for (const key of Object.keys(state.filters)) {
      state.filters[key] = inputValue(`filter.${key}`);
    }
  }

  function checkedIds() {
    return Array.from(state.selectedIds).filter(Boolean);
  }

  function isJobRunning(job) {
    return job && ['queued', 'running'].includes(String(job.status || ''));
  }

  async function refreshStatus(silent = false) {
    try {
      const data = await apiRequest('/api/status');
      state.status = data.status || null;
      state.jobs = data.jobs || [];
      state.activeJob = data.activeJob || null;
      if (!silent) setMessage('状态已刷新');
      render();
    } catch (error) {
      if (!silent) setMessage('', error.message);
    }
  }

  async function loadConfig() {
    setBusy(true);
    try {
      const data = await apiRequest('/api/config');
      state.config = data.config || {};
      state.status = data.status || state.status;
      setMessage('配置已加载');
    } catch (error) {
      setMessage('', error.message);
    } finally {
      setBusy(false);
    }
  }

  function collectConfigPayload() {
    const payload = {};
    document.querySelectorAll('#s2r-root [data-config-key]').forEach((node) => {
      const key = node.getAttribute('data-config-key');
      if (!key) return;
      if (node.type === 'checkbox') payload[key] = node.checked;
      else payload[key] = node.value;
    });
    return payload;
  }

  async function saveConfig() {
    const payload = collectConfigPayload();
    setBusy(true);
    try {
      const data = await apiRequest('/api/config', { method: 'POST', body: payload });
      if (payload.pluginAccessToken) {
        state.token = payload.pluginAccessToken;
        localStorage.setItem(`${STORAGE_PREFIX}token`, state.token);
      }
      state.config = data.config || {};
      state.status = data.status || state.status;
      setMessage('配置已保存');
    } catch (error) {
      setMessage('', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function scanCandidates() {
    rememberFiltersFromInputs();
    setBusy(true);
    try {
      const params = new URLSearchParams();
      for (const key of ['email', 'plan', 'group', 'groupId', 'preferGroup', 'preferGroupId']) {
        const value = state.filters[key];
        if (value) params.set(key, value);
      }
      const suffix = params.toString() ? `?${params}` : '';
      const data = await apiRequest(`/api/candidates${suffix}`);
      state.candidates = data.candidates || [];
      state.selectedIds = new Set();
      setMessage(`扫描完成：${state.candidates.length} 个`);
    } catch (error) {
      setMessage('', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function startJob(payload) {
    setBusy(true);
    try {
      const data = await apiRequest('/api/jobs', {
        method: 'POST',
        body: {
          type: 'reauthorize',
          ...payload,
        },
      });
      state.activeTab = 'jobs';
      state.activeJob = data.job || null;
      setMessage(`任务已创建：${state.activeJob?.id || ''}`);
      startPolling();
    } catch (error) {
      setMessage('', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob(id) {
    if (!id) return;
    setBusy(true);
    try {
      const data = await apiRequest(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: { reason: '用户停止任务' },
      });
      state.activeJob = data.job || state.activeJob;
      setMessage(`已发送停止请求：#${id}`);
      startPolling();
    } catch (error) {
      setMessage('', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshJobs(silent = false) {
    try {
      const data = await apiRequest('/api/jobs');
      state.jobs = data.jobs || [];
      state.activeJob = data.activeJob || null;
      if (!silent) setMessage('任务已刷新');
      render();
    } catch (error) {
      if (!silent) setMessage('', error.message);
    }
  }

  async function loadLogs() {
    setBusy(true);
    try {
      const data = await apiRequest('/api/logs?limit=80');
      state.logs = data.entries || [];
      setMessage(`日志已加载：${state.logs.length} 条`);
    } catch (error) {
      setMessage('', error.message);
    } finally {
      setBusy(false);
    }
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(async () => {
      if (!state.open) return;
      await refreshJobs(true);
      if (!state.activeJob) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    }, 2000);
  }

  function statusPills() {
    const status = state.status || {};
    return el('div', { class: 's2r-status' }, [
      pill('插件服务', status.canScan ? '已连接' : '待配置'),
      pill('重授权', status.canReauthorize ? '可用' : '待配置'),
      pill('Sub2API', status.sub2apiBaseUrl || state.baseUrl),
      pill('运行任务', state.activeJob ? `${state.activeJob.status} #${state.activeJob.id}` : '无'),
    ]);
  }

  function pill(label, value) {
    return el('div', { class: 's2r-pill' }, [
      el('div', { class: 's2r-pill-label', text: label }),
      el('div', { class: 's2r-pill-value', title: value || '', text: value || '-' }),
    ]);
  }

  function tabButton(id, text) {
    return el('button', {
      class: `s2r-tab ${state.activeTab === id ? 'active' : ''}`,
      text,
      onclick: () => {
        state.activeTab = id;
        saveUiSettings();
        if (id === 'config' && !state.config) loadConfig();
        if (id === 'logs' && !state.logs.length) loadLogs();
        render();
      },
    });
  }

  function filterSection() {
    return el('div', { class: 's2r-section' }, [
      el('div', { class: 's2r-section-title', text: '筛选' }),
      el('div', { class: 's2r-grid' }, [
        field('邮箱', 'filter.email', state.filters.email),
        selectField('套餐', 'filter.plan', [
          ['', '全部'],
          ['plus', 'Plus'],
          ['free', 'Free'],
        ], state.filters.plan),
        field('分组名称', 'filter.group', state.filters.group),
        field('分组 ID', 'filter.groupId', state.filters.groupId),
        field('优先分组', 'filter.preferGroup', state.filters.preferGroup),
        field('优先分组 ID', 'filter.preferGroupId', state.filters.preferGroupId),
      ]),
      el('div', { class: 's2r-actions' }, [
        button('扫描候选', scanCandidates, true),
        button('刷新状态', () => refreshStatus(false)),
        button('按筛选批量处理', () => startJob({ filters: collectFilters() }), true, 'primary'),
      ]),
    ]);
  }

  function collectFilters() {
    rememberFiltersFromInputs();
    const filters = {};
    for (const key of ['email', 'plan', 'group', 'groupId', 'preferGroup', 'preferGroupId']) {
      const value = state.filters[key];
      if (value) filters[key] = value;
    }
    return filters;
  }

  function candidateList() {
    const actions = el('div', { class: 's2r-actions' }, [
      button('全选', () => {
        state.selectedIds = new Set(state.candidates.map((item) => String(item.id)));
        render();
      }),
      button('清空', () => {
        state.selectedIds = new Set();
        render();
      }),
      button(`处理选中 ${checkedIds().length}`, () => startJob({ accountIds: checkedIds() }), checkedIds().length > 0, 'primary'),
    ]);
    const rows = state.candidates.length
      ? state.candidates.map(candidateRow)
      : [el('div', { class: 's2r-empty', text: '暂无候选账号' })];
    return el('div', { class: 's2r-section' }, [
      el('div', { class: 's2r-section-title', text: `候选账号 ${state.candidates.length}` }),
      actions,
      el('div', { class: 's2r-list' }, rows),
    ]);
  }

  function candidateRow(account) {
    const id = String(account.id);
    const checkbox = el('input', {
      type: 'checkbox',
      checked: state.selectedIds.has(id) ? 'checked' : null,
      onchange: (event) => {
        if (event.target.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        render();
      },
    });
    return el('div', { class: 's2r-row' }, [
      checkbox,
      el('div', { class: 's2r-row-main' }, [
        el('div', { class: 's2r-row-title', text: `#${account.id} ${account.email || account.name || ''}` }),
        el('div', { class: 's2r-meta' }, [
          tag(account.plan || '未知套餐'),
          tag(account.status || '未知状态'),
          tag(account.groups?.join('|') || '无分组'),
          tag(account.proxyId ? `代理 ${account.proxyId}` : '无代理'),
        ]),
        account.errorMessage ? el('div', { class: 's2r-row-error', text: account.errorMessage }) : null,
      ]),
      button('处理', () => startJob({ accountIds: [id] }), true, 'primary'),
    ]);
  }

  function tag(text) {
    return el('span', { class: 's2r-tag', text });
  }

  function scanView() {
    return [filterSection(), candidateList()];
  }

  function jobsView() {
    const job = state.activeJob || state.jobs[0] || null;
    const logs = job?.logs || [];
    return [
      el('div', { class: 's2r-section' }, [
        el('div', { class: 's2r-section-title', text: '任务' }),
        job ? el('div', { class: 's2r-grid' }, [
          pill('编号', `#${job.id}`),
          pill('状态', job.status),
          pill('进度', `${job.progress?.current || 0}/${job.progress?.total || 0}`),
          pill('结果', job.summary ? `成功 ${job.summary.success} / 失败 ${job.summary.failed} / 跳过 ${job.summary.skipped}` : '-'),
        ]) : el('div', { class: 's2r-empty', text: '暂无任务' }),
        el('div', { class: 's2r-actions' }, [
          button('刷新任务', () => refreshJobs(false)),
          button('刷新日志', loadLogs),
          job ? button('停止任务', () => cancelJob(job.id), isJobRunning(job), 'danger') : null,
        ]),
      ]),
      el('div', { class: 's2r-section' }, [
        el('div', { class: 's2r-section-head' }, [
          el('div', { class: 's2r-section-title', text: '输出' }),
          button('到底部', scrollLogToBottom),
        ]),
        logBox(logs),
      ]),
      job?.results?.length ? el('div', { class: 's2r-section' }, [
        el('div', { class: 's2r-section-title', text: '结果' }),
        el('div', { class: 's2r-list' }, job.results.map((item) => resultRow(item))),
      ]) : null,
    ];
  }

  function resultRow(item) {
    return el('div', { class: 's2r-row' }, [
      tag(item.status),
      el('div', { class: 's2r-row-main' }, [
        el('div', { class: 's2r-row-title', text: `#${item.account?.id || ''} ${item.account?.email || ''}` }),
        item.error ? el('div', { class: 's2r-row-error', text: item.error }) : null,
      ]),
      tag(item.mode || item.reason || ''),
    ]);
  }

  function logBox(logs) {
    const content = logs.length
      ? logs.map((line) => `[${line.time || ''}] ${line.level || 'info'} ${line.message || ''}`).join('\n')
      : '暂无输出';
    return el('div', { class: 's2r-log', text: content, onscroll: rememberLogScroll });
  }

  function logsView() {
    return [
      el('div', { class: 's2r-section' }, [
        el('div', { class: 's2r-section-title', text: '历史' }),
        el('div', { class: 's2r-actions' }, [button('刷新历史', loadLogs)]),
        state.logs.length
          ? el('div', { class: 's2r-list' }, state.logs.map((item) => historyRow(item)))
          : el('div', { class: 's2r-empty', text: '暂无历史日志' }),
      ]),
    ];
  }

  function historyRow(item) {
    return el('div', { class: 's2r-row' }, [
      tag(item.result || 'log'),
      el('div', { class: 's2r-row-main' }, [
        el('div', { class: 's2r-row-title', text: `#${item.accountId || ''} ${item.email || ''}` }),
        el('div', { class: 's2r-meta' }, [
          tag(item.planType || '未知套餐'),
          tag(item.authMode || '未知模式'),
          tag(item.finishedAt || item.startedAt || ''),
        ]),
        item.error ? el('div', { class: 's2r-row-error', text: item.error }) : null,
      ]),
      tag(item.groupNames?.join('|') || ''),
    ]);
  }

  function configValue(key) {
    const item = state.config?.[key];
    if (!item) return '';
    if (typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'value')) {
      const value = item.value;
      return Array.isArray(value) ? value.join(',') : String(value ?? '');
    }
    return String(item ?? '');
  }

  function configBool(key) {
    const value = configValue(key).toLowerCase();
    return value === 'true' || value === '1' || value === 'yes' || value === 'on';
  }

  function secretConfigured(key) {
    return Boolean(state.config?.[key]?.configured);
  }

  function configView() {
    return [
      el('div', { class: 's2r-section' }, [
        el('div', { class: 's2r-section-title', text: '插件连接' }),
        el('div', { class: 's2r-grid' }, [
          field('服务地址', 'plugin.baseUrl', state.baseUrl),
          field('访问 Token', 'plugin.token', state.token, 'password'),
        ]),
        el('div', { class: 's2r-actions' }, [
          button('保存连接', () => {
            state.baseUrl = inputValue('plugin.baseUrl') || DEFAULT_BASE_URL;
            state.token = inputValue('plugin.token');
            saveUiSettings();
            refreshStatus(false);
          }),
          button('加载配置', loadConfig),
        ]),
      ]),
      el('div', { class: 's2r-section' }, [
        el('div', { class: 's2r-section-title', text: '服务配置' }),
        configGrid(),
        el('div', { class: 's2r-actions' }, [
          button('保存配置', saveConfig, true, 'primary'),
        ]),
      ]),
    ];
  }

  function configGrid() {
    if (!state.config) return el('div', { class: 's2r-empty', text: '配置未加载' });
    return el('div', { class: 's2r-grid' }, [
      configField('Sub2API 地址', 'sub2apiBaseUrl'),
      configField('管理员邮箱', 'sub2apiAdminEmail'),
      configField(secretConfigured('sub2apiAdminPassword') ? '管理员密码 已设置' : '管理员密码', 'sub2apiAdminPassword', 'password'),
      configField('邮箱服务地址', 'mailBaseUrl'),
      configField(secretConfigured('mailAdminPassword') ? '邮箱管理密码 已设置' : '邮箱管理密码', 'mailAdminPassword', 'password'),
      configField(secretConfigured('mailSitePassword') ? '邮箱站点密码 已设置' : '邮箱站点密码', 'mailSitePassword', 'password'),
      configField('邮箱域名', 'mailDomain'),
      configField('OAuth 回调', 'oauthRedirectUri'),
      configSelectField('授权浏览器', 'browserEngine', [
        ['camoufox', 'Camoufox 隐私浏览器'],
        ['chrome', 'Chrome/Puppeteer'],
      ]),
      configCheckboxField('Camoufox 失败回退 Chrome', 'browserEngineFallbackToChrome'),
      configField('浏览器路径', 'chromePath'),
      configField('浏览器资料目录', 'browserUserDataDir'),
      configField(secretConfigured('browserProxyUrl') ? '浏览器授权代理 已设置，支持 {sid}' : '浏览器授权代理，支持 {sid}', 'browserProxyUrl', 'password'),
      configField('链式代理第一跳', 'browserProxyChainFirst'),
      configField('链式代理程序', 'browserProxyChainBinary'),
      configField('链式代理监听地址', 'browserProxyChainListenHost'),
      configField('链式代理启动超时 ms', 'browserProxyChainStartupTimeoutMs'),
      configField('OAuth 最大重启次数', 'browserOAuthMaxRestarts'),
      configField('输出目录', 'tokenOutputDirs'),
      configField(secretConfigured('pluginAccessToken') ? '插件 Token 已设置' : '插件 Token', 'pluginAccessToken', 'password'),
      configField('允许页面 Origin', 'pluginAllowedOrigins'),
    ]);
  }

  function configField(label, key, type = 'text') {
    return el('label', { class: 's2r-field' }, [
      el('span', { class: 's2r-label', text: label }),
      el('input', {
        class: 's2r-input',
        type,
        'data-config-key': key,
        value: type === 'password' ? '' : configValue(key),
      }),
    ]);
  }

  function configSelectField(label, key, options) {
    const selected = configValue(key);
    return el('label', { class: 's2r-field' }, [
      el('span', { class: 's2r-label', text: label }),
      el('select', { class: 's2r-select', 'data-config-key': key }, options.map(([value, text]) => el('option', {
        value,
        text,
        selected: String(value) === String(selected) ? 'selected' : null,
      }))),
    ]);
  }

  function configCheckboxField(label, key) {
    return el('label', { class: 's2r-check-field' }, [
      el('input', {
        type: 'checkbox',
        'data-config-key': key,
        checked: configBool(key) ? 'checked' : null,
      }),
      el('span', { text: label }),
    ]);
  }

  function field(label, name, value = '', type = 'text') {
    return el('label', { class: 's2r-field' }, [
      el('span', { class: 's2r-label', text: label }),
      el('input', {
        class: 's2r-input',
        type,
        name,
        value,
        oninput: () => {
          if (name.startsWith('filter.')) {
            state.filters[name.slice('filter.'.length)] = inputValue(name);
          }
        },
      }),
    ]);
  }

  function selectField(label, name, options, selected = '') {
    return el('label', { class: 's2r-field' }, [
      el('span', { class: 's2r-label', text: label }),
      el('select', {
        class: 's2r-select',
        name,
        onchange: () => {
          if (name.startsWith('filter.')) {
            state.filters[name.slice('filter.'.length)] = inputValue(name);
          }
        },
      }, options.map(([value, text]) => el('option', {
        value,
        text,
        selected: String(value) === String(selected) ? 'selected' : null,
      }))),
    ]);
  }

  function button(text, onclick, enabled = true, tone = '') {
    return el('button', {
      class: `s2r-btn ${tone}`,
      text,
      disabled: (!enabled || state.busy) ? 'disabled' : null,
      onclick,
    });
  }

  function messageNodes() {
    return [
      state.error ? el('div', { class: 's2r-error', text: state.error }) : null,
      state.message ? el('div', { class: 's2r-message', text: state.message }) : null,
    ];
  }

  function bodyContent() {
    if (state.activeTab === 'jobs') return jobsView();
    if (state.activeTab === 'config') return configView();
    if (state.activeTab === 'logs') return logsView();
    return scanView();
  }

  function renderPanel() {
    return el('div', { class: 's2r-panel' }, [
      el('div', { class: 's2r-head' }, [
        el('div', { class: 's2r-title', text: 'OpenAI 重授权' }),
        el('div', { class: 's2r-head-actions' }, [
          el('button', { class: 's2r-icon-btn', title: '刷新', text: '↻', onclick: () => refreshStatus(false) }),
          el('button', {
            class: 's2r-icon-btn',
            title: '收起',
            text: '×',
            onclick: () => {
              state.open = false;
              saveUiSettings();
              render();
            },
          }),
        ]),
      ]),
      statusPills(),
      el('div', { class: 's2r-tabs' }, [
        tabButton('scan', '扫描'),
        tabButton('jobs', '任务'),
        tabButton('config', '配置'),
        tabButton('logs', '日志'),
      ]),
      el('div', { class: 's2r-body', onscroll: rememberBodyScroll }, [
        ...messageNodes(),
        ...bodyContent(),
      ]),
    ]);
  }

  function render() {
    let root = document.getElementById('s2r-root');
    if (!root) {
      root = el('div', { id: 's2r-root' });
      document.body.appendChild(root);
    }
    captureScrollState();
    root.innerHTML = '';
    root.appendChild(state.open
      ? renderPanel()
      : el('button', {
        class: 's2r-launch',
        title: 'OpenAI 重授权',
        text: '重',
        onclick: () => {
          state.open = true;
          saveUiSettings();
          refreshStatus(true);
          render();
        },
      }));
    restoreScrollState();
  }

  function installStyle() {
    if (document.getElementById('s2r-style')) return;
    document.head.appendChild(el('style', { id: 's2r-style', text: css }));
  }

  function init() {
    installStyle();
    render();
    refreshStatus(true);
    if (state.open) startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
