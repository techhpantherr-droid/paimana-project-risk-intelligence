import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { money, monthLabel, num } from "./api";

export const AXIS = { fontSize: 10, fill: "#6b7c93", fontFamily: "Inter, Segoe UI, sans-serif" };
export const TOOLTIP = {
  contentStyle: {
    border: "1px solid #dfe4ec",
    borderRadius: 4,
    fontSize: 12,
    fontFamily: "Nunito, Montserrat, sans-serif",
    boxShadow: "0 1px 3px rgba(1,38,119,.1)",
  },
  labelStyle: { fontWeight: 600, color: "#012677" },
};

export const PALETTE = ["#012677", "#0a3d9e", "#3a6fb5", "#6f9dd6", "#a8c4e8",
  "#f0a742", "#d4703a", "#b3261e", "#1d7a4c", "#5a6474"];

export const RISK_COLOR = { High: "#b3261e", Medium: "#b26a00", Low: "#1d7a4c" };

export function RiskTag({ value }) {
  const key = String(value ?? "").toLowerCase();
  const cls = key === "high" ? "high" : key === "medium" ? "medium" : key === "low" ? "low" : "neutral";
  return <span className={`tag ${cls}`}>{value ?? "-"}</span>;
}

export function Card({ title, hint, actions, children, flush = false }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {hint ? <div className="hint">{hint}</div> : null}
        </div>
        {actions ? <div className="toolbar">{actions}</div> : null}
      </div>
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Modal({ open, onClose, title, subtitle, children }) {
  if (!open) return null;
  return (
    <div className="modal open" onClick={onClose} role="presentation">
      <div className="modal-box" onClick={(event) => event.stopPropagation()} role="dialog">
        <button className="close" onClick={onClose}>Close</button>
        <h2>{title}</h2>
        {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function Tile({ label, value, note, tone = "" }) {
  return (
    <div className={`tile ${tone}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

export function PageHead({ title, description, children }) {
  return (
    <div className="page-head">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {children ? <div className="toolbar">{children}</div> : null}
    </div>
  );
}

export function Loader({ label = "Loading" }) {
  return <div className="spinner">{label}...</div>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="card">
      <div className="card-body">
        <strong style={{ color: "#b3261e" }}>The API is not answering</strong>
        <div className="note-block" style={{ marginTop: 8 }}>
          <div>{String(error.message ?? error)}</div>
          <div style={{ marginTop: 8 }}>
            The site renders nothing without the FastAPI service. In two terminals from the
            project root:
          </div>
          <div style={{ marginTop: 6 }}>
            <code>python -m backend.main</code>
            <br />
            <code>cd frontend &amp;&amp; npm run dev</code>
          </div>
          <div style={{ marginTop: 8 }}>
            On a fresh clone also run <code>python -m backend.train</code> and{" "}
            <code>python -m backend.store</code> once, before starting the API. Confirm the
            service is up at <code>http://127.0.0.1:8000/api/health</code> &mdash; it should
            return <code>{'{"status":"ok", ...}'}</code>.
          </div>
        </div>
      </div>
    </div>
  );
}

export function useFetch(loader, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [token, setToken] = useState(0);

  useEffect(() => {
    let live = true;
    loader()
      .then((data) => live && setState({ data, loading: false, error: null }))
      .catch((error) => live && setState({ data: null, loading: false, error }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, token]);

  const reload = () => {
    setState((s) => ({ ...s, loading: true }));
    setToken((t) => t + 1);
  };

  return { ...state, reload };
}

export function MiniBar({ value, max, tone = "" }) {
  const width = max ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="bar-track">
      <div className={`bar-fill ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export function DriverBars({ rows, suffix = "" }) {
  if (!rows?.length) return <div className="empty">No drivers computed</div>;
  const max = Math.max(...rows.map((r) => r.mean_abs_shap));
  return (
    <div>
      {rows.map((row) => (
        <div className="driver-row" key={row.label}>
          <span title={row.label}>{row.label}</span>
          <MiniBar value={row.mean_abs_shap} max={max} />
          <span className="val">{num(row.mean_abs_shap, 2)}{suffix}</span>
        </div>
      ))}
    </div>
  );
}

export function CostTrend({ data }) {
  const rows = (data ?? []).map((row) => ({
    month: monthLabel(row.month_year),
    Approved: row.original_cost / 100000,
    Revised: row.revised_cost ? row.revised_cost / 100000 : null,
    Expenditure: row.expenditure / 100000,
  }));
  return (
    <ResponsiveContainer width="100%" height={265}>
      <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="#edf0f5" />
        <XAxis dataKey="month" tick={AXIS} interval="preserveStartEnd" />
        <YAxis tick={AXIS} tickFormatter={(v) => `${v}L`} width={44} />
        <Tooltip {...TOOLTIP} formatter={(v, name) => [`Rs ${num(v, 2)} lakh cr`, name]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="Approved" stroke="#012677" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="Revised" stroke="#f0a742" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="Expenditure" stroke="#1d7a4c" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function PortfolioBars({ rows, valueKey = "expenditure", labelKey = "label", moneyFmt = true }) {
  const data = (rows ?? []).slice(0, 14).map((row) => ({
    name: String(row[labelKey]).length > 22 ? `${String(row[labelKey]).slice(0, 21)}…` : row[labelKey],
    value: row[valueKey],
  }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(240, data.length * 26)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 22, bottom: 4, left: 4 }}>
        <CartesianGrid stroke="#edf0f5" horizontal={false} />
        <XAxis type="number" tick={AXIS} />
        <YAxis type="category" dataKey="name" tick={AXIS} width={150} />
        <Tooltip
          {...TOOLTIP}
          formatter={(v) => [moneyFmt ? money(v * 100000) : num(v, 1), ""]}
        />
        <Bar dataKey="value" fill="#012677" radius={[0, 2, 2, 0]} barSize={14} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function RiskPie({ mix }) {
  const data = Object.entries(mix ?? {}).map(([name, value]) => ({ name, value }));
  return (
    <div>
      <ResponsiveContainer width="100%" height={215}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={82}
            paddingAngle={2} stroke="#fff">
            {data.map((entry) => (
              <Cell key={entry.name} fill={RISK_COLOR[entry.name] ?? "#5a6474"} />
            ))}
          </Pie>
          <Tooltip {...TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="legend">
        {data.map((entry) => (
          <span key={entry.name}>
            <i style={{ background: RISK_COLOR[entry.name] }} />
            {entry.name} &middot; {num(entry.value, 0)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DataTable({ columns, rows, onRowClick, empty = "Nothing to show" }) {
  if (!rows?.length) return <div className="empty">{empty}</div>;
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={col.align === "right" ? "num" : ""}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key ?? index}
              className={onRowClick ? "clickable" : ""}
              onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((col) => (
                <td key={col.key} className={col.align === "right" ? "num" : ""}>
                  {col.render ? col.render(row) : (row[col.key] ?? "-")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}