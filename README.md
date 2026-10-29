<div align="center">

# deepseek-search-fetch-mcp

把 DeepSeek 官方的 **Search / Fetch API** 包成 stdio MCP 工具，一行命令接进 Claude Code。

[![npm](https://img.shields.io/npm/v/deepseek-search-fetch-mcp?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/deepseek-search-fetch-mcp)
[![CI](https://github.com/BryleXia/deepseek-search-fetch-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/BryleXia/deepseek-search-fetch-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520.3-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[English](./README.en.md) · [安装](#安装) · [工具](#工具) · [行为与安全](#行为与安全)

</div>

## 它做什么

| 工具 | 作用 | 上游接口 |
|---|---|---|
| `deepseek_search` | 网页搜索，返回标题、URL、摘要、发布日期、权威度、相关性 | `POST /v1/tools/search` |
| `deepseek_fetch` | 抓取单个网页，返回标题 + Markdown 正文 | `POST /v1/tools/fetch` |

搜索返回的是一手证据，不是模型二次加工的答案；按请求次数计费，不消耗模型 token。

## 安装

需要 Node.js ≥ 20.3、[DeepSeek API Key](https://platform.deepseek.com/api_keys)，账户有余额。Search / Fetch 各 **5 元 / 1000 次成功请求**，失败、空结果、超时不收费。

**Claude Code · Windows**

```powershell
claude mcp add --scope user --env DEEPSEEK_API_KEY=sk-你的Key deepseek-search -- cmd /c npx -y deepseek-search-fetch-mcp
```

**Claude Code · macOS / Linux**

```bash
claude mcp add --scope user --env DEEPSEEK_API_KEY=sk-你的Key deepseek-search -- npx -y deepseek-search-fetch-mcp
```

> Windows 必须保留 `cmd /c`：Claude Code 启动 MCP 进程时不经过 shell，而 `npx` 是 `.cmd` 脚本。首次运行需要下载依赖，之后可以 `npm i -g deepseek-search-fetch-mcp` 提速。

**其他 MCP 客户端**

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

验证：`claude mcp list`，然后 `claude mcp get deepseek-search`。

### Key 放哪里

| 方式 | 优先级 | 适用 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 高 | 最省事 |
| `DEEPSEEK_API_KEY_FILE` | 低 | 不想让 Key 出现在 `claude mcp get` 的输出里 |

服务器**不读** `ANTHROPIC_AUTH_TOKEN`。切换供应商后那个变量里装的是别家 Key，回退读取会把它发给 DeepSeek。

## 工具

### `deepseek_search`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 搜索词；超过 128 字符会截断并附 warning |
| `count` | 1–50 | 10 | 返回条数 |
| `need_content` | bool | false | 是否带每条结果的正文，很占 token |
| `ori_question` | string | — | 原始问题，帮助理解意图（≤128 字符） |
| `freshness` | enum | `noLimit` | `oneDay` / `oneWeek` / `oneMonth` / `oneYear`，映射为 `after:` 日期 |

返回 `{ query, query_sent, count, results[], warnings[] }`。每条结果含 `title`、`url`、`snippet`、`summary`、`date`、`site_name`、`authority`（-1–4）、`rerank_score`（0–3），以及可选的 `content`。空结果是正常成功，不计费。

### `deepseek_fetch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 公网 HTTP/HTTPS，≤8192 字符，不能带账号密码 |
| `max_chars` | 1000–500000 | 50000 | 返回 Markdown 的字符上限 |

返回 `{ url, title, content, truncated, original_chars }`。

### 搜索语法

| 操作符 | 示例 | 作用 |
|---|---|---|
| `site:` / `-site:` | `DeepSeek site:github.com` | 限定 / 排除站点 |
| `-词` / `"短语"` | `DeepSeek -广告` | 排除词、精确短语 |
| `lang:` | `DeepSeek lang:zh,en` | 限定语言 |
| `after:` / `before:` | `after:2026-01-01` | 按发布日期过滤 |

## 行为与安全

- **限速**：本地 4 次/秒（250ms 间隔），账号额度是 Search / Fetch 各 5 QPS。
- **重试**：408 / 429 / 5xx / 网络错误；Search 最多 3 次、Fetch 最多 2 次，退避 500ms → 1500ms → 4000ms + 抖动，尊重 `Retry-After`。
- **截止**：Search 45s、Fetch 55s 总 deadline，重试不会把会话挂死。
- **SSRF**：拒绝 localhost、私有 IPv4/IPv6、`.local` / `.internal` / `.lan` 等内网地址和带凭据的 URL。
- **Key**：只从环境变量或指定文件读取，不进日志、不进命令行。
- **错误**：以 `isError: true` 返回可操作信息，不抛协议级异常。

## 开发

```bash
npm test                # 纯函数单测，不联网
npm run verify:package  # 打包 → 空目录安装 → 本地假 API 跑完整 MCP 握手
npm run smoke:list      # 只列工具，不需要 Key
npm run smoke           # 真实 API 冒烟
```

## 许可证

[MIT](./LICENSE) · 非官方社区实现，与 DeepSeek 无关联。API 行为与计费以[官方文档](https://api-docs.deepseek.com/guides/search)为准。
