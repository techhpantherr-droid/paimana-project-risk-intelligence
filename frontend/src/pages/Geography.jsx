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
import { api, money, monthLabel, num, pct } from "../api";
import {
  AXIS,
  Card,
  DataTable,
  ErrorNote,
  Loader,
  MiniBar,
  PALETTE,
  PageHead,
  PortfolioBars,
  Tile,
  TOOLTIP,
  useFetch,
} from "../ui";

export default function Geography() {
  const navigate = useNavigate();
  const [dimension, setDimension] = useState("sector");
  const [selected, setSelected] = useState(null);
  const map = useFetch(() => api.sectorMap(), []);
  const breakdown = useFetch(() => api.breakdown(dimension, undefined, 30), [dimension]);
  const sectorTrend = useFetch(() => api.portfolioTrend("sector"), []);

  if (map.loading || breakdown.loading) return <Loader label="Loading sector and state view" />;
  if (map.error) return <ErrorNote error={map.error} />;

  const states = map.data?.rows ?? [];
  const rows = breakdown.data?.rows ?? [];
  const trendRows = sectorTrend.data?.rows ?? [];

  const byMonth = {};
  trendRows.forEach((row) => {
    byMonth[row.label] ??= [];
    byMonth[row.label].push(row);
  });
  const topSectors = [...new Set(trendRows.map((r) => r.label))].slice(0, 6);
  const trendData = (trendRows.filter((r) => topSectors.includes(r.label))).map((row) => ({
    month: monthLabel(row.month_year),
    [row.label]: row.original_cost / 100000,
  }));

  const activeRows = selected
    ? rows.filter((r) => r.label === selected)
    : rows;

  return (
    <>
      <PageHead title="Sector and state intelligence"
        description="Portal aggregates by sector and by state across all fourteen freezes, plus the live project-level view.">
        <div className="pills">
          {["sector", "state"].map((d) => (
            <button key={d} className={`pill ${dimension === d ? "on" : ""}`}
              onClick={() => { setDimension(d); setSelected(null); }}>
              By {d}
            </button>
          ))}
        </div>
      </PageHead>

      <div className="tiles">
        <Tile label="Sectors" value={num(new Set(trendRows.map((r) => r.label)).size, 0)}
          note="Tracked in the portal aggregates" />
        <Tile label="States and UTs" value={num(states.length, 0)} note="With at least one project" />
        <Tile label="Largest state outlay" value={states[0]?.state ?? "-"}
          note={states[0] ? money(states[0].approved_cost_cr) : ""} />
        <Tile label="Highest state utilisation"
          value={[...states].sort((a, b) => b.utilisation_pct - a.utilisation_pct)[0]?.state ?? "-"}
          note={[...states].sort((a, b) => b.utilisation_pct - a.utilisation_pct)[0]
            ? pct([...states].sort((a, b) => b.utilisation_pct - a.utilisation_pct)[0].utilisation_pct)
            : ""}
          tone="warn" />
      </div>

      <Card title="Approved outlay by sector over time" hint="Lakh crore, from the monthly portal aggregates">
        <ResponsiveContainer width="100%" height={290}>
          <BarChart data={trendData} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="#edf0f5" />
            <XAxis dataKey="month" tick={AXIS} interval="preserveStartEnd" />
            <YAxis tick={AXIS} tickFormatter={(v) => `${v}L`} width={44} />
            <Tooltip {...TOOLTIP} formatter={(v) => [`Rs ${num(v, 2)} lakh cr`, ""]} />
            {topSectors.map((sector, i) => (
              <Bar key={sector} dataKey={sector} stackId="a" fill={PALETTE[i % PALETTE.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid-2">
        <Card title={`Approved cost by ${dimension}`} hint="Click a bar to isolate it">
          <div className="scroll-x">
            <ResponsiveContainer width="100%" height={Math.max(250, rows.length * 24)}>
              <BarChart data={rows.slice(0, 20).map((r) => ({
                name: String(r.label).slice(0, 20),
                approved: r.original_cost / 1000,
                highlight: r.label === selected,
              }))}
                layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 4 }}>
                <CartesianGrid stroke="#edf0f5" horizontal={false} />
                <XAxis type="number" tick={AXIS} tickFormatter={(v) => `${v}k`} />
                <YAxis type="category" dataKey="name" tick={AXIS} width={150}
                  onClick={(e) => {
                    const label = e?.activeLabel;
                    if (label) setSelected(selected === label ? null : label);
                  }} />
                <Tooltip {...TOOLTIP} formatter={(v) => [`Rs ${num(v, 1)}k cr`, "Approved"]} />
                <Bar dataKey="approved" radius={[0, 2, 2, 0]} barSize={13}>
                  {rows.slice(0, 20).map((r, i) => (
                    <Cell key={r.label} fill={r.label === selected ? "#f0a742" : PALETTE[i % PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title={selected ? `${selected}` : `Expenditure against approved cost`}
          hint={selected ? "Filtered to the selection" : "Top rows by approved outlay"}
          actions={selected ? <button className="btn ghost small" onClick={() => setSelected(null)}>Clear</button> : null}>
          <DataTable
            rows={activeRows.slice(0, 18)}
            empty="Nothing in this selection"
            columns={[
              { key: "label", label: "Name" },
              { key: "projects", label: "Projects", align: "right", render: (r) => num(r.projects, 0) },
              { key: "original_cost", label: "Approved", align: "right", render: (r) => money(r.original_cost) },
              { key: "expenditure", label: "Expenditure", align: "right", render: (r) => money(r.expenditure) },
              {
                key: "expenditure_pct",
                label: "Utilisation",
                render: (r) => (
                  <div style={{ minWidth: 110 }}>
                    <div style={{ fontSize: 12 }}>{pct(r.expenditure_pct)}</div>
                    <MiniBar value={r.expenditure_pct} max={100}
                      tone={r.expenditure_pct > 90 ? "high" : r.expenditure_pct > 60 ? "medium" : "low"} />
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>

      <Card title="State-level project view"
        hint="Live project counts with the model's risk expectations"
        actions={<button className="btn small" onClick={() => navigate("/projects")}>Open in explorer</button>}
        flush>
        <DataTable
          rows={states}
          columns={[
            { key: "state", label: "State / UT", render: (r) => <strong>{r.state}</strong> },
            { key: "projects", label: "Projects", align: "right", render: (r) => num(r.projects, 0) },
            { key: "approved_cost_cr", label: "Approved cost", align: "right", render: (r) => money(r.approved_cost_cr) },
            { key: "expenditure_cr", label: "Expenditure", align: "right", render: (r) => money(r.expenditure_cr) },
            {
              key: "utilisation_pct",
              label: "Utilisation",
              render: (r) => (
                <div style={{ minWidth: 120 }}>
                  <div style={{ fontSize: 12 }}>{pct(r.utilisation_pct)}</div>
                  <MiniBar value={r.utilisation_pct} max={100}
                    tone={r.utilisation_pct > 90 ? "high" : r.utilisation_pct > 60 ? "medium" : "low"} />
                </div>
              ),
            },
            { key: "avg_progress", label: "Avg progress", align: "right", render: (r) => pct(r.avg_progress) },
            { key: "high_risk", label: "High risk", align: "right", render: (r) => num(r.high_risk, 0) },
            { key: "high_risk_pct", label: "High-risk share", align: "right", render: (r) => pct(r.high_risk_pct) },
          ]}
        />
      </Card>

      <div className="grid-2">
        <Card title="Sector share of approved cost">
          <ResponsiveContainer width="100%" height={270}>
            <PieChart>
              <Pie data={rows.slice(0, 10).map((r) => ({ name: r.label, value: r.original_cost }))}
                dataKey="value" nameKey="name" outerRadius={100} stroke="#fff">
                {rows.slice(0, 10).map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Pie>
              <Tooltip {...TOOLTIP} formatter={(v) => [money(v), "Approved"]} />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Portfolio bars" hint="Same data, different cut">
          <PortfolioBars rows={rows} valueKey="expenditure" />
        </Card>
      </div>
    </>
  );
}