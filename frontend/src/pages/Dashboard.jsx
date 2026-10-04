import { useState } from "react";
import { Link } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, months, money, monthLabel, num, pct, share, signedPct } from "../api";
import {
  AXIS,
  Card,
  ErrorNote,
  Loader,
  Modal,
  TOOLTIP,
  useFetch,
} from "../ui";

const RISK_MIX = { High: "#ef4444", Medium: "#f59e0b", Low: "#18a66a" };

const SORTS = [
  ["cost_pressure", "Cost pressure"],
  ["delay", "Delay"],
  ["cost", "Approved cost"],
  ["progress", "Progress"],
  ["risk", "Risk class"],
];

const K = (value) => (value ? value.toLocaleString("en-IN") : 0);

export default function Dashboard() {
  const [sector, setSector] = useState("");
  const [ministry, setMinistry] = useState("");
  const [risk, setRisk] = useState("");
  const [sort, setSort] = useState("cost_pressure");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(null);
  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState([]);
  const [busy, setBusy] = useState(false);

  const overview = useFetch(() => api.overview(), []);
  const reference = useFetch(() => api.reference(), []);
  const trend = useFetch(() => api.portfolioTrend("portfolio"), []);
  const sectors = useFetch(() => api.breakdown("sector"), []);
  const states = useFetch(() => api.sectorMap(), []);
  const detail = useFetch(() => (open ? api.project(open) : Promise.resolve(null)), [open]);
  const table = useFetch(
    () => api.projects({ sector, ministry, risk, sort, search, page_size: 25, page: 1 }),
    [sector, ministry, risk, sort, search],
  );

  if (overview.loading) return <Loader label="Loading dashboard" />;
  if (overview.error) return <ErrorNote error={overview.error} />;

  const data = overview.data;
  const mix = data.predicted_risk_mix ?? {};
  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0);
  let cursor = 0;
  const stops = Object.entries(mix)
    .map(([name, value]) => {
      const start = cursor;
      cursor += (value / mixTotal) * 100;
      return `${RISK_MIX[name] ?? "#94a3b8"} ${start.toFixed(1)}% ${cursor.toFixed(1)}%`;
    })
    .join(", ");

  const trendData = (trend.data?.rows ?? []).map((row) => ({
    month: monthLabel(row.month_year),
    Approved: row.original_cost / 100000,
    Revised: row.revised_cost ? row.revised_cost / 100000 : null,
    Expenditure: row.expenditure / 100000,
  }));

  const sectorRows = (sectors.data?.rows ?? []).slice(0, 8);
  const sectorMax = Math.max(...sectorRows.map((r) => r.original_cost), 1);
  const stateRows = (states.data?.rows ?? []).slice(0, 7);
  const stateMax = Math.max(...stateRows.map((r) => r.approved_cost_cr), 1);
  const current = detail.data?.current;
  const peers = detail.data?.sector_peers;

  async function ask(text) {
    const q = (text ?? question).trim();
    if (!q || busy) return;
    setBusy(true);
    setQuestion("");
    try {
      const reply = await api.assistant(q);
      setChat((log) => [
        ...log,
        { who: "user", text: q },
        { who: "bot", text: reply.answer, meta: reply.confidence },
      ]);
    } catch (error) {
      setChat((log) => [...log, { who: "user", text: q }, { who: "bot", text: String(error.message ?? error) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="icon">▤</div>
          <div className="num">{K(data.projects)}</div>
          <div className="label">Projects monitored</div>
          <div className="sub">Freeze {data.freeze_label}</div>
        </div>
        <div className="kpi">
          <div className="icon">₹</div>
          <div className="num">{money(data.approved_cost_cr)}</div>
          <div className="label">Approved cost</div>
          <div className="sub">{pct(data.utilisation_pct, 2)} utilised</div>
        </div>
        <div className="kpi">
          <div className="icon green">◈</div>
          <div className="num">{money(data.expenditure_cr)}</div>
          <div className="label">Expenditure</div>
          <div className="sub ok">{money(data.unspent_cr)} unspent</div>
        </div>
        <div className="kpi">
          <div className="icon red">▲</div>
          <div className="num">{K(data.predicted_high_risk)}</div>
          <div className="label">Predicted high risk</div>
          <div className="sub alert">{K(data.new_high_risk_entries)} new entries next month</div>
        </div>
        <div className="kpi">
          <div className="icon amber">◐</div>
          <div className="num">{pct(data.mean_physical_progress)}</div>
          <div className="label">Mean physical progress</div>
          <div className="sub">Across all monitored projects</div>
        </div>
      </div>

      <div className="filters">
        <select value={sector} onChange={(e) => setSector(e.target.value)}>
          <option value="">All sectors</option>
          {(reference.data?.sectors ?? []).map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <select value={ministry} onChange={(e) => setMinistry(e.target.value)}>
          <option value="">All ministries</option>
          {(reference.data?.ministries ?? []).map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="">All risk classes</option>
          <option value="High">High risk</option>
          <option value="Medium">Medium risk</option>
          <option value="Low">Low risk</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <input
          placeholder="Search project, code or agency"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid-3">
        <Card title="Predicted risk mix" hint="Risk class expected next month">
          <div className="donut-row">
            <div className="donut" data-center={K(mixTotal)} style={{ background: `conic-gradient(${stops})` }} />
            <div className="legend" style={{ display: "block" }}>
              {Object.entries(mix).map(([name, value]) => (
                <div key={name}>
                  <span className="dot" style={{ background: RISK_MIX[name] ?? "#94a3b8" }} />
                  <span style={{ marginLeft: 7 }}>{name}</span>
                  <strong style={{ marginLeft: 5 }}>{K(value)}</strong>
                  <div className="muted" style={{ paddingLeft: 16 }}>
                    {pct((value / mixTotal) * 100)}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="note" style={{ marginTop: 12 }}>
            Published position today: {Object.entries(data.current_risk_mix)
              .map(([name, value]) => `${value} ${name.toLowerCase()}`).join(", ")}.
            These are model estimates, not report statistics.
          </div>
        </Card>

        <Card title="Approved outlay by sector" hint="Largest sanctioned budgets">
          {sectorRows.map((row) => (
            <div className="bar-item" key={row.label}>
              <div className="bar-label">
                <span>{row.label}</span>
                <strong>{money(row.original_cost)}</strong>
              </div>
              <div className="bar">
                <i style={{ width: `${(row.original_cost / sectorMax) * 100}%` }} />
              </div>
              <div className="muted" style={{ marginTop: 3 }}>
                {K(row.projects)} projects &middot; {pct(row.expenditure_pct)} utilised
              </div>
            </div>
          ))}
        </Card>

        <Card title="Top states by outlay" hint="Where the sanctioned budget sits">
          {stateRows.map((row) => (
            <div className="bar-item" key={row.state}>
              <div className="bar-label">
                <span>{row.state}</span>
                <strong>{money(row.approved_cost_cr)}</strong>
              </div>
              <div className="bar">
                <i
                  className={row.high_risk_pct > 30 ? "high" : row.high_risk_pct > 12 ? "medium" : "low"}
                  style={{ width: `${(row.approved_cost_cr / stateMax) * 100}%` }}
                />
              </div>
              <div className="muted" style={{ marginTop: 3 }}>
                {K(row.projects)} projects &middot; {pct(row.high_risk_pct)} high risk
              </div>
            </div>
          ))}
        </Card>
      </div>

      <Card
        title="Priority projects"
        hint="One-month-ahead predictions, filtered from the project panel"
        actions={<Link className="btn ghost small" to="/projects">Open explorer</Link>}
        flush
      >
        {table.loading ? (
          <Loader />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Sector</th>
                  <th>State</th>
                  <th className="num">Approved</th>
                  <th className="num">Progress</th>
                  <th className="num">Cost pressure</th>
                  <th className="num">Delay</th>
                  <th>Risk</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(table.data?.rows ?? []).map((row) => (
                  <tr key={row.project_code}>
                    <td>
                      <span className="project">{String(row.project_name).slice(0, 54)}</span>
                      <div className="muted">{row.project_code} &middot; {row.agency}</div>
                    </td>
                    <td>{row.sector}</td>
                    <td>{row.state}</td>
                    <td className="num">{money(row.original_cost)}</td>
                    <td className="num">{pct(row.physical_progress)}</td>
                    <td className="num">
                      {row.predicted_cost_pressure_pct > 0 ? "+" : ""}
                      {signedPct(row.predicted_cost_pressure_pct, 2)}
                    </td>
                    <td className="num">{months(row.predicted_time_overrun_months, 1)}</td>
                    <td>
                      <span className={`pill-tag ${String(row.predicted_risk_class).toLowerCase()}`}>
                        {row.predicted_risk_class}
                      </span>
                    </td>
                    <td>
                      <button className="view-btn" onClick={() => setOpen(row.project_code)}>View</button>
                    </td>
                  </tr>
                ))}
                {!(table.data?.rows ?? []).length ? (
                  <tr><td colSpan={9} className="empty">No project matches these filters</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        <div className="legend-inline" style={{ padding: "10px 15px" }}>
          <span>Total matching: {K(table.data?.total ?? 0)} projects</span>
          <span>Showing first {K((table.data?.rows ?? []).length)}</span>
          <span>Cost pressure is measured spending against sanctioned cost, not a revised cost</span>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Portfolio cost and expenditure" hint="Lakh crore, from the portal's monthly aggregates">
          <ResponsiveContainer width="100%" height={265}>
            <LineChart data={trendData} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#edf1f6" />
              <XAxis dataKey="month" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} tickFormatter={(v) => `${v}L`} width={44} />
              <Tooltip {...TOOLTIP} formatter={(v, name) => [`Rs ${num(v, 2)} lakh cr`, name]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="Approved" stroke="#1384f7" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Revised" stroke="#f59e0b" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Expenditure" stroke="#18a66a" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card
          title="Ask the analyst"
          hint="Deterministic answers from the same database"
          actions={<Link className="btn ghost small" to="/assistant">Full assistant</Link>}
        >
          <div className="chat-log">
            {chat.length === 0 ? (
              <div className="empty">
                Ask about totals, risk counts, sectors or what the model predicts next month.
              </div>
            ) : null}
            {chat.map((entry, index) => (
              <div key={index} className={`bubble ${entry.who}`}>
                {entry.text}
                {entry.meta ? <div className="meta">match confidence: {entry.meta}</div> : null}
              </div>
            ))}
            {busy ? <div className="bubble bot">Reading the extract...</div> : null}
          </div>
          <div className="chat-input">
            <input
              placeholder="e.g. Which sectors have the worst predicted delays?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
            />
            <button className="btn" onClick={() => ask()} disabled={busy || !question.trim()}>
              Ask
            </button>
          </div>
        </Card>
      </div>

      <Modal
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={current?.project_name ?? "Loading project"}
        subtitle={current ? `${current.project_code} · ${current.sector} · ${current.state} · ${current.agency}` : ""}
      >
        {current ? (
          <>
            <div className="metric-grid">
              <div className="metric">
                <div className="k">Approved cost</div>
                <div className="v">{money(current.original_cost)}</div>
              </div>
              <div className="metric">
                <div className="k">Expenditure</div>
                <div className="v">{money(current.expenditure)}</div>
              </div>
              <div className="metric">
                <div className="k">Physical progress</div>
                <div className="v">{pct(current.physical_progress)}</div>
              </div>
              <div className="metric">
                <div className="k">Predicted delay</div>
                <div className="v">{months(current.predicted_time_overrun_months, 1)}</div>
              </div>
            </div>
            <div className="progress"><i style={{ width: `${current.physical_progress}%` }} /></div>
            <div className="legend-inline">
              <span>Predicted cost pressure {signedPct(current.predicted_cost_pressure_pct, 2)}</span>
              <span>
                Risk class{" "}
                <span className={`pill-tag ${String(current.predicted_risk_class).toLowerCase()}`}>
                  {current.predicted_risk_class}
                </span>
              </span>
              <span>Model confidence {share(current.confidence)}</span>
            </div>
            {peers ? (
              <div className="note" style={{ marginTop: 12 }}>
                Sector peers average {pct(peers.sector_progress)} progress,
                {" "}{months(peers.sector_delay, 1)} delay and
                {" "}{signedPct(peers.sector_pressure, 2)} cost pressure across
                {" "}{K(peers.sector_projects)} projects.
              </div>
            ) : null}
            <div className="toolbar" style={{ marginTop: 14 }}>
              <Link className="btn" to={`/projects/${current.project_code}`}>Full project report</Link>
              <Link className="btn ghost" to="/predict">Run what-if</Link>
            </div>
          </>
        ) : (
          <Loader />
        )}
      </Modal>
    </>
  );
}