const BASE = import.meta.env.VITE_API ?? "";

// Distinguishes "the service is down" from "the service answered and said no".
// Without this every failure surfaces as the same generic banner, which sends you
// looking at the server when the real problem is a bad project code or an
// out-of-range slider.
class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.offline = status === 0;
  }
}

function detailText(body, fallback) {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((item) => `${(item.loc ?? []).slice(1).join(".") || "input"}: ${item.msg ?? "invalid"}`)
      .join("; ");
  }
  return fallback;
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(BASE + path, options);
  } catch {
    throw new ApiError("Could not reach the API service", 0,
      "No response from the backend. Check that it is running.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(detailText(body, `${path} failed: ${response.status}`),
      response.status, body?.detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function get(path, params) {
  const url = new URL(BASE + path, window.location.origin);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== "" && value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  return request(url.toString(), { method: "GET" });
}

async function post(path, body) {
  return request(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export const api = {
  overview: (month) => get("/api/overview", { month }),
  reference: () => get("/api/reference"),
  breakdown: (dimension, month, limit) => get("/api/breakdown", { dimension, month, limit }),
  portfolioTrend: (dimension) => get("/api/portfolio-trend", { dimension }),
  projects: (filters) => get("/api/projects", filters),
  project: (code) => get(`/api/projects/${code}`),
  explain: (code) => get(`/api/projects/${code}/explain`),
  whatIf: (payload) => post("/api/what-if", payload),
  benchmarks: (dimension, limit) => get("/api/benchmarks", { dimension, limit }),
  drivers: (limit) => get("/api/drivers", { limit }),
  metrics: () => get("/api/model/metrics"),
  dataGap: () => get("/api/data-gap"),
  alerts: (limit) => get("/api/alerts", { limit }),
  sectorMap: () => get("/api/sector-map"),
  timeline: (code) => get("/api/health-timeline", { project_code: code }),
  assistant: (question) => post("/api/assistant", { question }),
  suggestions: () => get("/api/search-suggestions"),
  glossary: () => get("/api/field-glossary"),
};

// A dash means "the portal did not publish this". It is deliberately typed as an
// en dash rather than a hyphen, and it never carries a unit: `-%` and `- mo` read
// as a broken figure rather than an absent one.
export const MISSING = "–";

export const isMissing = (value) =>
  value === null || value === undefined || value === "" || Number.isNaN(Number(value));

export const money = (value) => {
  if (isMissing(value)) return MISSING;
  if (Math.abs(value) >= 100000) return `Rs ${(value / 100000).toFixed(2)} lakh crore`;
  return `Rs ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })} cr`;
};

export const num = (value, digits = 1) =>
  isMissing(value)
    ? MISSING
    : Number(value).toLocaleString("en-IN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

export const pct = (value, digits = 1) =>
  isMissing(value) ? MISSING : `${Number(value).toFixed(digits)}%`;

// for figures where a positive number carries meaning, so the sign is spelled out
export const signedPct = (value, digits = 1) =>
  isMissing(value)
    ? MISSING
    : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;

// unit-aware formatters for the measures the portal leaves empty
export const months = (value, digits = 1) =>
  isMissing(value) ? MISSING : `${num(value, digits)} mo`;

export const signedMonths = (value, digits = 1) =>
  isMissing(value)
    ? MISSING
    : `${Number(value) > 0 ? "+" : ""}${num(value, digits)} months`;

export const points = (value, digits = 1) =>
  isMissing(value) ? MISSING : `${num(value, digits)} pp`;

// ratios arrive as fractions and are always shown as a percentage
export const share = (value, digits = 1) =>
  isMissing(value) ? MISSING : `${(Number(value) * 100).toFixed(digits)}%`;

export const monthLabel = (monthYear) => {
  if (!monthYear) return "";
  const [year, month] = monthYear.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(month) - 1]} ${year}`;
};