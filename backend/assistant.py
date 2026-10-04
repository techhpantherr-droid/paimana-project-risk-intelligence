"""Database-backed question answering for the dashboard assistant.

The assistant only reads numbers that are already in data/app.db or metrics.json
and phrases them as sentences. It never predicts, estimates or invents a figure -
when a question does not match a known query it says so and lists what it can
answer, which keeps the answers auditable.

Three things make it usable as a working tool rather than a demo:

* the rule table is declared as data, so a new question is one entry, not a new
  function, and the whole capability surface can be published to the client;
* every rule declares the follow-up questions it makes sense to ask next, so the
  conversation can be driven forward from a reply instead of restarted;
* the previous turn is carried into the next question, so "what about Karnataka"
  and "why?" resolve against the subject already under discussion.
"""

from __future__ import annotations

import json
import re
from typing import Callable

import pandas as pd

from backend.store import ARTIFACTS, connect

METRICS = json.loads((ARTIFACTS / "metrics.json").read_text(encoding="utf-8"))

# a run of characters that could be the name of a state, sector or ministry
CAPITALISED = r"[A-Za-z][A-Za-z0-9&\-\.()/,' ]*"

# PAIMANA project codes are six digits. The length floor matters: without it a
# bare "5" in "top 5 projects" would be read as a project code.
PROJECT_CODE = r"\b\d{5,}\b"

# a turn carries the subject it was about, so the next question can refer back to it
Context = dict


class Unmatched(Exception):
    """Raised when nothing in the rule table can answer the question."""


def run(sql: str, params: tuple = ()) -> pd.DataFrame:
    with connect() as conn:
        return pd.read_sql_query(sql, conn, params=params)


def records_of(frame: pd.DataFrame) -> list[dict]:
    frame = frame.where(pd.notna(frame), None)
    return json.loads(frame.to_json(orient="records", date_format="iso"))


def rows_of(frame: pd.DataFrame) -> list[dict]:
    """Plain dicts for sentence building. itertuples breaks on column names that
    are not valid identifiers, and subscripting a namedtuple by string always does."""
    return frame.to_dict(orient="records")


def cr(value: float) -> str:
    return f"Rs {float(value):,.0f} crore"


def pct(value: float, digits: int = 1) -> str:
    return f"{float(value):.{digits}f}%"


RULES: list[dict] = []


def rule(*patterns: str, topic: str, follow_ups: Callable[[re.Match], list[str]] | None = None,
         needs: str = ""):
    """Register a question handler.

    `topic` groups related rules so the client can offer sensible next questions.
    `follow_ups` receives the match and returns the questions worth asking next.
    `needs` names a context key the handler requires, which is how a rule
    disqualifies itself rather than answering about the wrong subject.
    """
    def register(fn):
        RULES.append({
            "patterns": [re.compile(p, re.I) for p in patterns],
            "handler": fn,
            "topic": topic,
            "follow_ups": follow_ups,
            "needs": needs,
        })
        return fn
    return register


# ------------------------------------------------------------------ vocabulary
def known_values(table: str) -> list[str]:
    return run(f"SELECT name FROM {table} ORDER BY name")["name"].tolist()


SECTORS = known_values("sectors")
STATES = known_values("states")
MINISTRIES = known_values("ministries")
VOCABULARY = sorted({v.casefold() for v in SECTORS + STATES + MINISTRIES if v})


def _matches(text: str, value: str) -> int:
    """Length of the longest match for `value` in `text`, or 0.

    Matches on word boundaries rather than substrings, and accepts a distinctive
    leading word on its own, so "the Roads sector" resolves to "Roads & Highways"
    without "Road" matching "Railways" or "Broadband".
    """
    folded = text.casefold()
    needle = value.casefold().strip()
    if re.search(r"(?<!\w)" + re.escape(needle) + r"(?!\w)", folded):
        return len(needle)

    head = re.split(r"\s*(?:&|,|/|\band\b)", needle)[0].strip()
    if len(head) >= 5 and re.search(r"(?<!\w)" + re.escape(head) + r"\w*(?!\w)", folded):
        return len(head)
    return 0


def find_place(text: str, context: Context) -> tuple[str | None, str | None]:
    """Resolve a state, sector or ministry by name, falling back to the subject
    the previous turn was about. Returns (value, kind)."""
    best: tuple[int, str, str] | None = None
    for value, kind in ([(v, "state") for v in STATES]
                        + [(v, "sector") for v in SECTORS]
                        + [(v, "ministry") for v in MINISTRIES]):
        score = _matches(text, value)
        if score and (best is None or score > best[0]):
            best = (score, value, kind)
    if best:
        return best[1], best[2]
    if context.get("place"):
        return context["place"], context.get("place_kind", "state")
    return None, None


