import { Link } from "react-router-dom";
import { api, monthLabel, num } from "../api";
import { Card, Loader, PageHead, useFetch } from "../ui";

export default function Methodology() {
  const metrics = useFetch(() => api.metrics(), []);
  const glossary = useFetch(() => api.glossary(), []);

  if (metrics.loading || glossary.loading) return <Loader label="Loading methodology" />;
  const m = metrics.data;
  const fields = glossary.data?.fields ?? [];

  return (
    <>
      <PageHead
        title="Methodology and data notes"
        description="How every figure on this platform is produced: the source, the definitions, the forecast design and the boundary of what the data can support."
      />

      <div className="method-grid">
        <Card title="1. Source">
          <p>
            All published figures come from the PAIMANA monthly Flash Reports and the portal
            aggregates at <code>paimana-proj.mospi.gov.in</code>. The extract is refreshed on
            each portal freeze and is versioned with the freeze month, so any figure on the
            site can be traced to the freeze it came from.
          </p>
          <dl className="kv">
            <dt>Projects in freeze</dt><dd>{num(m?.projects, 0)}</dd>
            <dt>Monthly snapshots</dt><dd>{num(m?.snapshots?.length, 0)}</dd>
            <dt>Panel rows</dt><dd>{num(m?.panel_rows, 0)}</dd>
            <dt>Supervised rows</dt><dd>{num(m?.supervised_rows, 0)}</dd>
            <dt>Freeze range</dt>
            <dd>{m?.snapshots?.map((s) => monthLabel(s)).join(" → ") ?? "-"}</dd>
          </dl>
        </Card>

        <Card title="2. What is measured and what is forecast">
          <p>
            These are kept strictly apart throughout the platform. Anything labelled{" "}
            <em>reported</em> is a number the portal published. Anything labelled{" "}
            <em>predicted</em> or <em>measured</em> is produced by this platform and is an
            estimate, not a published figure.
          </p>
          <dl className="kv">
            <dt>Approved cost, expenditure, progress</dt><dd>Reported</dd>
            <dt>Revised cost, revised completion</dt><dd>Reported, where published</dd>
            <dt>Measured budget pressure</dt><dd>Derived from reported spend</dd>
            <dt>Cost pressure, delay, risk class</dt><dd>Predicted, one month ahead</dd>
          </dl>
          <div className="note-block" style={{ marginTop: 12 }}>
            The portal publishes a revised cost only in the major-project tables. For the
            remainder, an overrun cannot be read from the data, so the platform reports
            <strong> measured budget pressure</strong> instead and labels every figure as{" "}
            <span className="tag measured">Measured</span> or{" "}
            <span className="tag reported">Reported</span> at the point of use.
          </div>
        </Card>

        <Card title="3. Forecast design">
          <p>
            Each training row pairs a project as observed at month <em>t</em> with what was
            published for the same project at month <em>t+1</em>. The horizon is therefore
            one month ahead, which is the shortest horizon at which the portal republishes.
          </p>
          <dl className="kv">
            <dt>Target definition</dt><dd>{m?.target_definition}</dd>
            <dt>Excluded from features</dt>
            <dd>Revised cost and revised completion date, because they are the forecast targets</dd>
            <dt>Validation</dt><dd>Five-fold cross-validation, shuffled, fixed seed</dd>
            <dt>Baselines reported</dt><dd>Median regressor and majority class, per head</dd>
          </dl>
          <div className="note-block" style={{ marginTop: 12 }}>
            Each head is reported against a trivial baseline, so a headline accuracy figure
            is always read next to the score the simplest possible predictor would have
            achieved. See <Link to="/models">model performance</Link> for the comparison.
          </div>
        </Card>

        <Card title="4. Field definitions"
          hint="Every derived field, and the basis it is published on">
          <div className="glossary">
            {fields.map((f) => (
              <div className="glossary-row" key={f.field}>
                <div className="glossary-head">
                  <span className="glossary-label">{f.label}</span>
                  <span className={`tag basis-${f.basis.startsWith("Reported") ? "reported" : f.basis.startsWith("Predicted") ? "predicted" : f.basis === "Label" ? "neutral" : "measured"}`}>
                    {f.basis}
                  </span>
                </div>
                <code className="glossary-field">{f.field}</code>
                <p className="glossary-def">{f.definition}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="5. Risk classification">
          <p>
            Risk classes are cut from published fields using documented thresholds, not
            learned. The class a project sits in today and the class the model expects it to
            sit in next month are reported as two separate values.
          </p>
          <dl className="kv">
            <dt>Classes</dt><dd>{m?.heads?.risk_class?.classes?.join(", ")}</dd>
            <dt>Inputs</dt>
            <dd>Elapsed duration against sanctioned duration, measured budget pressure, physical progress</dd>
            <dt>Movement</dt>
            <dd>Escalating where the predicted class is worse than the current class</dd>
          </dl>
        </Card>

        <Card title="6. Boundary of the data">
          <p>
            Stated plainly so that no figure on this platform is read as more than it is.
          </p>
          <ul className="tight-list">
            <li>
              The extract covers {num(m?.snapshots?.length, 0)} monthly freezes, giving{" "}
              {num(m?.supervised_rows, 0)} one-step-ahead training rows. Validation measures
              predictive skill across those rows; it is not a forward-in-time backtest. Once
              further freezes are published, the same pipeline switches to a time-ordered
              split.
            </li>
            <li>
              Ministry and sector labels are derived from the layout of the published report.
              Where a section heading is ambiguous the label may not match the ministry's own
              classification, so filter by ministry with that in mind.
            </li>
            <li>
              Spend figures are cumulative as reported and are not adjusted for revision.
              Projections are one month ahead and compound monthly error over any longer
              horizon.
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}