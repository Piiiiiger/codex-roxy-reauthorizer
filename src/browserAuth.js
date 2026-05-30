const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect } = require('puppeteer-real-browser');
const { extractVerificationCodeFromMailRaw, pollEmailCodeByAddress } = require('./emailCode');
const { abortableSleep, addAbortListener, isCancelError, throwIfAborted } = require('./cancel');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rethrowIfCancel(error) {
  if (isCancelError(error)) throw error;
}

function normalizeBrowserEngine(value) {
  const engine = String(value || 'camoufox').trim().toLowerCase();
  if (['camoufox', 'privacy', 'private', 'firefox'].includes(engine)) return 'camoufox';
  if (['chrome', 'chromium', 'edge', 'puppeteer'].includes(engine)) return 'chrome';
  return 'camoufox';
}

function resolvePathMaybeRelative(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  return path.isAbsolute(candidate) ? candidate : path.join(process.cwd(), candidate);
}

function getPageUrl(page) {
  const raw = page?.url;
  return String(typeof raw === 'function' ? raw.call(page) : raw || '');
}

function getRequestUrl(request) {
  const raw = request?.url;
  return String(typeof raw === 'function' ? raw.call(request) : raw || '');
}

function parseBrowserProxyUrl(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;

  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('浏览器授权代理格式无效，请使用 host:port 或 protocol://user:pass@host:port');
  }

  if (!parsed.hostname || !parsed.port) {
    throw new Error('浏览器授权代理需要包含主机和端口');
  }

  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = protocol === 'http'
    ? parsed.hostname
    : `${protocol}://${parsed.hostname}`;

  return {
    host,
    port: parsed.port,
    username: parsed.username ? decodeURIComponent(parsed.username) : '',
    password: parsed.password ? decodeURIComponent(parsed.password) : '',
  };
}

function parsePlaywrightProxyUrl(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;

  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('浏览器授权代理格式无效，请使用 host:port 或 protocol://user:pass@host:port');
  }

  if (!parsed.hostname || !parsed.port) {
    throw new Error('浏览器授权代理需要包含主机和端口');
  }

  const proxy = {
    server: `${parsed.protocol.replace(/:$/, '').toLowerCase()}://${parsed.host}`,
  };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

const EMAIL_LOGIN_TEXTS = [
  'Continue with email',
  'Continue with email address',
  'Log in with email',
  'email',
  '鐢靛瓙閭欢鍦板潃鐧诲綍',
  '閭鐧诲綍',
  '缁х画浣跨敤鐢靛瓙閭欢鍦板潃鐧诲綍',
];

const OTP_TEXTS = [
  'Use a one-time code',
  'one-time code',
  'one time code',
  'email code',
  'send code',
  'magic code',
  'try another way',
  'verification code',
  '浣跨敤涓€娆℃€ч獙璇佺爜鐧诲綍',
  '涓€娆℃€ч獙璇佺爜鐧诲綍',
  '涓€娆℃€ч獙璇佺爜',
];

const CHATGPT_LOGIN_TEXTS = [
  'Log in',
  'Login',
  'Sign in',
  '\u767b\u5f55',
  '\u767b\u5165',
];

const ACCOUNT_SWITCH_TEXTS = [
  'Use another account',
  'Log in to another account',
  'Sign in with another account',
  'Continue with another account',
  '\u4f7f\u7528\u5176\u4ed6\u8d26\u6237',
  '\u767b\u5f55\u5176\u4ed6\u8d26\u6237',
];

function textMatchesAny(value, candidates) {
  const text = String(value || '');
  const lower = text.toLowerCase();
  return candidates.some((candidate) => {
    const expected = String(candidate || '');
    return expected && (text.includes(expected) || lower.includes(expected.toLowerCase()));
  });
}

