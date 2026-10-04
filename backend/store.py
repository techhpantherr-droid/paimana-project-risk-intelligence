"""SQLite layer over the PAIMANA extract.

The project panel, the live portal aggregates and the model outputs all end up
in one local database so the API and the assistant answer from the same numbers
the charts are drawn from.

    python -m backend.store
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from backend import features as F

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "processed"
ARTIFACTS = ROOT / "artifacts"
DB_PATH = ROOT / "data" / "app.db"


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def load_bundle() -> dict:
    return joblib.load(ARTIFACTS / "models.joblib")


def build(path: Path | str = DB_PATH, force: bool = False) -> Path:
    path = Path(path)
    if path.exists() and not force:
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()

    panel = pd.read_csv(DATA / "project_snapshots.csv", dtype={"project_code": str})
    panel["snapshot"] = panel["snapshot"].astype(str)
    reference = json.loads((DATA / "reference_data.json").read_text(encoding="utf-8"))
    aggregates = pd.read_csv(DATA / "dashboard_totals.csv")

    latest = panel["snapshot"].max()
    current = panel[panel["snapshot"] == latest].copy()
    enriched = F.add_features(current)
    enriched["risk_class"] = F.risk_label(enriched)
    enriched = enriched.merge(
        panel[["project_code", "source_table"]].drop_duplicates("project_code"),
        on="project_code", how="left")

    scored = score_projects(enriched)

    conn = connect(path)
    panel.to_sql("project_panel", conn, index=False)
    aggregates.to_sql("portal_aggregates", conn, index=False)
    scored.to_sql("project_current", conn, index=False)

    freeze_meta = reference["freeze_dates"]
    months = sorted(aggregates["month_year"].unique())
    labels = F.month_labels(months)
    display = freeze_meta.get("displayFreeze", "")
    pd.DataFrame({
        "month_year": months,
        "label": labels,
        "is_display_freeze": [f"{lab} {m.split('-')[0]}" == display
                              for lab, m in zip(labels, months)],
    }).to_sql("freeze_dates", conn, index=False)

    for name in ("sectors", "states", "ministries"):
        pd.DataFrame([{"id": item["Value"], "name": item["Text"]}
                      for item in reference[name]]).to_sql(name, conn, index=False)

    conn.commit()
    conn.close()
    return path


def score_projects(frame: pd.DataFrame) -> pd.DataFrame:
    """Attach next-month predictions to the latest snapshot."""
    bundle = load_bundle()
    heads = bundle["heads"]
    labels = bundle["labels"]

    X = bundle["preprocessors"]["base"].transform(F.feature_matrix(frame))

    out = frame.copy()
    out["predicted_cost_pressure_pct"] = heads["cost"]["model"].predict(X)
    out["predicted_time_overrun_months"] = heads["time"]["model"].predict(X)
    probabilities = heads["risk"]["model"].predict_proba(X)
    out["predicted_risk_class"] = [labels[int(i)] for i in probabilities.argmax(axis=1)]
    for i, label in enumerate(labels):
        out[f"risk_prob_{label}"] = probabilities[:, i]
    out["confidence"] = probabilities.max(axis=1)

    live_risk = out["risk_class"].astype(str)
    out["risk_moved"] = np.where(
        out["predicted_risk_class"] == live_risk, "Unchanged", "Escalating")
    out["alert"] = np.where(
        (out["predicted_risk_class"] == "High") & (live_risk != "High"),
        "New high-risk entry",
        np.where(out["predicted_risk_class"] == "High", "High risk next month", ""))
    return out


if __name__ == "__main__":
    created = build(force=True)
    print(f"wrote {created} ({created.stat().st_size / 1e6:.1f} MB)")