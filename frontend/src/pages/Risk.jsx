import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, num, pct } from "../api";
import {
  AXIS,
  Card,
  DataTable,
  ErrorNote,
  Loader,
  PageHead,
  PALETTE,
  RISK_COLOR,
  RiskTag,
  Tile,
  TOOLTIP,
  useFetch,
} from "../ui";

const FILTERS = ["All", "New high-risk entry", "High risk next month"];

export default function Risk() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("All");
  const alerts = useFetch(() => api.alerts(120), []);
  const projects = useFetch(
    () => api.projects({ risk: "High", sort: "cost_pressure", page_size: 40 }),
    [],
  );

  if (alerts.loading) return <Loader label="Loading risk view" />;
  if (alerts.error) return <ErrorNote error={alerts.error} />;

  const counts = Object.fromEntries((alerts.data?.counts ?? []).map((c) => [c.alert, c.n]));
  const rows = (alerts.data?.rows ?? []).filter((r) => filter === "All" || r.alert === filter);

  const bySector = Object.values(
    (projects.data?.rows ?? []).reduce((acc, row) => {
      const key = row.sector ?? "Not stated";
      acc[key] ??= { sector: key, projects: 0, pressure: 0 };
      acc[key].projects += 1;
      acc[key].pressure += row.predicted_cost_pressure_pct ?? 0;
      return acc;
    }, {}),
  ).map((item) => ({ ...item, pressure: item.pressure / item.projects }))
    .sort((a, b) => b.pressure - a.pressure).slice(0, 12);

  const mix = [
    { name: "New high-risk entry", value: counts["New high-risk entry"] ?? 0 },
    { name: "High risk next month", value: counts["High risk next month"] ?? 0 },
  ];

  return (
    <>
      <PageHead title="Risk and early warnings"
        description="Projects the models expect to enter or stay in the high-risk band at the next freeze, ordered by predicted cost pressure.">
        <div className="pills">
          {FILTERS.map((f) => (
            <button key={f} className={`pill ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
              {f === "All" ? `All alerts (${(mix[0].value ?? 0) + (mix[1].value ?? 0)})` : f}
            </button>
          ))}
        </div>
      </PageHead>

      <div className="tiles">
        <Tile label="Projects on watch" value={num((mix[0].value ?? 0) + (mix[1].value ?? 0), 0)}
          note="Predicted high risk at the next freeze" tone="bad" />
        <Tile label="New high-risk entries"
          value={num(counts["New high-risk entry"] ?? 0, 0)}
          note="Not high risk today, expected to cross next month" tone="warn" />
        <Tile label="Already high risk"
          value={num(counts["High risk next month"] ?? 0, 0)}
          note="High risk today and expected to stay there" />
        <Tile label="Review priority" value="New entries first"
          note="These are the ones an early-warning system exists for" tone="warn" />
      </div>

      <div className="grid-2">
        <Card title="Alert composition">
          <ResponsiveContainer width="100%" height={230}>
            <PieChart>
              <Pie data={mix} dataKey="value" nameKey="name" innerRadius={55} outerRadius={88}
                paddingAngle={2} stroke="#fff">
                {mix.map((entry, i) => (
                  <Cell key={entry.name} fill={[RISK_COLOR.High, "#e08a2f"][i % 2]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP} />
            </PieChart>
          </ResponsiveContainer>
          <div className="legend">
            {mix.map((entry, i) => (
              <span key={entry.name}>
                <i style={{ background: [RISK_COLOR.High, "#e08a2f"][i] }} />
                {entry.name} &middot; {num(entry.value, 0)}
              </span>
            ))}
          </div>
          <div className="note-block" style={{ marginTop: 10 }}>
            A new entry is the actionable case: the project is fine on today's published
            numbers but the model expects slippage or budget pressure to build over the next
            month. Those are the projects where a review still changes the outcome.
          </div>
        </Card>

        <Card title="Where the pressure concentrates"
          hint="Average predicted cost pressure across the highest-risk projects">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={bySector} margin={{ top: 6, right: 14, bottom: 54, left: 4 }}>
              <CartesianGrid stroke="#edf0f5" />
              <XAxis dataKey="sector" tick={AXIS} interval={0} angle={-32}
                textAnchor="end" height={70} />
              <YAxis tick={AXIS} tickFormatter={(v) => `${v}%`} width={46} />
              <Tooltip {...TOOLTIP} formatter={(v) => [`${num(v, 2)}%`, "Avg cost pressure"]} />
              <Bar dataKey="pressure" radius={[2, 2, 0, 0]}>
                {bySector.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title={`Watchlist (${num(rows.length, 0)} shown)`}
        hint="Click a row to open the project record and its explanation"
        flush>
        <DataTable
          rows={rows}
          empty="No project matches this alert type"
          onRowClick={(row) => navigate(`/projects/${row.project_code}`)}
          columns={[
            { key: "project_code", label: "Code", render: (r) => <code style={{ fontSize: 12 }}>{r.project_code}</code> },
            {
              key: "project_name",
              label: "Project",
              render: (r) => (
                <span>
                  <strong style={{ fontWeight: 600 }}>{String(r.project_name).slice(0, 50)}</strong>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{r.sector} &middot; {r.state}</div>
                </span>
              ),
            },
            { key: "risk_class", label: "Risk today", render: (r) => <RiskTag value={r.risk_class} /> },
            { key: "predicted_risk_class", label: "Predicted", render: (r) => <RiskTag value={r.predicted_risk_class} /> },
            {
              key: "alert",
              label: "Alert",
              render: (r) => (
                <span className={`tag ${r.alert === "New high-risk entry" ? "high" : "neutral"}`}>
                  {r.alert}
                </span>
              ),
            },
            { key: "physical_progress", label: "Progress", align: "right", render: (r) => pct(r.physical_progress) },
            { key: "progress_gap", label: "Progress gap", align: "right", render: (r) => num(r.progress_gap, 1) },
            {
              key: "predicted_cost_pressure_pct",
              label: "Cost pressure",
              align: "right",
              render: (r) => `${num(r.predicted_cost_pressure_pct, 2)}%`,
            },
            {
              key: "predicted_time_overrun_months",
              label: "Delay",
              align: "right",
              render: (r) => `${num(r.predicted_time_overrun_months, 1)} mo`,
            },
            { key: "confidence", label: "Confidence", align: "right", render: (r) => pct(r.confidence * 100, 0) },
          ]}
        />
      </Card>
    </>
  );
}