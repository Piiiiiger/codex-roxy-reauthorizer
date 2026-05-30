const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const util = require('util');
const { URL } = require('url');
const { loadConfig } = require('./config');
const { Sub2ApiClient } = require('./sub2apiClient');
const { MailProvider } = require('./mailProvider');
const {
  findCandidates,
  reauthorizeAccount,
  getEmail,
  getPlanType,
  getGroupNames,
  isOpenAiOauthAccount,
} = require('./cli');
const { TaskCancelledError, isCancelError, throwIfAborted } = require('./cancel');

const SECRET_KEYS = new Set([
  'sub2apiAdminPassword',
  'sub2apiTurnstileToken',
  'mailAdminPassword',
  'mailSitePassword',
  'browserProxyUrl',
  'pluginAccessToken',
]);

const CONFIG_KEYS = new Set([
  'sub2apiBaseUrl',
  'sub2apiAdminEmail',
  'sub2apiAdminPassword',
  'sub2apiTurnstileToken',
  'mailBaseUrl',
  'mailAdminPassword',
  'mailSitePassword',
  'mailDomain',
  'mailTimeoutMs',
  'oauthRedirectUri',
  'tokenOutputDirs',
  'tokenFilenameMode',
  'reauthLogFile',
  'browserWindowWidth',
  'browserWindowHeight',
  'browserWindowStartX',
  'browserWindowStartY',
  'browserEngine',
  'browserEngineFallbackToChrome',
  'browserUserDataDir',
  'browserProxyUrl',
  'browserProxyChainFirst',
  'browserProxyChainBinary',
  'browserProxyChainListenHost',
  'browserProxyChainStartupTimeoutMs',
  'browserOAuthMaxRestarts',
  'useChrome',
  'chromePath',
  'useEdge',
  'edgePath',
  'candidateErrorKeywords',
  'preferredGroupNames',
  'preferredGroupIds',
  'pluginHost',
  'pluginPort',
  'pluginAccessToken',
  'pluginAllowedOrigins',
]);

const ARRAY_KEYS = new Set([
  'tokenOutputDirs',
  'candidateErrorKeywords',
  'preferredGroupNames',
  'preferredGroupIds',
  'pluginAllowedOrigins',
]);

const NUMBER_KEYS = new Set([
  'mailTimeoutMs',
  'browserWindowWidth',
  'browserWindowHeight',
  'browserWindowStartX',
  'browserWindowStartY',
  'pluginPort',
  'browserProxyChainStartupTimeoutMs',
  'browserOAuthMaxRestarts',
]);

const BOOLEAN_KEYS = new Set(['browserEngineFallbackToChrome', 'useChrome', 'useEdge']);

const jobs = new Map();
const recentJobIds = [];
let activeJobId = null;
let nextJobId = 1;

function getConfigPath() {
  return path.join(process.cwd(), 'config.json');
}

function readRawConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件解析失败：${error.message}`);
  }
}

function writeRawConfig(config) {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  fs.chmodSync(configPath, 0o600);
  return configPath;
}

function loadCurrentConfig() {
  return loadConfig();
}

function getLanIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function buildPluginBaseUrls(config) {
  const port = config.pluginPort || 8765;
  const host = String(config.pluginHost || '127.0.0.1');
  const hosts = [
    ...(host === '0.0.0.0' || host === '::' ? getLanIPv4Addresses() : [host]),
    '127.0.0.1',
    'localhost',
  ];
  return Array.from(new Set(hosts.filter(Boolean))).map((item) => `http://${item}:${port}`);
}

function sanitizeConfig(config) {
  const result = {};
  for (const key of CONFIG_KEYS) {
    if (SECRET_KEYS.has(key)) {
      result[key] = {
        configured: Boolean(config[key]),
        value: '',
      };
      continue;
    }
    result[key] = {
      configured: config[key] !== undefined && config[key] !== null && String(config[key]).length > 0,
      value: config[key],
    };
  }
  return result;
}

