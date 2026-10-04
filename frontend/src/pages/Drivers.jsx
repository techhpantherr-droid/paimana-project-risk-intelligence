import { useState } from "react";
import { api } from "../api";
import {
  Card,
  DataTable,
  DriverBars,
  ErrorNote,
  Loader,
  PageHead,
  useFetch,
} from "../ui";

const TARGETS = [
  ["cost_overrun_pct", "Cost pressure"],
  ["time_overrun_months", "Schedule delay"],
];

export default function Drivers() {
  const [target, setTarget] = useState(TARGETS[0][0]);
  const drivers = useFetch(() => api.drivers(14), []);
  const metrics = useFetch(() => api.metrics(), []);

  if (drivers.loading || metrics.loading) return <Loader label="Loading driver analysis" />;
  if (drivers.error) return <ErrorNote error={drivers.error} />;

  const rows = drivers.data?.[target] ?? [];
  const total = rows.reduce((sum, r) => sum + r.mean_abs_shap, 0);
  const gap = metrics.data?.data_gap ?? {};
  const baseline = metrics.data?.heads?.cost_overrun_pct?.comparison?.[0];

  return (
    <>
      <PageHead title="Driver analysis"
        description="SHAP decomposes each prediction into per-feature contributions, so a number can be traced back to the published fields that produced it.">
        <div className="pills">
          {TARGETS.map(([key, label]) => (
            <button key={key} className={`pill ${target === key ? "on" : ""}`}
              onClick={() => setTarget(key)}>
              {label}
            </button>
          ))}
        </div>
      </PageHead>

      <div className="split">
        <Card title={`What moves ${target === "cost_overrun_pct" ? "cost pressure" : "delay"}`}
          hint="Mean absolute SHAP value across 1,500 sampled project-months">
          <DriverBars rows={rows} />
          <div className="note-block" style={{ marginTop: 12 }}>
            A larger bar means the feature shifts the prediction further on average. These are
            associations measured across {num(metrics.data?.supervised_rows, 0)} one-step-ahead
            project rows. They describe what the published data contains, not a causal claim
            about why a specific project slipped.
          </div>
        </Card>

        <Card title="Reading the decomposition">
          <dl className="kv">
            <dt>Training rows</dt><dd>{num(metrics.data?.supervised_rows, 0)}</dd>
            <dt>Projects</dt><dd>{num(metrics.data?.projects, 0)}</dd>
            <dt>Snapshots</dt>
            <dd>{(metrics.data?.snapshots ?? []).map((s) => s).join(", ")}</dd>
            <dt>Target design</dt>
            <dd>{metrics.data?.target_definition}</dd>
            <dt>Best cost model</dt>
            <dd>{metrics.data?.heads?.cost_overrun_pct?.chosen_model}</dd>
            <dt>Best delay model</dt>
            <dd>{metrics.data?.heads?.time_overrun_months?.chosen_model}</dd>
          </dl>
          <div className="note-block" style={{ marginTop: 12 }}>
            The portal does not publish a revised cost for most projects, so cost pressure is
            measured as spending above the sanctioned cost where no revision exists. That choice
            is why financial progress ranks so strongly on the cost model.
          </div>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <button className="btn ghost small"
              onClick={() => setTarget(TARGETS[0][0])}>Cost drivers</button>
            <button className="btn ghost small"
              onClick={() => setTarget(TARGETS[1][0])}>Delay drivers</button>
          </div>
        </Card>
      </div>

      <Card title="Feature importances in full" flush>
        <DataTable
          rows={rows}
          columns={[
            { key: "label", label: "Feature" },
            { key: "feature", label: "Encoded column", render: (r) => <code style={{ fontSize: 11 }}>{r.feature}</code> },
            { key: "mean_abs_shap", label: "Mean |SHAP|", align: "right", render: (r) => r.mean_abs_shap.toFixed(4) },
            {
              key: "share",
              label: "Share of total",
              align: "right",
              render: (r) => `${((r.mean_abs_shap / total) * 100).toFixed(1)}%`,
            },
          ]}
        />
      </Card>

      <div className="grid-2">
        <Card title="What the models cannot see" hint="Fields the portal does not publish today">
          <div className="note-block">
            {gap.note ?? "Run the training script to populate the data-gap experiment."}
          </div>
          <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 13, color: "#4b5563" }}>
            {(gap.candidate_variables ?? []).map((v) => (
              <li key={v}>{v.replaceAll("_", " ")}</li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: "#6b7280" }}>
            Baseline cost MAE {num(baseline?.mae, 3)} percentage points. The data-gap page shows
            what each of these would be worth if captured.
          </p>
        </Card>

        <Card title="Model choice and why">
          <div className="note-block">
            XGBoost is not assumed to be best. It was compared against linear regression, ridge,
            random forest and a median baseline under identical five-fold cross-validation, and
            the winner is written into the artefacts.
          </div>
          <p style={{ fontSize: 13, color: "#4b5563", marginTop: 10 }}>
            On this panel the gradient-boosted trees win on every head, and the gap over linear
            models is wide because the relationships are non-linear and threshold-like: slippage
            concentrates once the sanctioned duration is used up, and cost pressure concentrates
            once spending crosses the sanctioned cost.
          </p>
        </Card>
      </div>
    </>
  );
}