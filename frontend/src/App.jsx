import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "./api";
import "./index.css";

const ShellContext = createContext(null);

export function useShell() {
  return useContext(ShellContext);
}

const NAV = [
  ["/", "Dashboard", "◧"],
  ["/projects", "Projects", "▤"],
  ["/risk", "Risk Analytics", "▲"],
  ["/predict", "What-If Analysis", "⇄"],
  ["/drivers", "What-If Drivers", "◎"],
  ["/benchmarks", "Benchmarking", "⇅"],
  ["/sectors", "Data Insights", "◈"],
  ["/models", "Model Validation", "∑"],
  ["/data-gap", "Data Gap", "◐"],
  ["/assistant", "AI Assistant", "✦"],
];

export default function App() {
  const [freeze, setFreeze] = useState(null);
  const location = useLocation();

  useEffect(() => {
    api.overview().then(setFreeze).catch(() => {});
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <ShellContext.Provider value={{ freeze }}>
      <div className="app">
        <aside className="side">
          <div className="brand">
            PRAGATI<span>-AI</span>
          </div>
          <div className="brand-tag">Predict &bull; Prevent &bull; Deliver</div>

          <nav className="side-nav">
            {NAV.map(([path, label, glyph]) => (
              <NavLink key={path} to={path} end={path === "/"}>
                <span className="glyph">{glyph}</span>
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="side-source">
            Source: PAIMANA monthly Flash Reports &amp; portal aggregates,
            paimana-proj.mospi.gov.in. Figures are {freeze?.freeze_label ?? "the latest freeze"}
            {" "}publish figures; risk values are model estimates.
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div>
              <h1>AI Powered Project Monitoring and Risk Analytics Platform</h1>
              <p className="sub">
                Cost overrun, schedule delay and risk forecasts for {freeze?.projects?.toLocaleString("en-IN") ?? "-"} PAIMANA projects
              </p>
            </div>
            <div className="logos">
              <span className="gov">
                <span aria-hidden="true">सा</span> MoSPI
              </span>
              <span className="sih">SIH 2026 &middot; PS 26103</span>
              <span className="badge">Data as on {freeze?.freeze_label ?? "-"}</span>
            </div>
          </header>

          <main className="content">
            <Outlet />
          </main>

          <footer className="footer">
            PRAGATI-AI &middot; Public Investment Infrastructure Monitoring System &middot;
            predictions are one-month-ahead estimates from models trained on published fields only
          </footer>
        </div>
      </div>
    </ShellContext.Provider>
  );
}