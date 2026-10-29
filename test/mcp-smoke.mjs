import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "index.mjs");
const keyFile = process.env.DEEPSEEK_API_KEY_FILE || "";

function envForChild() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string")
  );
}

function textOf(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

function parseToolJson(result) {
  if (result?.isError) throw new Error(textOf(result));
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Tool did not return JSON: ${text.slice(0, 300)}`);
  }
}

async function main() {
  const listOnly = process.argv.includes("--list-only");
  if (!listOnly) {
    assert.ok(
      keyFile || process.env.DEEPSEEK_API_KEY,
      "set DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE before running the smoke test"
    );
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: envForChild(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  const client = new Client({ name: "deepseek-search-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["deepseek_fetch", "deepseek_search"]);
    console.log(`PASS tools/list: ${names.join(", ")}`);

    if (listOnly) return;

    const searchResult = await client.callTool({
      name: "deepseek_search",
      arguments: { query: "DeepSeek 搜索 API 上线", count: 3 },
    });
    const search = parseToolJson(searchResult);
    assert.ok(Array.isArray(search.results));
    assert.ok(search.results.length > 0, "expected at least one search result");
    assert.ok(search.results[0].title);
    assert.ok(search.results[0].url);
    console.log(
      `PASS deepseek_search: ${search.results.length} results, first=${search.results[0].url}`
    );

    const operatorResult = await client.callTool({
      name: "deepseek_search",
      arguments: { query: "site:github.com DeepSeek lang:en after:2026-10-01", count: 2 },
    });
    const operatorSearch = parseToolJson(operatorResult);
    assert.ok(Array.isArray(operatorSearch.results));
    console.log(`PASS deepseek_search operators: ${operatorSearch.results.length} results`);

    const fetchResult = await client.callTool({
      name: "deepseek_fetch",
      arguments: { url: "https://example.com", max_chars: 5000 },
    });
    const fetched = parseToolJson(fetchResult);
    assert.ok(fetched.title || fetched.content);
    assert.ok(fetched.content.length > 0);
    console.log(
      `PASS deepseek_fetch: title=${JSON.stringify(fetched.title)}, chars=${fetched.original_chars}`
    );

    const invalidResult = await client.callTool({
      name: "deepseek_fetch",
      arguments: { url: "ftp://example.com" },
    });
    assert.equal(invalidResult.isError, true);
    assert.match(textOf(invalidResult), /HTTP|URL|rejected/i);
    console.log("PASS invalid URL is rejected");

    const queries = [
      "北京 天气",
      "上海 天气",
      "广州 天气",
      "深圳 天气",
      "杭州 天气",
      "成都 天气",
      "武汉 天气",
      "南京 天气",
    ];
    const started = Date.now();
    const concurrent = await Promise.all(
      queries.map((query) =>
        client.callTool({ name: "deepseek_search", arguments: { query, count: 1 } })
      )
    );
    const elapsed = Date.now() - started;

    for (const [index, result] of concurrent.entries()) {
      if (result.isError) {
        throw new Error(`concurrent search ${index + 1} failed: ${textOf(result)}`);
      }
      const parsed = JSON.parse(textOf(result));
      assert.ok(Array.isArray(parsed.results));
    }
    assert.ok(elapsed >= 1600, `expected the pacer to space 8 calls over >=1600ms, got ${elapsed}ms`);
    console.log(`PASS concurrency/pacing: 8 calls in ${elapsed}ms`);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("FAIL:", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
