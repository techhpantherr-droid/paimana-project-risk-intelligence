"""Database-backed question answering for the dashboard assistant.

The assistant only reads numbers that are already in data/app.db or metrics.json
and phrases them as sentences. It never predicts, estimates or invents a figure -
when a question does not match a known query it says so and lists what it can
answer, which keeps the answers auditable.
"""

from __future__ import annotations

import json
import re

import pandas as pd

from backend.store import ARTIFACTS, connect

METRICS = json.loads((ARTIFACTS / "metrics.json").read_text(encoding="utf-8"))

CAPITALISED = r"[A-Za-z][A-Za-z0-9&\-\.()/,' ]*"

RULES: list[dict] = []


def rule(*patterns: str):
    def register(fn):
        RULES.append({"patterns": [re.compile(p, re.I) for p in patterns], "handler": fn})
        return fn
    return register


def run(sql: str, params: tuple = ()) -> pd.DataFrame:
    with connect() as conn:
        return pd.read_sql_query(sql, conn, params=params)


def cr(value: float) -> str:
    return f"Rs {float(value):,.0f} crore"


def answer(text: str) -> dict:
    for entry in RULES:
        for pattern in entry["patterns"]:
            found = pattern.search(text)
            if found:
                return {**entry["handler"](found), "intent": entry["patterns"][0].pattern}
    return {
        "answer": "I could not match that to a query I can run against the PAIMANA "
                  "extract. I answer only from published project data, so I will not "
                  "estimate a figure.",
        "results": [],
        "suggestions": [r["examples"] for r in [
            {"examples": ["Which sectors have the worst predicted delays?",
                          "How many high-risk projects are in Karnataka?",
                          "Show the top 5 projects by predicted cost pressure",
                          "What drives cost overrun risk?"]}]][0],
        "confidence": "low",
    }


# --------------------------------------------------------------- questions
@rule(r"how many (high[- ]risk|at risk|risk) projects", r"count of high risk")
def high_risk_count(m: re.Match) -> dict:
    frame = run("SELECT COUNT(*) AS n FROM project_current "
                "WHERE predicted_risk_class = 'High'")
    total = run("SELECT COUNT(*) AS n FROM project_current")["n"].iat[0]
    n = int(frame["n"].iat[0])
    new = int(run("SELECT COUNT(*) AS n FROM project_current "
                  "WHERE alert = 'New high-risk entry'")["n"].iat[0])
    return {
        "answer": f"{n} of {total} projects in the latest freeze are predicted to fall "
                  f"into the high-risk band next month, which is "
                  f"{round(n / total * 100, 1)}% of the portfolio. "
                  f"{new} of those are new entries that are not high risk today.",
        "results": [{"high_risk": int(n), "portfolio": int(total),
                     "new_entries": int(new)}],
        "confidence": "high",
    }


@rule(r"(how many|number of|count of).{0,40}in (" + CAPITALISED + r")",
      r"(" + CAPITALISED + r").{0,25}high[- ]risk")
def projects_in_place(m: re.Match) -> dict:
    groups = [g for g in m.groups() if g]
    place = groups[-1].strip().strip("?. ")
    title = place.title()
    row = run("SELECT COUNT(*) AS projects FROM project_current "
              "WHERE state = ? OR sector = ? OR ministry = ?",
              (title, title, title))
    if row.empty or int(row["projects"].iat[0]) == 0:
        found = run("SELECT state AS name FROM project_current "
                    "WHERE state LIKE ? OR sector LIKE ? OR ministry LIKE ? LIMIT 1",
                    (f"%{place}%", f"%{place}%", f"%{place}%"))
        if found.empty:
            return {"answer": f"No project in the extract matches '{place}'. The freeze "
                               "covers states, sectors and ministries as labelled by the "
                               "portal.", "results": [], "confidence": "low"}
        title = found["name"].iat[0]
        row = run("SELECT COUNT(*) AS projects FROM project_current "
                  "WHERE state = ? OR sector = ? OR ministry = ?",
                  (title, title, title))
    detail = run("SELECT predicted_risk_class, COUNT(*) AS n FROM project_current "
                 "WHERE state = ? OR sector = ? OR ministry = ? GROUP BY 1",
                 (title, title, title))
    mix = ", ".join(f"{int(r['n'])} {r['predicted_risk_class'].lower()} risk"
                    for _, r in detail.iterrows())
    return {
        "answer": f"{title} has {int(row['projects'].iat[0])} projects in the "
                  f"latest freeze - {mix}.",
        "results": records_of(detail.assign(place=title)),
        "confidence": "high",
    }


