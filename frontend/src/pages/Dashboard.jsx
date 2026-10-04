import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, money, monthLabel, num, pct } from "../api";
import {
  AXIS,
  Card,
  DataTable,
  ErrorNote,
  Loader,
  MiniBar,
  PageHead,
  PortfolioBars,
  RiskPie,
  RiskTag,
  TOOLTIP,
  Tile,
  useFetch,
} from "../ui";

const TABS = [
  ["sector", "By sector"],
  ["state", "By state"],
  ["progress_slab", "By progress slab"],
];

export default function Dashboard() {
  const [dimension, setDimension] = useState("sector");
  const overview = useFetch(() => api.overview(), []);
  const trend = useFetch(() => api.portfolioTrend("portfolio"), []);
  const breakdown = useFetch(() => api.breakdown(dimension), [dimension]);
  const alerts = useFetch(() => api.alerts(8), []);
  const data = overview.data;

  if (overview.loading) return <Loader label="Loading dashboard" />;
  if (overview.error) return <ErrorNote error={overview.error} />;

  const rows = breakdown.data?.rows ?? [];
  const utilisation = (row) => (row.original_cost ? (row.expenditure / row.original_cost) * 100 : 0);

  const portfolioRows = trend.data?.rows ?? [];
  const trendData = portfolioRows.map((row) => ({
    month: monthLabel(row.month_year),
    Approved: row.original_cost / 100000,
    Revised: row.revised_cost ? row.revised_cost / 100000 : null,
    Expenditure: row.expenditure / 100000,
  }));

  return (
    <>
      <PageHead title="Portfolio overview"
        description={`Every figure below is read from the ${data.freeze_label} freeze of the PAIMANA project panel. Risk figures are one-month-ahead model outputs, not published statistics.`} />

      <div className="tiles">
        <Tile label="Projects monitored" value={num(data.projects, 0)}
          note={`Latest freeze ${data.freeze_label}`} />
        <Tile label="Approved cost" value={money(data.approved_cost_cr)}
          note={`Spending ${pct(data.utilisation_pct, 2)} of sanctioned cost`} />
        <Tile label="Expenditure" value={money(data.expenditure_cr)}
          note={`${money(data.unspent_cr)} still unspent`} tone="good" />
        <Tile label="Mean physical progress" value={pct(data.mean_physical_progress)}
          note="Across all monitored projects" />
        <Tile label="Predicted high risk" value={num(data.predicted_high_risk, 0)}
          note={`${num(data.new_high_risk_entries, 0)} new entries next month`} tone="bad" />
        <Tile label="Reported revised cost"
          value={money(data.reported_revised_cost_cr)}
          note={`Only ${num(data.projects_with_reported_revised_cost, 0)} projects carry a revised cost in the report tables`}
          tone="warn" />
      </div>

      <div className="split">
        <Card title="Cost and expenditure trend" hint="Lakh crore, from the portal's monthly aggregates">
          <ResponsiveContainer width="100%" height={265}>
            <BarChart data={trendData} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#edf0f5" />
              <XAxis dataKey="month" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} tickFormatter={(v) => `${v}L`} width={44} />
              <Tooltip {...TOOLTIP} formatter={(v, name) => [`Rs ${num(v, 2)} lakh cr`, name]} />
              <Bar dataKey="Approved" fill="#012677" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Revised" fill="#f0a742" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Expenditure" fill="#1d7a4c" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Predicted risk mix" hint="Risk class the models expect next month">
          <RiskPie mix={data.predicted_risk_mix} />
          <div className="note-block" style={{ marginTop: 10 }}>
            Current published position: {Object.entries(data.current_risk_mix)
              .map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}. The mix shifts to
            {" "}{data.predicted_high_risk} high-risk projects because the model expects
            slippage and budget pressure to build over the next month.
          </div>
        </Card>
      </div>

      <Card title="Where the money sits"
        hint="Approved outlay by dimension, live portal aggregates"
        actions={
          <div className="pills">
            {TABS.map(([key, label]) => (
              <button key={key} className={`pill ${dimension === key ? "on" : ""}`}
                onClick={() => setDimension(key)}>
                {label}
              </button>
            ))}
          </div>
        }
        flush>
        <DataTable
          rows={rows}
          onRowClick={null}
          columns={[
            {
              key: "label",
              label: dimension === "progress_slab" ? "Progress slab" : dimension === "state" ? "State" : "Sector",
              render: (row) => row.label,
            },
            { key: "projects", label: "Projects", align: "right", render: (r) => num(r.projects, 0) },
            { key: "original_cost", label: "Approved", align: "right", render: (r) => money(r.original_cost) },
            {
              key: "revised_cost",
              label: "Revised (reported)",
              align: "right",
              render: (r) => (r.revised_cost ? money(r.revised_cost) : <span className="tag neutral">Not published</span>),
            },
            { key: "expenditure", label: "Expenditure", align: "right", render: (r) => money(r.expenditure) },
            {
              key: "utilisation",
              label: "Utilisation",
              render: (r) => (
                <div style={{ minWidth: 120 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span>{pct(utilisation(r))}</span>
                  </div>
                  <MiniBar value={utilisation(r)} max={100}
                    tone={utilisation(r) > 90 ? "high" : utilisation(r) > 60 ? "medium" : "low"} />
                </div>
              ),
            },
          ]}
        />
      </Card>

      <div className="grid-2">
        <Card title="Projects needing attention first"
          hint="Highest predicted cost pressure, from the alerts page"
          actions={<Link className="btn ghost small" to="/risk">Open risk page</Link>}
          flush>
          <DataTable
            rows={alerts.data?.rows ?? []}
            empty="No alerts in this freeze"
            onRowClick={(row) => { window.location.href = `/projects/${row.project_code}`; }}
            columns={[
              {
                key: "project_name",
                label: "Project",
                render: (r) => (
                  <span>
                    <strong style={{ fontWeight: 600 }}>{String(r.project_name).slice(0, 46)}</strong>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>{r.sector} &middot; {r.state}</div>
                  </span>
                ),
              },
              { key: "physical_progress", label: "Progress", align: "right", render: (r) => pct(r.physical_progress) },
              {
                key: "predicted_cost_pressure_pct",
                label: "Cost pressure",
                align: "right",
                render: (r) => `${r.predicted_cost_pressure_pct > 0 ? "+" : ""}${num(r.predicted_cost_pressure_pct, 2)}%`,
              },
              {
                key: "predicted_time_overrun_months",
                label: "Delay",
                align: "right",
                render: (r) => `${num(r.predicted_time_overrun_months, 1)} mo`,
              },
              { key: "predicted_risk_class", label: "Risk", render: (r) => <RiskTag value={r.predicted_risk_class} /> },
            ]}
          />
        </Card>

        <Card title="Largest approved outlay"
          hint="Where the sanctioned budget is concentrated">
          <PortfolioBars rows={rows.slice(0, 12)} valueKey="original_cost" />
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Expenditure against approved cost" hint={dimension === "sector" ? "Top sectors" : `Top ${dimension.replace("_", " ")}`}>
          <ResponsiveContainer width="100%" height={270}>
            <BarChart data={rows.slice(0, 10).map((r) => ({
              name: String(r.label).slice(0, 16),
              Approved: r.original_cost / 1000,
              Expenditure: r.expenditure / 1000,
            }))} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#edf0f5" />
              <XAxis dataKey="name" tick={AXIS} interval={0} angle={-22} textAnchor="end" height={54} />
              <YAxis tick={AXIS} tickFormatter={(v) => `${v}k`} width={44} />
              <Tooltip {...TOOLTIP} formatter={(v) => [`Rs ${num(v, 1)}k cr`, ""]} />
              <Bar dataKey="Approved" fill="#012677" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Expenditure" fill="#1d7a4c" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="How to read this dashboard">
          <div className="note-block">
            Cost overrun is only published per project for the major-project tables, so this
            build reports <strong>cost pressure</strong> everywhere else: how far spending sits
            against the sanctioned cost. It is a measured figure from the same report, not an
            estimate of a revised cost.
          </div>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Approved cost</dt>
            <dd>{money(data.approved_cost_cr)} across {num(data.projects, 0)} projects</dd>
            <dt>Expenditure</dt>
            <dd>{money(data.expenditure_cr)}</dd>
            <dt>Utilisation</dt>
            <dd>{pct(data.utilisation_pct, 2)}</dd>
            <dt>Freeze range</dt>
            <dd>July 2025 to {data.freeze_label}</dd>
            <dt>Source</dt>
            <dd>{data.source}</dd>
          </dl>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <Link className="btn" to="/models">See model validation</Link>
            <Link className="btn ghost" to="/data-gap">What data is missing</Link>
          </div>
        </Card>
      </div>
    </>
  );
}