import fs from "node:fs";
import {
  sleep,
  composeSearchQuery,
  normalizeOriQuestion,
  validateFetchUrl,
  shapeSearchResults,
  shapeFetchResult,
} from "./format.mjs";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

const SEARCH_TIMEOUT_MS = 15000;
const SEARCH_DEADLINE_MS = 45000;
const SEARCH_MAX_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 25000;
const FETCH_DEADLINE_MS = 55000;
const FETCH_MAX_ATTEMPTS = 2;
const REQUEST_INTERVAL_MS = 250; // 4 requests/sec, leaving headroom under the 5 QPS account limit
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class DeepSeekError extends Error {
  constructor(message, { status = null, retryable = false, cause = null } = {}) {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

function stripQuotes(text) {
  return text.replace(/^['"]|['"]$/g, "");
}

export function resolveConfig() {
  const rawBase = (process.env.DEEPSEEK_API_BASE || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const isHttps = /^https:\/\//i.test(rawBase);
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(rawBase);
  if (!isHttps && !isLocalHttp) {
    throw new DeepSeekError("DEEPSEEK_API_BASE must use HTTPS (HTTP is allowed only for localhost tests).");
  }

  const envKey = stripQuotes((process.env.DEEPSEEK_API_KEY || "").trim());
  if (envKey) {
    return { apiKey: envKey, keySource: "env", keyFile: null, baseUrl: rawBase };
  }

  const keyFile = (process.env.DEEPSEEK_API_KEY_FILE || "").trim();
  if (keyFile) {
    try {
      if (fs.existsSync(keyFile)) {
        const key = stripQuotes(stripBom(fs.readFileSync(keyFile, "utf8")).trim()).trim();
        if (key) {
          return { apiKey: key, keySource: "file", keyFile, baseUrl: rawBase };
        }
      }
    } catch {
      // Missing/unreadable key file: keep the server alive and fail on tool calls.
    }
  }

  return { apiKey: null, keySource: "none", keyFile: keyFile || null, baseUrl: rawBase };
}

export class RequestPacer {
  constructor(intervalMs = REQUEST_INTERVAL_MS) {
    this.intervalMs = intervalMs;
    this.nextAt = 0;
  }

  async acquire(signal) {
    const now = Date.now();
    const startAt = Math.max(now, this.nextAt);
    this.nextAt = startAt + this.intervalMs;
    if (startAt > now) {
      await sleep(startAt - now, signal);
    }
  }

  pause(ms) {
    if (ms > 0) {
      this.nextAt = Math.max(this.nextAt, Date.now() + ms);
    }
  }
}

const searchPacer = new RequestPacer();
const fetchPacer = new RequestPacer();

function redactSecrets(text) {
  return String(text ?? "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.min(10000, Math.floor(seconds * 1000)));
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(10000, date - Date.now()));
  }
  return 0;
}

function backoffMs(attempt) {
  const base = [500, 1500, 4000][Math.min(attempt - 1, 2)];
  return base + Math.floor(Math.random() * 250);
}

function isRetryableNetworkError(error) {
  const code = error?.code || error?.cause?.code || "";
  if (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }
  return /fetch failed|network/i.test(error?.message || "");
}

function parseErrorBody(status, statusText, text, config) {
  let apiMessage = "";
  try {
    const parsed = JSON.parse(text);
    apiMessage = parsed?.error?.message || parsed?.message || "";
  } catch {
    // Non-JSON gateway response; fall back to the raw body.
  }

  const detail = redactSecrets(apiMessage || text || statusText || "").slice(0, 300);
  let message;

  switch (status) {
    case 400:
      message = `DeepSeek 400 invalid_request: ${detail || "bad request"}. Check query length (<=128) and count (1-50).`;
      break;
    case 401:
      message = config.keyFile
        ? `DeepSeek 401 unauthorized: the key in ${config.keyFile} is invalid. Replace it and restart your MCP client.`
        : "DeepSeek 401 unauthorized: DEEPSEEK_API_KEY is missing or invalid. Check the key and restart your MCP client.";
      break;
    case 402:
      message =
        "DeepSeek 402 balance: account balance insufficient (¥5/1000 requests). Top up at platform.deepseek.com.";
      break;
    case 403:
      message = "DeepSeek 403 fetch_blocked: URL rejected by DeepSeek security policy.";
      break;
    case 404:
      message =
        "DeepSeek 404 no_content: no usable content at URL (JS-heavy, paywalled, PDF, anti-bot). Try a dedicated crawler.";
      break;
    case 408:
      message = "DeepSeek 408 timeout after retries; retry later or use another provider.";
      break;
    case 413:
      message = "DeepSeek 413 too_large: URL or response exceeds limits; shorten the URL or use another fetch provider.";
      break;
    case 429:
      message = "DeepSeek 429 rate_limited: 5 QPS account-wide; wait a few seconds and retry.";
      break;
    default:
      message =
        status >= 500
          ? `DeepSeek ${status} upstream error; retry later.`
          : `DeepSeek ${status} error: ${detail || statusText || "request failed"}`;
  }

  return new DeepSeekError(message, { status, retryable: RETRYABLE_STATUS.has(status) });
}

async function postJson(config, endpoint, path, body, options) {
  if (!config.apiKey) {
    throw new DeepSeekError(
      config.keyFile
        ? `DeepSeek API key not configured: DEEPSEEK_API_KEY_FILE points to ${config.keyFile}, but the file is missing or empty.`
        : "DeepSeek API key not configured. Set DEEPSEEK_API_KEY (or DEEPSEEK_API_KEY_FILE pointing to a file that contains the key), then restart your MCP client."
    );
  }

  const started = Date.now();
  const deadline = started + options.deadlineMs;
  let lastError = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (deadline - Date.now() <= 0) break;
    await options.pacer.acquire(options.signal);

    const timeoutMs = Math.min(options.timeoutMs, Math.max(1, deadline - Date.now()));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;
    const attemptStarted = Date.now();

    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "deepseek-search-mcp/1.0.0",
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      const text = await response.text();

      if (response.ok) {
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          const error = new DeepSeekError(
            `DeepSeek ${response.status} bad_gateway: non-JSON response (${redactSecrets(text).slice(0, 300) || "empty"})`,
            { status: response.status, retryable: true }
          );
          lastError = error;
          if (attempt < options.maxAttempts) {
            await sleep(backoffMs(attempt), options.signal);
            continue;
          }
          throw error;
        }

        console.error(
          `[deepseek-search] endpoint=${endpoint} status=${response.status} attempt=${attempt} ms=${Date.now() - started} bytes=${text.length}`
        );
        return { data, status: response.status, attempts: attempt };
      }

      const error = parseErrorBody(response.status, response.statusText, text, config);
      lastError = error;
      console.error(
        `[deepseek-search] endpoint=${endpoint} status=${response.status} attempt=${attempt} ms=${Date.now() - started} retryable=${error.retryable}`
      );

      if (error.retryable && attempt < options.maxAttempts) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfter > 0) options.pacer.pause(retryAfter);
        await sleep(retryAfter || backoffMs(attempt), options.signal);
        continue;
      }
      throw error;
    } catch (caught) {
      if (caught instanceof DeepSeekError) {
        if (caught.retryable && attempt < options.maxAttempts) {
          lastError = caught;
          await sleep(backoffMs(attempt), options.signal);
          continue;
        }
        throw caught;
      }

      if (options.signal?.aborted) {
        const cancelled = new Error("DeepSeek request was cancelled.");
        cancelled.name = "AbortError";
        throw cancelled;
      }

      const timedOut = timeoutSignal.aborted;
      const error = new DeepSeekError(
        timedOut
          ? `DeepSeek request timed out after ${timeoutMs}ms.`
          : `DeepSeek network_error: ${caught?.message || String(caught)}. Check network/proxy/TLS.`,
        { retryable: timedOut || isRetryableNetworkError(caught), cause: caught }
      );
      lastError = error;
      console.error(
        `[deepseek-search] endpoint=${endpoint} attempt=${attempt} ms=${Date.now() - started} error=${timedOut ? "timeout" : "network"} retryable=${error.retryable}`
      );

      if (error.retryable && attempt < options.maxAttempts) {
        await sleep(backoffMs(attempt), options.signal);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new DeepSeekError("DeepSeek request failed after retries.", { retryable: false });
}

export async function search(
  config,
  { query, count = 10, need_content = false, ori_question, freshness = "noLimit", signal } = {}
) {
  const composed = composeSearchQuery(query, freshness);
  if (!composed.querySent) {
    throw new DeepSeekError("DeepSeek search query is empty.");
  }

  const warnings = [...composed.warnings];
  const body = { query: composed.querySent, count, need_content };
  if (ori_question) {
    const normalized = normalizeOriQuestion(ori_question);
    if (normalized.value) body.ori_question = normalized.value;
    if (normalized.truncated) {
      warnings.push(`ori_question truncated from ${normalized.originalLength} to 128 characters`);
    }
  }

  const { data } = await postJson(config, "search", "/v1/tools/search", body, {
    pacer: searchPacer,
    timeoutMs: SEARCH_TIMEOUT_MS,
    deadlineMs: SEARCH_DEADLINE_MS,
    maxAttempts: SEARCH_MAX_ATTEMPTS,
    signal,
  });

  const shaped = shapeSearchResults(data?.results, { needContent: Boolean(need_content) });
  warnings.push(...shaped.warnings);
  if (shaped.results.length === 0) {
    warnings.push("No matching results. Try broader keywords or remove operators.");
  }

  return {
    query: composed.query,
    query_sent: composed.querySent,
    count: shaped.results.length,
    results: shaped.results,
    warnings,
  };
}

export async function fetchPage(config, { url, max_chars = 50000, signal } = {}) {
  const validated = validateFetchUrl(url);
  if (!validated.ok) {
    throw new DeepSeekError(`DeepSeek fetch URL rejected: ${validated.error}`);
  }

  const maxChars = Math.max(1000, Math.min(500000, Number(max_chars) || 50000));
  const { data } = await postJson(config, "fetch", "/v1/tools/fetch", { url: validated.url }, {
    pacer: fetchPacer,
    timeoutMs: FETCH_TIMEOUT_MS,
    deadlineMs: FETCH_DEADLINE_MS,
    maxAttempts: FETCH_MAX_ATTEMPTS,
    signal,
  });

  const shaped = shapeFetchResult(data, { url: validated.url, maxChars });
  if (shaped.error) {
    throw new DeepSeekError(`DeepSeek ${shaped.error}`);
  }
  return shaped.result;
}