function normalizeConfigValue(key, value) {
  if (ARRAY_KEYS.has(key)) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    if (typeof value === 'string') {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }
  if (NUMBER_KEYS.has(key)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (BOOLEAN_KEYS.has(key)) {
    return value === true || value === 'true' || value === '1' || value === 1;
  }
  return String(value ?? '');
}

function updateConfigFromPayload(payload) {
  const raw = readRawConfig();
  const next = { ...raw };
  for (const [key, value] of Object.entries(payload || {})) {
    if (!CONFIG_KEYS.has(key)) continue;
    if (SECRET_KEYS.has(key) && (value === '' || value === null || value === undefined)) continue;
    next[key] = normalizeConfigValue(key, value);
  }
  const configPath = writeRawConfig(next);
  return { configPath, config: loadCurrentConfig() };
}

function buildConfigStatus(config) {
  const isTokenMailbox = /\/token(?:[/?#]|$)/.test(String(config.mailBaseUrl || ''));
  const hasMailboxAuth = Boolean(config.mailAdminPassword || isTokenMailbox);

  return {
    configPath: getConfigPath(),
    sub2apiBaseUrl: config.sub2apiBaseUrl,
    mailBaseUrl: config.mailBaseUrl,
    mailSourceType: isTokenMailbox ? 'token-page' : 'mail-api',
    oauthRedirectUri: config.oauthRedirectUri,
    reauthLogFile: config.reauthLogFile,
    tokenOutputDirs: config.tokenOutputDirs,
    browserEngine: config.browserEngine,
    browserEngineFallbackToChrome: config.browserEngineFallbackToChrome,
    browserUserDataDir: config.browserUserDataDir,
    pluginHost: config.pluginHost,
    pluginPort: config.pluginPort,
    hasSub2apiAdminEmail: Boolean(config.sub2apiAdminEmail),
    hasSub2apiAdminPassword: Boolean(config.sub2apiAdminPassword),
    hasMailAdminPassword: Boolean(config.mailAdminPassword),
    hasBrowserProxyUrl: Boolean(config.browserProxyUrl),
    hasBrowserProxyChain: Boolean(config.browserProxyChainFirst),
    hasPluginAccessToken: Boolean(config.pluginAccessToken),
    canScan: Boolean(config.sub2apiBaseUrl && config.sub2apiAdminEmail && config.sub2apiAdminPassword),
    canReauthorize: Boolean(
      config.sub2apiBaseUrl
      && config.sub2apiAdminEmail
      && config.sub2apiAdminPassword
      && config.mailBaseUrl
      && hasMailboxAuth
    ),
  };
}

function buildClient(config, signal = null) {
  return new Sub2ApiClient({
    baseUrl: config.sub2apiBaseUrl,
    adminEmail: config.sub2apiAdminEmail,
    adminPassword: config.sub2apiAdminPassword,
    turnstileToken: config.sub2apiTurnstileToken,
    signal,
  });
}

function buildMailProvider(config, signal = null) {
  return new MailProvider({
    baseUrl: config.mailBaseUrl,
    adminPassword: config.mailAdminPassword,
    sitePassword: config.mailSitePassword,
    domain: config.mailDomain,
    timeoutMs: config.mailTimeoutMs,
    signal,
  });
}

function parseFilters(input = {}) {
  const filters = {};
  for (const key of ['accountId', 'email', 'plan', 'group', 'groupId', 'preferGroup', 'preferGroupId']) {
    const value = input[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      filters[key] = String(value).trim();
    }
  }
  return filters;
}

function accountSummary(account) {
  return {
    id: account?.id,
    name: account?.name || '',
    email: getEmail(account),
    plan: getPlanType(account) || '',
    groups: getGroupNames(account),
    groupIds: Array.isArray(account?.group_ids) ? account.group_ids : [],
    platform: account?.platform || '',
    type: account?.type || '',
    status: account?.status || '',
    errorMessage: account?.error_message || account?.temp_unschedulable_reason || '',
    proxyId: account?.proxy_id || null,
  };
}

function readLogEntries(config, limit = 50) {
  const filePath = path.isAbsolute(config.reauthLogFile)
    ? config.reauthLogFile
    : path.join(process.cwd(), config.reauthLogFile);
  if (!fs.existsSync(filePath)) return { filePath, entries: [] };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return {
    filePath,
    entries: entries.slice(Math.max(0, entries.length - limit)).reverse(),
  };
}

function jsonHeaders(origin = '') {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Reauth-Token',
    'Access-Control-Max-Age': '600',
  };
}

function sendJson(res, statusCode, payload, origin = '') {
  res.writeHead(statusCode, jsonHeaders(origin));
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', origin = '') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Reauth-Token',
  });
  res.end(text);
}

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isOriginAllowed(origin, config) {
  if (isLocalOrigin(origin)) return true;
  const allowed = Array.isArray(config.pluginAllowedOrigins) ? config.pluginAllowedOrigins : [];
  return allowed.some((item) => String(item || '').replace(/\/+$/, '') === String(origin || '').replace(/\/+$/, ''));
}

