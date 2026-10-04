import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { api, money, num, pct } from "../api";
import {
  AXIS,
  Card,
  DataTable,
  ErrorNote,
  Loader,
  MiniBar,
  PALETTE,
  PageHead,
  Tile,
  TOOLTIP,
  useFetch,
} from "../ui";

export default function Benchmarks() {
  const navigate = useNavigate();
  const [dimension, setDimension] = useState("sector");
  const data = useFetch(() => api.benchmarks(dimension, 30), [dimension]);
  const projects = useFetch(() => api.projects({ page_size: 300, sort: "cost" }), []);

  if (data.loading || projects.loading) return <Loader label="Loading benchmarks" />;
  if (data.error) return <ErrorNote error={data.error} />;

  const rows = data.data?.rows ?? [];
  const best = data.data?.best_performers ?? [];
  const scatter = (projects.data?.rows ?? [])
    .filter((r) => r.original_cost > 0 && r.physical_progress !== null)
    .map((r) => ({
      x: Number(r.physical_progress),
      y: Number(r.predicted_time_overrun_months),
      z: Math.min(400, Math.sqrt(Number(r.original_cost)) * 2),
      name: String(r.project_name).slice(0, 40),
      sector: r.sector,
      risk: r.predicted_risk_class,
    }));
  const maxDelay = Math.max(...rows.map((r) => r.avg_delay_months), 1);

  return (
    <>
      <PageHead title="Benchmarking"
        description="Compare sectors, states or ministries on progress, predicted delay and predicted cost pressure. The same definitions apply everywhere, so the ranking is comparable.">
        <div className="pills">
          {["sector", "state", "ministry"].map((d) => (
            <button key={d} className={`pill ${dimension === d ? "on" : ""}`}
              onClick={() => setDimension(d)}>
              By {d}
            </button>
          ))}
        </div>
      </PageHead>

      <div className="tiles">
        <Tile label={`${dimension.replace(/^\w/, (c) => c.toUpperCase())}s compared`}
          value={num(rows.length, 0)} note="Groups with at least one project" />
        <Tile label="Best on delay"
          value={best[0] ? `${best[0].name}` : "-"}
          note={best[0] ? `${num(best[0].avg_delay_months, 1)} months average predicted delay` : ""}
          tone="good" />
        <Tile label="Worst on delay"
          value={rows[0]?.name ?? "-"}
          note={rows[0] ? `${num(rows[0].avg_delay_months, 1)} months average predicted delay` : ""}
          tone="bad" />
        <Tile label="Projects in view"
          value={num(projects.data?.total ?? 0, 0)} note="Used for the scatter below" />
      </div>

      <Card title="Progress against predicted delay"
        hint="Bubble size is the approved cost. Bottom-right is healthy, top-right is the problem quadrant.">
        <ResponsiveContainer width="100%" height={340}>
          <ScatterChart margin={{ top: 8, right: 20, bottom: 16, left: 4 }}>
            <CartesianGrid stroke="#edf0f5" />
            <XAxis type="number" dataKey="x" name="Physical progress %" tick={AXIS}
              domain={[0, 100]} label={{ value: "Physical progress %", position: "insideBottom", offset: -8, fontSize: 11 }} />
            <YAxis type="number" dataKey="y" name="Predicted delay (months)" tick={AXIS}
              label={{ value: "Predicted delay (months)", angle: -90, position: "insideLeft", fontSize: 11 }} />
            <ZAxis type="number" dataKey="z" range={[18, 320]} />
            <Tooltip {...TOOLTIP}
              formatter={(value, name) => [name === "Approved cost (bubble)" ? "" : num(value, 1), name]} />
            <Scatter data={scatter} fill="#012677" fillOpacity={0.45} />
          </ScatterChart>
        </ResponsiveContainer>
      </Card>

      <Card title={`Average predicted delay by ${dimension}`} hint="Months, from the same models behind the project page">
        <ResponsiveContainer width="100%" height={Math.max(240, rows.length * 24)}>
          <BarChart data={rows.slice(0, 20).map((r) => ({
            name: String(r.name).length > 24 ? `${String(r.name).slice(0, 23)}…` : r.name,
            delay: Number(r.avg_delay_months),
            share: Number(r.high_risk_share_pct),
          }))}
            layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="#edf0f5" horizontal={false} />
            <XAxis type="number" tick={AXIS} tickFormatter={(v) => `${v} mo`} />
            <YAxis type="category" dataKey="name" tick={AXIS} width={170} />
            <Tooltip {...TOOLTIP} formatter={(v, name) => [num(v, 1), name]} />
            <Bar dataKey="delay" radius={[0, 2, 2, 0]} barSize={13}>
              {rows.slice(0, 20).map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Full benchmark table" flush>
        <DataTable
          rows={rows}
          onRowClick={null}
          columns={[
            { key: "name", label: dimension.replace(/^\w/, (c) => c.toUpperCase()), render: (r) => <strong>{r.name}</strong> },
            { key: "projects", label: "Projects", align: "right", render: (r) => num(r.projects, 0) },
            { key: "approved_cost_cr", label: "Approved cost", align: "right", render: (r) => money(r.approved_cost_cr) },
            { key: "avg_progress", label: "Avg progress", align: "right", render: (r) => pct(r.avg_progress) },
            {
              key: "avg_delay_months",
              label: "Avg predicted delay",
              render: (r) => (
                <div style={{ minWidth: 150 }}>
                  <div style={{ fontSize: 12 }}>{num(r.avg_delay_months, 1)} months</div>
                  <MiniBar value={r.avg_delay_months} max={maxDelay}
                    tone={r.avg_delay_months > 24 ? "high" : r.avg_delay_months > 12 ? "medium" : "low"} />
                </div>
              ),
            },
            { key: "avg_cost_pressure", label: "Avg cost pressure", align: "right", render: (r) => `${num(r.avg_cost_pressure, 2)}%` },
            { key: "high_risk_share_pct", label: "High-risk share", align: "right", render: (r) => pct(r.high_risk_share_pct) },
          ]}
        />
      </Card>

      <Card title="Explore the extremes" hint="Jump straight into the projects behind a number">
        <div className="toolbar">
          <button className="btn" onClick={() => navigate("/projects?")}>Open explorer</button>
          <button className="btn ghost" onClick={() => navigate("/risk")}>Open watchlist</button>
          <span className="tag info" style={{ padding: "6px 10px" }}>
            Sort the explorer by predicted delay or cost pressure to reproduce any row here
          </span>
        </div>
      </Card>
    </>
  );
}