def place_column(kind: str | None) -> str:
    return {"state": "state", "sector": "sector", "ministry": "ministry"}.get(kind, "state")


def place_clause(kind: str) -> str:
    column = place_column(kind)
    return f"({column} = ? OR state = ? OR sector = ? OR ministry = ?)"


def place_answer(row: pd.DataFrame, place: str, kind: str, count: int) -> str:
    detail = run(f"SELECT predicted_risk_class, COUNT(*) AS n FROM project_current "
                 f"WHERE {place_clause(kind)} GROUP BY 1", (place, place, place, place))
    mix = ", ".join(f"{int(r['n'])} {r['predicted_risk_class'].lower()}"
                    for r in rows_of(detail))
    return (f"{place} has {count} projects in the latest freeze - {mix} "
            f"expected next month.")


# ------------------------------------------------------------------- portfolio
@rule(r"how many (high[- ]risk|at risk|risk) projects", r"count of high risk",
      r"portfolio at risk", r"how risky is the portfolio",
      topic="risk", follow_ups=lambda m: PORTFOLIO_FOLLOW_UPS)
def high_risk_count(m: re.Match, ctx: Context) -> dict:
    # "how many high-risk projects are in Karnataka" is a question about Karnataka,
    # not about the portfolio, so hand over to the place rule when a place is named
    place, kind = find_place(m.string, {})
    if place and kind == "state":
        ctx["place"] = place
        ctx["place_kind"] = kind
        clause = place_clause(kind)
        params = (place, place, place, place)
        rows = run(f"SELECT predicted_risk_class, COUNT(*) AS n FROM project_current "
                   f"WHERE {clause} GROUP BY 1", params)
        total = int(run(f"SELECT COUNT(*) AS n FROM project_current WHERE {clause}",
                        params)["n"].iat[0])
        if not total:
            raise Unmatched
        mix = ", ".join(f"{int(r['n'])} {r['predicted_risk_class'].lower()}"
                        for r in rows_of(rows))
        high = int(run(f"SELECT COUNT(*) AS n FROM project_current WHERE {clause} "
                       "AND predicted_risk_class = 'High'", params)["n"].iat[0])
        return {
            "answer": f"{high} of {total} projects in {place} are predicted to fall into the "
                      f"high-risk band next month, which is {pct(high / total * 100)} of the "
                      f"state's portfolio. Mix: {mix}.",
            "results": records_of(rows.assign(place=place)),
            "confidence": "high",
            "follow_ups": [f"Which projects in {place} are worst?",
                           f"What is the average progress in {place}?",
                           "What will happen next month?"],
        }
    total = int(run("SELECT COUNT(*) AS n FROM project_current")["n"].iat[0])
    n = int(run("SELECT COUNT(*) AS n FROM project_current "
                "WHERE predicted_risk_class = 'High'")["n"].iat[0])
    new = int(run("SELECT COUNT(*) AS n FROM project_current "
                  "WHERE alert = 'New high-risk entry'")["n"].iat[0])
    return {
        "answer": f"{n} of {total} projects in the latest freeze are predicted to fall "
                  f"into the high-risk band next month, which is {pct(n / total * 100)} of "
                  f"the portfolio. {new} of those are new entries that are not high risk today.",
        "results": [{"high_risk": n, "portfolio": total, "new_entries": new}],
        "confidence": "high",
        "follow_ups": PORTFOLIO_FOLLOW_UPS,
    }


PORTFOLIO_FOLLOW_UPS = [
    "Which sectors have the worst predicted delays?",
    "Show the new high-risk entries",
    "How good is the model?",
]


@rule(r"(worst|most|highest|biggest).{0,25}(delay|overrun|slippage|late)",
      r"(sector|state|ministry).{0,25}(delay|overrun)",
      r"which .{0,20}(sector|state)s? .{0,20}(worst|worst)",
      topic="risk", follow_ups=lambda m: ["How many high-risk projects are there?",
                                          "What drives cost overrun risk?"])