@rule(r"(worst|most|highest|biggest).{0,25}(delay|overrun|slippage|late)",
      r"(sector|state|ministry).{0,25}(delay|overrun)")
def worst_delay(m: re.Match) -> dict:
    dimension = "state" if "state" in text_of(m) else "sector"
    rows = run(f"SELECT {dimension} AS name, COUNT(*) AS projects, "
               "AVG(predicted_time_overrun_months) AS avg_delay "
               f"FROM project_current WHERE {dimension} IS NOT NULL "
               "GROUP BY 1 ORDER BY avg_delay DESC LIMIT 5")
    listed = "; ".join(f"{r['name']} ({r['avg_delay']:.1f} months across "
                       f"{int(r['projects'])} projects)" for _, r in rows.iterrows())
    return {
        "answer": f"Highest average predicted delay next month by {dimension}: {listed}.",
        "results": records_of(rows),
        "confidence": "high",
    }


def text_of(m: re.Match) -> str:
    return m.string


@rule(r"(average|mean|avg).{0,30}(physical )?progress")
def average_progress(m: re.Match) -> dict:
    row = run("SELECT AVG(physical_progress) AS avg_progress, COUNT(*) AS projects "
              "FROM project_current")
    worst = run("SELECT sector, AVG(physical_progress) AS avg_progress FROM project_current "
                "GROUP BY sector ORDER BY avg_progress LIMIT 3")
    best = run("SELECT sector, AVG(physical_progress) AS avg_progress FROM project_current "
               "GROUP BY sector ORDER BY avg_progress DESC LIMIT 3")
    return {
        "answer": f"Average physical progress across {int(row['projects'].iat[0])} "
                  f"projects is {row['avg_progress'].iat[0]:.1f}%. Lowest: "
                  f"{', '.join(f'{r.sector} ({r.avg_progress:.0f}%)' for r in worst.itertuples())}. "
                  f"Highest: "
                  f"{', '.join(f'{r.sector} ({r.avg_progress:.0f}%)' for r in best.itertuples())}.",
        "results": records_of(worst.assign(group="lowest"))
        + records_of(best.assign(group="highest")),
        "confidence": "high",
    }


@rule(r"(top|best|highest|worst).{0,30}(cost pressure|overrun risk|spending above)")
def top_cost_pressure(m: re.Match) -> dict:
    rows = run("SELECT project_code, project_name, sector, state, "
               "predicted_cost_pressure_pct, predicted_time_overrun_months "
               "FROM project_current ORDER BY predicted_cost_pressure_pct DESC LIMIT 5")
    listed = "; ".join(f"{r['project_name'][:48]} ({r['sector']}, "
                       f"{r['predicted_cost_pressure_pct']:+.1f}%)" for _, r in rows.iterrows())
    return {"answer": f"Projects with the highest predicted cost pressure next month: "
                      f"{listed}.",
            "results": records_of(rows), "confidence": "high"}


