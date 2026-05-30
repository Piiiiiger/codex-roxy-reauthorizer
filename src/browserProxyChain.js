const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const DEFAULT_CHAIN_BINARY = '/home/pigger/.config/sub2api/cliproxy_chain_proxy';

function normalizeProxyUrl(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function parseSecondHopProxy(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('浏览器授权代理格式无效，无法作为链式代理第二跳');
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('链式代理第二跳目前需要 HTTP 代理');
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error('链式代理第二跳需要包含主机和端口');
  }
  return {
    address: `${parsed.hostname}:${parsed.port}`,
    username: parsed.username ? decodeURIComponent(parsed.username) : '',
    password: parsed.password ? decodeURIComponent(parsed.password) : '',
  };
}

function isBrowserProxyChainEnabled(config) {
  return Boolean(String(config.browserProxyChainFirst || '').trim());
}

function redact(value, secret) {
  if (!secret) return value;
  return String(value || '').split(secret).join('[redacted]');
}

function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(400);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitUntilListening(host, port, child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`浏览器链式代理启动失败，进程退出码=${child.exitCode}`);
    }
    if (await canConnect(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`浏览器链式代理启动超时：${host}:${port}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 1500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startBrowserProxyChain(config) {
  if (!isBrowserProxyChainEnabled(config)) return null;

  const secondHop = parseSecondHopProxy(config.browserProxyUrl);
  if (!secondHop) throw new Error('启用浏览器链式代理时，需要配置浏览器授权代理作为第二跳');

  const binary = String(config.browserProxyChainBinary || DEFAULT_CHAIN_BINARY).trim();
  if (!fs.existsSync(binary)) {
    throw new Error(`浏览器链式代理程序不存在：${binary}`);
  }

  const listenHost = String(config.browserProxyChainListenHost || '127.0.0.1').trim();
  const listenPort = await getFreePort(listenHost);
  const listen = `${listenHost}:${listenPort}`;
  const first = String(config.browserProxyChainFirst || '').trim();
  const timeoutMs = Number(config.browserProxyChainStartupTimeoutMs || 5000);
  const args = [
    '-listen', listen,
    '-first', first,
    '-second', secondHop.address,
    '-user', secondHop.username,
    '-pass', secondHop.password,
  ];
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  const capture = (chunk) => {
    const text = redact(String(chunk || ''), secondHop.password).trim();
    if (text) output.push(text);
    while (output.length > 20) output.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    await waitUntilListening(listenHost, listenPort, child, timeoutMs);
  } catch (error) {
    await stopProcess(child);
    const detail = output.length ? `：${output.join('\n')}` : '';
    throw new Error(`${error.message}${detail}`);
  }

  console.log(`[浏览器代理链] 已启动：127.0.0.1:${listenPort} -> ${first} -> ${secondHop.address}`);
  return {
    proxyUrl: `http://${listen}`,
    async close() {
      await stopProcess(child);
      console.log(`[浏览器代理链] 已关闭：${listen}`);
    },
  };
}

module.exports = {
  isBrowserProxyChainEnabled,
  startBrowserProxyChain,
};