def worst_delay(m: re.Match, ctx: Context) -> dict:
    dimension = place_column(ctx.get("dimension"))
    if re.search(r"\bsector", m.string, re.I):
        dimension = "sector"
    elif re.search(r"\b(state|ministry)", m.string, re.I):
        dimension = re.search(r"\b(state|ministry)", m.string, re.I).group(1)
    rows = run(f"SELECT {dimension} AS name, COUNT(*) AS projects, "
               "AVG(predicted_time_overrun_months) AS avg_delay, "
               "AVG(physical_progress) AS avg_progress "
               f"FROM project_current WHERE {dimension} IS NOT NULL AND {dimension} != '' "
               "GROUP BY 1 ORDER BY avg_delay DESC LIMIT 5")
    listed = "; ".join(f"{r['name']} ({r['avg_delay']:.1f} months across "
                       f"{int(r['projects'])} projects)" for r in rows_of(rows))
    ctx["dimension"] = dimension
    return {
        "answer": f"Highest average predicted delay next month by {dimension}: {listed}.",
        "results": records_of(rows),
        "confidence": "high",
        "follow_ups": ["How many high-risk projects are there?",
                       "What drives cost overrun risk?"],
    }


@rule(r"(average|mean|avg).{0,30}(physical )?progress",
      topic="progress", follow_ups=lambda m: ["Which sectors are furthest behind?",
                                               "What is the progress gap on a project?"])
def average_progress(m: re.Match, ctx: Context) -> dict:
    # resolve against this question only. Inheriting the previous subject here would
    # silently answer a new question about the old place.
    place, kind = find_place(m.string, {})
    if place:
        clause = place_clause(kind)
        params = (place, place, place, place)
        row = run(f"SELECT AVG(physical_progress) AS avg_progress, COUNT(*) AS projects "
                  f"FROM project_current WHERE {clause}", params)
        rows = run(f"SELECT {place_column(kind)} AS name, COUNT(*) AS projects, "
                   "AVG(physical_progress) AS avg_progress, "
                   "AVG(predicted_time_overrun_months) AS avg_delay "
                   f"FROM project_current WHERE {clause} GROUP BY 1 ORDER BY avg_progress",
                   params)
        listed = "; ".join(f"{r['name']} ({r['avg_progress']:.1f}%)" for r in rows_of(rows))
        return {
            "answer": f"Average physical progress across {place} is "
                      f"{row['avg_progress'].iat[0]:.1f}% over {int(row['projects'].iat[0])} "
                      f"projects. By unit: {listed}.",
            "results": records_of(rows),
            "confidence": "high",
            "follow_ups": [f"How many high-risk projects are in {place}?",
                           f"Which {kind}s have the worst predicted delays?"],
        }

    row = run("SELECT AVG(physical_progress) AS avg_progress, COUNT(*) AS projects "
              "FROM project_current")
    worst = run("SELECT sector, AVG(physical_progress) AS avg_progress FROM project_current "
                "GROUP BY sector ORDER BY avg_progress LIMIT 3")
    best = run("SELECT sector, AVG(physical_progress) AS avg_progress FROM project_current "
               "GROUP BY sector ORDER BY avg_progress DESC LIMIT 3")
    ctx["dimension"] = "sector"
    # built outside the f-string: nested same-quote indexing needs Python 3.12
    low_list = ", ".join("{} ({:.0f}%)".format(r["sector"], r["avg_progress"])
                         for r in rows_of(worst))
    high_list = ", ".join("{} ({:.0f}%)".format(r["sector"], r["avg_progress"])
                          for r in rows_of(best))
    return {
        "answer": f"Average physical progress across {int(row['projects'].iat[0])} projects "
                  f"is {row['avg_progress'].iat[0]:.1f}%. Lowest: {low_list}. "
                  f"Highest: {high_list}.",
        "results": records_of(worst.assign(group="lowest"))
        + records_of(best.assign(group="highest")),
        "confidence": "high",
        "follow_ups": ["Which sectors have the worst predicted delays?",
                       "What is the average spend against approved cost?"],
    }


@rule(r"(top|best|highest|worst).{0,30}(cost pressure|overrun risk|spending above)",
      r"which projects .{0,25}(cost pressure|overrun)",
      topic="risk", follow_ups=lambda m: ["Why is the top project flagged?",
                                          "What drives cost overrun risk?"])
def top_cost_pressure(m: re.Match, ctx: Context) -> dict:
    limit = _limit(m.string)
    rows = run("SELECT project_code, project_name, sector, state, ministry, "
               "predicted_cost_pressure_pct, predicted_time_overrun_months, "
               "predicted_risk_class "
               f"FROM project_current ORDER BY predicted_cost_pressure_pct DESC LIMIT {limit}")
    listed = "; ".join(f"{r['project_name'][:44]} ({r['sector']}, "
                       f"{r['predicted_cost_pressure_pct']:+.1f}%)" for r in rows_of(rows))
    ctx["focus"] = rows.iloc[0]["project_code"] if len(rows) else None
    return {
        "answer": f"The {limit} projects with the highest predicted cost pressure next month: "
                  f"{listed}.",
        "results": records_of(rows),
        "confidence": "high",
        "follow_ups": [f"Why is {rows.iloc[0]['project_code']} flagged?" if len(rows)
                       else "What drives cost overrun risk?",
                       "Show the new high-risk entries"],
    }