@rule(r"(approved|sanctioned|total) cost", r"compare.{0,25}(cost|expenditure)")
def cost_totals(m: re.Match) -> dict:
    row = run("SELECT SUM(original_cost) AS approved, SUM(expenditure) AS spent, "
              "COUNT(*) AS projects FROM project_current")
    approved = row["approved"].iat[0]
    spent = row["spent"].iat[0]
    return {
        "answer": f"Across {int(row['projects'].iat[0])} projects the sanctioned cost is "
                  f"{cr(approved)} against expenditure of {cr(spent)}, so "
                  f"{round(spent / approved * 100, 2)}% of the approved budget has been "
                  f"spent, leaving {cr(approved - spent)} unspent.",
        "results": [{"approved_cost_cr": round(approved, 2),
                     "expenditure_cr": round(spent, 2),
                     "utilisation_pct": round(spent / approved * 100, 2),
                     "unspent_cr": round(approved - spent, 2)}],
        "confidence": "high",
    }


@rule(r"(above budget|over budget|exceed)", r"budget pressure")
def over_budget(m: re.Match) -> dict:
    row = run("SELECT COUNT(*) AS n, SUM(original_cost) AS cost FROM project_current "
              "WHERE expenditure > original_cost")
    total = run("SELECT COUNT(*) AS n FROM project_current")["n"].iat[0]
    return {
        "answer": f"{int(row['n'].iat[0])} of {total} projects have already spent more "
                  f"than the sanctioned cost, against an approved outlay of "
                  f"{cr(row['cost'].iat[0])}. The portal publishes a revised cost only "
                  "for the major-project tables, so for the rest this is measured as "
                  "budget pressure rather than a reported overrun.",
        "results": records_of(row),
        "confidence": "high",
    }


@rule(r"(driver|cause|explain|shap|contribution).{0,25}(cost|overrun|risk|delay)",
      r"what (drives|causes)")
def drivers(m: re.Match) -> dict:
    frame = pd.read_csv(ARTIFACTS / "shap_importance.csv")
    target = "time_overrun_months" if re.search(r"delay|time|late", m.string, re.I) \
        else "cost_overrun_pct"
    block = frame[frame["target"] == target].head(5)
    listed = "; ".join(f"{r.label} ({r.mean_abs_shap:.2f})" for r in block.itertuples())
    return {
        "answer": f"The {target.replace('_', ' ')} model ranks these as the strongest "
                  f"drivers by mean absolute SHAP value: {listed}. These are "
                  "associations measured across projects, not causal claims.",
        "results": records_of(block),
        "confidence": "medium",
    }


@rule(r"(model|accuracy|how good|performance|metric|r2|precision)")
def model_quality(m: re.Match) -> dict:
    cost = METRICS["heads"]["cost_overrun_pct"]
    time = METRICS["heads"]["time_overrun_months"]
    risk = METRICS["heads"]["risk_class"]
    risk_best = risk["comparison"][0]
    return {
        "answer": f"Cost pressure: {cost['chosen_model']}, MAE "
                  f"{cost['comparison'][0]['mae']} percentage points against "
                  f"{[c for c in cost['comparison'] if 'baseline' in c['model'].lower()][0]['mae']} "
                  f"for a median baseline. Delay: {time['chosen_model']}, MAE "
                  f"{time['comparison'][0]['mae']} months, R2 "
                  f"{time['comparison'][0]['r2']}. Risk class: {risk['chosen_model']}, "
                  f"{round(risk_best['accuracy'] * 100, 1)}% accuracy against "
                  f"{round([c for c in risk['comparison'] if 'baseline' in c['model'].lower()][0]['accuracy'] * 100, 1)}% "
                  "for a majority baseline. Validation is five-fold cross-validation on "
                  f"{METRICS['supervised_rows']} one-step-ahead rows.",
        "results": [METRICS["heads"][k] for k in ("cost_overrun_pct", "time_overrun_months")],
        "confidence": "high",
    }