const CODE_PAGE_TEXT_RE = /(email[-_\s]?verification|verify[-_\s]?email|verification code|one[-\s]?time code|one[-\s]?time|email code|security code|passcode|otp|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i;
const CODE_FIELD_TEXT_RE = /(verification|verify|code|otp|passcode|security|one[-\s]?time|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i;
const NON_CODE_FIELD_TEXT_RE = /(phone|mobile|email|user(name)?|identifier|login|password)/i;

function getInputSearchText(input) {
  return [
    input?.name,
    input?.placeholder,
    input?.id,
    input?.autocomplete,
    input?.ariaLabel,
    input?.inputMode,
    input?.type,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isLikelyVerificationInput(input) {
  if (!input || !input.visible) return false;

  const type = String(input.type || '').toLowerCase();
  if (type === 'hidden' || type === 'password') return false;

  const searchText = getInputSearchText(input);
  const hasCodeHint = CODE_FIELD_TEXT_RE.test(searchText) || String(input.autocomplete || '').toLowerCase() === 'one-time-code';
  const numericType = type === 'tel' || type === 'number' || String(input.inputMode || '').toLowerCase() === 'numeric';
  const shortLength = Number(input.maxLength) > 0 && Number(input.maxLength) <= 8;
  const blockedByIdentityHint = NON_CODE_FIELD_TEXT_RE.test(searchText);

  if (hasCodeHint) return true;
  if (numericType && shortLength && !blockedByIdentityHint) return true;
  if (numericType && /code|verify|otp|passcode|security|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027/i.test(searchText) && !blockedByIdentityHint) return true;
  return false;
}

function isCodePage(pageInfo) {
  const url = String(pageInfo?.url || '').toLowerCase();
  const pageText = `${pageInfo?.url || ''}\n${pageInfo?.text || ''}`.toLowerCase();
  const hasCodeRoute = /email[-_]?verification|verify[-_]?email|verification|one[-\s]?time|otp/.test(url);
  const hasCodeCopy = CODE_PAGE_TEXT_RE.test(pageText);
  const inputs = Array.isArray(pageInfo?.inputs) ? pageInfo.inputs : [];
  const hasLikelyField = inputs.some((input) => isLikelyVerificationInput(input));
  return (hasCodeRoute || hasCodeCopy) && hasLikelyField;
}

function isConsentPage(pageInfo) {
  const url = String(pageInfo?.url || '').toLowerCase();
  return /sign-in-with-chatgpt\/codex\/consent/.test(url) || /\/consent(?:[/?#]|$)/.test(url);
}

function hasEmailInput(pageInfo) {
  const inputs = Array.isArray(pageInfo?.inputs) ? pageInfo.inputs : [];
  return inputs.some((input) => (
    input.visible
    && (
      input.type === 'email'
      || ['email', 'username', 'identifier'].includes(input.name)
      || String(input.autocomplete || '').toLowerCase().includes('username')
    )
  ));
}

function hasPasswordInput(pageInfo) {
  const inputs = Array.isArray(pageInfo?.inputs) ? pageInfo.inputs : [];
  return inputs.some((input) => input.visible && input.type === 'password')
    || /password/i.test(String(pageInfo?.url || ''));
}

function isChooseAccountPage(pageInfo) {
  const url = String(pageInfo?.url || '').toLowerCase();
  const combined = [
    pageInfo?.url,
    pageInfo?.title,
    pageInfo?.text,
    ...(Array.isArray(pageInfo?.buttons) ? pageInfo.buttons : []),
  ].join('\n').toLowerCase();
  return (
    /choose[-_]?an[-_]?account/.test(url)
    || combined.includes('choose an account to continue')
    || combined.includes('use another account')
    || combined.includes('log in to another account')
    || combined.includes('sign in with another account')
  );
}

function isOpenAiTimeoutErrorPage(pageInfo) {
  const combined = [
    pageInfo?.url,
    pageInfo?.title,
    pageInfo?.errorSummary,
    pageInfo?.text,
    ...(Array.isArray(pageInfo?.buttons) ? pageInfo.buttons : []),
  ].join('\n').toLowerCase();
  return (
    combined.includes('operation timed out')
    || combined.includes('oops, an error occurred')
    || combined.includes('oops, something went wrong')
    || combined.includes('something went wrong')
    || /\u7cdf\u7cd5.*\u51fa\u9519/.test(combined)
    || combined.includes('\u64cd\u4f5c\u8d85\u65f6')
  );
}

function deriveOAuthPageType(pageInfo) {
  if (!pageInfo) return '';
  if (isOpenAiTimeoutErrorPage(pageInfo)) return 'timeout_error';
  if (isChooseAccountPage(pageInfo)) return 'choose_account';
  if (isConsentPage(pageInfo)) return 'consent';
  if (hasPasswordInput(pageInfo)) return 'login_password';
  if (isCodePage(pageInfo)) return 'email_otp_verification';
  if (hasEmailInput(pageInfo)) return 'login_email';
  if (pageInfo.buttons?.some((button) => textMatchesAny(button, EMAIL_LOGIN_TEXTS))) return 'continue_with_email';
  if (/chatgpt\.com/i.test(String(pageInfo.url || ''))) return 'chatgpt_home';
  return '';
}

function normalizeMailsFromPayload(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.mails)) return payload.mails;
  if (Array.isArray(payload.emails)) return payload.emails;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.records)) return payload.records;
  if (payload.data) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.data.results)) return payload.data.results;
    if (Array.isArray(payload.data.mails)) return payload.data.mails;
    if (Array.isArray(payload.data.emails)) return payload.data.emails;
    if (Array.isArray(payload.data.items)) return payload.data.items;
    if (Array.isArray(payload.data.list)) return payload.data.list;
    if (Array.isArray(payload.data.records)) return payload.data.records;
  }
  return null;
}

class AddPhoneRequiredError extends Error {
  constructor(message = 'OpenAI 要求进行手机号验证') {
    super(message);
    this.name = 'AddPhoneRequiredError';
    this.code = 'ADD_PHONE_REQUIRED';
  }
}

class AccountDeactivatedError extends Error {
  constructor(message = 'OpenAI 账号已删除或停用') {
    super(message);
    this.name = 'AccountDeactivatedError';
    this.code = 'ACCOUNT_DEACTIVATED';
  }
}

class OAuthBrowserRestartRequiredError extends Error {
  constructor(message = 'OpenAI OAuth 浏览器需要重启后重试') {
    super(message);
    this.name = 'OAuthBrowserRestartRequiredError';
    this.code = 'OAUTH_BROWSER_RESTART_REQUIRED';
  }
}

class BrowserAuth {
  constructor(config) {
    this.config = config;
    this.signal = config.signal || null;
    this.browser = null;
    this.page = null;
    this.mailboxPage = null;
    this.mailboxBaseUrl = '';
    this.browserEngine = '';
    this.screenshotDir = path.join(os.tmpdir(), 'codex-openai-reauthorizer');
  }

  throwIfCancelled(signal = this.signal) {
    throwIfAborted(signal);
  }

  async sleep(ms, signal = this.signal) {
    return signal ? abortableSleep(ms, signal) : sleep(ms);
  }

  getBrowserCandidatePaths() {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const chromeCandidates = [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const edgeCandidates = [
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    return this.config.useEdge ? [...edgeCandidates, ...chromeCandidates] : [...chromeCandidates, ...edgeCandidates];
  }

  detectExecutablePath() {
    if (process.platform !== 'win32') return '';
    for (const candidate of this.getBrowserCandidatePaths()) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  resolveExecutablePath(candidatePath) {
    const candidate = String(candidatePath || '').trim();
    if (!candidate) return this.detectExecutablePath();
    const looksLikeFsPath = candidate.includes('/') || candidate.includes('\\') || path.isAbsolute(candidate);
    if (looksLikeFsPath && !fs.existsSync(candidate)) {
      console.warn(`[浏览器] 配置的浏览器路径不存在：${candidate}`);
      return this.detectExecutablePath();
    }
    return candidate;
  }

  resolveBrowserUserDataDir() {
    const configured = String(this.config.browserUserDataDir || '').trim();
    const engine = normalizeBrowserEngine(this.config.browserEngine);
    const fallback = engine === 'camoufox' ? 'data/camoufox-profile' : 'data/browser-profile';
    return resolvePathMaybeRelative(configured || fallback);
  }

  async setPageViewport(page) {
    if (!page) return;
    const viewport = {
      width: this.config.browserWindowWidth,
      height: this.config.browserWindowHeight,
    };
    if (typeof page.setViewport === 'function') {
      await page.setViewport(viewport).catch(() => {});
      return;
    }
    if (typeof page.setViewportSize === 'function') {
      await page.setViewportSize(viewport).catch(() => {});
    }
  }

  async launchChrome() {
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      `--window-size=${this.config.browserWindowWidth},${this.config.browserWindowHeight}`,
      `--window-position=${this.config.browserWindowStartX},${this.config.browserWindowStartY}`,
    ];
    const userDataDir = this.resolveBrowserUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });
    const connectOptions = {
      headless: false,
      turnstile: true,
      args,
      customConfig: {
        userDataDir,
      },
    };
    const proxy = parseBrowserProxyUrl(this.config.browserProxyUrl);
    if (proxy) {
      connectOptions.proxy = proxy;
      console.log(`[浏览器] 使用授权代理：${proxy.host}:${proxy.port}`);
    }

    const preferred = this.config.useEdge ? this.config.edgePath : this.config.chromePath;
    const executablePath = this.resolveExecutablePath(preferred);
    if (executablePath) {
      connectOptions.customConfig.chromePath = executablePath;
      process.env.CHROME_PATH = executablePath;
      console.log(`[浏览器] 使用可执行文件：${executablePath}`);
    }
    console.log(`[浏览器] 使用 Chrome/Puppeteer 资料目录：${userDataDir}`);

    const { browser, page } = await connect(connectOptions);
    this.browser = browser;
    this.browserEngine = 'chrome';
    const pages = await browser.pages?.();
    this.page = pages && pages.length > 0 ? await browser.newPage() : page;
    await this.page.bringToFront().catch(() => {});
    await this.setPageViewport(this.page);
  }