def _limit(text: str, default: int = 5, cap: int = 25) -> int:
    found = re.search(r"\b(?:top|first|last)\s+(\d{1,2})\b", text, re.I)
    if not found:
        found = re.search(r"\b(\d{1,2})\s+(?:projects|states|sectors|rows)\b", text, re.I)
    return min(int(found.group(1)), cap) if found else default


@rule(r"(approved|sanctioned|total) cost", r"compare.{0,25}(cost|expenditure)",
      r"how much (is )?(being )?spent", topic="cost",
      follow_ups=lambda m: ["Which states have the most projects above budget?",
                            "What is the average spend against approved cost?"])
def cost_totals(m: re.Match, ctx: Context) -> dict:
    row = run("SELECT SUM(original_cost) AS approved, SUM(expenditure) AS spent, "
              "COUNT(*) AS projects FROM project_current")
    approved = row["approved"].iat[0]
    spent = row["spent"].iat[0]
    return {
        "answer": f"Across {int(row['projects'].iat[0])} projects the sanctioned cost is "
                  f"{cr(approved)} against expenditure of {cr(spent)}, so "
                  f"{pct(spent / approved * 100, 2)} of the approved budget has been spent, "
                  f"leaving {cr(approved - spent)} unspent.",
        "results": [{"approved_cost_cr": round(approved, 2),
                     "expenditure_cr": round(spent, 2),
                     "utilisation_pct": round(spent / approved * 100, 2),
                     "unspent_cr": round(approved - spent, 2)}],
        "confidence": "high",
        "follow_ups": ["Which states have the most projects above budget?",
                       "How many high-risk projects are there?"],
    }


@rule(r"(above budget|over budget|exceed)", r"budget pressure",
      r"how many projects .{0,20}(spent|overspend)",
      topic="cost", follow_ups=lambda m: ["Which states have the most projects above budget?",
                                          "What drives cost overrun risk?"])
def over_budget(m: re.Match, ctx: Context) -> dict:
    row = run("SELECT COUNT(*) AS n, SUM(original_cost) AS cost FROM project_current "
              "WHERE expenditure > original_cost")
    total = int(run("SELECT COUNT(*) AS n FROM project_current")["n"].iat[0])
    return {
        "answer": f"{int(row['n'].iat[0])} of {total} projects have already spent more than "
                  f"the sanctioned cost, against an approved outlay of {cr(row['cost'].iat[0])}. "
                  "The portal publishes a revised cost only for the major-project tables, so for "
                  "the rest this is measured as budget pressure rather than a reported overrun.",
        "results": records_of(row),
        "confidence": "high",
        "follow_ups": ["Which states have the most projects above budget?",
                       "Show the top 5 projects by predicted cost pressure"],
    }


@rule(r"(driver|cause|explain|shap|contribution).{0,25}(cost|overrun|risk|delay)",
      r"what (drives|causes)", r"why (is|are).{0,30}(risk|overrun|delay)",
      topic="models", follow_ups=lambda m: ["How good is the model?",
                                             "What data is missing?"])
def drivers(m: re.Match, ctx: Context) -> dict:
    frame = pd.read_csv(ARTIFACTS / "shap_importance.csv")
    target = "time_overrun_months" if re.search(r"delay|time|late", m.string, re.I) \
        else "cost_overrun_pct"
    block = frame[frame["target"] == target].head(5)
    listed = "; ".join(f"{r['label']} ({r['mean_abs_shap']:.2f})" for r in rows_of(block))
    return {
        "answer": f"The {target.replace('_', ' ')} model ranks these as the strongest drivers "
                  f"by mean absolute SHAP value: {listed}. These are associations measured "
                  "across projects, not causal claims.",
        "results": records_of(block),
        "confidence": "medium",
        "follow_ups": ["How good is the model?", "What data is missing?"],
    }


@rule(r"(model|accuracy|how good|performance|metric|r2|precision|reliable)",
      topic="models", follow_ups=lambda m: ["What data is missing?",
                                             "What drives cost overrun risk?"])
