import test from "node:test";
import assert from "node:assert/strict";
import {
  truncateByCodePoints,
  normalizeOriQuestion,
  appendFreshness,
  composeSearchQuery,
  validateFetchUrl,
  truncateContent,
  shapeSearchResults,
  shapeFetchResult,
  MAX_QUERY_CHARS,
} from "../lib/format.mjs";
import { RequestPacer } from "../lib/client.mjs";

test("truncateByCodePoints counts code points", () => {
  assert.deepEqual(truncateByCodePoints("😀😀😀", 2), {
    text: "😀😀",
    truncated: true,
    originalLength: 3,
  });
  assert.deepEqual(truncateByCodePoints("abc", 5), {
    text: "abc",
    truncated: false,
    originalLength: 3,
  });
});

test("normalizeOriQuestion trims and truncates to 128", () => {
  const result = normalizeOriQuestion("  " + "a".repeat(200) + "  ");
  assert.equal(result.value.length, 128);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 200);
  assert.equal(normalizeOriQuestion("   ").value, null);
});

test("appendFreshness maps oneWeek to an after: date", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  const result = appendFreshness("测试", "oneWeek", now);
  assert.equal(result.query, "测试 after:2026-10-10");
  assert.equal(result.suffix, " after:2026-10-10");
  assert.equal(result.warning, null);
});

test("appendFreshness ignores when query already has after:/before:", () => {
  const result = appendFreshness("测试 after:2026-01-01", "oneWeek");
  assert.equal(result.query, "测试 after:2026-01-01");
  assert.match(result.warning, /ignored/);
});

test("composeSearchQuery preserves the freshness suffix while truncating", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  const result = composeSearchQuery("x".repeat(300), "oneWeek", now);
  assert.equal(Array.from(result.querySent).length, MAX_QUERY_CHARS);
  assert.ok(result.querySent.endsWith(" after:2026-10-10"));
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some((warning) => warning.includes("truncated")));
});

test("composeSearchQuery keeps short queries unchanged", () => {
  const result = composeSearchQuery("北京 博物馆", "noLimit");
  assert.equal(result.querySent, "北京 博物馆");
  assert.equal(result.truncated, false);
});

test("validateFetchUrl accepts public URLs", () => {
  for (const url of [
    "https://example.com",
    "http://example.com/path?q=1",
    "https://api-docs.deepseek.com/guides/search",
  ]) {
    assert.equal(validateFetchUrl(url).ok, true, url);
  }
});

test("validateFetchUrl rejects internal and invalid URLs", () => {
  const bad = [
    "ftp://example.com",
    "file:///C:/temp/a.txt",
    "http://localhost:8080",
    "http://foo.localhost/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.1.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://service.internal/",
    "https://user:pass@example.com/",
    "not a url",
  ];
  for (const url of bad) {
    assert.equal(validateFetchUrl(url).ok, false, url);
  }
});

test("truncateContent appends a marker", () => {
  const result = truncateContent("abcdef", 3);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 6);
  assert.ok(result.content.startsWith("abc"));
  assert.match(result.content, /truncated at 3 characters/);
});

test("shapeSearchResults omits site_icon, falls back summary, and truncates content", () => {
  const { results, warnings } = shapeSearchResults(
    [
      {
        title: "T",
        url: "https://example.com",
        snippet: "S",
        summary: "",
        content: "C".repeat(7000),
        site_icon: "https://example.com/favicon.ico",
        site_name: "Example",
        date: "2026-10-17T00:00:00Z",
        authority: 3,
        rerank_score: 2.1,
      },
    ],
    { needContent: true }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].summary, "S");
  assert.equal(results[0].site_icon, undefined);
  assert.equal(results[0].site_name, "Example");
  assert.equal(results[0].authority, 3);
  assert.equal(results[0].content_truncated, true);
  assert.ok(warnings.some((warning) => warning.includes("content truncated")));
});

test("shapeFetchResult returns content and truncation metadata", () => {
  const shaped = shapeFetchResult(
    { title: "Example", content: "abc" },
    { url: "https://example.com", maxChars: 2 }
  );
  assert.equal(shaped.result.title, "Example");
  assert.equal(shaped.result.truncated, true);
  assert.equal(shaped.result.original_chars, 3);
  assert.match(shaped.result.content, /truncated at 2 characters/);

  const empty = shapeFetchResult({ title: "Empty", content: "" }, { url: "https://example.com", maxChars: 10 });
  assert.ok(empty.error);
});

test("RequestPacer spaces calls", async () => {
  const pacer = new RequestPacer(50);
  const started = Date.now();
  await pacer.acquire();
  await pacer.acquire();
  await pacer.acquire();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 90, `expected >= 90ms, got ${elapsed}ms`);
});
