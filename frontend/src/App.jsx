import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "./api";
import "./index.css";

const ShellContext = createContext(null);

export function useShell() {
  return useContext(ShellContext);
}

const NAV = [
  ["/", "Dashboard"],
  ["/projects", "Project Explorer"],
  ["/predict", "Cost & Delay Prediction"],
  ["/risk", "Risk & Early Warnings"],
  ["/drivers", "Driver Analysis"],
  ["/benchmarks", "Benchmarking"],
  ["/sectors", "Sector & State"],
  ["/models", "Model Performance"],
  ["/data-gap", "Data Gap"],
  ["/assistant", "AI Assistant"],
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
      <div className="gov-bar">
        <span>Government of India &middot; Ministry of Statistics &amp; Programme Implementation</span>
        <span>Public Investment Infrastructure Monitoring System</span>
      </div>

      <header className="masthead">
        <div className="emblem">सा</div>
        <div>
          <h1>PAIMANA &middot; Project Risk Intelligence</h1>
          <div className="sub">
            Cost overrun, delay and risk forecasts built on the published project panel
          </div>
        </div>
        <div className="spacer" />
        <div className="freeze-badge">
          <span>Data as on</span>
          <strong>{freeze?.freeze_label ?? "-"}</strong>
          <span>{freeze ? `${freeze.projects.toLocaleString("en-IN")} projects` : ""}</span>
        </div>
      </header>

      <nav className="nav">
        <div className="nav-inner">
          {NAV.map(([path, label]) => (
            <NavLink key={path} to={path} end={path === "/"}>
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      <main>
        <Outlet />
      </main>

      <footer className="footer">
        Source: PAIMANA monthly Flash Reports and portal aggregates, paimana-proj.mospi.gov.in
        &middot; Predictions are one-month-ahead estimates from models trained on the
        published fields only
      </footer>
    </ShellContext.Provider>
  );
}