  async firstPageOrNew(browser) {
    const pages = typeof browser?.pages === 'function' ? browser.pages() : [];
    const firstBlank = pages.find((item) => {
      const url = getPageUrl(item);
      return !url || ['about:blank', 'chrome://newtab/'].includes(String(url));
    });
    if (firstBlank) return firstBlank;
    if (pages.length > 0) return pages[0];
    return browser.newPage();
  }

  async launchCamoufox() {
    let Camoufox;
    try {
      ({ Camoufox } = require('camoufox'));
    } catch (error) {
      throw new Error(`Camoufox 依赖未安装：${error.message}`);
    }

    const userDataDir = this.resolveBrowserUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });
    const proxy = parsePlaywrightProxyUrl(this.config.browserProxyUrl);
    const launchOptions = {
      headless: false,
      data_dir: userDataDir,
      window: [this.config.browserWindowWidth, this.config.browserWindowHeight],
      humanize: 0.5,
      firefox_user_prefs: {
        'browser.privatebrowsing.autostart': true,
        'browser.sessionstore.resume_from_crash': false,
        'browser.startup.page': 0,
      },
    };
    if (proxy) {
      launchOptions.proxy = proxy;
      launchOptions.geoip = true;
      const safeServer = proxy.server.replace(/\/\/.*@/, '//');
      console.log(`[浏览器] 使用 Camoufox 授权代理：${safeServer}`);
    }

    console.log(`[浏览器] 使用 Camoufox 隐私浏览器，资料目录：${userDataDir}`);
    const browser = await Camoufox(launchOptions);
    this.browser = browser;
    this.browserEngine = 'camoufox';
    this.page = await this.firstPageOrNew(browser);
    await this.page.bringToFront().catch(() => {});
    await this.setPageViewport(this.page);
  }

  async launch() {
    this.throwIfCancelled();
    const engine = normalizeBrowserEngine(this.config.browserEngine);
    if (engine === 'chrome') {
      await this.launchChrome();
      this.throwIfCancelled();
      return;
    }

    try {
      await this.launchCamoufox();
    } catch (error) {
      const fallbackToChrome = this.config.browserEngineFallbackToChrome === true;
      if (!fallbackToChrome) {
        throw new Error(`Camoufox 隐私浏览器启动失败：${error.message}`);
      }
      console.warn(`[浏览器] Camoufox 启动失败，回退 Chrome/Puppeteer：${error.message}`);
      await this.launchChrome();
    }
    this.throwIfCancelled();
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
      this.mailboxPage = null;
      this.mailboxBaseUrl = '';
    }
  }

  resolveMailboxBaseUrl(mailProvider) {
    return String(mailProvider?.baseUrl || this.config.mailBaseUrl || '').replace(/\/+$/, '');
  }

  async keepMainPageVisible() {
    if (this.page && !this.page.isClosed?.()) {
      await this.page.bringToFront().catch(() => {});
    }
  }

  async ensureMailboxPage(mailProvider) {
    if (!this.browser) throw new Error('浏览器尚未启动');

    const baseUrl = this.resolveMailboxBaseUrl(mailProvider);
    if (!baseUrl) throw new Error('mailBaseUrl 为空');

    const needsNewPage = !this.mailboxPage || this.mailboxPage.isClosed?.() || this.mailboxBaseUrl !== baseUrl;
    if (needsNewPage) {
      this.mailboxPage = await this.browser.newPage();
      this.mailboxBaseUrl = baseUrl;
      await this.setPageViewport(this.mailboxPage);
      console.log(`[邮箱][浏览器] 打开邮箱辅助页：${baseUrl}`);
      await this.mailboxPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await this.keepMainPageVisible();
    return this.mailboxPage;
  }

  async fetchMailsByBrowserPage(mailProvider, email, limit = 20, offset = 0) {
    const mailboxPage = await this.ensureMailboxPage(mailProvider);
    const adminPassword = String(mailProvider?.adminPassword || this.config.mailAdminPassword || '');
    const sitePassword = String(mailProvider?.sitePassword || this.config.mailSitePassword || '');
    const timeoutMs = Number(mailProvider?.timeoutMs || this.config.mailTimeoutMs || 45000);

    const result = await mailboxPage.evaluate(async (params) => {
      const headers = { 'Content-Type': 'application/json' };
      if (params.adminPassword) headers['x-admin-auth'] = params.adminPassword;
      if (params.adminPassword) headers['X-API-Key'] = params.adminPassword;
      if (params.sitePassword) headers['x-custom-auth'] = params.sitePassword;

      const withQuery = (url, query) => {
        const search = new URLSearchParams();
        Object.entries(query || {}).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
        });
        const queryString = search.toString();
        if (!queryString) return url;
        return `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
      };

      const fetchJson = async (candidate) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), params.timeoutMs);
        try {
          const requestUrl = candidate.params ? withQuery(candidate.url, candidate.params) : candidate.url;
          const init = {
            method: candidate.method,
            headers,
            credentials: 'include',
            signal: controller.signal,
          };
          if (candidate.data) init.body = JSON.stringify(candidate.data);

          const response = await fetch(requestUrl, init);
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { rawText: text.slice(0, 500) };
          }

          return {
            ok: response.ok,
            status: response.status,
            method: candidate.method,
            url: requestUrl,
            data,
            textPreview: text.slice(0, 200),
          };
        } catch (error) {
          return {
            ok: false,
            method: candidate.method,
            url: candidate.url,
            error: error?.message || String(error),
          };
        } finally {
          clearTimeout(timer);
        }
      };

      const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
      const parseAccounts = (raw) => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
          if (Array.isArray(parsed?.accounts)) return parsed.accounts;
          if (Array.isArray(parsed?.data)) return parsed.data;
          if (parsed && typeof parsed === 'object') return Object.values(parsed).filter((item) => item && typeof item === 'object');
        } catch {
          return [];
        }
        return [];
      };
      const readTokenAccounts = () => {
        const keys = ['token_accounts_v22', 'token_accounts_v21', 'token_accounts_v20'];
        const accounts = [];
        for (const key of keys) {
          const parsed = parseAccounts(localStorage.getItem(key));
          for (const account of parsed) {
            accounts.push({ ...account, sourceKey: key });
          }
        }
        return accounts;
      };
      const looksLikeTokenMailboxPage = () => {
        const title = String(document.title || '');
        return location.pathname.includes('/token')
          || title.includes('令牌取件')
          || ['token_accounts_v22', 'token_accounts_v21', 'token_accounts_v20'].some((key) => Boolean(localStorage.getItem(key)));
      };
      const fetchTokenPageMails = async () => {
        const accounts = readTokenAccounts();
        const account = accounts.find((item) => normalizeEmail(item?.email) === normalizeEmail(params.email));
        if (!account) {
          return {
            ok: false,
            method: 'POST',
            url: '/api/fetch_by_token',
            error: `令牌取件页 localStorage 没有找到邮箱 ${params.email}，请先在该页面导入账号令牌`,
          };
        }
        if (!account.client_id || !account.token) {
          return {
            ok: false,
            method: 'POST',
            url: '/api/fetch_by_token',
            error: `令牌取件页邮箱 ${params.email} 缺少 client_id/token`,
          };
        }
        const response = await fetchJson({
          method: 'POST',
          url: '/api/fetch_by_token',
          data: {
            email: account.email || params.email,
            client_id: account.client_id,
            token: account.token,
            limit: params.limit,
          },
        });
        if (response.ok && response.data?.status !== 'error' && Array.isArray(response.data?.emails)) {
          return response;
        }
        return {
          ...response,
          ok: false,
          error: response.data?.message || response.error || '令牌取件接口未返回邮件列表',
        };
      };

      const candidates = [
        { method: 'GET', url: '/admin/mails', params: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/admin/mails', params: { email: params.email, limit: params.limit, offset: params.offset } },
        { method: 'POST', url: '/admin/mails', data: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/admin/get_mails', params: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/api/mails', params: { address: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/api/mails', params: { email: params.email, limit: params.limit, offset: params.offset } },
        { method: 'GET', url: '/api/external/emails', params: { email: params.email, top: params.limit, skip: params.offset, folder: 'inbox', include_body: '1', preferred_method: 'imap' } },
        { method: 'GET', url: '/api/external/emails', params: { email: params.email, top: params.limit, skip: params.offset, folder: 'junkemail', include_body: '1', preferred_method: 'imap' } },
      ];

      const attempts = [];
      if (looksLikeTokenMailboxPage()) {
        const response = await fetchTokenPageMails();
        attempts.push({
          ok: response.ok,
          status: response.status,
          method: response.method,
          url: response.url,
          error: response.error || '',
          textPreview: response.ok ? '' : response.textPreview,
        });
        if (response.ok) {
          return { ok: true, payload: response.data, attempts };
        }
      }

      for (const candidate of candidates) {
        const response = await fetchJson(candidate);
        attempts.push({
          ok: response.ok,
          status: response.status,
          method: response.method,
          url: response.url,
          error: response.error || '',
          textPreview: response.ok ? '' : response.textPreview,
        });
        if (response.ok) {
          return { ok: true, payload: response.data, attempts };
        }
      }

      return { ok: false, attempts };
    }, {
      email,
      limit,
      offset,
      adminPassword,
      sitePassword,
      timeoutMs: Math.min(Math.max(timeoutMs, 5000), 60000),
    });

    await this.keepMainPageVisible();

    if (!result?.ok) {
      const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
      const tokenAttempt = attempts.find((attempt) => String(attempt?.url || '').includes('/api/fetch_by_token'));
      const lastAttempt = attempts[attempts.length - 1] || null;
      const usefulAttempt = tokenAttempt?.error ? tokenAttempt : lastAttempt;
      throw new Error(`浏览器邮箱查询失败${usefulAttempt?.error ? `：${usefulAttempt.error}` : ''}`);
    }

    const mails = normalizeMailsFromPayload(result.payload);
    if (!Array.isArray(mails)) {
      throw new Error('浏览器邮箱响应中没有邮件列表');
    }
    return mails;
  }

  async pollEmailCodeByBrowserPage(mailProvider, email, options = {}) {
    const maxAttempts = Number(options.maxAttempts) || 30;
    const intervalMs = Number(options.intervalMs) || 5000;
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 20;
    const signal = options.signal || this.signal;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      console.log(`[邮箱][浏览器] 正在轮询 ${email} 的验证码 (${attempt}/${maxAttempts})`);
      try {
        const mails = await this.fetchMailsByBrowserPage(mailProvider, email, limit, 0);
        if (Array.isArray(mails) && mails.length > 0) {
          for (const mail of mails) {
            const code = extractVerificationCodeFromMailRaw(mail);
            if (code) {
              console.log(`[邮箱][浏览器] 已获取 ${email} 的验证码`);
              await this.keepMainPageVisible();
              return code;
            }
          }
          const firstMail = mails[0];
          const subject = String(firstMail?.subject || firstMail?.title || '').trim();
          console.log(`[邮箱][浏览器] 已收到 ${email} 的邮件，但还没匹配到验证码${subject ? `（主题="${subject.slice(0, 80)}"）` : ''}`);
        }
      } catch (error) {
        if (isCancelError(error)) throw error;
        console.warn(`[邮箱][浏览器] 轮询失败：${error.message}`);
      }

      await this.keepMainPageVisible();
      await this.sleep(intervalMs, signal);
    }

    throw new Error(`${email} 邮箱验证码超时`);
  }

  async pollEmailCode(mailProvider, email, options = {}) {
    console.log('[邮箱] 使用本地 Email 服务读取验证码');
    return await pollEmailCodeByAddress(mailProvider, email, { ...options, signal: options.signal || this.signal });
  }

  async waitForCloudflare(timeoutMs = 60000, options = {}) {
    const signal = options.signal || this.signal;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      throwIfAborted(signal);
      try {
        const title = await this.page.title();
        const text = await this.page.evaluate(() => (document.body?.innerText || '').slice(0, 400)).catch(() => '');
        if (!/checking|moment|cloudflare|verify you are human/i.test(`${title}\n${text}`)) {
          return;
        }
      } catch {
        // Navigation can destroy the context.
      }
      await this.sleep(3000, signal);
    }
    throw new Error('Cloudflare 等待超时');
  }

  async waitForCloudflareQuiet(timeoutMs = 60000, signal = this.signal) {
    try {
      await this.waitForCloudflare(timeoutMs, { signal });
    } catch (error) {
      rethrowIfCancel(error);
    }
  }

  async getPageInfo() {
    return await this.page.evaluate(() => {
      const visible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const errorSelectors = [
        '[role="alert"]',
        '[aria-live="assertive"]',
        '[data-testid*="error"]',
        '.error',
        '.text-red-500',
        '.text-danger',
      ];
      const errorTexts = [];
      for (const selector of errorSelectors) {
        for (const node of document.querySelectorAll(selector)) {
          const text = (node.innerText || node.textContent || '').trim();
          if (text && visible(node)) errorTexts.push(text);
        }
      }

      return {
        url: location.href,
        title: document.title || '',
        text: (document.body?.innerText || '').substring(0, 1000),
        errorSummary: Array.from(new Set(errorTexts)).slice(0, 5).join(' | '),
        buttons: Array.from(document.querySelectorAll('button, a, [role="button"]'))
          .filter((node) => visible(node))
          .map((node) => `${node.innerText || ''} ${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.trim())
          .filter(Boolean),
        inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map((input) => ({
          type: input.type,
          name: input.name,
          placeholder: input.placeholder,
          id: input.id,
          autocomplete: input.autocomplete || '',
          inputMode: input.inputMode || '',
          maxLength: Number(input.maxLength) || 0,
          ariaLabel: input.getAttribute('aria-label') || '',
          visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
        })),
      };
    });
  }

  async clickByText(candidates, timeoutMs = 10000) {
    const items = Array.isArray(candidates) ? candidates : [candidates];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const clicked = await this.page.evaluate((texts) => {
        for (const node of document.querySelectorAll('button, a, [role="button"]')) {
          const nodeText = `${node.innerText || ''} ${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.trim();
          const lower = nodeText.toLowerCase();
          const matched = texts.some((item) => {
            const expected = String(item || '');
            return expected && (nodeText.includes(expected) || lower.includes(expected.toLowerCase()));
          });
          if (matched) {
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
              node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            return true;
          }
        }
        return false;
      }, items);
      if (clicked) return true;
      await this.sleep(1000);
    }
    return false;
  }

  async clickChooseAccountEntry(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const clickedMatched = normalizedEmail
      ? await this.page.evaluate((expectedEmail) => {
        const visible = (node) => {
          if (!node) return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const clickNode = (node) => {
          if (typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'center', inline: 'center' });
          }
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
            node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          });
        };
        const controls = Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]'));
        for (const node of controls) {
          if (!visible(node)) continue;
          const text = `${node.innerText || ''} ${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
          if (!text.includes(expectedEmail)) continue;
          clickNode(node);
          return true;
        }
        return false;
      }, normalizedEmail).catch(() => false)
      : false;

    if (clickedMatched) return 'matched_email';

    const clickedSwitch = await this.clickByText(ACCOUNT_SWITCH_TEXTS, 3000);
    return clickedSwitch ? 'switch_account' : '';
  }

  async clickByXPath(xpath) {
    if (!xpath) return false;
    return await this.page.evaluate((expression) => {
      const result = document.evaluate(
        expression,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      const node = result?.singleNodeValue;
      if (!node) return false;
      if (typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'center', inline: 'center' });
      }
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    }, xpath).catch(() => false);
  }

  async fillInput(selectors, value) {
    let input = null;
    for (const selector of selectors) {
      input = await this.page.$(selector);
      if (input) break;
    }
    if (!input) return false;

    await input.click({ clickCount: 3 }).catch(() => {});
    await this.page.keyboard.press('Backspace').catch(() => {});
    await input.evaluate((node, nextValue) => {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      const setValue = descriptor && typeof descriptor.set === 'function'
        ? descriptor.set.bind(node)
        : (v) => { node.value = v; };
      node.focus();
      setValue('');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      setValue(String(nextValue || ''));
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    return true;
  }

  async clickSubmitButton() {
    await this.page.evaluate(() => {
      const preferredTexts = [
        'Continue',
        'Next',
        'Verify',
        'Submit',
        'Allow',
        '\u7ee7\u7eed',
        '\u4e0b\u4e00\u6b65',
        '\u9a8c\u8bc1',
        '\u63d0\u4ea4',
        '\u5141\u8bb8',
        '\u6388\u6743',
        '\u540c\u610f',
      ];
      for (const button of document.querySelectorAll('button[type="submit"], button')) {
        const text = (button.innerText || '').trim();
        if (button.disabled) continue;
        if (!preferredTexts.some((item) => text === item || text.includes(item))) continue;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
          button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
        return;
      }
    });
    await this.sleep(2500);
  }

  async enterVerificationCode(code) {
    const digits = String(code || '').trim();
    const handles = await this.page.$$('input:not([type="hidden"]):not([type="password"])');
    const candidates = [];

    for (const handle of handles) {
      try {
        const info = await handle.evaluate((node) => ({
          type: node.type,
          name: node.name,
          placeholder: node.placeholder,
          id: node.id,
          autocomplete: node.autocomplete || '',
          inputMode: node.inputMode || '',
          maxLength: Number(node.maxLength) || 0,
          ariaLabel: node.getAttribute('aria-label') || '',
          visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
        }));
        if (info.visible) candidates.push({ handle, info });
      } catch {
        // Skip detached inputs.
      }
    }

    const searchTextForInput = (input) => [
      input?.name,
      input?.placeholder,
      input?.id,
      input?.autocomplete,
      input?.ariaLabel,
      input?.inputMode,
      input?.type,
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();

    const isVerificationInput = (input) => {
      const type = String(input?.type || '').toLowerCase();
      if (!input?.visible || type === 'hidden' || type === 'password') return false;
      const searchText = searchTextForInput(input);
      const hasCodeHint = /(verification|verify|code|otp|passcode|security|one[-\s]?time|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i.test(searchText)
        || String(input.autocomplete || '').toLowerCase() === 'one-time-code';
      const numericType = type === 'tel' || type === 'number' || String(input.inputMode || '').toLowerCase() === 'numeric';
      const shortLength = Number(input.maxLength) > 0 && Number(input.maxLength) <= 8;
      const blockedByIdentityHint = /(phone|mobile|email|user(name)?|identifier|login|password)/i.test(searchText);
      if (hasCodeHint) return true;
      if (numericType && shortLength && !blockedByIdentityHint) return true;
      return false;
    };

    const splitInputs = candidates.filter(({ info }) => (
      isVerificationInput(info)
      && (Number(info.maxLength) === 1 || String(info.inputMode || '').toLowerCase() === 'numeric')
    ));

    if (splitInputs.length >= digits.length) {
      for (let index = 0; index < digits.length; index += 1) {
        const target = splitInputs[index].handle;
        await target.click({ clickCount: 1 }).catch(() => {});
        await target.evaluate((node, nextValue) => {
          const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          const setValue = descriptor && typeof descriptor.set === 'function'
            ? descriptor.set.bind(node)
            : (v) => { node.value = v; };
          node.focus();
          setValue(String(nextValue || ''));
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, digits[index]);
      }
    } else {
      const ranked = candidates
        .map(({ handle, info }) => {
          const searchText = searchTextForInput(info);
          let score = 0;
          if (String(info.autocomplete || '').toLowerCase() === 'one-time-code') score += 100;
          if (/(verification|verify|code|otp|passcode|security|one[-\s]?time|\u9a8c\u8bc1\u7801|\u9a8c\u8b49\u78bc|\u4e00\u6b21\u6027)/i.test(searchText)) score += 80;
          if (info.type === 'tel' || info.type === 'number') score += 30;
          if (String(info.inputMode || '').toLowerCase() === 'numeric') score += 20;
          if (Number(info.maxLength) > 0 && Number(info.maxLength) <= 8) score += 10;
          if (/(phone|mobile|email|user(name)?|identifier|login|password)/i.test(searchText)) score -= 80;
          return { handle, score };
        })
        .sort((a, b) => b.score - a.score);

      const target = ranked[0]?.handle || candidates[0]?.handle;
      if (target) {
        await target.click({ clickCount: 3 }).catch(() => {});
        try {
          await target.type(digits, { delay: 80 });
        } catch {
          await target.evaluate((node, nextValue) => {
            const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            const setValue = descriptor && typeof descriptor.set === 'function'
              ? descriptor.set.bind(node)
              : (v) => { node.value = v; };
            node.focus();
            setValue('');
            node.dispatchEvent(new Event('input', { bubbles: true }));
            setValue(String(nextValue || ''));
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          }, digits);
        }
      } else {
        await this.page.keyboard.type(digits, { delay: 80 });
      }
    }

    await this.sleep(1000);
    await this.clickSubmitButton();
  }

  isAddPhonePage(pageInfo) {
    const text = `${pageInfo.url}\n${pageInfo.text}`.toLowerCase();
    const hasPhoneInput = pageInfo.inputs.some((input) => input.name === 'phoneNumberInput' || input.type === 'tel');
    return (
      /add[-_]phone|add phone|phone verification|verify your phone|娣诲姞鎵嬫満鍙穦娣诲姞鎵嬫満|娣诲姞鐢佃瘽鍙风爜/.test(text)
      || (hasPhoneInput && /add|verify|娣诲姞|楠岃瘉/.test(text) && /phone|鎵嬫満鍙穦鎵嬫満|鐢佃瘽鍙风爜/.test(text))
    );
  }

  isAccountDeactivatedPage(pageInfo) {
    const text = `${pageInfo?.url || ''}\n${pageInfo?.text || ''}`.toLowerCase();
    return (
      /account_deactivated/.test(text)
      || /account (?:has been )?(?:deleted|deactivated|disabled)/.test(text)
      || /you do not have an account/.test(text)
      || /\u4f60\u6ca1\u6709\u8d26\u6237|\u60a8\u6c92\u6709\u5e33\u6236|\u8be5\u8d26\u6237\u5df2\u88ab\u5220\u9664\u6216\u505c\u7528|\u8a72\u8cec\u6236\u5df2\u88ab\u522a\u9664\u6216\u505c\u7528|\u8d26\u6237\u5df2\u88ab\u5220\u9664\u6216\u505c\u7528/.test(text)
    );
  }

  async screenshot(name) {
    try {
      if (!fs.existsSync(this.screenshotDir)) fs.mkdirSync(this.screenshotDir, { recursive: true });
      const filePath = path.join(this.screenshotDir, name);
      await this.page.screenshot({ path: filePath });
      return filePath;
    } catch {
      return null;
    }
  }

  async authorizeWithEmailOtp({ authUrl, email, mailProvider, redirectUri, signal }) {
    const flowSignal = signal || this.signal;
    throwIfAborted(flowSignal);
    const redirectBase = new URL(redirectUri);
    let callbackUrl = '';
    const requestListener = (request) => {
      const reqUrl = getRequestUrl(request);
      try {
        const parsed = new URL(reqUrl);
        if (
          parsed.hostname === redirectBase.hostname
          && parsed.port === redirectBase.port
          && parsed.pathname === redirectBase.pathname
          && (parsed.searchParams.has('code') || parsed.searchParams.has('error'))
        ) {
          callbackUrl = reqUrl;
        }
      } catch {
        // Ignore non-URL requests.
      }
    };

    const removeAbortListener = addAbortListener(flowSignal, () => {
      this.close().catch(() => {});
    });

    this.page.on('request', requestListener);
    try {
      await this.page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      throwIfAborted(flowSignal);
      await this.waitForCloudflare(undefined, { signal: flowSignal });
      await this.sleep(4000, flowSignal);

      let lastLoggedSignature = '';
      let timeoutErrorCount = 0;
      const maxRounds = 60;

      for (let round = 0; round < maxRounds; round += 1) {
        throwIfAborted(flowSignal);
        await this.sleep(1800, flowSignal);
        if (callbackUrl) return { status: 'callback', callbackUrl };

        let pageInfo;
        try {
          pageInfo = await this.getPageInfo();
        } catch (error) {
          rethrowIfCancel(error);
          throwIfAborted(flowSignal);
          continue;
        }

        if (callbackUrl) return { status: 'callback', callbackUrl };
        if (this.isAddPhonePage(pageInfo)) {
          await this.screenshot('add-phone.png');
          throw new AddPhoneRequiredError();
        }
        if (this.isAccountDeactivatedPage(pageInfo)) {
          await this.screenshot('account-deactivated.png');
          throw new AccountDeactivatedError();
        }

        try {
          const current = new URL(pageInfo.url);
          if (
            current.hostname === redirectBase.hostname
            && current.port === redirectBase.port
            && current.pathname === redirectBase.pathname
            && (current.searchParams.has('code') || current.searchParams.has('error'))
          ) {
            return { status: 'callback', callbackUrl: pageInfo.url };
          }
        } catch {
          // Continue.
        }

        if (/chrome-error/i.test(pageInfo.url) && callbackUrl) {
          return { status: 'callback', callbackUrl };
        }

        const pageType = deriveOAuthPageType(pageInfo);
        const logSignature = `${pageType}|${pageInfo.url}|${pageInfo.errorSummary || ''}`;
        if (logSignature !== lastLoggedSignature) {
          const detail = pageInfo.errorSummary ? ` error="${pageInfo.errorSummary.substring(0, 120)}"` : '';
          console.log(`[浏览器] OAuth state step[${round + 1}/${maxRounds}] page=${pageType || '-'} url=${pageInfo.url.substring(0, 110)}${detail}`);
          lastLoggedSignature = logSignature;
        }

        if (pageType === 'timeout_error') {
          timeoutErrorCount += 1;
          await this.screenshot(`oauth-timeout-${timeoutErrorCount}.png`);
          console.warn(`[浏览器] 检测到 OpenAI 超时错误页 (${timeoutErrorCount})，关闭当前浏览器并重试`);
          throw new OAuthBrowserRestartRequiredError('检测到 OpenAI 超时错误页，需要重启授权浏览器');
        }

        if (pageType === 'choose_account') {
          const clickedAccount = await this.clickChooseAccountEntry(email);
          if (!clickedAccount) {
            throw new OAuthBrowserRestartRequiredError('OAuth 账号选择页未找到匹配账号或其他账号入口');
          }
          console.log(`[浏览器] OAuth 账号选择页已点击：${clickedAccount}`);
          await this.sleep(1000, flowSignal);
          await this.waitForCloudflareQuiet(30000, flowSignal);
          continue;
        }

        if (pageType === 'continue_with_email') {
          await this.clickByText(EMAIL_LOGIN_TEXTS, 5000);
          continue;
        }

        if (pageType === 'login_email') {
          console.log(`[浏览器] 输入邮箱：${email}`);
          await this.fillInput([
            'input[type="email"]',
            'input[name="email"]',
            'input[name="username"]',
            'input[name="identifier"]',
            'input[type="text"]',
          ], email);
          await this.page.keyboard.press('Enter').catch(() => {});
          await this.sleep(1000, flowSignal);
          await this.clickSubmitButton();
          await this.waitForCloudflareQuiet(30000, flowSignal);
          continue;
        }

        if (pageType === 'login_password') {
          const clickedOtp = await this.clickByXPath('/html/body/div/div/fieldset/form/div[2]/div[3]/div/button')
            || await this.clickByText(OTP_TEXTS, 5000);
          if (!clickedOtp) {
            throw new Error('密码页已显示，但未找到一次性验证码登录入口');
          }
          await this.sleep(1000, flowSignal);
          await this.waitForCloudflareQuiet(30000, flowSignal);
          continue;
        }

        if (pageType === 'email_otp_verification') {
          console.log('[浏览器] 等待邮箱验证码');
          const code = await this.pollEmailCode(mailProvider, email, { limit: 20, signal: flowSignal });
          await this.keepMainPageVisible();
          await this.enterVerificationCode(code);
          await this.waitForCloudflareQuiet(30000, flowSignal);
          continue;
        }

        if (pageType === 'consent') {
          console.log('[浏览器] 点击授权确认按钮');
          const clickedConsent = await this.clickByXPath('/html/body/div/div/fieldset/form/div[2]/div/div[2]/button')
            || await this.clickByText(['Allow', 'Authorize', 'Continue', '鍏佽', '鎺堟潈', '鍚屾剰', '缁х画'], 2500);
          if (clickedConsent) {
            await this.sleep(1000, flowSignal);
            if (callbackUrl) return { status: 'callback', callbackUrl };
            await this.waitForCloudflareQuiet(30000, flowSignal);
            if (callbackUrl) return { status: 'callback', callbackUrl };
            continue;
          }
        }

        const clickedConsent = await this.clickByText(['Allow', 'Authorize', 'Continue', '鍏佽', '鎺堟潈', '鍚屾剰', '缁х画'], 2500);
        if (clickedConsent) {
          await this.waitForCloudflareQuiet(30000, flowSignal);
          if (callbackUrl) return { status: 'callback', callbackUrl };
          continue;
        }

        if (round % 6 === 5) {
          await this.screenshot(`oauth-round-${round}.png`);
          console.log(`[浏览器] 页面内容：${pageInfo.text.substring(0, 180)}`);
        }
      }

      throw new OAuthBrowserRestartRequiredError(`OpenAI OAuth 状态机 ${maxRounds} 轮内未完成，需要重启授权浏览器`);
    } finally {
      removeAbortListener();
      if (this.page && typeof this.page.off === 'function') this.page.off('request', requestListener);
      else if (this.page && typeof this.page.removeListener === 'function') this.page.removeListener('request', requestListener);
    }
  }

  async readChatGptSession() {
    await this.page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.waitForCloudflareQuiet(60000);
    await this.sleep(5000);

    const result = await this.readChatGptSessionFromCurrentPage();
    if (!result.ok && !result.accessToken) {
      throw new Error(`ChatGPT 会话接口失败：HTTP ${result.status || 'unknown'}`);
    }
    if (!result.accessToken) {
      throw new Error('ChatGPT 会话中没有 accessToken');
    }
    return result;
  }

  async readChatGptSessionFromCurrentPage() {
    const result = await this.page.evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      const session = await response.json().catch(() => ({}));
      return {
        ok: response.ok,
        status: response.status,
        session,
        accessToken: String(session?.accessToken || '').trim(),
      };
    });

    return result;
  }

  async tryReadChatGptSessionFromCurrentPage() {
    try {
      const url = new URL(getPageUrl(this.page));
      if (!/(^|\.)chatgpt\.com$/i.test(url.hostname)) return null;
      const result = await this.readChatGptSessionFromCurrentPage();
      return result?.accessToken ? result : null;
    } catch {
      return null;
    }
  }

  async loginChatGptWithEmailOtp({ email, mailProvider, signal }) {
    const flowSignal = signal || this.signal;
    throwIfAborted(flowSignal);
    const removeAbortListener = addAbortListener(flowSignal, () => {
      this.close().catch(() => {});
    });

    console.log(`[浏览器] 重新打开浏览器登录 ChatGPT：${email}`);
    try {
      await this.page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      throwIfAborted(flowSignal);
      await this.waitForCloudflareQuiet(60000, flowSignal);
      await this.sleep(3000, flowSignal);

      let lastLoggedUrl = '';
      let codeEntered = false;
      for (let round = 0; round < 48; round += 1) {
        throwIfAborted(flowSignal);
        await this.sleep(2500, flowSignal);

        const sessionState = await this.tryReadChatGptSessionFromCurrentPage();
        if (sessionState) {
          console.log('[浏览器] 已获取 ChatGPT session access token');
          return sessionState;
        }

        let pageInfo;
        try {
          pageInfo = await this.getPageInfo();
        } catch (error) {
          rethrowIfCancel(error);
          throwIfAborted(flowSignal);
          continue;
        }

        if (this.isAccountDeactivatedPage(pageInfo)) {
          await this.screenshot('chatgpt-account-deactivated.png');
          throw new AccountDeactivatedError();
        }
        if (this.isAddPhonePage(pageInfo)) {
          await this.screenshot('chatgpt-add-phone.png');
          throw new AddPhoneRequiredError('ChatGPT 登录时要求进行手机号验证');
        }

        if (pageInfo.url !== lastLoggedUrl) {
          console.log(`[浏览器] ChatGPT 登录第 ${round} 轮：${pageInfo.url.substring(0, 90)}`);
          lastLoggedUrl = pageInfo.url;
        }

        const hasEmailInput = pageInfo.inputs.some((input) => input.type === 'email' || ['email', 'username', 'identifier'].includes(input.name));
        if (hasEmailInput) {
          console.log(`[浏览器] 输入 ChatGPT 邮箱：${email}`);
          await this.fillInput([
            'input[type="email"]',
            'input[name="email"]',
            'input[name="username"]',
            'input[name="identifier"]',
            'input[type="text"]',
          ], email);
          await this.page.keyboard.press('Enter').catch(() => {});
          await this.sleep(1000, flowSignal);
          await this.clickSubmitButton();
          await this.waitForCloudflareQuiet(30000, flowSignal);
          continue;
        }

        const hasPassword = pageInfo.inputs.some((input) => input.type === 'password') || /password/i.test(pageInfo.url);
        if (hasPassword) {
          const clickedOtp = await this.clickByXPath('/html/body/div/div/fieldset/form/div[2]/div[3]/div/button')
            || await this.clickByText(OTP_TEXTS, 5000);
          if (!clickedOtp) {
            throw new Error('ChatGPT 密码页已显示，但未找到一次性验证码登录入口');
          }
          codeEntered = false;
          await this.sleep(1000, flowSignal);
          await this.waitForCloudflareQuiet(30000, flowSignal);
          continue;
        }

        if (isCodePage(pageInfo) && !codeEntered) {
          console.log('[浏览器] 等待 ChatGPT 邮箱验证码');
          const code = await this.pollEmailCode(mailProvider, email, { limit: 20, signal: flowSignal });
          await this.keepMainPageVisible();
          await this.enterVerificationCode(code);
          await this.waitForCloudflareQuiet(30000, flowSignal);
          codeEntered = true;
          continue;
        }

        if (pageInfo.buttons.some((button) => textMatchesAny(button, EMAIL_LOGIN_TEXTS))) {
          await this.clickByText(EMAIL_LOGIN_TEXTS, 5000);
          continue;
        }

        if (pageInfo.buttons.some((button) => textMatchesAny(button, CHATGPT_LOGIN_TEXTS))) {
          await this.clickByText(CHATGPT_LOGIN_TEXTS, 5000);
          continue;
        }

        const clickedContinue = await this.clickByText(['Continue', '\u7ee7\u7eed'], 2000);
        if (clickedContinue) {
          await this.waitForCloudflareQuiet(30000, flowSignal);
          continue;
        }

        if (round % 6 === 5) {
          await this.screenshot(`chatgpt-login-round-${round}.png`);
          console.log(`[浏览器] ChatGPT 登录页面内容：${pageInfo.text.substring(0, 180)}`);
        }
      }

      throw new Error('ChatGPT 重新登录并获取 access token 超时');
    } finally {
      removeAbortListener();
    }
  }
}

module.exports = {
  BrowserAuth,
  AddPhoneRequiredError,
  AccountDeactivatedError,
  OAuthBrowserRestartRequiredError,
};
