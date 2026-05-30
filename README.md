# codex-openai-reauthorizer

一个用于 sub2api 的 OpenAI / Codex 账号重新授权工具。

它会自动扫描需要重新授权的账号，打开真实浏览器完成 OpenAI 登录流程，读取邮箱验证码，处理授权回调，并把新的 OAuth 凭据回写到 sub2api，同时保存本地 token 和操作日志。

## 功能

- 扫描需要重新授权的 sub2api OAuth 账号
- 支持按账号 ID、邮箱、分组、套餐筛选
- 支持交互式选择单个账号，或先按分组筛选后用 `all` 批量处理同一组账号
- 自动打开浏览器完成登录、验证码输入和授权确认
- 支持邮箱验证码从 Cloudflare 邮箱辅助页读取
- 遇到账号被删除/停用时自动跳过并记录
- 遇到免费账号要求绑定手机号时自动跳过
- 遇到 Plus 账号手机号验证时关闭当前浏览器，重新打开浏览器登录 ChatGPT 并获取 session access token
- 更新 sub2api 账号凭据、清理错误状态，并写入本地 token 文件和日志

## 环境要求

- Node.js 18+
- Chrome 或 Edge
- 可访问的 sub2api 管理接口
- 可访问的邮箱服务辅助页

## 安装

```powershell
npm install
copy config.example.json config.json
notepad config.json
```

## 配置

编辑 `config.json`，至少填写这些项：

- `sub2apiBaseUrl`
- `sub2apiAdminEmail`
- `sub2apiAdminPassword`
- `mailBaseUrl`
- `mailAdminPassword`，如果 `mailBaseUrl` 使用令牌取件页则可不填

可选项：

- `mailSitePassword`
- `mailDomain`
- `mailTimeoutMs`
- `oauthRedirectUri`
- `tokenOutputDirs`
- `tokenFilenameMode`
- `reauthLogFile`
- `browserWindowWidth`
- `browserWindowHeight`
- `browserEngine`：默认 `camoufox`，使用 Camoufox 隐私浏览器；也可设为 `chrome` 走旧的 Chrome/Puppeteer
- `browserEngineFallbackToChrome`：默认 `false`，Camoufox 启动失败时不自动回退 Chrome
- `browserUserDataDir`
- `browserProxyUrl`
- `chromePath`
- `edgePath`
- `candidateErrorKeywords`
- `preferredGroupNames`
- `preferredGroupIds`

邮箱验证码：

- 插件默认通过 `mailBaseUrl` 配置的 Email 服务 API 读取验证码，不依赖授权浏览器的 localStorage。
- 如果本机运行 `/home/pigger/code/Email`，推荐把 `mailBaseUrl` 配成 `http://127.0.0.1:5000`，并配置 `mailAdminPassword` 为该服务的对外 API Key。
- `https://.../token` 这类取件页只适合人工查看和导入邮箱令牌，不建议作为自动授权的数据源。

浏览器授权代理：

- 插件默认使用 Camoufox，不再默认打开普通 Chrome。Camoufox 资料目录默认是 `data/camoufox-profile`，和旧 Chrome profile 分开。
- `browserProxyUrl` 用于插件打开的授权浏览器，影响该浏览器访问 `auth.openai.com`、`chatgpt.com` 和邮箱取件页的网络。
- 支持 `host:port`、`http://user:pass@host:port`、`socks5://host:port` 这类格式。
- 需要每个账号更换 sticky session 时，可以在代理用户名里写 `{sid}`，插件会在每次处理账号前替换成新的随机值。
- `browserProxyChainFirst` 用于启用浏览器链式代理。启用后流程为：Chrome -> 临时本地端口 -> `browserProxyChainFirst` -> `browserProxyUrl`。
- 如果要复用 sub2api 的 Cliproxy 链式代理方式，可以把 `browserProxyChainFirst` 设置为 Clash Verge 的 HTTP 代理地址，例如 `http://127.0.0.1:7901`，再把 `browserProxyUrl` 设置为 Cliproxy 第二跳。
- `browserProxyChainBinary` 默认使用 `/home/pigger/.config/sub2api/cliproxy_chain_proxy`。插件会在每个账号授权前启动独立的临时链式代理，授权结束后关闭。
- sub2api 后端生成授权链接和换取 token 仍会使用账号自身的 `proxy_id`。


## 运行方式

### 可视化插件面板

这个工具可以作为外部插件服务运行，不需要修改官方 sub2api 仓库。

```bash
npm install
npm run plugin
```

插件服务默认地址：

```text
http://127.0.0.1:8765
```

有两种接入方式：

- 通过外部安全网关注入：在 `sub2api-security-gateway` 中开启 `SG_REAUTH_PLUGIN_ENABLED=true`，然后打开网关入口 `http://127.0.0.1:8317`
- 通过浏览器 userscript：打开 `http://127.0.0.1:8765/sub2api-reauthorizer.user.js` 安装脚本后，再打开 sub2api 页面

面板会显示在 sub2api 页面右侧，包含候选账号扫描、单个/批量重授权、任务日志和配置页。插件配置保存在本项目的 `config.json`，不会写入 sub2api 官方仓库。

### 1. 扫描候选账号

```powershell
node index.js --list-candidates
```

### 2. 处理单个账号

按 ID：

```powershell
node index.js --account-id 123
```

按邮箱：

```powershell
node index.js --email user@example.com
```

### 3. 自动处理第一个匹配账号

```powershell
node index.js --auto
```

### 4. 交互式处理

先扫描，再手动确认：

```powershell
node index.js --interactive
```

在候选列表里可以输入：

- 序号
- 账号 ID
- 邮箱
- `all` 一次处理全部匹配账号

如果想按分组分批处理，可以直接先加分组筛选，再在该组候选里输入 `all`：

```powershell
node index.js --interactive --group plus
node index.js --interactive --group-id 1
```

### 5. 常用筛选

```powershell
node index.js --interactive --group plus
node index.js --interactive --plan free
node index.js --auto --group-id 1
node index.js --auto --prefer-group plus
node index.js --auto --prefer-group-id 1
```

参数说明：

- `--group` / `--group-id`：严格过滤候选账号
- `--prefer-group` / `--prefer-group-id`：优先处理匹配账号，但不排除其他候选
- `--plan`：按套餐过滤，支持 `free` / `plus`
- `--confirm`：和 `--interactive` 等价
- `--interactive` 配合 `--group` / `--group-id` 可按分组分批次选择账号

## 处理流程

1. 扫描 sub2api 中符合条件的 OAuth 账号
2. 打开浏览器进入 OpenAI 登录页
3. 输入邮箱并继续
4. 如遇密码页，点击“一次性验证码登录”
5. 从邮箱辅助页读取验证码并填入
6. 完成授权确认
7. 获取回调地址中的授权码并兑换凭据
8. 更新 sub2api 账号状态和凭据
9. 写入本地 token 文件和 reauth 日志

## 输出文件

- `tokens/`：本地 token 文件
- `data/reauth-log.json`：重新授权日志

## 注意事项

- 如果账号被删除/停用，工具会跳过该账号继续后续流程

## 友情链接
- linux.do