def model_quality(m: re.Match, ctx: Context) -> dict:
    cost = METRICS["heads"]["cost_overrun_pct"]
    time = METRICS["heads"]["time_overrun_months"]
    risk = METRICS["heads"]["risk_class"]
    cost_baseline = next(c for c in cost["comparison"] if "baseline" in c["model"].lower())
    risk_baseline = next(c for c in risk["comparison"] if "baseline" in c["model"].lower())
    return {
        "answer": f"Cost pressure: {cost['chosen_model']}, MAE {cost['comparison'][0]['mae']} "
                  f"percentage points against {cost_baseline['mae']} for a median baseline. "
                  f"Delay: {time['chosen_model']}, MAE {time['comparison'][0]['mae']} months, "
                  f"R2 {time['comparison'][0]['r2']}. Risk class: {risk['chosen_model']}, "
                  f"{pct(risk['comparison'][0]['accuracy'] * 100)} accuracy against "
                  f"{pct(risk_baseline['accuracy'] * 100)} for a majority baseline. Validation "
                  f"is five-fold cross-validation on {METRICS['supervised_rows']} one-step-ahead "
                  "rows.",
        "results": [METRICS["heads"][k] for k in ("cost_overrun_pct", "time_overrun_months")],
        "confidence": "high",
        "follow_ups": ["What data is missing?", "What will happen next month?"],
    }


@rule(r"(data gap|missing data|data is missing|collect more|what if we collect|uncaptured)",
      topic="models", follow_ups=lambda m: ["How good is the model?",
                                             "What drives cost overrun risk?"])
def data_gap(m: re.Match, ctx: Context) -> dict:
    gap = METRICS["data_gap"]
    ranked = sorted([s for s in gap["steps"] if s["added"] not in (None, "all")],
                    key=lambda s: s["change_pct"])
    listed = "; ".join(f"{s['step'][2:]} {s['change_pct']:+.1f}%" for s in ranked[:3])
    return {
        "answer": f"Cost-pressure MAE today is {gap['baseline_mae']}. Adding one simulated "
                  f"variable at a time, the ones that would help most are: {listed}. Together "
                  f"the candidates move MAE to {gap['steps'][-1]['mae']} "
                  f"({gap['steps'][-1]['change_pct']:+.1f}%). These variables are synthesised, so "
                  "this sizes the prize rather than claiming accuracy.",
        "results": gap["steps"],
        "confidence": "medium",
        "follow_ups": ["How good is the model?", "What drives cost overrun risk?"],
    }


@rule(r"(state|states).{0,30}(most projects|highest approved|largest)",
      r"(which|what) states", topic="cost",
      follow_ups=lambda m: ["Which sectors have the worst predicted delays?",
                            "How many high-risk projects are there?"])
def state_leaderboard(m: re.Match, ctx: Context) -> dict:
    limit = _limit(m.string)
    rows = run("SELECT state, COUNT(*) AS projects, SUM(original_cost) AS approved, "
               "SUM(expenditure) AS spent FROM project_current WHERE state IS NOT NULL "
               f"AND state != '' GROUP BY state ORDER BY approved DESC LIMIT {limit}")
    listed = "; ".join(f"{r['state']} ({int(r['projects'])} projects, {cr(r['approved'])})"
                       for r in rows_of(rows))
    ctx["dimension"] = "state"
    return {"answer": f"States by approved outlay: {listed}.",
            "results": records_of(rows), "confidence": "high",
            "follow_ups": ["Which states have the most projects above budget?",
                           "How many high-risk projects are there?"]}


@rule(r"(alert|escalat|new high risk|warning|review first)",
      topic="risk", follow_ups=lambda m: ["Why is the top project flagged?",
                                          "What drives cost overrun risk?"])
def alert_summary(m: re.Match, ctx: Context) -> dict:
    rows = run("SELECT alert, COUNT(*) AS n FROM project_current WHERE alert != '' "
               "GROUP BY alert")
    new = int(run("SELECT COUNT(*) AS n FROM project_current "
                  "WHERE alert = 'New high-risk entry'")["n"].iat[0])
    listed = "; ".join(f"{int(r['n'])} {r['alert']}" for r in rows_of(rows))
    top = run("SELECT project_code, project_name, sector, predicted_cost_pressure_pct "
              "FROM project_current WHERE alert != '' "
              "ORDER BY predicted_cost_pressure_pct DESC LIMIT 5")
    ctx["focus"] = top.iloc[0]["project_code"] if len(top) else None
    return {
        "answer": f"Current alerts: {listed}. The {new} new high-risk entries are the ones to "
                  "review first - they are not high risk today but the model expects them to "
                  "cross into that band next month.",
        "results": records_of(rows.assign(
            projects=top["project_name"].tolist() + [""] * max(0, len(rows) - len(top)))),
        "confidence": "high",
        "follow_ups": [f"Why is {top.iloc[0]['project_code']} flagged?" if len(top)
                       else "Show the top 5 projects by predicted cost pressure",
                       "What drives cost overrun risk?"],
    }


