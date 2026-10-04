"""FastAPI service for the PAIMANA project risk platform.

    python -m backend.main            # http://127.0.0.1:8000/docs

Every figure the site shows comes from data/app.db or from the trained models in
artifacts/. Nothing is hard-coded and nothing is estimated at request time.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import shap
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend import features as F
from backend import store
from backend.assistant import answer_question
from backend.store import ARTIFACTS, DB_PATH, ROOT


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.build(DB_PATH)
    yield


app = FastAPI(title="PAIMANA Project Risk Intelligence API", version="1.0.0",
              lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

METRICS = json.loads((ARTIFACTS / "metrics.json").read_text(encoding="utf-8"))
REFERENCE = json.loads((ROOT / "data" / "processed" / "reference_data.json").read_text(
    encoding="utf-8"))

RISK_ORDER = {"High": 0, "Medium": 1, "Low": 2}


def query(sql: str, params: tuple = ()) -> pd.DataFrame:
    with store.connect() as conn:
        return pd.read_sql_query(sql, conn, params=params)


def latest_month() -> str:
    return query("SELECT MAX(snapshot) AS m FROM project_current")["m"].iat[0]


def rupees(value: float | None) -> float:
    return round(float(value or 0.0), 2)


def records(frame: pd.DataFrame) -> list[dict]:
    frame = frame.where(pd.notna(frame), None)
    return json.loads(frame.to_json(orient="records", date_format="iso"))


# ---------------------------------------------------------------- dashboard
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "database": DB_PATH.exists(), "latest_month": latest_month()}


@app.get("/api/overview")
def overview(month: str | None = None) -> dict:
    month = month or latest_month()
    panel = query("SELECT * FROM project_current WHERE snapshot = ?", (month,))
    cost = panel["original_cost"].sum()
    spent = panel["expenditure"].sum()
    revised_known = panel[panel["revised_cost"].notna()]

    trend = query(
        "SELECT snapshot, SUM(original_cost) AS original_cost, "
        "SUM(expenditure) AS expenditure, COUNT(*) AS projects "
        "FROM project_panel GROUP BY snapshot ORDER BY snapshot")
    trend["utilisation_pct"] = (trend["expenditure"] / trend["original_cost"] * 100).round(2)

    by_risk = panel["predicted_risk_class"].value_counts().to_dict()
    live_risk = panel["risk_class"].value_counts().to_dict()
    return {
        "freeze_month": month,
        "freeze_label": REFERENCE["freeze_dates"]["displayFreeze"],
        "projects": int(len(panel)),
        "approved_cost_cr": rupees(cost),
        "expenditure_cr": rupees(spent),
        "utilisation_pct": round(float(spent / cost * 100), 2) if cost else 0.0,
        "unspent_cr": rupees(cost - spent),
        "reported_revised_cost_cr": rupees(revised_known["revised_cost"].sum()),
        "projects_with_reported_revised_cost": int(len(revised_known)),
        "mean_physical_progress": round(float(panel["physical_progress"].mean()), 2),
        "predicted_high_risk": int(by_risk.get("High", 0)),
        "predicted_medium_risk": int(by_risk.get("Medium", 0)),
        "predicted_low_risk": int(by_risk.get("Low", 0)),
        "new_high_risk_entries": int((panel["alert"] == "New high-risk entry").sum()),
        "current_risk_mix": {k: int(v) for k, v in live_risk.items()},
        "predicted_risk_mix": {k: int(v) for k, v in by_risk.items()},
        "portfolio_trend": records(trend),
        "source": METRICS["source"],
    }


@app.get("/api/breakdown")
def breakdown(dimension: str = Query("sector", pattern="^(sector|state|progress_slab)$"),
              month: str | None = None,
              limit: int = 40) -> dict:
    month = month or latest_month()
    rows = query(
        "SELECT label, projects, original_cost, revised_cost, expenditure "
        "FROM portal_aggregates WHERE dimension = ? AND month_year = ? "
        "ORDER BY original_cost DESC", (dimension, month))
    rows["expenditure_pct"] = (rows["expenditure"] / rows["original_cost"] * 100).round(2)
    return {"dimension": dimension, "month_year": month,
            "rows": records(rows.head(limit)),
            "total": records(rows.tail(1))}


@app.get("/api/portfolio-trend")
def portfolio_trend(dimension: str = "portfolio") -> dict:
    rows = query(
        "SELECT month_year, label, projects, original_cost, revised_cost, expenditure "
        "FROM portal_aggregates WHERE dimension = ? ORDER BY month_year, label", (dimension,))
    return {"dimension": dimension, "rows": records(rows)}


@app.get("/api/reference")
def reference() -> dict:
    return {
        "sectors": [item["Text"] for item in REFERENCE["sectors"]],
        "states": [item["Text"] for item in REFERENCE["states"]],
        "ministries": [item["Text"] for item in REFERENCE["ministries"]],
        "freeze": REFERENCE["freeze_dates"],
    }


# ----------------------------------------------------------------- projects
PROJECT_SORTS = {
    "cost": "original_cost", "expenditure": "expenditure",
    "progress": "physical_progress", "risk": "predicted_risk_class",
    "cost_pressure": "predicted_cost_pressure_pct",
    "delay": "predicted_time_overrun_months",
}


@app.get("/api/projects")
def projects(
    search: str = "",
    sector: str = "",
    state: str = "",
    ministry: str = "",
    risk: str = "",
    movement: str = "",
    min_cost: float = 0,
    max_delay: float | None = None,
    sort: str = "cost",
    page: int = 1,
    page_size: int = 25,
) -> dict:
    sort_column = PROJECT_SORTS.get(sort, "original_cost")
    order = "ASC" if sort == "progress" else "DESC"

    clauses = ["original_cost >= ?"]
    params: list[Any] = [min_cost]
    if search:
        clauses.append("(project_name LIKE ? OR project_code LIKE ? OR agency LIKE ?)")
        like = f"%{search}%"
        params += [like, like, like]
    for column, value in (("sector", sector), ("state", state),
                          ("ministry", ministry), ("predicted_risk_class", risk),
                          ("risk_moved", movement)):
        if value:
            clauses.append(f"{column} = ?")
            params.append(value)
    if max_delay is not None:
        clauses.append("predicted_time_overrun_months >= ?")
        params.append(max_delay)

    where = " AND ".join(clauses)
    total = int(query(f"SELECT COUNT(*) AS n FROM project_current WHERE {where}",
                      tuple(params))["n"].iat[0])

    if sort == "risk":
        ordering = ("ORDER BY CASE predicted_risk_class "
                    "WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, "
                    "predicted_cost_pressure_pct DESC")
    else:
        ordering = f"ORDER BY {sort_column} {order}"

    frame = query(
        f"SELECT * FROM project_current WHERE {where} {ordering} LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]))
    return {"total": total, "page": page, "page_size": page_size,
            "columns": list(frame.columns), "rows": records(frame)}


@app.get("/api/projects/{project_code}")
def project_detail(project_code: str) -> dict:
    current = query("SELECT * FROM project_current WHERE project_code = ?", (project_code,))
    if current.empty:
        raise HTTPException(404, "project not found in the latest freeze")
    history = query(
        "SELECT snapshot, month_name, original_cost, revised_cost, expenditure, "
        "physical_progress FROM project_panel WHERE project_code = ? ORDER BY snapshot",
        (project_code,))
    peers = query(
        "SELECT AVG(physical_progress) AS sector_progress, "
        "AVG(predicted_time_overrun_months) AS sector_delay, "
        "AVG(predicted_cost_pressure_pct) AS sector_pressure, "
        "COUNT(*) AS sector_projects "
        "FROM project_current WHERE sector = ?", (current["sector"].iat[0],))
    return {"current": records(current)[0], "history": records(history),
            "sector_peers": records(peers)[0]}


@app.get("/api/projects/{project_code}/explain")
def project_explain(project_code: str, top: int = 10) -> dict:
    frame = query("SELECT * FROM project_current WHERE project_code = ?", (project_code,))
    if frame.empty:
        raise HTTPException(404, "project not found in the latest freeze")
    bundle = store.load_bundle()
    X = bundle["preprocessors"]["base"].transform(F.feature_matrix(frame))
    values = shap.TreeExplainer(bundle["heads"]["cost"]["model"]).shap_values(
        np.asarray(X.toarray() if hasattr(X, "toarray") else X, dtype=float),
        check_additivity=False)
    if isinstance(values, list):
        values = values[-1]
    names = bundle["heads"]["cost"]["names"]
    order = np.argsort(np.abs(values[0]))[::-1][:top]
    base = float(bundle["heads"]["cost"]["model"].predict(X)[0])
    return {
        "project_code": project_code,
        "project_name": frame["project_name"].iat[0],
        "base_value": round(base, 3),
        "prediction": round(base + float(values[0].sum()), 3),
        "contributions": [
            {"feature": names[i],
             "label": _label(names[i]),
             "shap": round(float(values[0][i]), 4),
             "direction": "pushes risk up" if values[0][i] > 0 else "pushes risk down"}
            for i in order
        ],
    }


def _label(name: str) -> str:
    base = name.split("__", 1)[-1] if "__" in name else name
    if name.startswith("cat__"):
        for field in sorted(F.FEATURE_LABELS, key=len, reverse=True):
            if base.startswith(field + "_"):
                return f"{F.FEATURE_LABELS[field]}: {base[len(field) + 1:]}"
        return base.replace("_", " ").capitalize()
    return F.FEATURE_LABELS.get(base, base.replace("_", " ").capitalize())


# ----------------------------------------------------------------- what-if
class Scenario(BaseModel):
    project_code: str
    expenditure_change_pct: float = Field(0, ge=-90, le=500)
    progress_change_pp: float = Field(0, ge=-100, le=100)
    cost_change_pct: float = Field(0, ge=-50, le=300)


@app.post("/api/what-if")
def what_if(scenario: Scenario) -> dict:
    frame = query("SELECT * FROM project_current WHERE project_code = ?",
                  (scenario.project_code,))
    if frame.empty:
        raise HTTPException(404, "project not found")
    row = frame.iloc[0].copy()
    baseline = {
        "predicted_cost_pressure_pct": float(row["predicted_cost_pressure_pct"]),
        "predicted_time_overrun_months": float(row["predicted_time_overrun_months"]),
        "predicted_risk_class": row["predicted_risk_class"],
    }

    row["expenditure"] = float(row["expenditure"]) * (1 + scenario.expenditure_change_pct / 100)
    row["physical_progress"] = float(np.clip(
        float(row["physical_progress"]) + scenario.progress_change_pp, 0, 100))
    row["original_cost"] = float(row["original_cost"]) * (1 + scenario.cost_change_pct / 100)

    adjusted = F.add_features(pd.DataFrame([row]))
    bundle = store.load_bundle()
    X = bundle["preprocessors"]["base"].transform(F.feature_matrix(adjusted))
    probabilities = bundle["heads"]["risk"]["model"].predict_proba(X)[0]
    labels = bundle["labels"]
    result = {
        "predicted_cost_pressure_pct": round(
            float(bundle["heads"]["cost"]["model"].predict(X)[0]), 3),
        "predicted_time_overrun_months": round(
            float(bundle["heads"]["time"]["model"].predict(X)[0]), 3),
        "predicted_risk_class": labels[int(probabilities.argmax())],
        "risk_probabilities": {label: round(float(p), 4)
                               for label, p in zip(labels, probabilities)},
    }
    return {"project_code": scenario.project_code, "project_name": row["project_name"],
            "baseline": {**baseline,
                         "risk_probabilities": {label: round(float(row[f"risk_prob_{label}"]), 4)
                                                for label in labels}},
            "scenario": result,
            "change": {
                "cost_pressure_pp": round(result["predicted_cost_pressure_pct"]
                                          - baseline["predicted_cost_pressure_pct"], 3),
                "delay_months": round(result["predicted_time_overrun_months"]
                                      - baseline["predicted_time_overrun_months"], 3),
                "risk_class_changed": result["predicted_risk_class"]
                                      != baseline["predicted_risk_class"],
            },
            "inputs": scenario.model_dump()}


# -------------------------------------------------------------- benchmarking
@app.get("/api/benchmarks")
def benchmarks(dimension: str = Query("sector", pattern="^(sector|state|ministry)$"),
               limit: int = 15) -> dict:
    rows = query(
        f"SELECT {dimension} AS name, COUNT(*) AS projects, "
        "AVG(physical_progress) AS avg_progress, "
        "AVG(predicted_time_overrun_months) AS avg_delay_months, "
        "AVG(predicted_cost_pressure_pct) AS avg_cost_pressure, "
        "SUM(CASE WHEN predicted_risk_class = 'High' THEN 1 ELSE 0 END) AS high_risk, "
        "SUM(original_cost) AS approved_cost "
        f"FROM project_current WHERE {dimension} IS NOT NULL "
        f"GROUP BY {dimension} ORDER BY avg_delay_months DESC")
    rows["high_risk_share_pct"] = (rows["high_risk"] / rows["projects"] * 100).round(1)
    rows["approved_cost_cr"] = rows["approved_cost"].round(2)
    rows = rows.drop(columns=["approved_cost"])
    best = rows.nsmallest(min(3, len(rows)), "avg_delay_months")
    return {"dimension": dimension, "rows": records(rows.head(limit)),
            "best_performers": records(best)}


@app.get("/api/drivers")
def drivers(limit: int = 12) -> dict:
    frame = pd.read_csv(ARTIFACTS / "shap_importance.csv")
    out = {}
    for target, block in frame.groupby("target"):
        out[target] = records(block.head(limit))
    return out


@app.get("/api/model/metrics")
def model_metrics() -> dict:
    return METRICS


@app.get("/api/data-gap")
def data_gap() -> dict:
    gap = METRICS["data_gap"]
    steps = gap["steps"]
    ranked = sorted([s for s in steps if s["added"] not in (None, "all")],
                    key=lambda s: s["change_pct"])
    return {
        "note": gap["note"],
        "baseline_mae": gap["baseline_mae"],
        "steps": steps,
        "most_valuable": ranked[:3],
        "least_valuable": ranked[-3:][::-1],
        "risk_accuracy_today": gap["risk_accuracy_today"],
        "risk_accuracy_with_extra": gap["risk_accuracy_with_extra"],
        "candidates": gap["candidate_variables"],
    }


@app.get("/api/alerts")
def alerts(limit: int = 60) -> dict:
    rows = query(
        "SELECT project_code, project_name, sector, ministry, state, "
        "physical_progress, expenditure_pct_of_cost, progress_gap, "
        "risk_class, predicted_risk_class, predicted_cost_pressure_pct, "
        "predicted_time_overrun_months, confidence, alert "
        "FROM project_current WHERE alert != '' "
        "ORDER BY predicted_cost_pressure_pct DESC LIMIT ?", (limit,))
    counts = query(
        "SELECT alert, COUNT(*) AS n FROM project_current WHERE alert != '' "
        "GROUP BY alert")
    return {"counts": records(counts), "rows": records(rows)}


@app.get("/api/sector-map")
def sector_map() -> dict:
    rows = query(
        "SELECT state, COUNT(*) AS projects, SUM(original_cost) AS approved_cost_cr, "
        "SUM(expenditure) AS expenditure_cr, "
        "SUM(CASE WHEN predicted_risk_class = 'High' THEN 1 ELSE 0 END) AS high_risk, "
        "AVG(physical_progress) AS avg_progress "
        "FROM project_current GROUP BY state ORDER BY approved_cost_cr DESC")
    rows["utilisation_pct"] = (rows["expenditure_cr"] / rows["approved_cost_cr"] * 100).round(2)
    rows["high_risk_pct"] = (rows["high_risk"] / rows["projects"] * 100).round(1)
    return {"rows": records(rows)}


@app.get("/api/health-timeline")
def health_timeline(project_code: str | None = None, top: int = 25) -> dict:
    if project_code:
        rows = query(
            "SELECT snapshot, month_name, physical_progress, expenditure, "
            "original_cost, ROUND(expenditure / NULLIF(original_cost, 0) * 100, 2) "
            "AS expenditure_pct_of_cost FROM project_panel "
            "WHERE project_code = ? ORDER BY snapshot", (project_code,))
    else:
        rows = query(
            "SELECT snapshot, AVG(physical_progress) AS physical_progress, "
            "SUM(expenditure) AS expenditure, SUM(original_cost) AS original_cost, "
            "COUNT(*) AS projects FROM project_panel GROUP BY snapshot ORDER BY snapshot")
    return {"project_code": project_code, "rows": records(rows), "limit": top}


@app.post("/api/assistant")
def assistant(payload: dict) -> dict:
    question = str(payload.get("question", "")).strip()
    if not question:
        raise HTTPException(400, "question is required")
    return answer_question(question)


@app.get("/api/search-suggestions")
def search_suggestions() -> dict:
    rows = query("SELECT DISTINCT sector AS value FROM project_current "
                 "WHERE sector IS NOT NULL ORDER BY sector")
    sectors = [r["value"] for r in records(rows)]
    rows = query("SELECT DISTINCT state AS value FROM project_current "
                 "WHERE state IS NOT NULL ORDER BY state")
    states = [r["value"] for r in records(rows)]
    return {"sectors": sectors, "states": states,
            "examples": [
                "Which sectors have the worst predicted delays?",
                "How many high-risk projects are in Karnataka?",
                "What is the average physical progress in the Roads sector?",
                "Show the top 5 projects by predicted cost pressure",
                "How does the approved cost compare with expenditure?",
                "Which states have the most projects above budget?",
                "What drives cost overrun risk?",
                "How good is the model?",
                "What data is missing?",
                "What will happen next month?",
            ]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)