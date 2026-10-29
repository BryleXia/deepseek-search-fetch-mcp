// Pure helpers for the DeepSeek Search/Fetch MCP server.
// No I/O here so every function is unit-testable.

export const MAX_QUERY_CHARS = 128;
export const MAX_ORI_QUESTION_CHARS = 128;
export const MAX_CONTENT_PER_RESULT = 6000;
export const MAX_TOTAL_CONTENT = 60000;
export const MAX_FETCH_URL_CHARS = 8192;

const FRESHNESS_DAYS = {
  oneDay: 1,
  oneWeek: 7,
  oneMonth: 30,
  oneYear: 365,
};

const PRIVATE_HOST_SUFFIXES = [".local", ".internal", ".lan", ".localhost", ".home.arpa"];

export function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      cleanup();
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function truncateByCodePoints(text, max) {
  const value = String(text ?? "");
  const chars = Array.from(value);
  if (chars.length <= max) {
    return { text: value, truncated: false, originalLength: chars.length };
  }
  return {
    text: chars.slice(0, max).join(""),
    truncated: true,
    originalLength: chars.length,
  };
}

export function normalizeOriQuestion(value) {
  if (value == null) return { value: null, truncated: false, originalLength: 0 };
  const trimmed = String(value).trim();
  if (!trimmed) return { value: null, truncated: false, originalLength: 0 };
  const result = truncateByCodePoints(trimmed, MAX_ORI_QUESTION_CHARS);
  return {
    value: result.text,
    truncated: result.truncated,
    originalLength: result.originalLength,
  };
}

export function appendFreshness(query, freshness, now = new Date()) {
  const value = String(query ?? "").trim();
  if (!freshness || freshness === "noLimit") {
    return { query: value, suffix: "", warning: null };
  }
  if (/\b(?:after|before):/i.test(value)) {
    return {
      query: value,
      suffix: "",
      warning: "freshness ignored: query already contains after:/before:",
    };
  }
  const days = FRESHNESS_DAYS[freshness];
  if (!days) {
    return { query: value, suffix: "", warning: `freshness ignored: unknown value "${freshness}"` };
  }
  const date = new Date(now.getTime() - days * 86400000);
  if (Number.isNaN(date.getTime())) {
    return { query: value, suffix: "", warning: "freshness ignored: invalid current date" };
  }
  const suffix = ` after:${date.toISOString().slice(0, 10)}`;
  return { query: value + suffix, suffix, warning: null };
}

export function composeSearchQuery(rawQuery, freshness, now = new Date()) {
  const base = String(rawQuery ?? "").trim();
  if (!base) {
    return { query: "", querySent: "", truncated: false, warnings: ["query is empty"] };
  }

  const fresh = appendFreshness(base, freshness, now);
  const warnings = [];
  if (fresh.warning) warnings.push(fresh.warning);

  const combined = fresh.query;
  if (Array.from(combined).length <= MAX_QUERY_CHARS) {
    return { query: base, querySent: combined, truncated: false, warnings };
  }

  const suffixLength = Array.from(fresh.suffix).length;
  const baseBudget = Math.max(0, MAX_QUERY_CHARS - suffixLength);
  const truncated = truncateByCodePoints(base, baseBudget);
  warnings.push(
    `query truncated from ${truncated.originalLength} to ${baseBudget} characters (max ${MAX_QUERY_CHARS}); refine keywords if needed`
  );

  return {
    query: base,
    querySent: truncated.text + fresh.suffix,
    truncated: true,
    warnings,
  };
}

function isPrivateIPv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  const first = Number.parseInt(h.split(":")[0] || "", 16);
  if (!Number.isNaN(first)) {
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  }
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function validateFetchUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, error: "url is empty" };
  if (value.length > MAX_FETCH_URL_CHARS) {
    return { ok: false, error: `url exceeds ${MAX_FETCH_URL_CHARS} characters` };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "url is not a valid absolute URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "only HTTP/HTTPS URLs are supported" };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "url must contain a host" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "url must not contain a username or password" };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, error: "localhost is not allowed" };
  }
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, error: "internal hostnames are not allowed" };
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && isPrivateIPv4(host)) {
    return { ok: false, error: "private IPv4 addresses are not allowed" };
  }
  if (host.includes(":") && isPrivateIPv6(host)) {
    return { ok: false, error: "private IPv6 addresses are not allowed" };
  }

  return { ok: true, url: parsed.toString() };
}

export function truncateContent(content, maxChars) {
  const value = String(content ?? "");
  const chars = Array.from(value);
  if (chars.length <= maxChars) {
    return { content: value, truncated: false, originalLength: chars.length };
  }
  return {
    content: chars.slice(0, maxChars).join("") + `\n\n[truncated at ${maxChars} characters]`,
    truncated: true,
    originalLength: chars.length,
  };
}

export function shapeSearchResults(apiResults, { needContent = false } = {}) {
  const warnings = [];
  let remainingContent = MAX_TOTAL_CONTENT;
  const input = Array.isArray(apiResults) ? apiResults : [];

  const results = input.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const shaped = {
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: item.snippet ?? "",
      summary: item.summary || item.snippet || "",
      date: item.date ?? null,
      site_name: item.site_name ?? null,
      authority: typeof item.authority === "number" ? item.authority : -1,
      rerank_score: typeof item.rerank_score === "number" ? item.rerank_score : null,
    };

    if (needContent) {
      const content = typeof item.content === "string" ? item.content : "";
      if (!content) {
        shaped.content = "";
        shaped.content_truncated = false;
      } else {
        const budget = Math.min(MAX_CONTENT_PER_RESULT, remainingContent);
        if (budget <= 0) {
          shaped.content = "";
          shaped.content_truncated = true;
          warnings.push(`result ${index + 1}: content omitted because the total content budget was exhausted`);
        } else {
          const truncated = truncateContent(content, budget);
          shaped.content = truncated.content;
          shaped.content_truncated = truncated.truncated;
          remainingContent -= Math.min(truncated.originalLength, budget);
          if (truncated.truncated) {
            warnings.push(
              `result ${index + 1}: content truncated from ${truncated.originalLength} to ${budget} characters`
            );
          }
        }
      }
    }

    return shaped;
  });

  return { results, warnings };
}

export function shapeFetchResult(api, { url, maxChars }) {
  const title = typeof api?.title === "string" ? api.title : "";
  const content = typeof api?.content === "string" ? api.content : "";
  if (!content) {
    return { error: "Fetch returned no page content." };
  }
  const truncated = truncateContent(content, maxChars);
  return {
    result: {
      url,
      title,
      content: truncated.content,
      truncated: truncated.truncated,
      original_chars: truncated.originalLength,
    },
  };
}