@rule(r"(next month|forecast|will happen|outlook|expected)",
      topic="risk", follow_ups=lambda m: ["Show the new high-risk entries",
                                          "What drives cost overrun risk?"])
def outlook(m: re.Match, ctx: Context) -> dict:
    row = run("SELECT COUNT(*) AS projects, "
              "SUM(CASE WHEN predicted_risk_class = 'High' THEN 1 ELSE 0 END) AS high, "
              "SUM(CASE WHEN alert = 'New high-risk entry' THEN 1 ELSE 0 END) AS new_high, "
              "AVG(predicted_time_overrun_months) AS avg_delay, "
              "AVG(predicted_cost_pressure_pct) AS avg_pressure FROM project_current")
    sectors = run("SELECT sector, AVG(predicted_time_overrun_months) AS avg_delay "
                  "FROM project_current GROUP BY sector ORDER BY avg_delay DESC LIMIT 3")
    longest = ", ".join("{} ({:.0f} months)".format(r["sector"], r["avg_delay"])
                        for r in rows_of(sectors))
    return {
        "answer": f"For the month after the {METRICS['snapshots'][-1]} freeze the models put "
                  f"{int(row['high'].iat[0])} of {int(row['projects'].iat[0])} projects in the "
                  f"high-risk band, {int(row['new_high'].iat[0])} of them new entries. Average "
                  f"predicted delay is {row['avg_delay'].iat[0]:.1f} months and average "
                  f"predicted cost pressure {row['avg_pressure'].iat[0]:+.2f}%. Longest "
                  f"predicted delays sit in {longest}.",
        "results": records_of(sectors),
        "confidence": "medium",
        "follow_ups": ["Show the new high-risk entries", "What drives cost overrun risk?"],
    }


@rule(r"^(?:what about|how about|tell me about|and)\s+([A-Za-z][\w&,'/()\- ]{2,40}?)\??$",
      r"^([A-Za-z][\w&,'/()\- ]{2,40}?)\??$",
      topic="portfolio", follow_ups=lambda m: ["What drives cost overrun risk?"])
def bare_place(m: re.Match, ctx: Context) -> dict:
    """A follow-up that is only a place name means "tell me about this one".

    Resolved from this question alone, never from the previous subject: inheriting
    here would turn any short sentence into an answer about the last place asked
    about, which is worse than saying the question was not understood.
    """
    place, kind = find_place(m.string, {})
    if not place:
        raise Unmatched
    clause = place_clause(kind)
    params = (place, place, place, place)
    total = int(run(f"SELECT COUNT(*) AS n FROM project_current WHERE {clause}",
                    params)["n"].iat[0])
    if not total:
        raise Unmatched
    ctx["place"] = place
    ctx["place_kind"] = kind
    return {
        "answer": place_answer(None, place, kind, total),
        "results": records_of(run(
            f"SELECT {place_column(kind)} AS unit, predicted_risk_class, COUNT(*) AS projects, "
            "AVG(physical_progress) AS avg_progress, "
            "AVG(predicted_cost_pressure_pct) AS avg_cost_pressure, "
            "AVG(predicted_time_overrun_months) AS avg_delay "
            f"FROM project_current WHERE {clause} GROUP BY 1, 2", params)),
        "confidence": "high",
        "follow_ups": [f"Which projects in {place} are worst?",
                       f"What is the average progress in {place}?",
                       f"How many high-risk projects are in {place}?"],
    }


@rule(r"\b(why|explain)\b",
      r"^(" + PROJECT_CODE + r")$",
      topic="portfolio", follow_ups=lambda m: ["What drives cost overrun risk?"])
