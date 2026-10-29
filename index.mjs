#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveConfig, search, fetchPage, DeepSeekError } from "./lib/client.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const config = resolveConfig();
console.error(
  `[deepseek-search] ready key_source=${config.keySource} key_file=${config.keyFile ?? "(env)"} base_url=${config.baseUrl}`
);

const server = new McpServer({
  name: "deepseek-search",
  version: pkg.version,
});

const searchInput = {
  query: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      'Search query (1-4096 chars; truncated to 128 Unicode chars before sending). Supports operators: site:example.com, -site:example.com, -word, "exact phrase", -"phrase", lang:zh,en, after:YYYY-MM-DD, before:YYYY-MM-DD.'
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(
      "Number of results (1-50). Each result includes a 600-800 character summary; higher counts use more context."
    ),
  need_content: z
    .boolean()
    .default(false)
    .describe(
      "Return full page content per result. Expensive in tokens; prefer deepseek_fetch on selected URLs."
    ),
  ori_question: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Optional original user question (truncated to 128 chars) to improve query understanding."),
  freshness: z
    .enum(["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"])
    .default("noLimit")
    .describe("Recency filter mapped to after:YYYY-MM-DD. Ignored if query already contains after:/before:."),
};

server.registerTool(
  "deepseek_search",
  {
    title: "DeepSeek Web Search",
    description: `Search the live web with DeepSeek's search engine. Returns ranked results with title, URL, snippet, long summary, publish date, site name, authority (0-4; >=3 highly authoritative), and relevance score (0-3; >=1.5 high quality).

Query limits and operators:
- Query is limited to 128 Unicode characters; longer queries are truncated with a warning.
- site:example.com, -site:example.com, -word, "exact phrase", -"phrase", lang:zh,en, after:YYYY-MM-DD, before:YYYY-MM-DD.

Guidance:
- Best for Chinese-language and China-focused queries; pair it with another provider for English technical documentation.
- need_content=false by default; use deepseek_fetch on selected URLs when full page text is needed.
- Empty results are a normal successful search, not an error.`,
    inputSchema: searchInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args, extra) => {
    try {
      const result = await search(config, { ...args, signal: extra?.signal });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

const fetchInput = {
  url: z
    .string()
    .min(1)
    .max(8192)
    .describe(
      "Public HTTP/HTTPS URL with a host. Localhost, private IPs, internal hostnames, and URLs with credentials are rejected."
    ),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(500000)
    .default(50000)
    .describe("Maximum Markdown characters to return (1000-500000)."),
};

server.registerTool(
  "deepseek_fetch",
  {
    title: "DeepSeek Fetch Page",
    description: `Fetch a single public HTTP/HTTPS page with DeepSeek and return its title and Markdown content. Use for a specific URL when search summaries are insufficient.

- Not a crawler: for whole-site crawl/map or JS-heavy pages, use a dedicated crawler.
- Localhost/private/internal addresses and URLs with credentials are rejected.
- Content is truncated at max_chars.`,
    inputSchema: fetchInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args, extra) => {
    try {
      const result = await fetchPage(config, { ...args, signal: extra?.signal });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

function formatError(error) {
  if (error instanceof DeepSeekError) return error.message;
  if (error?.name === "AbortError") return "DeepSeek request was cancelled.";
  return `DeepSeek error: ${error?.message || String(error)}`;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[deepseek-search] stdio connected");
}

process.on("unhandledRejection", (reason) => {
  console.error("[deepseek-search] unhandledRejection:", reason?.message || String(reason));
});

process.on("uncaughtException", (error) => {
  console.error("[deepseek-search] uncaughtException:", error?.message || String(error));
  process.exit(1);
});

main().catch((error) => {
  console.error("[deepseek-search] fatal:", error?.message || String(error));
  process.exit(1);
});
