<div align="center">

# deepseek-search-fetch-mcp

A stdio MCP server that turns DeepSeek's official **Search / Fetch API** into two tools for Claude Code and any MCP client.

[![npm](https://img.shields.io/npm/v/deepseek-search-fetch-mcp?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/deepseek-search-fetch-mcp)
[![CI](https://github.com/BryleXia/deepseek-search-fetch-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/BryleXia/deepseek-search-fetch-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520.3-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[中文](./README.md) · [Install](#install) · [Tools](#tools) · [Behavior](#behavior)

</div>

## What it does

| Tool | What it does | Upstream API |
|---|---|---|
| `deepseek_search` | Web search with ranked results: title, URL, snippet, long summary, date, site, authority, relevance | `POST https://api.deepseek.com/v1/tools/search` |
| `deepseek_fetch` | Fetch one page as title + Markdown | `POST https://api.deepseek.com/v1/tools/fetch` |

## Requirements

- Node.js ≥ 20.3
- A DeepSeek API key: <https://platform.deepseek.com/api_keys>
- Account balance. Search / Fetch cost **¥5 per 1,000 successful requests**; failures, empty results, and timeouts are free.

## Install

### Claude Code (macOS / Linux)

```bash
claude mcp add --scope user \
  --env DEEPSEEK_API_KEY=sk-your-key \
  deepseek-search -- npx -y deepseek-search-fetch-mcp
```

### Claude Code (Windows)

```powershell
claude mcp add --scope user --env DEEPSEEK_API_KEY=sk-your-key deepseek-search -- cmd /c npx -y deepseek-search-fetch-mcp
```

`cmd /c` is required on native Windows: Claude Code spawns MCP servers without a shell, and `npx` is a `.cmd` shim.

### Any other MCP client

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

On Windows use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "deepseek-search-fetch-mcp"]`.

### API key

Resolution order:

1. `DEEPSEEK_API_KEY`
2. `DEEPSEEK_API_KEY_FILE`, a path to a file containing only the key

`claude mcp get` prints the configured env in plain text, so use the file form if you do not want the key to show up there.

The server deliberately never falls back to `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`: provider-switching tools rewrite those variables, and forwarding another vendor's key to DeepSeek would leak it.

## Tools

### `deepseek_search`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | required | Truncated to 128 Unicode chars before sending; operators supported (`site:`, `-site:`, `-word`, `"phrase"`, `lang:zh,en`, `after:`/`before:`) |
| `count` | 1–50 | 10 | Number of results |
| `need_content` | bool | false | Include page content per result (token-expensive) |
| `ori_question` | string | — | Original user question, improves intent understanding (≤128 chars) |
| `freshness` | enum | `noLimit` | `oneDay` / `oneWeek` / `oneMonth` / `oneYear`, mapped to `after:YYYY-MM-DD` |

Returns `{ query, query_sent, count, results[], warnings[] }`. Each result has `title`, `url`, `snippet`, `summary`, `date`, `site_name`, `authority` (0–4, `-1` unknown), `rerank_score` (0–3), and optionally `content`. Empty results are a successful, free search.

### `deepseek_fetch`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | Public HTTP/HTTPS, host required, no credentials, ≤8192 chars |
| `max_chars` | 1000–500000 | 50000 | Markdown truncation limit |

Returns `{ url, title, content, truncated, original_chars }`. Localhost, private IPv4/IPv6, and internal hostnames are rejected before the URL is sent upstream.

## Billing and rate limits

- ¥5 per 1,000 successful Search or Fetch requests; `count` does not change the price.
- 5 QPS per account for Search and Fetch separately.
- The server self-throttles to 4 requests/second (250 ms spacing) per endpoint to stay under the account limit, retrying 429 with backoff.

## Behavior

- No caching; every call hits the API.
- Retries on 408 / 429 / 5xx / network errors / non-JSON gateway responses: up to 3 attempts for Search, 2 for Fetch, backoff 500 ms → 1500 ms → 4000 ms with jitter, honoring `Retry-After` (capped at 10 s).
- Hard deadlines: 45 s for Search, 55 s for Fetch, so a retry loop cannot hang the client.
- Other 4xx responses are returned immediately with an actionable message.
- Tool failures use `isError: true`; stderr logs contain endpoint, status, duration, and attempt count, never the query body or the key.

## Development

```bash
npm test                  # pure unit tests, no network
npm run verify:package    # pack, install into an empty project, run against a mock API
npm run smoke:list        # spawn the real server, list tools (no key needed)
npm run smoke             # live API smoke test (needs a key)
```

## License

[MIT](./LICENSE). Unofficial community project, not affiliated with DeepSeek.
