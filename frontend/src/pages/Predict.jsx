import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { api, money, num, pct } from "../api";
import {
  Card,
  DataTable,
  ErrorNote,
  PageHead,
  RiskTag,
} from "../ui";

export default function Predict() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [search, setSearch] = useState(params.get("code") ?? "");
  const [detail, setDetail] = useState(null);
  const [sim, setSim] = useState({ expenditure_change_pct: 10, progress_change_pp: -5, cost_change_pct: 0 });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const matches = useFetch(() => api.projects({ search, page_size: 8, sort: "cost" }), [search]);

  useEffect(() => {
    if (!code) return;
    api.project(code).then((data) => {
      setDetail(data);
      setResult(null);
      setError(null);
    }).catch(setError);
  }, [code]);

  const run = async () => {
    setBusy(true);
    try {
      setResult(await api.whatIf({ project_code: code, ...sim }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const p = detail?.current;

  return (
    <>
      <PageHead title="Cost and delay prediction lab"
        description="Pick a project, see the model's one-month-ahead cost pressure and delay estimate, then test how a change in the observed numbers would move it." />

      <Card title="Find a project">
        <div className="toolbar">
          <input placeholder="Search by name, code or agency" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 280 }} />
          <button className="btn" disabled={!matches.data?.rows?.length}
            onClick={() => setCode(matches.data.rows[0].project_code)}>
            Load first match
          </button>
          {code ? <span className="tag info">Loaded {code}</span> : null}
        </div>
        <div style={{ marginTop: 12 }}>
          <DataTable
            rows={matches.data?.rows ?? []}
            empty={search ? "No project matches" : "Type to search the panel"}
            onRowClick={(row) => { setCode(row.project_code); setSearch(row.project_name); }}
            columns={[
              { key: "project_code", label: "Code", render: (r) => <code style={{ fontSize: 12 }}>{r.project_code}</code> },
              { key: "project_name", label: "Project", render: (r) => String(r.project_name).slice(0, 62) },
              { key: "state", label: "State" },
              { key: "original_cost", label: "Approved", align: "right", render: (r) => money(r.original_cost) },
              { key: "predicted_risk_class", label: "Predicted risk", render: (r) => <RiskTag value={r.predicted_risk_class} /> },
            ]}
          />
        </div>
      </Card>

      {error ? <ErrorNote error={error} /> : null}
      {!p ? <Card title="Prediction"><div className="empty">Select a project to load its prediction.</div></Card> : (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="label">Predicted cost pressure</div>
              <div className="value">{num(p.predicted_cost_pressure_pct, 2)}%</div>
              <div className="note">Spending above sanctioned cost, next month</div>
            </div>
            <div className="tile">
              <div className="label">Predicted delay</div>
              <div className="value">{num(p.predicted_time_overrun_months, 1)} mo</div>
              <div className="note">Against the original completion date</div>
            </div>
            <div className="tile">
              <div className="label">Risk class</div>
              <div className="value"><RiskTag value={p.predicted_risk_class} /></div>
              <div className="note">Confidence {pct(p.confidence * 100, 0)}</div>
            </div>
            <div className="tile">
              <div className="label">Risk today</div>
              <div className="value"><RiskTag value={p.risk_class} /></div>
              <div className="note">{p.risk_moved}</div>
            </div>
          </div>

          <Card title="Scenario inputs" hint="Adjust the observed numbers and re-run the models">
            <div className="toolbar">
              <label className="toolbar">Expenditure %
                <input type="number" step="5" value={sim.expenditure_change_pct}
                  onChange={(e) => setSim({ ...sim, expenditure_change_pct: Number(e.target.value) })} />
              </label>
              <label className="toolbar">Progress pp
                <input type="number" step="5" value={sim.progress_change_pp}
                  onChange={(e) => setSim({ ...sim, progress_change_pp: Number(e.target.value) })} />
              </label>
              <label className="toolbar">Approved cost %
                <input type="number" step="5" value={sim.cost_change_pct}
                  onChange={(e) => setSim({ ...sim, cost_change_pct: Number(e.target.value) })} />
              </label>
              <button className="btn" onClick={run} disabled={busy}>{busy ? "Running" : "Predict"}</button>
              <button className="btn ghost" onClick={() => setSim({ expenditure_change_pct: 0, progress_change_pp: 0, cost_change_pct: 0 })}>
                Reset to actuals
              </button>
              <Link className="btn ghost" to={`/projects/${code}`}>Full project record</Link>
            </div>
          </Card>

          {result ? (
            <Card title="Result" hint="Same models, adjusted inputs">
              <div className="grid-3">
                <div className="tile">
                  <div className="label">Cost pressure</div>
                  <div className="value">{num(result.scenario.predicted_cost_pressure_pct, 2)}%</div>
                  <div className="note">
                    {result.change.cost_pressure_pp > 0 ? "+" : ""}{num(result.change.cost_pressure_pp, 2)} pp
                    against {num(result.baseline.predicted_cost_pressure_pct, 2)}%
                  </div>
                </div>
                <div className="tile">
                  <div className="label">Delay</div>
                  <div className="value">{num(result.scenario.predicted_time_overrun_months, 1)} mo</div>
                  <div className="note">
                    {result.change.delay_months > 0 ? "+" : ""}{num(result.change.delay_months, 1)} months
                    against {num(result.baseline.predicted_time_overrun_months, 1)} mo
                  </div>
                </div>
                <div className="tile">
                  <div className="label">Risk class</div>
                  <div className="value"><RiskTag value={result.scenario.predicted_risk_class} /></div>
                  <div className="note">
                    probabilities: {Object.entries(result.scenario.risk_probabilities)
                      .map(([k, v]) => `${k} ${pct(v * 100, 0)}`).join("  ")}
                  </div>
                </div>
              </div>
              <div className="note-block" style={{ marginTop: 12 }}>
                This is a what-if on the same fitted models, not a forecast of what the ministry
                will do. It answers a narrow question: if this project's reported numbers moved
                by the amount above, where would the prediction land?
              </div>
            </Card>
          ) : null}

          <Card title="Observed inputs behind this prediction" flush>
            <DataTable
              rows={[p]}
              columns={[
                { key: "original_cost", label: "Approved cost", align: "right", render: (r) => money(r.original_cost) },
                { key: "expenditure", label: "Expenditure", align: "right", render: (r) => money(r.expenditure) },
                { key: "expenditure_pct_of_cost", label: "Spend %", align: "right", render: (r) => pct(r.expenditure_pct_of_cost) },
                { key: "physical_progress", label: "Progress", align: "right", render: (r) => pct(r.physical_progress) },
                { key: "elapsed_pct", label: "Time elapsed", align: "right", render: (r) => pct(r.elapsed_pct) },
                { key: "progress_gap", label: "Progress gap", align: "right", render: (r) => num(r.progress_gap, 1) },
                { key: "spend_vs_progress_gap", label: "Spend vs progress", align: "right", render: (r) => num(r.spend_vs_progress_gap, 1) },
                { key: "project_age_months", label: "Age (months)", align: "right", render: (r) => num(r.project_age_months, 0) },
                { key: "months_to_original_doc", label: "Months to due", align: "right", render: (r) => num(r.months_to_original_doc, 0) },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}