def why_flagged(m: re.Match, ctx: Context) -> dict:
    """Resolves "why is it flagged" against whatever the last turn was about, so a
    follow-up does not need the project named again. When the last turn was about a
    place rather than a project, it answers for that place's worst project."""
    code = ctx.get("focus")
    scope = ""
    if not code and ctx.get("place"):
        clause = place_clause(ctx.get("place_kind", "state"))
        place = ctx["place"]
        top = run(f"SELECT project_code FROM project_current WHERE {clause} "
                  "ORDER BY predicted_cost_pressure_pct DESC LIMIT 1",
                  (place, place, place, place))
        if not top.empty:
            code = top["project_code"].iat[0]
            scope = f" It is the highest predicted cost pressure in {place}."
    if not code:
        raise Unmatched

    row = run("SELECT project_code, project_name, sector, predicted_cost_pressure_pct, "
              "predicted_time_overrun_months, predicted_risk_class, confidence, alert "
              f"FROM project_current WHERE project_code = '{code}'")
    if row.empty:
        raise Unmatched
    r = row.iloc[0]
    block = pd.read_csv(ARTIFACTS / "shap_importance.csv")
    top = block[block["target"] == "cost_overrun_pct"].head(3)
    listed = "; ".join(f"{t['label']} ({t['mean_abs_shap']:.2f})" for t in rows_of(top))
    ctx["focus"] = code
    return {
        "answer": f"{r['project_name']} ({r['project_code']}) is expected to be "
                  f"{str(r['predicted_risk_class']).lower()} risk next month at "
                  f"{r['confidence'] * 100:.0f}% confidence, with predicted cost pressure "
                  f"{r['predicted_cost_pressure_pct']:+.1f}% and a delay of "
                  f"{r['predicted_time_overrun_months']:.1f} months.{scope} Across the "
                  f"portfolio the strongest cost-pressure drivers are {listed}. Those are "
                  "associations measured across projects, not causal claims about this one.",
        "results": records_of(row.assign(top_drivers=listed)),
        "confidence": "medium",
        "follow_ups": [f"Show the top 5 projects by predicted cost pressure",
                       "How good is the model?"],
    }


@rule(r"(how many|number of|count of).{0,40}in (" + CAPITALISED + r")",
      r"(why|explain|about|tell me about).{0,40}(" + PROJECT_CODE + r")",
      r"^(" + PROJECT_CODE + r")$",
      topic="portfolio", follow_ups=lambda m: ["Why is it flagged?",
                                               "What drives cost overrun risk?"])
def place_or_project(m: re.Match, ctx: Context) -> dict:
    text = m.string

    # a project code was named directly
    code = re.search(PROJECT_CODE, text)
    if code:
        return project_detail(code.group(0), ctx)

    groups = [g.strip().strip("?. ") for g in m.groups() if g]
    candidate = groups[-1] if groups else ""
    place, kind = find_place(text, ctx)
    if not place and candidate:
        place, kind = find_place(candidate, {})
    if not place:
        raise Unmatched

    clause = place_clause(kind)
    params = (place, place, place, place)
    count = int(run(f"SELECT COUNT(*) AS n FROM project_current WHERE {clause}",
                    params)["n"].iat[0])
    if count == 0:
        raise Unmatched

    ctx["place"] = place
    ctx["place_kind"] = kind
    return {
        "answer": place_answer(run("SELECT 1"), place, kind, count),
        "results": records_of(run(
            f"SELECT {place_column(kind)} AS unit, predicted_risk_class, COUNT(*) AS projects, "
            f"AVG(physical_progress) AS avg_progress, "
            "AVG(predicted_cost_pressure_pct) AS avg_cost_pressure, "
            "AVG(predicted_time_overrun_months) AS avg_delay "
            f"FROM project_current WHERE {clause} GROUP BY 1, 2", params)),
        "confidence": "high",
        "follow_ups": [f"Which projects in {place} are worst?",
                       f"What is the average progress in {place}?",
                       f"How many high-risk projects are in {place}?"],
    }


def project_detail(code: str, ctx: Context) -> dict:
    row = run("SELECT project_code, project_name, sector, state, ministry, "
              "original_cost, revised_cost, expenditure, physical_progress, "
              "predicted_cost_pressure_pct, predicted_time_overrun_months, "
              "risk_class, predicted_risk_class, confidence, alert, cost_overrun_basis "
              f"FROM project_current WHERE project_code = '{code}'")
    if row.empty:
        raise Unmatched
    r = row.iloc[0]
    ctx["focus"] = code
    basis = (f" It has a published revised cost, so this is a reported overrun of "
             f"{r['predicted_cost_pressure_pct']:+.1f}%." if r["revised_cost"] is not None else
             " The portal publishes no revised cost for it, so cost pressure here is measured "
             "against the sanctioned budget rather than a reported overrun.")
    return {
        "answer": f"{r['project_name']} ({r['project_code']}) is a {r['sector']} project in "
                  f"{r['state']} under {r['ministry']}. Approved cost {cr(r['original_cost'])}, "
                  f"spent {cr(r['expenditure'])}, physical progress {r['physical_progress']:.1f}%. "
                  f"It is {str(r['risk_class']).lower()} risk today and the model expects "
                  f"{str(r['predicted_risk_class']).lower()} next month at "
                  f"{r['confidence'] * 100:.0f}% confidence, with a predicted delay of "
                  f"{r['predicted_time_overrun_months']:.1f} months.{basis}",
        "results": records_of(row),
        "confidence": "high",
        "follow_ups": [f"Why is {code} flagged?",
                       "What drives cost overrun risk?"],
    }