function getBearerToken(req, url) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const headerToken = String(req.headers['x-reauth-token'] || '').trim();
  if (headerToken) return headerToken;
  return url.searchParams.get('token') || '';
}

function requireAuth(req, res, url, config, origin) {
  if (!config.pluginAccessToken) return true;
  const token = getBearerToken(req, url);
  if (token && token === config.pluginAccessToken) return true;
  sendJson(res, 401, { ok: false, error: '插件服务访问 token 不正确' }, origin);
  return false;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function appendJobLog(job, level, args) {
  const message = args.map((item) => {
    if (typeof item === 'string') return item;
    return util.inspect(item, { depth: 3, breakLength: 120 });
  }).join(' ');
  job.logs.push({
    time: new Date().toISOString(),
    level,
    message,
  });
  if (job.logs.length > 1000) job.logs.splice(0, job.logs.length - 1000);
}

async function withJobConsole(job, fn) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => {
    appendJobLog(job, 'info', args);
    original.log(...args);
  };
  console.warn = (...args) => {
    appendJobLog(job, 'warn', args);
    original.warn(...args);
  };
  console.error = (...args) => {
    appendJobLog(job, 'error', args);
    original.error(...args);
  };
  try {
    return await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function compactJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    cancelRequested: Boolean(job.cancelRequested),
    cancelReason: job.cancelReason || '',
    progress: job.progress,
    summary: job.summary,
    logs: job.logs.slice(-300),
    results: job.results,
  };
}

function listJobs() {
  return recentJobIds
    .map((id) => jobs.get(id))
    .filter(Boolean)
    .map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      cancelRequested: Boolean(job.cancelRequested),
      cancelReason: job.cancelReason || '',
      progress: job.progress,
      summary: job.summary,
    }));
}

function createJob(type, payload) {
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active && ['queued', 'running'].includes(active.status)) {
      const error = new Error(`已有任务正在运行：${active.id}`);
      error.statusCode = 409;
      throw error;
    }
  }

  const id = String(nextJobId++);
  const abortController = new AbortController();
  const job = {
    id,
    type,
    payload,
    abortController,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
    error: '',
    progress: { current: 0, total: 0, label: '' },
    summary: null,
    cancelRequested: false,
    cancelReason: '',
    logs: [],
    results: [],
  };
  jobs.set(id, job);
  recentJobIds.unshift(id);
  if (recentJobIds.length > 20) {
    const removed = recentJobIds.pop();
    if (removed && removed !== activeJobId) jobs.delete(removed);
  }
  activeJobId = id;
  setImmediate(() => runJob(job).catch(() => {}));
  return job;
}

function cancelJob(jobId, reason = '用户停止任务') {
  const job = jobs.get(String(jobId));
  if (!job) {
    const error = new Error('任务不存在');
    error.statusCode = 404;
    throw error;
  }

  if (!['queued', 'running'].includes(job.status)) {
    return job;
  }

  const message = String(reason || '').trim() || '用户停止任务';
  if (!job.cancelRequested) {
    job.cancelRequested = true;
    job.cancelReason = message;
    appendJobLog(job, 'warn', [`已请求停止任务：${message}`]);
  }

  if (!job.abortController?.signal?.aborted) {
    job.abortController?.abort(new TaskCancelledError(message));
  }

  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.error = message;
    job.finishedAt = new Date().toISOString();
    if (activeJobId === job.id) activeJobId = null;
  }

  return job;
}

async function resolveJobAccounts(client, config, payload) {
  const filters = parseFilters(payload.filters || payload);
  if (Array.isArray(payload.accountIds) && payload.accountIds.length) {
    const accounts = [];
    for (const id of payload.accountIds) {
      accounts.push(await client.getAccount(id));
    }
    return accounts.filter((account) => isOpenAiOauthAccount(account));
  }
  if (payload.accountId) {
    const account = await client.getAccount(payload.accountId);
    if (!isOpenAiOauthAccount(account)) throw new Error(`账号 ${payload.accountId} 不是 OpenAI OAuth 账号`);
    return [account];
  }
  const candidates = await findCandidates(client, config, filters);
  if (payload.email) {
    const email = String(payload.email).trim().toLowerCase();
    return candidates.filter((account) => getEmail(account).toLowerCase() === email);
  }
  return candidates;
}

