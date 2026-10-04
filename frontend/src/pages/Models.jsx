import { api, num } from "../api";
import {
  Card,
  DataTable,
  ErrorNote,
  Loader,
  PageHead,
  Tile,
  useFetch,
} from "../ui";

const HEADS = [
  ["cost_overrun_pct", "Cost pressure", "MAE in percentage points"],
  ["time_overrun_months", "Schedule delay", "MAE in months"],
];

export default function Models() {
  const metrics = useFetch(() => api.metrics(), []);
  if (metrics.loading) return <Loader label="Loading validation results" />;
  if (metrics.error) return <ErrorNote error={metrics.error} />;
  const m = metrics.data;

  return (
    <>
      <PageHead title="Model performance"
        description="Every head was compared against linear, ridge, random-forest and baseline models under identical five-fold cross-validation on one-step-ahead rows." />

      <div className="tiles">
        <Tile label="Supervised rows" value={num(m.supervised_rows, 0)}
          note={`${num(m.projects, 0)} projects, ${m.snapshots.length} snapshots`} />
        <Tile label="Panel rows" value={num(m.panel_rows, 0)} note={m.target_definition} />
        <Tile label="Cost pressure model" value={m.heads.cost_overrun_pct.chosen_model}
          note={`MAE ${num(m.heads.cost_overrun_pct.comparison[0].mae, 3)} pp`} />
        <Tile label="Delay model" value={m.heads.time_overrun_months.chosen_model}
          note={`R2 ${num(m.heads.time_overrun_months.comparison[0].r2, 3)}`} tone="good" />
        <Tile label="Risk classifier" value={m.heads.risk_class.chosen_model}
          note={`${pctOf(m.heads.risk_class.comparison[0].accuracy)} accuracy`} />
        <Tile label="Data source" value="PAIMANA Flash Reports"
          note={`${m.snapshots[0]} to ${m.snapshots[m.snapshots.length - 1]}`} tone="warn" />
      </div>

      {HEADS.map(([key, label, unit]) => (
        <Card key={key} title={`${label} model comparison`} hint={unit} flush>
          <DataTable
            rows={m.heads[key].comparison}
            columns={[
              {
                key: "model",
                label: "Model",
                render: (r) => (
                  <span>
                    <strong>{r.model}</strong>
                    {r.model === m.heads[key].chosen_model
                      ? <span className="tag info" style={{ marginLeft: 8 }}>selected</span> : null}
                  </span>
                ),
              },
              { key: "mae", label: "MAE", align: "right", render: (r) => num(r.mae, 3) },
              { key: "rmse", label: "RMSE", align: "right", render: (r) => num(r.rmse, 3) },
              { key: "r2", label: "R2", align: "right", render: (r) => num(r.r2, 3) },
              { key: "seconds", label: "Fit time (s)", align: "right", render: (r) => num(r.seconds, 1) },
            ]}
          />
          <div style={{ padding: "10px 15px" }}>
            <div className="note-block">
              {m.heads[key].description}. Lower MAE is better; the median baseline always
              predicts the same value, so it measures what a rules-only approach would achieve.
            </div>
          </div>
        </Card>
      ))}

      <Card title="Risk classifier comparison" hint="Accuracy, balanced accuracy and macro F1" flush>
        <DataTable
          rows={m.heads.risk_class.comparison}
          columns={[
            {
              key: "model",
              label: "Model",
              render: (r) => (
                <span>
                  <strong>{r.model}</strong>
                  {r.model === m.heads.risk_class.chosen_model
                    ? <span className="tag info" style={{ marginLeft: 8 }}>selected</span> : null}
                </span>
              ),
            },
            { key: "accuracy", label: "Accuracy", align: "right", render: (r) => pctOf(r.accuracy) },
            { key: "balanced_accuracy", label: "Balanced acc.", align: "right", render: (r) => pctOf(r.balanced_accuracy) },
            { key: "macro_f1", label: "Macro F1", align: "right", render: (r) => pctOf(r.macro_f1) },
            {
              key: "seconds",
              label: "Fit time (s)",
              align: "right",
              render: (r) => num(r.seconds, 1),
            },
          ]}
        />
        <div style={{ padding: "10px 15px" }}>
          <div className="note-block">
            The class distribution is imbalanced, so the majority baseline is a real bar to clear.
            Balanced accuracy is the fairer number: it weights a rare class as heavily as a common
            one, which matters because the High band is the one that matters.
          </div>
        </div>
      </Card>

      <Card title="Per-class performance of the selected classifier" flush>
        <DataTable
          rows={Object.entries(m.heads.risk_class.comparison[0].per_class).map(([name, stats]) => ({
            name, ...stats,
          }))}
          columns={[
            { key: "name", label: "Risk class", render: (r) => <strong>{r.name}</strong> },
            { key: "support", label: "Rows", align: "right", render: (r) => num(r.support, 0) },
            { key: "precision", label: "Precision", align: "right", render: (r) => pctOf(r.precision) },
            { key: "recall", label: "Recall", align: "right", render: (r) => pctOf(r.recall) },
            { key: "f1", label: "F1", align: "right", render: (r) => pctOf(r.f1) },
          ]}
        />
      </Card>

      <div className="grid-2">
        <Card title="How the targets are built">
          <div className="note-block">
            Each training row pairs a project as of month <strong>t</strong> with what was
            published for the same project at month <strong>t+1</strong>. Revised cost and
            revised completion date are excluded from the feature set, because they are the
            things being forecast.
          </div>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Source</dt><dd>{m.source}</dd>
            <dt>Target design</dt><dd>{m.target_definition}</dd>
            <dt>Validation</dt><dd>Five-fold cross-validation, shuffled, fixed seed</dd>
            <dt>Risk classes</dt><dd>{m.heads.risk_class.classes.join(", ")}</dd>
            <dt>Generated</dt><dd>{m.generated_at}</dd>
          </dl>
        </Card>

        <Card title="Honest limitations">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#4b5563", lineHeight: 1.7 }}>
            <li>Only five monthly snapshots are available, so the one-step-ahead design yields
              {` ${num(m.supervised_rows, 0)} rows`} rather than the tens of thousands a mature
              dataset would provide.</li>
            <li>Cross-validation mixes months, so it measures predictive skill rather than
              strict forward-in-time performance. With more freezes the same code should switch
              to a time-ordered split.</li>
            <li>The portal publishes a revised cost only for the major-project tables, so cost
              pressure mixes reported revisions with measured overspend. The two are kept
              distinguishable in the data.</li>
            <li>Ministry and sector labels are inferred from the report layout and can be wrong
              where a section heading is ambiguous.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}

function pctOf(value) {
  return value === undefined || value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}