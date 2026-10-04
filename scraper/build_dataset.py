"""Build the modelling dataset from the PAIMANA sources.

    python -m scraper.build_dataset            # full run
    python -m scraper.build_dataset --skip-api  # PDFs only

Writes:
    data/processed/project_snapshots.csv   one row per project per month
    data/processed/reference_data.json     sectors / states / ministries
    data/processed/dashboard_totals.csv    live portal aggregates per freeze month
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pandas as pd

from scraper import flash_report
from scraper.paimana_client import PaimanaClient

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"

SECTOR_KEYS = [
    ("SectorWiseDataList", "sector"),
    ("StateWiseDataList", "state"),
    ("PhysicalProgressDataList", "progress_slab"),
]


def collect_reports(client: PaimanaClient) -> None:
    catalog = client.report_catalog()
    client.save_json(catalog, RAW / "report_catalog.json")
    kept = 0
    for row in catalog:
        name = Path(row["path"]).name
        if not name.lower().startswith("flashreport"):
            continue
        if client.download(row["path"], RAW / "reports" / name):
            kept += 1
    print(f"flash reports on disk: {kept}")


def load_reference(client: PaimanaClient) -> dict:
    path = OUT / "reference_data.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    ref = {
        "sectors": client.sectors(),
        "states": client.states(),
        "ministries": client.ministries(),
        "freeze_dates": client.freeze_dates(),
    }
    client.save_json(ref, path)
    return ref


NAME_TAIL_RE = re.compile(r"\s*\((?:-|\d{3,})\)\s*$")


def tidy(frame: pd.DataFrame) -> pd.DataFrame:
    frame["project_name"] = (
        frame["project_name"].str.replace(r"\s+", " ", regex=True).str.strip()
    )
    for _ in range(3):
        frame["project_name"] = frame["project_name"].str.replace(NAME_TAIL_RE, "", regex=True)
    frame["state"] = frame["state"].str.replace(r"\s+", " ", regex=True).str.strip()
    return frame


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-api", action="store_true")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    client = PaimanaClient()

    if not args.skip_api:
        print("fetching flash reports")
        collect_reports(client)
        print("fetching reference lists")
        load_reference(client)

    ref = json.loads((OUT / "reference_data.json").read_text(encoding="utf-8"))
    ministry_names = {m["Text"] for m in ref["ministries"]}
    sector_names = {s["Text"] for s in ref["sectors"]}

    print("parsing project tables")
    rows = flash_report.parse_folder(RAW / "reports", ministry_names, sector_names)
    if not rows:
        raise SystemExit("no project rows parsed - check the report layout")

    snap = pd.DataFrame(rows)
    for col in ["approval_date", "start_date", "original_doc", "revised_doc"]:
        if col not in snap:
            snap[col] = None
        snap[col] = pd.to_datetime(snap[col], errors="coerce")
    snap["original_cost"] = pd.to_numeric(snap.get("original_cost"), errors="coerce")
    snap["revised_cost"] = pd.to_numeric(snap.get("revised_cost"), errors="coerce")
    snap["expenditure"] = pd.to_numeric(snap.get("expenditure"), errors="coerce")
    snap["physical_progress"] = pd.to_numeric(snap.get("physical_progress"), errors="coerce")

    # the narrow "major projects" table repeats some codes without dates or
    # state, but it is the only place a per-project revised cost is published,
    # so keep the detailed row and graft the revised cost onto it
    cost_lookup = (
        snap[snap["revised_cost"].notna()]
        .drop_duplicates(subset=["snapshot", "project_code"])
        .set_index(["snapshot", "project_code"])["revised_cost"]
    )
    snap["richness"] = snap[["original_doc", "revised_doc", "state"]].notna().sum(axis=1)
    snap = snap.sort_values(["snapshot", "project_code", "richness"])
    snap = snap.drop_duplicates(subset=["snapshot", "project_code"], keep="last")
    keys = pd.MultiIndex.from_frame(snap[["snapshot", "project_code"]])
    revised = snap["revised_cost"].copy()
    revised = revised.fillna(pd.Series(cost_lookup.reindex(keys).to_numpy(), index=snap.index))
    snap["revised_cost"] = revised
    snap = snap.sort_values(["snapshot", "project_code"]).reset_index(drop=True)
    snap = snap.drop(columns=["richness"])

    # the project table carries no ministry/state for the narrow tables, so fill
    # the gaps from the same project in other snapshots of the panel
    for col in ["ministry", "sector", "state", "agency"]:
        snap[col] = snap.groupby("project_code")[col].transform(lambda s: s.ffill().bfill())

    snap = tidy(snap)
    snap["report_date"] = pd.to_datetime(snap["snapshot"] + "-28")
    snap.to_csv(OUT / "project_snapshots.csv", index=False)
    print(f"project snapshots: {len(snap)} rows, {snap.project_code.nunique()} projects, "
          f"{snap.snapshot.nunique()} months, {snap.revised_cost.notna().sum()} with reported revised cost")

    if args.skip_api:
        return

    print("fetching dashboard aggregates")
    freeze = ref["freeze_dates"]
    months = _month_range(freeze["firstFreeze"], freeze["lastFreeze"])
    frames = []
    for month in months:
        try:
            data = client.dashboard(month_year=month)
        except Exception as exc:  # noqa: BLE001
            print(f"  {month} failed: {exc}")
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
                "month_year": month,
                "dimension": "portfolio",
                "label": "All projects",
                "projects": item.get("TOTAL_PROJECT") or item.get("TotalProject"),
                "original_cost": item.get("OriginalCost"),
                "revised_cost": item.get("RevisedCost"),
                "expenditure": item.get("CummulativeExpenditure"),
            })
        frames.append(pd.DataFrame(rows))
        print(f"  {month}: {len(rows)} aggregate rows")
        client.token(refresh=True)

    if frames:
        agg = pd.concat(frames, ignore_index=True)
        agg.to_csv(OUT / "dashboard_totals.csv", index=False)
        print(f"dashboard aggregates: {len(agg)} rows")


def _month_range(first: str, last: str) -> list[str]:
    fy, fm = int(first[:4]), int(first[5:7])
    ly, lm = int(last[:4]), int(last[5:7])
    out = []
    year, month = fy, fm
    while (year, month) <= (ly, lm):
        out.append(f"{year}-{month:02d}")
        month += 1
        if month == 13:
            year, month = year + 1, 1
    return out


if __name__ == "__main__":
    main()