async function runJob(job) {
  const signal = job.abortController?.signal || null;
  if (job.status === 'cancelled') {
    if (activeJobId === job.id) activeJobId = null;
    return;
  }

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  appendJobLog(job, 'info', [`任务开始：${job.type}`]);

  try {
    await withJobConsole(job, async () => {
      throwIfAborted(signal);
      const config = loadCurrentConfig();
      if (!buildConfigStatus(config).canReauthorize) {
        throw new Error('配置不完整：需要 sub2api 管理账号和邮箱辅助服务配置');
      }

      const client = buildClient(config, signal);
      const mailProvider = buildMailProvider(config, signal);
      const accounts = await resolveJobAccounts(client, config, job.payload || {});
      throwIfAborted(signal);
      if (!accounts.length) throw new Error('没有匹配到可处理账号');

      job.progress.total = accounts.length;
      job.summary = { total: accounts.length, success: 0, failed: 0, skipped: 0 };

      for (let index = 0; index < accounts.length; index += 1) {
        throwIfAborted(signal);
        const account = accounts[index];
        const summary = accountSummary(account);
        job.progress.current = index + 1;
        job.progress.label = `${summary.id} ${summary.email}`;
        appendJobLog(job, 'info', [`处理 ${index + 1}/${accounts.length}：编号=${summary.id} 邮箱=${summary.email}`]);

        try {
          const result = await reauthorizeAccount(account, { client, mailProvider, config, signal });
          if (result?.skipped) {
            job.summary.skipped += 1;
            job.results.push({ account: summary, status: 'skipped', reason: result.reason || '', logPath: result.logPath || '' });
          } else {
            job.summary.success += 1;
            job.results.push({ account: summary, status: 'success', mode: result?.mode || '', logPath: result?.logPath || '' });
          }
        } catch (error) {
          if (isCancelError(error)) throw error;
          job.summary.failed += 1;
          job.results.push({ account: summary, status: 'failed', error: error.message });
          appendJobLog(job, 'error', [`处理失败：编号=${summary.id} 邮箱=${summary.email} 原因=${error.message}`]);
        }
      }
    });

    throwIfAborted(signal);
    job.status = 'success';
    appendJobLog(job, 'info', ['任务完成']);
  } catch (error) {
    if (isCancelError(error)) {
      job.status = 'cancelled';
      job.cancelRequested = true;
      job.cancelReason = error.message || job.cancelReason || '任务已停止';
      job.error = job.cancelReason;
      appendJobLog(job, 'warn', [`任务已停止：${job.cancelReason}`]);
    } else {
      job.status = 'failed';
      job.error = error.message;
      appendJobLog(job, 'error', [`任务失败：${error.message}`]);
    }
  } finally {
    job.finishedAt = new Date().toISOString();
    if (activeJobId === job.id) activeJobId = null;
  }
}

function buildUserscript(config) {
  const filePath = path.join(process.cwd(), 'public', 'sub2api-reauthorizer.user.js');
  let source = fs.readFileSync(filePath, 'utf8');
  const baseUrls = buildPluginBaseUrls(config);
  const baseUrl = baseUrls[0] || `http://127.0.0.1:${config.pluginPort || 8765}`;
  source = source
    .replace(/__PLUGIN_BASE_URL__/g, JSON.stringify(baseUrl))
    .replace(/__PLUGIN_BASE_URLS__/g, JSON.stringify(baseUrls))
    .replace(/__PLUGIN_ACCESS_TOKEN__/g, JSON.stringify(config.pluginAccessToken || ''));
  return source;
}

