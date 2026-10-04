"""Fetch the live portal aggregates (no PDF work - the project panel is already
in data/processed/project_snapshots.csv)."""

import json
from pathlib import Path

import pandas as pd

from scraper.build_dataset import OUT, SECTOR_KEYS, _month_range, load_reference, tidy
from scraper.paimana_client import PaimanaClient

client = PaimanaClient()
ref = load_reference(client)

snap = tidy(pd.read_csv(OUT / "project_snapshots.csv"))
snap.to_csv(OUT / "project_snapshots.csv", index=False)
print("project panel:", len(snap), "rows")

frames = []
for month in _month_range(ref["freeze_dates"]["firstFreeze"], ref["freeze_dates"]["lastFreeze"]):
    try:
        data = client.dashboard(month_year=month)
    except Exception as exc:  # noqa: BLE001
        print(" ", month, "failed:", exc)
        continue
    rows = []
    for key, dim in SECTOR_KEYS:
        for item in data.get(key) or []:
            rows.append({
                "month_year": month,
                "dimension": dim,
                "label": item.get("SectorName") or item.get("StateName") or str(item.get("ProgressSlab")),
                "projects": item.get("TotalProject"),
                "original_cost": item.get("CumCost"),
                "revised_cost": item.get("CumRevCost"),
                "expenditure": item.get("CumExpen"),
            })
    for item in data.get("CostdetailsList") or []:
        rows.append({
            "month_year": month, "dimension": "portfolio", "label": "All projects",
            "projects": item.get("TOTAL_PROJECT") or item.get("TotalProject"),
            "original_cost": item.get("OriginalCost"),
            "revised_cost": item.get("RevisedCost"),
            "expenditure": item.get("CummulativeExpenditure"),
        })
    frames.append(pd.DataFrame(rows))
    print(" ", month, len(rows), "rows")
    client.token(refresh=True)

agg = pd.concat(frames, ignore_index=True)
agg.to_csv(OUT / "dashboard_totals.csv", index=False)
print("dashboard aggregates:", len(agg))
