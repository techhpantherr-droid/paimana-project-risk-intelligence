const BASE = import.meta.env.VITE_API ?? "";

async function get(path, params) {
  const url = new URL(BASE + path);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== "" && value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail ?? `${path} failed: ${response.status}`);
  }
  return response.json();
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
};

export const money = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (Math.abs(value) >= 100000)
    return `Rs ${(value / 100000).toFixed(2)} lakh crore`;
  return `Rs ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })} cr`;
};

export const num = (value, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "-"
    : Number(value).toLocaleString("en-IN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

export const pct = (value, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "-"
    : `${Number(value).toFixed(digits)}%`;

export const monthLabel = (monthYear) => {
  if (!monthYear) return "";
  const [year, month] = monthYear.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(month) - 1]} ${year}`;
};