async function handleApi(req, res, url, config, origin) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, {
      ok: true,
      status: buildConfigStatus(config),
      activeJob: compactJob(jobs.get(activeJobId)),
      jobs: listJobs(),
    }, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      ok: true,
      config: sanitizeConfig(config),
      status: buildConfigStatus(config),
    }, origin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = await readRequestBody(req);
    const result = updateConfigFromPayload(body);
    sendJson(res, 200, {
      ok: true,
      configPath: result.configPath,
      config: sanitizeConfig(result.config),
      status: buildConfigStatus(result.config),
    }, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/candidates') {
    const client = buildClient(config);
    const filters = parseFilters(Object.fromEntries(url.searchParams.entries()));
    const candidates = await findCandidates(client, config, filters);
    sendJson(res, 200, {
      ok: true,
      filters,
      count: candidates.length,
      candidates: candidates.map(accountSummary),
    }, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const limit = Number(url.searchParams.get('limit') || 50) || 50;
    sendJson(res, 200, {
      ok: true,
      ...readLogEntries(config, Math.max(1, Math.min(limit, 500))),
    }, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(res, 200, {
      ok: true,
      activeJob: compactJob(jobs.get(activeJobId)),
      jobs: listJobs(),
    }, origin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readRequestBody(req);
    const job = createJob(body.type || 'reauthorize', body);
    sendJson(res, 202, {
      ok: true,
      job: compactJob(job),
    }, origin);
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const body = await readRequestBody(req);
    const job = cancelJob(decodeURIComponent(cancelMatch[1]), body.reason || '用户停止任务');
    sendJson(res, 200, {
      ok: true,
      job: compactJob(job),
    }, origin);
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) {
      sendJson(res, 404, { ok: false, error: '任务不存在' }, origin);
      return;
    }
    sendJson(res, 200, { ok: true, job: compactJob(job) }, origin);
    return;
  }

  sendJson(res, 404, { ok: false, error: '接口不存在' }, origin);
}

function rootHtml(config) {
  const baseUrls = buildPluginBaseUrls(config);
  const baseUrl = baseUrls[0] || `http://127.0.0.1:${config.pluginPort || 8765}`;
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>Sub2API 重授权插件服务</title>
<body style="font-family: system-ui, sans-serif; margin: 32px; line-height: 1.5">
  <h1>Sub2API 重授权插件服务</h1>
  <p>服务已启动：${baseUrl}</p>
  <p>可尝试地址：${baseUrls.join(' / ')}</p>
  <p><a href="/sub2api-reauthorizer.user.js">安装/查看 userscript</a></p>
  <p>安装 userscript 后，打开 sub2api 管理页会出现右侧浮动的“重授权”入口。</p>
</body>
</html>`;
}

function startPluginServer() {
  const initialConfig = loadCurrentConfig();
  const server = http.createServer(async (req, res) => {
    const config = loadCurrentConfig();
    const origin = String(req.headers.origin || '');
    const url = new URL(req.url || '/', `http://${req.headers.host || `${config.pluginHost}:${config.pluginPort}`}`);

    try {
      if (req.method === 'OPTIONS') {
        if (!isOriginAllowed(origin, config)) {
          sendJson(res, 403, { ok: false, error: 'Origin 不允许访问插件服务' }, origin);
          return;
        }
        res.writeHead(204, jsonHeaders(origin));
        res.end();
        return;
      }

      if (!isOriginAllowed(origin, config)) {
        sendJson(res, 403, { ok: false, error: 'Origin 不允许访问插件服务' }, origin);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, status: 'ok' }, origin);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        sendText(res, 200, rootHtml(config), 'text/html; charset=utf-8', origin);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/sub2api-reauthorizer.user.js') {
        sendText(res, 200, buildUserscript(config), 'application/javascript; charset=utf-8', origin);
        return;
      }

      if (!requireAuth(req, res, url, config, origin)) return;
      await handleApi(req, res, url, config, origin);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, { ok: false, error: error.message }, origin);
    }
  });

  server.listen(initialConfig.pluginPort, initialConfig.pluginHost, () => {
    const baseUrls = buildPluginBaseUrls(initialConfig);
    const baseUrl = baseUrls[0] || `http://${initialConfig.pluginHost}:${initialConfig.pluginPort}`;
    console.log(`[插件] 服务已启动：${baseUrl}`);
    console.log(`[插件] 可尝试地址：${baseUrls.join(' / ')}`);
    console.log(`[插件] userscript：${baseUrl}/sub2api-reauthorizer.user.js`);
  });

  return server;
}

module.exports = {
  startPluginServer,
  accountSummary,
  buildConfigStatus,
};
