"""Feature engineering for the project panel.

The panel is one row per project per month, so every feature is computed
"as of" that month's freeze date using only what the portal had published by
then. The revised cost and revised completion date are deliberately left out of
the feature set - they are the things we are trying to forecast one month ahead.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# what the portal publishes per project today
CUF_FIELDS = [
    "original_cost",
    "expenditure",
    "physical_progress",
    "approval_date",
    "start_date",
    "original_doc",
    "ministry",
    "sector",
    "state",
]

# fields a ministry could start capturing; used by the data-gap experiment
UNCAPTURED_CANDIDATES = [
    "contractor_performance_index",
    "approval_turnaround_days",
    "material_price_index",
    "land_acquisition_status",
    "environment_clearance_delay_days",
    "monthly_expenditure_run_rate",
    "tender_reopen_count",
]

# land acquisition is recorded as a stage (0 not started, 1 in progress,
# 2 court pending, 3 cleared), so it is one-hot encoded rather than treated as a count
UNCAPTURED_CATEGORICAL = ["land_acquisition_status"]

NUMERIC_FEATURES = [
    "original_cost",
    "expenditure",
    "physical_progress",
    "expenditure_pct_of_cost",
    "spend_rate_ppm",
    "project_age_months",
    "sanctioned_duration_months",
    "months_to_original_doc",
    "elapsed_pct",
    "progress_gap",
    "financial_progress",
    "spend_vs_progress_gap",
    "unspent_balance",
    "cost_log",
    "is_mega_project",
    "doc_revision_flag",
]

CATEGORICAL_FEATURES = ["sector", "ministry", "state_group"]

FEATURE_LABELS = {
    "original_cost": "Approved project cost",
    "expenditure": "Cumulative expenditure",
    "physical_progress": "Physical progress reported",
    "expenditure_pct_of_cost": "Expenditure as % of approved cost",
    "spend_rate_ppm": "Monthly spend as % of approved cost",
    "project_age_months": "Months since approval",
    "sanctioned_duration_months": "Sanctioned project duration",
    "months_to_original_doc": "Months to original completion date",
    "elapsed_pct": "Share of sanctioned duration used",
    "progress_gap": "Physical progress less elapsed share",
    "financial_progress": "Financial progress",
    "spend_vs_progress_gap": "Financial progress less physical progress",
    "unspent_balance": "Unspent balance",
    "cost_log": "Project size band",
    "is_mega_project": "Mega project (>= Rs 1000 cr)",
    "doc_revision_flag": "Revised completion date already recorded",
    "sector": "Sector",
    "ministry": "Ministry / department",
    "state_group": "State group",
}

NON_LINEAR_GROUPS = [
    "progress_gap",
    "spend_vs_progress_gap",
    "months_to_original_doc",
    "spend_rate_ppm",
    "physical_progress",
    "expenditure_pct_of_cost",
]


def month_index(dates: pd.Series) -> pd.Series:
    return dates.dt.year * 12 + dates.dt.month


def add_features(frame: pd.DataFrame) -> pd.DataFrame:
    df = frame.copy()
    as_of = pd.to_datetime(df["snapshot"] + "-01")
    df["approval_date"] = pd.to_datetime(df["approval_date"], errors="coerce")
    df["start_date"] = pd.to_datetime(df["start_date"], errors="coerce")
    df["original_doc"] = pd.to_datetime(df["original_doc"], errors="coerce")
    df["revised_doc"] = pd.to_datetime(df["revised_doc"], errors="coerce")

    cost = df["original_cost"].replace(0, np.nan)
    df["expenditure_pct_of_cost"] = (df["expenditure"] / cost * 100).clip(0, 250)
    df["financial_progress"] = df["expenditure_pct_of_cost"]

    began = df["start_date"].fillna(df["approval_date"])
    age = month_index(as_of) - month_index(began)
    df["project_age_months"] = age.clip(lower=0)

    duration = month_index(df["original_doc"]) - month_index(began)
    df["sanctioned_duration_months"] = duration.where(duration > 0)

    remaining = month_index(df["original_doc"]) - month_index(as_of)
    df["months_to_original_doc"] = remaining

    df["elapsed_pct"] = np.where(
        df["sanctioned_duration_months"].notna(),
        (df["project_age_months"] / df["sanctioned_duration_months"] * 100).clip(0, 200),
        np.nan,
    )

    df["progress_gap"] = df["physical_progress"] - df["elapsed_pct"].fillna(
        df["physical_progress"].median()
    )
    df["spend_vs_progress_gap"] = df["financial_progress"] - df["physical_progress"]
    df["spend_rate_ppm"] = np.where(
        df["project_age_months"] > 0, df["expenditure_pct_of_cost"] / df["project_age_months"], np.nan
    )
    df["unspent_balance"] = (cost - df["expenditure"]).clip(lower=0)
    df["cost_log"] = np.log1p(cost)
    df["is_mega_project"] = (cost >= 1000).astype(int)
    df["doc_revision_flag"] = df["revised_doc"].notna().astype(int)

    df["state_group"] = (
        df["state"].fillna("Not stated").str.replace(r"\s+", " ", regex=True).str.strip()
    )

    df["time_overrun_months"] = (
        month_index(df["revised_doc"]) - month_index(df["original_doc"])
    ).where(df["revised_doc"].notna(), 0.0).clip(lower=0)

    df["cost_overrun_pct"] = np.where(
        df["revised_cost"].notna() & cost.notna(),
        (df["revised_cost"] / cost - 1) * 100,
        np.nan,
    )
    # projects with no revised cost recorded but spending above the sanctioned
    # budget are already over it - a measurable proxy, not a reported overrun
    df["budget_pressure_pct"] = (df["expenditure"] - cost) / cost * 100
    df["cost_pressure_pct"] = df["cost_overrun_pct"].where(
        df["cost_overrun_pct"].notna(), df["budget_pressure_pct"].clip(lower=0))
    return df


def risk_label(df: pd.DataFrame) -> pd.Series:
    """Documented risk classes, cut from the published fields only."""
    score = np.zeros(len(df))
    score += np.minimum(df["time_overrun_months"].fillna(0) / 12 * 100, 40)
    score += np.minimum(df["cost_pressure_pct"].fillna(0).clip(lower=0) / 20 * 25, 25)
    score += np.minimum((-df["progress_gap"]).fillna(0).clip(lower=0) / 30 * 20, 20)
    score += np.where(df["elapsed_pct"] > 100, 15, 0)
    return pd.cut(score, [-0.01, 25, 50, 100], labels=["Low", "Medium", "High"])


def build_supervised(panel: pd.DataFrame) -> pd.DataFrame:
    """One-step-ahead rows: features at month t, outcome observed at t+1."""
    df = add_features(panel).sort_values(["project_code", "snapshot"])
    df["risk_class"] = risk_label(df)
    df["next_snapshot"] = df.groupby("project_code")["snapshot"].shift(-1)

    outcome_cols = ["time_overrun_months", "cost_pressure_pct", "cost_overrun_pct",
                    "risk_class", "physical_progress", "expenditure"]
    following = df[["project_code", "snapshot"] + outcome_cols].rename(
        columns={"snapshot": "next_snapshot",
                 **{c: f"next_{c}" for c in outcome_cols}})

    pairs = df.merge(following, on=["project_code", "next_snapshot"], how="inner")
    pairs["progress_gain"] = pairs["next_physical_progress"] - pairs["physical_progress"]
    pairs["spend_gain"] = pairs["next_expenditure"] - pairs["expenditure"]
    pairs["target_cost_overrun_pct"] = pairs["next_cost_pressure_pct"].fillna(0)
    pairs["target_time_overrun_months"] = pairs["next_time_overrun_months"].fillna(0)
    pairs["target_risk_class"] = pairs["next_risk_class"].fillna("Low")
    return pairs


def feature_matrix(df: pd.DataFrame, augmented: bool = False) -> pd.DataFrame:
    cols = NUMERIC_FEATURES + CATEGORICAL_FEATURES
    out = df[cols].copy()
    if augmented:
        for name in UNCAPTURED_CANDIDATES:
            out[name] = df.get(name, pd.Series(np.nan, index=df.index))
    return out


def simulate_uncaptured(df: pd.DataFrame, seed: int = 11) -> pd.DataFrame:
    """Synthesise the variables the portal does not publish today.

    This is a best case, not an accuracy claim. Each candidate is built as the
    next month's outcome plus noise, so the experiment answers "is the remaining
    error even reachable if we captured this field?" - a field that carries no
    signal cannot lower the error, which is exactly what the page needs to show.
    """
    rng = np.random.default_rng(seed)
    out = df.copy()
    time_horizon = out["target_time_overrun_months"].clip(0, 24)
    cost_horizon = out["target_cost_overrun_pct"].clip(-5, 120)

    out["contractor_performance_index"] = (
        100 - time_horizon * 2 - cost_horizon * 0.05 + rng.normal(0, 18, len(out))
    )
    out["approval_turnaround_days"] = (
        out["project_age_months"].clip(0, 120) * 30 * 0.4 + rng.normal(120, 60, len(out))
    )
    heavy = out["sector"].isin(["Roads & Highways", "Oil & Gas", "Power", "Metals & Mining"])
    out["material_price_index"] = np.where(
        heavy, rng.normal(140, 25, len(out)), rng.normal(100, 12, len(out))
    ) + cost_horizon * 0.8
    out["land_acquisition_status"] = np.where(
        time_horizon > 12, rng.choice([0, 1, 2], len(out), p=[0.45, 0.40, 0.15]),
        rng.choice([0, 1, 2, 3], len(out), p=[0.15, 0.45, 0.25, 0.15]),
    )
    out["environment_clearance_delay_days"] = np.where(
        out["sector"].isin(["Roads & Highways", "Power", "Coal", "Oil & Gas"]),
        rng.gamma(2.0, 45, len(out)), rng.gamma(1.2, 10, len(out))
    ) + time_horizon * 8
    out["monthly_expenditure_run_rate"] = (
        out["spend_rate_ppm"].fillna(out["spend_rate_ppm"].median())
        + cost_horizon * 0.02 + rng.normal(0, 0.6, len(out))
    )
    out["tender_reopen_count"] = rng.poisson(0.4 + time_horizon / 10, len(out))
    return out


def month_labels(snapshots: list[str]) -> list[str]:
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return [f"{names[int(s.split('-')[1]) - 1]} {s.split('-')[0]}" for s in snapshots]
