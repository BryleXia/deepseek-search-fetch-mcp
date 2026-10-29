# deepseek-search-fetch-mcp

把 DeepSeek 官方的 **Search（网页搜索）** 和 **Fetch（网页抓取）** API 封装成 stdio MCP 服务器，供 Claude Code、Claude Desktop、Cursor 等任意 MCP 客户端调用。

| 工具 | 作用 | 对应 API |
|---|---|---|
| `deepseek_search` | 搜索网页，返回带权威度、相关性、发布日期的结构化结果 | `POST https://api.deepseek.com/v1/tools/search` |
| `deepseek_fetch` | 抓取单个网页，返回标题 + Markdown 正文 | `POST https://api.deepseek.com/v1/tools/fetch` |

工具描述用英文（给模型读），文档用中文（给人读）。English: [README.en.md](./README.en.md)。

---

## 安装

### 前提

- Node.js ≥ 20.3
- DeepSeek API Key：<https://platform.deepseek.com/api_keys>
- 账户有余额。Search / Fetch 各 **5 元 / 1000 次成功请求**，失败、空结果、超时不收费

### Claude Code（macOS / Linux）

```bash
claude mcp add --scope user \
  --env DEEPSEEK_API_KEY=sk-你的Key \
  deepseek-search -- npx -y deepseek-search-fetch-mcp
```

### Claude Code（Windows）

```powershell
claude mcp add --scope user --env DEEPSEEK_API_KEY=sk-你的Key deepseek-search -- cmd /c npx -y deepseek-search-fetch-mcp
```

**Windows 必须写 `cmd /c`。** Claude Code 拉起 MCP 进程时不经过 shell，而 `npx` 是一个 `.cmd` 脚本，直接写 `npx` 会启动失败。

### 其他 MCP 客户端

```json
{
  "mcpServers": {
    "deepseek-search": {
      "command": "npx",
      "args": ["-y", "deepseek-search-fetch-mcp"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

Windows 上改成 `"command": "cmd"`、`"args": ["/c", "npx", "-y", "deepseek-search-fetch-mcp"]`。

### 验证

```bash
claude mcp list
claude mcp get deepseek-search
```

> `claude mcp get` 会把 env 原样打印，Key 会明文显示。介意的话用下面的 Key 文件方式。

首次 `npx` 需要下载依赖，启动会慢一两秒。常用的话可以 `npm install -g deepseek-search-fetch-mcp`，然后把命令里的 `npx -y deepseek-search-fetch-mcp` 换成 `deepseek-search-fetch-mcp`（Windows 仍要保留 `cmd /c`）。

### Key 的两种放法

| 方式 | 优先级 | 适用场景 |
|---|---|---|
| `DEEPSEEK_API_KEY` 环境变量 | 高 | 最省事，绝大多数人用这个 |
| `DEEPSEEK_API_KEY_FILE` 指向的文件 | 低 | 不想让 Key 出现在 MCP 配置和 `claude mcp get` 输出里 |

文件方式（Windows，顺手把权限收紧到只有当前账号能读）：

```powershell
New-Item -ItemType Directory -Force "$HOME\.deepseek" | Out-Null
[IO.File]::WriteAllText("$HOME\.deepseek\api-key.txt", "sk-你的Key", (New-Object System.Text.UTF8Encoding($false)))
icacls "$HOME\.deepseek\api-key.txt" /inheritance:r /grant:r "$((whoami).Trim()):F"
```

然后改用 `--env DEEPSEEK_API_KEY_FILE=C:\Users\你\.deepseek\api-key.txt`。

服务器**不会**读取 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`。这条是故意的：很多人用 CC Switch 之类的工具切换供应商，切换后那个变量里装的是别家的 Key，回退读取就等于把它发给 DeepSeek。

---

## 工具

### `deepseek_search`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 搜索词，1–4096 字符；超过 128 个 Unicode 字符会截断并回传 warning |
| `count` | int 1–50 | 10 | 返回条数 |
| `need_content` | bool | false | 是否返回每条结果的网页正文；很占 token，通常用 `deepseek_fetch` 抓选中的 URL |
| `ori_question` | string | 无 | 触发搜索的原始问题，帮助理解意图；超过 128 字符会截断 |
| `freshness` | enum | `noLimit` | `oneDay` / `oneWeek` / `oneMonth` / `oneYear`；会映射成查询里的 `after:YYYY-MM-DD`。query 里已有 `after:`/`before:` 时忽略 |

返回 JSON：`query`、`query_sent`、`count`、`results[]`、`warnings[]`。

`results[]` 字段：

- `title`、`url`、`snippet`、`summary`（600–800 字，给模型读）
- `date`（RFC 3339 UTC，可能为 null）、`site_name`、`authority`（-1–4，≥3 极权威）
- `rerank_score`（0–3，≥1.5 优质）
- `content`（仅 `need_content: true` 时返回；每条截到 6,000 字符，总预算 60,000 字符）

