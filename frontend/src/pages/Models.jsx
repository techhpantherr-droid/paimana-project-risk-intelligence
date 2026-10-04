import { Link } from "react-router-dom";
import { api, num, points, share } from "../api";
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
          note={`MAE ${points(m.heads.cost_overrun_pct.comparison[0].mae, 3)}`} />
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

        <Card title="Benchmarked against simple baselines"
          hint="A model only earns its place if it beats the trivial estimate">
          <div className="baseline-rows">
            {BASELINE_NOTE.map((line) => (
              <div className="baseline-row" key={line}>{line}</div>
            ))}
          </div>
          <div className="note-block" style={{ marginTop: 12 }}>
            Every headline figure on this page is reproduced from{" "}
            <code>artifacts/metrics.json</code> at build time. The full method, the
            definition of each field and the scope of the extract are published on the{" "}
            <Link to="/methodology">methodology page</Link>.
          </div>
        </Card>
      </div>
    </>
  );
}

const BASELINE_NOTE = [
  "Cost pressure is scored against a median-baseline regressor, so the reported MAE has to beat the error a single portfolio-wide constant would make.",
  "Delay is scored against a majority-class predictor, so the R2 shown has to clear zero.",
  "Risk class is scored against always-predicting-the-majority-class, which on an imbalanced portfolio is a high accuracy score and a useless model. The comparison is reported so the gap is visible.",
  "Validation uses five folds with a fixed seed, so re-running the pipeline reproduces the same numbers.",
];

function pctOf(value) {
  return share(value);
}