@rule(r"(data gap|missing data|data is missing|collect more|what if we collect|uncaptured)")
def data_gap(m: re.Match) -> dict:
    gap = METRICS["data_gap"]
    ranked = sorted([s for s in gap["steps"] if s["added"] not in (None, "all")],
                    key=lambda s: s["change_pct"])
    listed = "; ".join(f"{s['step'][2:]} {s['change_pct']:+.1f}%" for s in ranked[:3])
    return {
        "answer": f"Cost-pressure MAE today is {gap['baseline_mae']}. Adding one "
                  f"simulated variable at a time, the ones that would help most are: "
                  f"{listed}. Together the candidates move MAE to "
                  f"{gap['steps'][-1]['mae']} "
                  f"({gap['steps'][-1]['change_pct']:+.1f}%). These variables are "
                  "synthesised, so this sizes the prize rather than claiming accuracy.",
        "results": gap["steps"],
        "confidence": "medium",
    }


@rule(r"(state|states).{0,30}(most projects|highest approved|largest)")
def state_leaderboard(m: re.Match) -> dict:
    rows = run("SELECT state, COUNT(*) AS projects, SUM(original_cost) AS approved "
               "FROM project_current GROUP BY state ORDER BY approved DESC LIMIT 5")
    listed = "; ".join(f"{r['state']} ({int(r['projects'])} projects, "
                       f"{cr(r['approved'])})" for _, r in rows.iterrows())
    return {"answer": f"States by approved outlay: {listed}.",
            "results": records_of(rows), "confidence": "high"}


@rule(r"(alert|escalat|new high risk|warning)")
def alert_summary(m: re.Match) -> dict:
    rows = run("SELECT alert, COUNT(*) AS n FROM project_current WHERE alert != '' "
               "GROUP BY alert")
    new = int(run("SELECT COUNT(*) AS n FROM project_current "
                  "WHERE alert = 'New high-risk entry'")["n"].iat[0])
    listed = "; ".join(f"{int(r['n'])} {r['alert']}" for _, r in rows.iterrows())
    return {"answer": f"Current alerts: {listed}. The {new} new high-risk entries are the "
                      "ones to review first - they are not high risk today but the model "
                      "expects them to cross into that band next month.",
            "results": records_of(rows), "confidence": "high"}


@rule(r"(next month|forecast|will happen|outlook|expected)")
def outlook(m: re.Match) -> dict:
    row = run("SELECT COUNT(*) AS projects, "
              "SUM(CASE WHEN predicted_risk_class = 'High' THEN 1 ELSE 0 END) AS high, "
              "SUM(CASE WHEN alert = 'New high-risk entry' THEN 1 ELSE 0 END) AS new_high, "
              "AVG(predicted_time_overrun_months) AS avg_delay, "
              "AVG(predicted_cost_pressure_pct) AS avg_pressure "
              "FROM project_current")
    sectors = run("SELECT sector, AVG(predicted_time_overrun_months) AS avg_delay "
                  "FROM project_current GROUP BY sector ORDER BY avg_delay DESC LIMIT 3")
    return {
        "answer": f"For the month after the {METRICS['snapshots'][-1]} freeze the models "
                  f"put {int(row['high'].iat[0])} of {int(row['projects'].iat[0])} projects "
                  f"in the high-risk band, {int(row['new_high'].iat[0])} of them new "
                  f"entries. Average predicted delay is "
                  f"{row['avg_delay'].iat[0]:.1f} months and average predicted cost "
                  f"pressure {row['avg_pressure'].iat[0]:+.2f}%. Longest predicted delays "
                  f"sit in "
                  f"{', '.join(f'{r.sector} ({r.avg_delay:.0f} months)' for r in sectors.itertuples())}.",
        "results": records_of(sectors),
        "confidence": "medium",
    }


def records_of(frame: pd.DataFrame) -> list[dict]:
    frame = frame.where(pd.notna(frame), None)
    return json.loads(frame.to_json(orient="records", date_format="iso"))


def answer_question(question: str) -> dict:
    result = answer(question)
    result["question"] = question
    return result