空结果是正常成功（不计费）。`site_icon` 不返回，省 token。

### `deepseek_fetch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 公网 HTTP/HTTPS URL，有 host，不能带用户名/密码，≤8192 字符 |
| `max_chars` | int 1000–500000 | 50000 | 返回 Markdown 的最大字符数；超出会截断并标注 |

返回 JSON：`url`、`title`、`content`、`truncated`、`original_chars`。

拒绝 `localhost`、`127.0.0.1`、`::1`、私有 IPv4/IPv6、`.local`/`.internal`/`.lan`/`.home.arpa` 等内网地址，避免把内部 URL 交给第三方，也避免被诱导去探测内网。

### 搜索语法

`query` 原样透传给 DeepSeek，支持：

| 操作符 | 示例 | 作用 |
|---|---|---|
| `site:` | `DeepSeek site:github.com` | 限定站点；多站点用空格 + OR |
| `-site:` | `DeepSeek -site:example.com` | 排除站点 |
| `-词` | `DeepSeek -广告` | 排除含该词的页面 |
| `"..."` | `DeepSeek "精确短语"` | 精确短语 |
| `-"..."` | `DeepSeek -"release notes"` | 排除精确短语 |
| `lang:` | `DeepSeek lang:zh,en` | 限定语言，逗号分隔 |
| `after:` / `before:` | `after:2026-01-01` | 按发布日期过滤 |

---

## 计费与限速

- Search / Fetch 各 **5 元 / 1000 次成功请求**；失败、空结果、超时不收费；`count` 不影响单价。
- 每账号 Search / Fetch 各 **5 QPS**，两池独立；Fetch 另有按域名的限制。
- 服务器本地按 **4 次/秒** 留安全余量（250ms 间隔），两个 endpoint 各自排队。
- 多开 Claude Code 会话时每个进程各自限速，账号级 5 QPS 仍可能被合并突破；遇到 429 会自动退避重试。

## 行为

- 不缓存，每次实时请求。
- 不设单会话请求上限。
- 408 / 429 / 5xx / 网络错误 / 非 JSON 网关响应会重试：Search 最多 3 次，Fetch 最多 2 次；退避 500ms → 1500ms → 4000ms + 随机抖动，尊重 `Retry-After`（封顶 10s）。
- Search 总 deadline 45s，Fetch 55s；单次超时取「单次上限」和「剩余预算」的较小值，不会无限重试。
- 其它 4xx 不重试，直接返回可操作的错误。
- 失败不会自动切换其他搜索后端；错误信息会说明原因和下一步。
- 日志只写 stderr：endpoint、status、结果数、耗时、重试次数；不记录 query 正文，不记录 Key。
- 工具错误用 `isError: true` 返回，不抛协议级异常。

## 开发

```powershell
Set-Location 'E:\my-ai-studio\mcp-servers\deepseek-search'
node --check index.mjs
npm test                  # 纯函数单测，不联网
npm run verify:package    # 打包 -> 装进空目录 -> 用本地假 API 跑完整 MCP 握手
npm run smoke:list        # 真实进程，只列工具（不需要 Key）
npm run smoke             # 真实 API 冒烟（需要 DEEPSEEK_API_KEY 或 DEEPSEEK_API_KEY_FILE）
```

`verify:package` 不碰真实 API，适合每次发版前跑；`smoke` 会真实调用、产生少量费用。

## 排错

| 现象 | 处理 |
|---|---|
| 工具里返回 401 | Key 无效；检查 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_API_KEY_FILE` 指向的文件，改完后重启客户端 |
| 返回 402 | DeepSeek 账户余额不足；去 platform.deepseek.com 充值 |
| 返回 403 | Fetch 被 DeepSeek 安全策略拒绝；换公开来源 |
| 返回 404 | 页面无可提取正文（JS 重、付费墙、PDF、反爬）；换别的抓取工具 |
| 返回 429 | 账号级 5 QPS 被撞；等几秒，服务器已自动重试 |
| 超时 | Search 45s / Fetch 55s 总 deadline；稍后重试 |
| `/mcp` 里没有 `deepseek-search` | `claude mcp list` 确认注册；检查 Node 是否 ≥ 20.3；重启客户端 |
| Windows 启动失败 | 命令必须写成 `cmd /c npx -y deepseek-search-fetch-mcp` |
| 服务器连上但调用报 Key 错 | `claude mcp get deepseek-search` 看 env 里的变量名和路径对不对 |

## 更新 / 卸载

```bash
claude mcp remove --scope user deepseek-search
```

升级：`claude mcp remove` 后重新 `claude mcp add` 即可；`npx` 会自动拉最新版。全局安装的用户执行 `npm update -g deepseek-search-fetch-mcp`。

## 许可证

[MIT](./LICENSE)

本项目为非官方社区实现，与 DeepSeek 无关联。API 行为与计费以 [官方文档](https://api-docs.deepseek.com/guides/search) 为准。
