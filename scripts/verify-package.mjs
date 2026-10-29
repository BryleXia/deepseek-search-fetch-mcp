#!/usr/bin/env node
// End-to-end check of the *packaged artifact*, not the working tree:
//   npm pack -> install the tarball into an empty project -> start the installed
//   server against a local mock of the DeepSeek API -> exercise the MCP handshake,
//   both tools, the request shape, and the missing-key error.
//
// No real API key and no request to api.deepseek.com.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const binName = Object.keys(pkg.bin)[0];
const fromRegistry = process.argv.includes("--from-registry");

function runNpm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (cli && (cli.endsWith(".js") || cli.endsWith(".cjs"))) {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  // Fallback for direct `node scripts/verify-package.mjs` runs; .cmd shims need a shell.
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startMockApi() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        // Record the raw body below; malformed JSON is itself a failure signal.
      }
      requests.push({ path: req.url, auth: req.headers.authorization, body: parsed, raw: body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/tools/search") {
        res.end(
          JSON.stringify({
            results: [
              {
                title: "Mock result",
                url: "https://example.com/mock",
                snippet: "snippet",
                summary: "A long summary written for models.",
                date: "2026-10-01T00:00:00Z",
                site_name: "Example",
                authority: 3,
                rerank_score: 2.2,
                site_icon: "https://example.com/favicon.ico",
              },
            ],
          })
        );
        return;
      }
      if (req.url === "/v1/tools/fetch") {
        res.end(JSON.stringify({ title: "Mock page", content: "# Mock page\n\nHello." }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

function baseEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string")
  );
  delete env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_API_KEY_FILE;
  delete env.DEEPSEEK_API_BASE;
  return env;
}

function transportFor(env) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [path.join(tmpDir, "node_modules", pkg.name, "index.mjs")],
    env,
    stderr: "pipe",
  });
}

function textOf(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

let tmpDir;
let mock;
let client;
let noKeyClient;

try {
  mock = await startMockApi();
  const apiBase = `http://127.0.0.1:${mock.port}`;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-search-pack-"));
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "pack-check", private: true, version: "1.0.0" }, null, 2)
  );

  if (fromRegistry) {
    runNpm(
      ["install", `${pkg.name}@${pkg.version}`, "--no-audit", "--no-fund", "--loglevel=error"],
      tmpDir
    );
    console.log(`PASS npm install ${pkg.name}@${pkg.version} from the registry`);
  } else {
    const packed = JSON.parse(
      runNpm(["pack", "--json", "--pack-destination", tmpDir], root)
    );
    const tarball = path.join(tmpDir, packed[0].filename);
    assert.ok(fs.existsSync(tarball), `tarball missing: ${tarball}`);
    console.log(`PASS npm pack: ${packed[0].filename} (${packed[0].entryCount} files)`);

    runNpm(["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], tmpDir);
    console.log("PASS npm install into an empty project");
  }

  const shim =
    process.platform === "win32"
      ? path.join(tmpDir, "node_modules", ".bin", `${binName}.cmd`)
      : path.join(tmpDir, "node_modules", ".bin", binName);
  assert.ok(fs.existsSync(shim), `bin shim missing: ${shim}`);
  console.log(`PASS bin shim: ${path.relative(tmpDir, shim)}`);

  client = new Client({ name: "deepseek-search-pack-check", version: "1.0.0" });
  await client.connect(transportFor({ ...baseEnv(), DEEPSEEK_API_KEY: "sk-test-not-a-real-key", DEEPSEEK_API_BASE: apiBase }));

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["deepseek_fetch", "deepseek_search"]);
  console.log(`PASS tools/list: ${tools.map((tool) => tool.name).join(", ")}`);

  const searchResult = await client.callTool({
    name: "deepseek_search",
    arguments: { query: "mock query", count: 1 },
  });
  assert.notEqual(searchResult.isError, true, textOf(searchResult));
  const search = JSON.parse(textOf(searchResult));
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].title, "Mock result");
  assert.equal(search.results[0].site_icon, undefined, "site_icon should be dropped");

  const searchRequest = mock.requests.find((item) => item.path === "/v1/tools/search");
  assert.equal(searchRequest.auth, "Bearer sk-test-not-a-real-key");
  assert.equal(searchRequest.body.query, "mock query");
  assert.equal(searchRequest.body.count, 1);
  console.log("PASS deepseek_search: result shape and request body");

  const fetchResult = await client.callTool({
    name: "deepseek_fetch",
    arguments: { url: "https://example.com/mock", max_chars: 1000 },
  });
  assert.notEqual(fetchResult.isError, true, textOf(fetchResult));
  const fetched = JSON.parse(textOf(fetchResult));
  assert.equal(fetched.title, "Mock page");
  assert.match(fetched.content, /# Mock page/);
  console.log("PASS deepseek_fetch: title and Markdown content");

  noKeyClient = new Client({ name: "deepseek-search-pack-check-nokey", version: "1.0.0" });
  await noKeyClient.connect(transportFor(baseEnv()));
  const missingKey = await noKeyClient.callTool({
    name: "deepseek_search",
    arguments: { query: "no key" },
  });
  assert.equal(missingKey.isError, true);
  assert.match(textOf(missingKey), /DEEPSEEK_API_KEY/);
  console.log("PASS missing key: actionable error instead of a crash");

  console.log("\nAll packaged-artifact checks passed.");
} finally {
  await client?.close().catch(() => {});
  await noKeyClient?.close().catch(() => {});
  mock?.server.close();
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.error(`[verify-package] could not remove temp dir: ${tmpDir}`);
    }
  }
}
