import { useEffect, useRef, useState } from "react";
import { api, money, num } from "../api";
import {
  Card,
  DataTable,
  PageHead,
  RiskTag,
  useFetch,
} from "../ui";

export default function Assistant() {
  const suggestions = useFetch(() => api.suggestions(), []);
  const [log, setLog] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  const ask = async (question) => {
    const q = (question ?? text).trim();
    if (!q || busy) return;
    setBusy(true);
    setLog((l) => [...l, { who: "user", text: q }]);
    setText("");
    try {
      const reply = await api.assistant(q);
      setLog((l) => [...l, { who: "bot", ...reply }]);
    } catch (error) {
      setLog((l) => [...l, { who: "bot", answer: `Could not reach the query service: ${error.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Data assistant"
        description="Ask a question in plain words. The assistant runs a query against the PAIMANA extract and reports the numbers it finds. It does not predict, estimate or guess." />

      <div className="split">
        <Card title="Conversation">
          <div className="chat-log">
            {log.length === 0 ? (
              <div className="empty">
                Ask about risk, cost pressure, sectors or states. Pick an example on the right to
                start.
              </div>
            ) : null}
            {log.map((entry, index) => (
              <div key={index} className={`bubble ${entry.who}`}>
                {entry.answer ?? entry.text}
                {entry.confidence ? (
                  <div className="meta">match confidence: {entry.confidence}</div>
                ) : null}
              </div>
            ))}
            {busy ? <div className="bubble bot">Querying the extract...</div> : null}
            <div ref={endRef} />
          </div>

          {log.length && log[log.length - 1]?.results?.length ? (
            <div style={{ marginTop: 12 }}>
              <DataTable
                rows={log[log.length - 1].results.slice(0, 12)}
                columns={Object.keys(log[log.length - 1].results[0])
                  .slice(0, 5)
                  .map((key) => ({
                    key,
                    label: key.replaceAll("_", " "),
                    align: typeof log[log.length - 1].results[0][key] === "number" ? "right" : "left",
                    render: (row) => {
                      const value = row[key];
                      if (typeof value === "number") return num(value, 2);
                      if (key.includes("risk")) return <RiskTag value={value} />;
                      return String(value ?? "-");
                    },
                  }))}
              />
            </div>
          ) : null}

          <div className="chat-input">
            <input placeholder="e.g. which sectors have the worst predicted delays"
              value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()} />
            <button className="btn" onClick={() => ask()} disabled={busy || !text.trim()}>
              {busy ? "Asking" : "Ask"}
            </button>
          </div>
        </Card>

        <div>
          <Card title="What you can ask" hint="Each one maps to a fixed query over the extract">
            <div className="pills">
              {(suggestions.data?.examples ?? []).map((q) => (
                <button key={q} className="pill" onClick={() => ask(q)}>{q}</button>
              ))}
            </div>
          </Card>

          <Card title="What the assistant will not do">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#4b5563", lineHeight: 1.75 }}>
              <li>It will not invent a figure when a question does not match a known query. It
                says so and lists what it can answer.</li>
              <li>It will not predict. Risk and cost forecasts come from the models on the
                dedicated pages, where the validation is shown alongside.</li>
              <li>It will not claim a cost overrun where the portal has not published a revised
                cost. That case is reported as measured budget pressure instead.</li>
              <li>It will not attribute a cause. It reports what the data shows and what the
                SHAP decomposition associates with a prediction.</li>
            </ul>
          </Card>

          <Card title="Figures it draws on">
            <dl className="kv">
              <dt>Projects</dt>
              <dd>1,731 in the latest freeze</dd>
              <dt>Approved cost</dt>
              <dd>{money(3071947.05)}</dd>
              <dt>Expenditure</dt>
              <dd>{money(1632560.54)}</dd>
              <dt>Freeze range</dt>
              <dd>July 2025 to August 2026</dd>
              <dt>Prediction horizon</dt>
              <dd>One month ahead</dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}