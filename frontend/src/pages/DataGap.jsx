import { api, num, signedPct } from "../api";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS,
  Card,
  DataTable,
  ErrorNote,
  Loader,
  PageHead,
  Tile,
  TOOLTIP,
  useFetch,
} from "../ui";

export default function DataGap() {
  const gap = useFetch(() => api.dataGap(), []);
  if (gap.loading) return <Loader label="Loading data-gap experiment" />;
  if (gap.error) return <ErrorNote error={gap.error} />;

  const g = gap.data;
  const chart = g.steps.map((s) => ({
    step: s.step.length > 26 ? `${s.step.slice(0, 25)}…` : s.step,
    change: s.change_pct,
    mae: s.mae,
  }));

  return (
    <>
      <PageHead title="Data gap analysis"
        description="What the models would gain if the ministry captured the fields the portal does not publish today. The candidate variables are simulated, so this sizes the prize rather than claiming accuracy." />

      <div className="tiles">
        <Tile label="Baseline MAE" value={num(g.baseline_mae, 3)}
          note="Cost pressure, percentage points" />
        <Tile label="Best single addition"
          value={signedPct(g.most_valuable[0]?.change_pct, 2)}
          note={g.most_valuable[0]?.step.replace("+ ", "")} tone="good" />
        <Tile label="All candidates together"
          value={signedPct(g.steps[g.steps.length - 1].change_pct, 2)}
          note={`MAE ${num(g.steps[g.steps.length - 1].mae, 3)}`} tone="good" />
        <Tile label="Risk accuracy today"
          value={`${(g.risk_accuracy_today * 100).toFixed(1)}%`} />
        <Tile label="Risk accuracy with extras"
          value={`${(g.risk_accuracy_with_extra * 100).toFixed(1)}%`}
          note="Simulated fields, best case" tone="warn" />
        <Tile label="Fields assessed" value={num(g.candidates.length, 0)}
          note="Not captured by the portal today" tone="warn" />
      </div>

      <Card title="Error reduction by candidate variable"
        hint="Negative percentage means the model got better">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chart} margin={{ top: 8, right: 16, bottom: 74, left: 4 }}>
            <CartesianGrid stroke="#edf0f5" />
            <XAxis dataKey="step" tick={AXIS} interval={0} angle={-30} textAnchor="end" height={80} />
            <YAxis tick={AXIS} tickFormatter={(v) => `${v}%`} width={48} />
            <ReferenceLine y={0} stroke="#b3261e" />
            <Tooltip {...TOOLTIP} formatter={(v, name) => [name === "MAE" ? num(v, 3) : signedPct(v, 2), name]} />
            <Bar dataKey="change" radius={[2, 2, 0, 0]}>
              {chart.map((row) => (                <Cell key={row.step} fill={row.change < 0 ? "#1d7a4c" : "#b3261e"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Full experiment" hint="One variable added at a time, then all together" flush>
        <DataTable
          rows={g.steps}
          columns={[
            { key: "step", label: "Step" },
            {
              key: "mae",
              label: "Cost MAE",
              align: "right",
              render: (r) => num(r.mae, 3),
            },
            {
              key: "change_pct",
              label: "Change",
              align: "right",
              render: (r) => (
                <span className={`tag ${r.change_pct < 0 ? "low" : r.change_pct === 0 ? "neutral" : "high"}`}>
                  {signedPct(r.change_pct, 2)}
                </span>
              ),
            },
            {
              key: "verdict",
              label: "Verdict",
              render: (r) => (
                r.added === null ? "Starting point"
                  : r.change_pct < -5 ? "Worth capturing"
                    : r.change_pct < 0 ? "Small gain"
                      : "No measurable gain"
              ),
            },
          ]}
        />
        <div style={{ padding: "10px 15px" }}>
          <div className="note-block">{g.note}</div>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Highest value first">
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#4b5563", lineHeight: 1.8 }}>
            {g.most_valuable.map((s) => (
              <li key={s.step}>
                <strong>{s.step.replace("+ ", "").replaceAll("_", " ")}</strong> &mdash;
                {" "}{signedPct(s.change_pct, 2)} change in cost MAE
              </li>
            ))}
          </ol>
          <div className="note-block" style={{ marginTop: 12 }}>
            A variable only helps if it carries information the published fields do not already
            contain. Land acquisition and environmental clearance score close to zero here because
            their effect is already visible in the progress gap and elapsed share.
          </div>
        </Card>

        <Card title="Lowest value first" hint="Fields that would not have earned their collection cost">
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#4b5563", lineHeight: 1.8 }}>
            {g.least_valuable.map((s) => (
              <li key={s.step}>
                <strong>{s.step.replace("+ ", "").replaceAll("_", " ")}</strong> &mdash;
                {" "}{signedPct(s.change_pct, 2)} change in cost MAE
              </li>
            ))}
          </ol>
          <div className="note-block" style={{ marginTop: 12 }}>
            This is the useful half of the result. Collecting everything would cost money and
            widen the form burden on project cells; this experiment says which fields would
            repay that effort.
          </div>
        </Card>
      </div>
    </>
  );
}