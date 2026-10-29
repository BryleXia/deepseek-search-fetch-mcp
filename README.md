<div align="center">

# deepseek-search-fetch-mcp

DeepSeek 官方 **Search / Fetch API** 的 stdio MCP 服务器。标准 MCP 协议，Claude Code、Codex、DeepSeek Harness、WorkBuddy、Cursor 都能直接挂载。

[![npm](https://img.shields.io/npm/v/deepseek-search-fetch-mcp?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/deepseek-search-fetch-mcp)
[![CI](https://github.com/BryleXia/deepseek-search-fetch-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/BryleXia/deepseek-search-fetch-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520.3-339933?logo=node.js&logoColor=white)](https://nodejs.org)

</div>

## 把这段丢给你的 Agent

```text
帮我安装一个 MCP 服务器，名称 deepseek-search。

- 来源：npm 公开包 deepseek-search-fetch-mcp，stdio 传输
- 启动命令：npx -y deepseek-search-fetch-mcp
  Windows 上若客户端不经过 shell，用：cmd /c npx -y deepseek-search-fetch-mcp
- 环境变量：DEEPSEEK_API_KEY=<我的 Key>（我没有的话先问我）
- 请写进你所在客户端自己的 MCP 配置并重载：
  Claude Code 用 claude mcp add；Codex 用 codex mcp add 或 ~/.codex/config.toml；
  DeepSeek Harness 用官方 @deepseek-ai/dsh-mcp-client + cordis.patch.yml；
  WorkBuddy 用 ~/.workbuddy/mcp.json；Cursor 用 .cursor/mcp.json
- 装好后确认 deepseek_search 和 deepseek_fetch 两个工具可调用；
  启动失败就把 stderr 原文贴给我
```

## 客户端

| 客户端 | 配置位置 | 备注 |
|---|---|---|
| Claude Code | `claude mcp add` | Windows 命令前加 `cmd /c` |
| Codex | `~/.codex/config.toml` | CLI、IDE、桌面端共用一份 |
| DeepSeek Harness | `~/.dsh/profiles/web/cordis.patch.yml` | 官方 `@deepseek-ai/dsh-mcp-client` |
| WorkBuddy | `~/.workbuddy/mcp.json` | 保存后要在连接器里点「信任」 |
| Cursor | `.cursor/mcp.json` | 标准 `mcpServers` 结构 |

<details>
<summary><b>各客户端完整配置（点开）</b></summary>

**Claude Code**

```powershell
# Windows
claude mcp add --scope user --env DEEPSEEK_API_KEY=sk-你的Key deepseek-search -- cmd /c npx -y deepseek-search-fetch-mcp
```

```bash
# macOS / Linux
claude mcp add --scope user --env DEEPSEEK_API_KEY=sk-你的Key deepseek-search -- npx -y deepseek-search-fetch-mcp
```

**Codex**

```powershell
# Windows
codex mcp add deepseek-search --env DEEPSEEK_API_KEY=sk-你的Key -- cmd /c npx -y deepseek-search-fetch-mcp
```

```bash
# macOS / Linux
codex mcp add deepseek-search --env DEEPSEEK_API_KEY=sk-你的Key -- npx -y deepseek-search-fetch-mcp
```

**DeepSeek Harness**

先按宿主版本装官方 MCP 客户端（npm 的 `latest` 停在旧版，必须 pin）：

```bash
dsh --version
dsh plugin --profile web add @deepseek-ai/dsh-mcp-client@<上一步输出的版本>
```

再写入 `~/.dsh/profiles/web/cordis.patch.yml`（或 `~/.dsh/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-deepseek-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: deepseek-search
        transport: stdio
        command: npx
        args: ['-y', 'deepseek-search-fetch-mcp']
        env:
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

重启 DSH 后工具名是 `mcp__deepseek-search__deepseek_search`。DSH 默认工具超时 60s，本服务器 Fetch 最长 55s，不会被宿主先掐断。

**WorkBuddy**

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

Windows 拉不起 `npx` 时，改成 `"command": "cmd", "args": ["/d", "/s", "/c", "npx -y deepseek-search-fetch-mcp"]`。

**Cursor**

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

</details>

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `deepseek_search` | `query`、`count`(1–50)、`freshness`、`need_content`、`ori_question` | 标题、URL、摘要、发布日期、权威度、相关性 |
| `deepseek_fetch` | `url`、`max_chars` | 标题 + Markdown 正文 |

## 为什么是它

- **一手证据**：返回结构化搜索结果，不是模型二次加工的答案；按次计费，不烧模型 token。
- **便宜**：5 元 / 1000 次成功请求，失败、空结果、超时不收费。
- **不闯祸**：本地 4 次/秒限速、429 退避、45s/55s deadline、内网地址拦截；Key 只从环境变量或指定文件读取。

## 开发

`npm test` · `npm run verify:package` · `npm run smoke:list` · [MIT](./LICENSE) · [English](./README.en.md)
