import { Link, useNavigate, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useState } from "react";
import { api, money, monthLabel, num, pct } from "../api";
import {
  AXIS,
  Card,
  ErrorNote,
  Loader,
  MiniBar,
  PageHead,
  RiskTag,
  TOOLTIP,
  useFetch,
} from "../ui";

export default function ProjectDetail() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [sim, setSim] = useState({ expenditure_change_pct: 10, progress_change_pp: -5, cost_change_pct: 0 });
  const [simResult, setSimResult] = useState(null);
  const [simBusy, setSimBusy] = useState(false);

  const detail = useFetch(() => api.project(code), [code]);
  const explain = useFetch(() => api.explain(code), [code]);

  if (detail.loading) return <Loader label="Loading project" />;
  if (detail.error) return <ErrorNote error={detail.error} />;

  const p = detail.data?.current;
  if (!p) return <ErrorNote error={{ message: "project not found" }} />;

  const history = (detail.data?.history ?? []).map((row) => ({
    month: row.month_name ?? monthLabel(row.snapshot),
    Physical: row.physical_progress,
    Expenditure: row.expenditure ? row.expenditure / 100000 : 0,
  }));
  const peers = detail.data?.sector_peers ?? {};
  const contributions = explain.data?.contributions ?? [];
  const maxShap = Math.max(...contributions.map((c) => Math.abs(c.shap)), 0.001);

  const runSimulation = async () => {
    setSimBusy(true);
    try {
      setSimResult(await api.whatIf({ project_code: code, ...sim }));
    } finally {
      setSimBusy(false);
    }
  };

  return (
    <>
      <PageHead title={String(p.project_name).slice(0, 90)}
        description={`${p.ministry ?? "Ministry not stated"} &middot; ${p.agency ?? "-"} &middot; ${p.state}`}>
        <button className="btn ghost" onClick={() => navigate(-1)}>Back to list</button>
        <Link className="btn" to={`/predict?code=${code}`}>Open in prediction lab</Link>
      </PageHead>

      <div className="tiles">
        <Tileish label="Approved cost" value={money(p.original_cost)} />
        <Tileish label="Expenditure" value={money(p.expenditure)}
          note={`${pct(p.expenditure_pct_of_cost)} of sanctioned cost`} />
        <Tileish label="Physical progress" value={pct(p.physical_progress)}
          note={`Elapsed share of duration ${pct(p.elapsed_pct)}`} />
        <Tileish label="Risk today" value={<RiskTag value={p.risk_class} />} />
        <Tileish label="Predicted next month" value={<RiskTag value={p.predicted_risk_class} />}
          note={`Confidence ${pct(p.confidence * 100, 0)}`} />
        <Tileish label="Predicted cost pressure"
          value={`${p.predicted_cost_pressure_pct > 0 ? "+" : ""}${num(p.predicted_cost_pressure_pct, 2)}%`} />
        <Tileish label="Predicted delay"
          value={`${num(p.predicted_time_overrun_months, 1)} months`} />
        <Tileish label="Project code" value={<code>{p.project_code}</code>} />
      </div>

      <div className="split">
        <Card title="Month-by-month progress" hint="Physical progress against cumulative spending">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={history} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#edf0f5" />
              <XAxis dataKey="month" tick={AXIS} />
              <YAxis yAxisId="left" tick={AXIS} domain={[0, 100]} width={38} />
              <YAxis yAxisId="right" orientation="right" tick={AXIS}
                tickFormatter={(v) => `${v}L`} width={44} />
              <Tooltip {...TOOLTIP} />
              <ReferenceLine yAxisId="left" y={p.elapsed_pct} stroke="#b26a00" strokeDasharray="4 4"
                label={{ value: "Time elapsed", position: "insideTopRight", fontSize: 11, fill: "#b26a00" }} />
              <Line yAxisId="left" type="monotone" dataKey="Physical" stroke="#012677"
                strokeWidth={2} dot={{ r: 2 }} />
              <Line yAxisId="right" type="monotone" dataKey="Expenditure" stroke="#1d7a4c"
                strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
          {Number(p.progress_gap) < 0 ? (
            <div className="note-block" style={{ marginTop: 10 }}>
              Physical progress is {num(Math.abs(p.progress_gap), 1)} percentage points
              behind the share of the sanctioned duration already used. That gap is the
              clearest early signal in the published fields.
            </div>
          ) : null}
        </Card>

        <Card title="Project record">
          <dl className="kv">
            <dt>Sector</dt><dd>{p.sector ?? "Not stated"}</dd>
            <dt>Ministry / department</dt><dd>{p.ministry ?? "Not stated"}</dd>
            <dt>Implementing agency</dt><dd>{p.agency ?? "-"}</dd>
            <dt>State</dt><dd>{p.state ?? "-"}</dd>
            <dt>Approval date</dt><dd>{p.approval_date ?? "-"}</dd>
            <dt>Start date</dt><dd>{p.start_date ?? "-"}</dd>
            <dt>Original completion</dt><dd>{p.original_doc ?? "-"}</dd>
            <dt>Revised completion</dt>
            <dd>{p.revised_doc ?? <span className="tag neutral">No revision published</span>}</dd>
            <dt>Original cost</dt><dd>{money(p.original_cost)}</dd>
            <dt>Revised cost</dt>
            <dd>{p.revised_cost ? money(p.revised_cost) : <span className="tag neutral">Not published</span>}</dd>
            <dt>Source table</dt><dd>{p.source_table ?? "-"}</dd>
          </dl>
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Why the model rates this project" hint="SHAP contribution to the cost-pressure prediction">
          {explain.loading ? <Loader /> : (
            <>
              <div className="note-block" style={{ marginBottom: 10 }}>
                Base prediction {num(explain.data?.base_value, 3)} moves to
                {" "}{num(explain.data?.prediction, 3)} once these contributions are
                applied. Positive values push predicted cost pressure up.
              </div>
              {contributions.map((c) => (
                <div className="driver-row" key={c.feature}>
                  <span title={c.label}>{c.label}</span>
                  <MiniBar value={Math.abs(c.shap)} max={maxShap}
                    tone={c.shap > 0 ? "high" : "low"} />
                  <span className="val">{c.shap > 0 ? "+" : ""}{num(c.shap, 2)}</span>
                </div>
              ))}
            </>
          )}
        </Card>

        <Card title="Sector peer position"
          hint={`Compared against ${num(peers.sector_projects, 0)} ${p.sector ?? "sector"} projects`}>
          <dl className="kv">
            <dt>Project physical progress</dt><dd>{pct(p.physical_progress)}</dd>
            <dt>Sector average progress</dt><dd>{pct(peers.sector_progress)}</dd>
            <dt>Project predicted delay</dt><dd>{num(p.predicted_time_overrun_months, 1)} months</dd>
            <dt>Sector average delay</dt><dd>{num(peers.sector_delay, 1)} months</dd>
            <dt>Project predicted cost pressure</dt>
            <dd>{num(p.predicted_cost_pressure_pct, 2)}%</dd>
            <dt>Sector average cost pressure</dt><dd>{num(peers.sector_pressure, 2)}%</dd>
          </dl>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Progress against sector</div>
            <MiniBar value={p.physical_progress} max={100} tone="low" />
            <div style={{ fontSize: 12, color: "#6b7280", margin: "8px 0 4px" }}>Sector average</div>
            <MiniBar value={peers.sector_progress} max={100} />
          </div>
        </Card>
      </div>

      <Card title="What-if simulation"
        hint="Change an observed input and see how the same models respond. Nothing is written back.">
        <div className="toolbar">
          <label className="toolbar">
            Expenditure change %
            <input type="number" step="5" value={sim.expenditure_change_pct}
              onChange={(e) => setSim({ ...sim, expenditure_change_pct: Number(e.target.value) })} />
          </label>
          <label className="toolbar">
            Progress change (pp)
            <input type="number" step="5" value={sim.progress_change_pp}
              onChange={(e) => setSim({ ...sim, progress_change_pp: Number(e.target.value) })} />
          </label>
          <label className="toolbar">
            Approved cost change %
            <input type="number" step="5" value={sim.cost_change_pct}
              onChange={(e) => setSim({ ...sim, cost_change_pct: Number(e.target.value) })} />
          </label>
          <button className="btn" onClick={runSimulation} disabled={simBusy}>
            {simBusy ? "Running" : "Run simulation"}
          </button>
        </div>

        {simResult ? (
          <div className="grid-3" style={{ marginTop: 14 }}>
            <div className="tile">
              <div className="label">Predicted cost pressure</div>
              <div className="value">{num(simResult.scenario.predicted_cost_pressure_pct, 2)}%</div>
              <div className="note">
                was {num(simResult.baseline.predicted_cost_pressure_pct, 2)}% &middot;
                change {simResult.change.cost_pressure_pp > 0 ? "+" : ""}
                {num(simResult.change.cost_pressure_pp, 2)} pp
              </div>
            </div>
            <div className="tile">
              <div className="label">Predicted delay</div>
              <div className="value">{num(simResult.scenario.predicted_time_overrun_months, 1)} mo</div>
              <div className="note">
                was {num(simResult.baseline.predicted_time_overrun_months, 1)} mo &middot;
                change {simResult.change.delay_months > 0 ? "+" : ""}
                {num(simResult.change.delay_months, 1)} months
              </div>
            </div>
            <div className="tile">
              <div className="label">Predicted risk class</div>
              <div className="value"><RiskTag value={simResult.scenario.predicted_risk_class} /></div>
              <div className="note">
                was <RiskTag value={simResult.baseline.predicted_risk_class} />
                {simResult.change.risk_class_changed ? " &middot; class changes" : " &middot; class unchanged"}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty">Adjust an input and run the simulation to compare against the current prediction.</div>
        )}
      </Card>
    </>
  );
}

function Tileish({ label, value, note }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value" style={typeof value === "string" || typeof value === "number"
        ? undefined : { fontSize: 18, paddingTop: 4 }}>{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}