# ------------------------------------------------------------------- dispatch
def example_questions() -> list[str]:
    return [
        "Which sectors have the worst predicted delays?",
        "How many high-risk projects are in Karnataka?",
        "Show the top 5 projects by predicted cost pressure",
        "What drives cost overrun risk?",
        "How does the approved cost compare with expenditure?",
        "Which states have the most projects above budget?",
        "What is the average physical progress in the Roads sector?",
        "How good is the model?",
        "What data is missing?",
        "What will happen next month?",
    ]


def capabilities() -> list[dict]:
    """The published capability surface, so the client can offer what is answerable."""
    seen: dict[str, dict] = {}
    for entry in RULES:
        seen.setdefault(entry["topic"], {
            "topic": entry["topic"],
            "example": entry["patterns"][0].pattern,
        })
    return list(seen.values())


def _match(text: str, ctx: Context) -> tuple[Callable, re.Match, dict] | None:
    for entry in RULES:
        if entry["needs"] and not ctx.get(entry["needs"]):
            continue
        for pattern in entry["patterns"]:
            found = pattern.search(text)
            if found:
                return entry["handler"], found, entry
    return None


def _closest_examples(text: str, limit: int = 3) -> list[str]:
    """Near-miss suggestions, so an unanswerable question points somewhere useful
    instead of only reporting failure."""
    words = set(re.findall(r"[a-z]{4,}", text.casefold()))
    if not words:
        return example_questions()[:limit]
    scored = []
    for example in example_questions():
        overlap = words & set(re.findall(r"[a-z]{4,}", example.casefold()))
        if overlap:
            scored.append((len(overlap), example))
    scored.sort(reverse=True)
    return [example for _, example in scored[:limit]] or example_questions()[:limit]


def answer(text: str, context: Context | None = None) -> dict:
    ctx: Context = dict(context or {})
    for entry in RULES:
        if entry["needs"] and not ctx.get(entry["needs"]):
            continue
        for pattern in entry["patterns"]:
            found = pattern.search(text)
            if not found:
                continue
            try:
                payload = entry["handler"](found, ctx)
            except Unmatched:
                # The pattern matched but the handler decided it cannot answer this
                # question after all, typically because the subject it needed was not
                # in context. Keep looking rather than reporting a bare failure.
                continue
            payload["topic"] = entry["topic"]
            payload["context"] = {k: v for k, v in ctx.items()
                                  if k in ("place", "place_kind", "focus")}
            if not payload.get("follow_ups") and entry["follow_ups"]:
                payload["follow_ups"] = entry["follow_ups"](found)
            return payload

    raise Unmatched


def answer_question(question: str, context: dict | None = None) -> dict:
    question = str(question or "").strip()
    if not question:
        return {"answer": "Ask a question about cost, schedule, risk or sectors.",
                "results": [], "follow_ups": example_questions()[:4], "confidence": "low",
                "context": dict(context or {})}

    try:
        result = answer(question, context)
    except Unmatched:
        result = {
            "answer": "I could not match that to a query I can run against the PAIMANA "
                      "extract. I answer only from published project data, so I will not "
                      "estimate a figure. These are close to what you asked:",
            "results": [],
            "follow_ups": _closest_examples(question),
            "confidence": "low",
            "topic": "unmatched",
            "context": dict(context or {}),
        }
    result["question"] = question
    return result


if __name__ == "__main__":
    questions = [
        "Which sectors have the worst predicted delays?",
        "How many high-risk projects are in Karnataka?",
        "what about Tamil Nadu",
        "Show the top 5 projects by predicted cost pressure",
        "Why is that project flagged?",
        "What drives cost overrun risk?",
        "How good is the model?",
        "What data is missing?",
        "What will happen next month?",
        "Which states have the most projects above budget?",
        "What is the average physical progress in the Roads sector?",
        "tell me about the weather",
        "How many high-risk projects are there?",
        "average progress",
        "cost overruns inxyz",
        "what about the Roads sector",
    ]
    for q in questions:
        out = answer_question(q)
        print(f"\nQ: {q}\n   [{out['confidence']}/{out.get('topic')}] {out['answer'][:190]}")
        if out.get("follow_ups"):
            print("   next: " + " | ".join(out["follow_ups"][:3]))