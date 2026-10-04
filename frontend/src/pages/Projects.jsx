import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, money, months, num, pct, signedPct } from "../api";
import {
  BasisTag,
  Card,
  DataTable,
  ErrorNote,
  Loader,
  PageHead,
  RiskTag,
  useFetch,
} from "../ui";

const SORTS = [
  ["cost", "Approved cost"],
  ["expenditure", "Expenditure"],
  ["progress", "Physical progress"],
  ["risk", "Risk class"],
  ["cost_pressure", "Predicted cost pressure"],
  ["delay", "Predicted delay"],
];

const RISKS = ["", "High", "Medium", "Low"];
const MOVES = ["", "Escalating", "Unchanged"];

export default function Projects() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({
    search: "", sector: "", state: "", risk: "", movement: "",
    sort: "cost", page: 1, page_size: 25, min_cost: 0,
  });
  const reference = useFetch(() => api.reference(), []);
  const [query, setQuery] = useState(filters);
  const data = useFetch(() => api.projects(query), [JSON.stringify(query)]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const apply = () => setQuery({ ...filters, page: 1 });
  const reset = () => {
    const cleared = { search: "", sector: "", state: "", risk: "", movement: "", sort: "cost", page: 1, page_size: 25, min_cost: 0 };
    setFilters(cleared);
    setQuery(cleared);
  };

  const rows = data.data?.rows ?? [];
  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / query.page_size));

  return (
    <>
      <PageHead title="Project explorer"
        description="Filter the full panel, then open a project for its month-by-month history, peer comparison and model explanation." />

      <Card title="Filters">
        <div className="toolbar">
          <input placeholder="Project name, code or agency" value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && apply()} style={{ minWidth: 250 }} />

          <select value={filters.sector} onChange={(e) => set({ sector: e.target.value })}>
            <option value="">All sectors</option>
            {(reference.data?.sectors ?? []).map((s) => <option key={s}>{s}</option>)}
          </select>

          <select value={filters.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="">All states</option>
            {(reference.data?.states ?? []).map((s) => <option key={s}>{s}</option>)}
          </select>

          <select value={filters.risk} onChange={(e) => set({ risk: e.target.value })}>
            {RISKS.map((r) => <option key={r} value={r}>{r === "" ? "Any predicted risk" : `${r} risk`}</option>)}
          </select>

          <select value={filters.movement} onChange={(e) => set({ movement: e.target.value })}>
            {MOVES.map((m) => <option key={m} value={m}>{m === "" ? "Any movement" : m}</option>)}
          </select>

          <select value={filters.sort} onChange={(e) => { set({ sort: e.target.value }); apply(); }}>
            {SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}
          </select>

          <input type="number" min="0" step="100" value={filters.min_cost}
            onChange={(e) => set({ min_cost: Number(e.target.value) })}
            style={{ width: 130 }} placeholder="Min approved cost" />

          <button className="btn" onClick={apply}>Apply filters</button>
          <button className="btn ghost" onClick={reset}>Reset</button>
        </div>
      </Card>

      <Card title={`${num(total, 0)} projects`}
        hint={`Page ${query.page} of ${pages}`}
        actions={
          <div className="toolbar">
            <select value={query.page_size} onChange={(e) => { set({ page_size: Number(e.target.value) }); apply(); }}>
              {[25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
            <button className="btn ghost small" disabled={query.page <= 1}
              onClick={() => setQuery({ ...query, page: query.page - 1 })}>Previous</button>
            <button className="btn ghost small" disabled={query.page >= pages}
              onClick={() => setQuery({ ...query, page: query.page + 1 })}>Next</button>
          </div>
        }
        flush>
        {data.loading ? <Loader label="Loading projects" />
          : data.error ? <ErrorNote error={data.error} /> : (
            <DataTable
              rows={rows}
              empty="No project matches these filters"
              onRowClick={(row) => navigate(`/projects/${row.project_code}`)}
              columns={[
                { key: "project_code", label: "Code", render: (r) => <code style={{ fontSize: 12 }}>{r.project_code}</code> },
                {
                  key: "project_name",
                  label: "Project",
                  render: (r) => (
                    <span>
                      <strong style={{ fontWeight: 600 }}>{String(r.project_name).slice(0, 52)}</strong>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>{r.sector} &middot; {r.state}</div>
                    </span>
                  ),
                },
                { key: "original_cost", label: "Approved", align: "right", render: (r) => money(r.original_cost) },
                { key: "expenditure", label: "Expenditure", align: "right", render: (r) => money(r.expenditure) },
                { key: "physical_progress", label: "Progress", align: "right", render: (r) => pct(r.physical_progress) },
                { key: "expenditure_pct_of_cost", label: "Spend %", align: "right", render: (r) => pct(r.expenditure_pct_of_cost) },
                {
                  key: "predicted_cost_pressure_pct",
                  label: "Predicted pressure",
                  align: "right",
                  render: (r) => signedPct(r.predicted_cost_pressure_pct, 2),
                },
                {
                  key: "cost_overrun_basis",
                  label: "Overrun basis",
                  render: (r) => <BasisTag value={r.cost_overrun_basis} />,
                },
                {
                  key: "predicted_time_overrun_months",
                  label: "Delay",
                  align: "right",
                  render: (r) => months(r.predicted_time_overrun_months, 1),
                },
                { key: "risk_class", label: "Risk today", render: (r) => <RiskTag value={r.risk_class} /> },
                { key: "predicted_risk_class", label: "Predicted", render: (r) => <RiskTag value={r.predicted_risk_class} /> },
                { key: "confidence", label: "Confidence", align: "right", render: (r) => pct(r.confidence * 100, 0) },
              ]}
            />
          )}
      </Card>
    </>
  );
}