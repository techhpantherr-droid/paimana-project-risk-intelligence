"""Train the prediction models on the PAIMANA project panel.

    python -m backend.train

Three heads are trained on one-step-ahead rows - features as of month t, outcome
observed at month t+1:

    cost_overrun_pct     percentage over the sanctioned budget
    time_overrun_months  slippage against the original completion date
    risk_class           Low / Medium / High

Each head is compared against linear, ridge, random-forest and median-baseline
models so the choice of XGBoost rests on measured error rather than preference.
A second pass adds simulated versions of the fields the portal does not capture
today, which is what the data-gap page reports.

Artefacts land in artifacts/: models.joblib, metrics.json, shap_importance.csv.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import shap
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier, DummyRegressor
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, LogisticRegression, Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import KFold, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from xgboost import XGBClassifier, XGBRegressor

from backend import features as F

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "processed"
ARTIFACTS = ROOT / "artifacts"
SEED = 7


def load_panel() -> pd.DataFrame:
    panel = pd.read_csv(DATA / "project_snapshots.csv", dtype={"project_code": str})
    panel["snapshot"] = panel["snapshot"].astype(str)
    return panel


def make_prep(numeric: list[str], categorical: list[str]) -> ColumnTransformer:
    return ColumnTransformer([
        ("num", Pipeline([
            ("impute", SimpleImputer(strategy="median", add_indicator=True)),
            ("scale", StandardScaler()),
        ]), numeric),
        ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=2), categorical),
    ])


def regression_models() -> dict:
    return {
        "Median baseline": DummyRegressor(strategy="median"),
        "Linear regression": LinearRegression(),
        "Ridge": Ridge(alpha=1.0),
        "Random forest": RandomForestRegressor(
            n_estimators=300, min_samples_leaf=8, n_jobs=-1, random_state=SEED),
        "XGBoost": XGBRegressor(
            n_estimators=420, max_depth=5, learning_rate=0.05, subsample=0.85,
            colsample_bytree=0.8, min_child_weight=6, reg_lambda=1.5,
            objective="reg:squarederror", n_jobs=-1, random_state=SEED),
    }


def classifier_models() -> dict:
    return {
        "Majority baseline": DummyClassifier(strategy="most_frequent"),
        "Logistic regression": LogisticRegression(max_iter=2000),
        "Random forest": RandomForestClassifier(
            n_estimators=400, min_samples_leaf=10, n_jobs=-1, random_state=SEED),
        "XGBoost": XGBClassifier(
            n_estimators=380, max_depth=4, learning_rate=0.06, subsample=0.85,
            colsample_bytree=0.8, min_child_weight=8, reg_lambda=2.0,
            objective="multi:softprob", num_class=3, n_jobs=-1, random_state=SEED),
    }


def score_regression(models: dict, X, y, folds: int = 5) -> pd.DataFrame:
    splitter = KFold(n_splits=folds, shuffle=True, random_state=11)
    rows = []
    for name, model in models.items():
        started = time.time()
        preds = cross_val_predict(model, X, y, cv=splitter)
        rows.append({
            "model": name,
            "mae": round(mean_absolute_error(y, preds), 3),
            "rmse": round(float(np.sqrt(mean_squared_error(y, preds))), 3),
            "r2": round(r2_score(y, preds), 3),
            "seconds": round(time.time() - started, 1),
        })
    return pd.DataFrame(rows).sort_values("mae").reset_index(drop=True)


def score_classification(models: dict, X, y, labels: list[str], folds: int = 5) -> pd.DataFrame:
    splitter = KFold(n_splits=folds, shuffle=True, random_state=11)
    rows = []
    for name, model in models.items():
        started = time.time()
        preds = cross_val_predict(model, X, y, cv=splitter)
        detail = {}
        for label in labels:
            code = labels.index(label)
            tp = int(((preds == code) & (y == code)).sum())
            fp = int(((preds == code) & (y != code)).sum())
            fn = int(((preds != code) & (y == code)).sum())
            precision = tp / (tp + fp) if tp + fp else 0.0
            recall = tp / (tp + fn) if tp + fn else 0.0
            f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
            detail[label] = {"precision": round(precision, 3), "recall": round(recall, 3),
                             "f1": round(f1, 3), "support": int((y == code).sum())}
        rows.append({
            "model": name,
            "accuracy": round(float((preds == y).mean()), 4),
            "balanced_accuracy": round(float(np.mean([
                detail[l]["recall"] for l in labels])), 4),
            "macro_f1": round(float(np.mean([detail[l]["f1"] for l in labels])), 4),
            "seconds": round(time.time() - started, 1),
            "per_class": detail,
        })
    return pd.DataFrame(rows).sort_values("accuracy", ascending=False).reset_index(drop=True)


def pretty_label(name: str) -> str:
    base = name.split("__", 1)[-1] if "__" in name else name
    if name.startswith("cat__"):
        for field in sorted(F.FEATURE_LABELS, key=len, reverse=True):
            if base.startswith(field + "_"):
                level = base[len(field) + 1:]
                return f"{F.FEATURE_LABELS[field]}: {level}"
        return base.replace("_", " ").capitalize()
    return F.FEATURE_LABELS.get(base, base.replace("_", " ").capitalize())


def shap_table(model, matrix, feature_names: list[str], target: str) -> pd.DataFrame:
    dense = matrix.toarray() if hasattr(matrix, "toarray") else matrix
    sample = np.asarray(dense, dtype=float)[: min(1500, dense.shape[0])]
    values = shap.TreeExplainer(model).shap_values(sample, check_additivity=False)
    if isinstance(values, list):
        values = values[-1]
    frame = pd.DataFrame({
        "feature": feature_names,
        "mean_abs_shap": np.abs(values).mean(axis=0),
        "target": target,
    })
    frame["label"] = frame["feature"].map(pretty_label)
    return frame.sort_values("mean_abs_shap", ascending=False)


def main() -> None:
    ARTIFACTS.mkdir(exist_ok=True)
    panel = load_panel()
    rows = F.build_supervised(panel)
    print(f"panel {len(panel)} rows | one-step-ahead rows {len(rows)} | projects {rows.project_code.nunique()}")

    prep = make_prep(F.NUMERIC_FEATURES, F.CATEGORICAL_FEATURES)
    X_raw = F.feature_matrix(rows)
    X = prep.fit_transform(X_raw)
    names = list(prep.get_feature_names_out())

    augmented = F.simulate_uncaptured(rows)
    X_aug_raw = F.feature_matrix(augmented, augmented=True)
    aug_numeric = F.NUMERIC_FEATURES + [c for c in F.UNCAPTURED_CANDIDATES
                                        if c not in F.UNCAPTURED_CATEGORICAL]
    aug_categorical = F.CATEGORICAL_FEATURES + F.UNCAPTURED_CATEGORICAL
    prep_aug = make_prep(aug_numeric, aug_categorical)
    X_aug = prep_aug.fit_transform(X_aug_raw)
    names_aug = list(prep_aug.get_feature_names_out())

    labels = ["Low", "Medium", "High"]
    y_cost = rows["target_cost_overrun_pct"].clip(-5, 200).to_numpy()
    y_time = rows["target_time_overrun_months"].clip(0, 60).to_numpy()
    y_risk = pd.Categorical(rows["target_risk_class"], categories=labels).codes

    metrics = {
        "generated_at": pd.Timestamp.utcnow().round("s").isoformat(),
        "source": "PAIMANA monthly Flash Reports, paimana-proj.mospi.gov.in",
        "snapshots": sorted(panel["snapshot"].unique().tolist()),
        "projects": int(panel["project_code"].nunique()),
        "panel_rows": int(len(panel)),
        "supervised_rows": int(len(rows)),
        "target_definition": "features as of month t, outcome observed at month t+1",
        "heads": {},
    }

    heads = {}

    cost_table = score_regression(regression_models(), X, y_cost)
    print("\ncost overrun - mean absolute error (lower is better)")
    print(cost_table.to_string(index=False))
    cost_name = cost_table["model"].iat[0]
    cost_model = regression_models()[cost_name]
    cost_model.fit(X, y_cost)
    heads["cost"] = {"model": cost_model, "names": names, "chosen": cost_name}
    metrics["heads"]["cost_overrun_pct"] = {
        "description": "Percentage by which spending exceeds, or is projected to exceed, "
                       "the sanctioned cost, one month ahead",
        "chosen_model": cost_name,
        "comparison": cost_table.to_dict("records"),
    }

    time_table = score_regression(regression_models(), X, y_time)
    print("\ntime overrun - mean absolute error in months")
    print(time_table.to_string(index=False))
    time_name = time_table["model"].iat[0]
    time_model = regression_models()[time_name]
    time_model.fit(X, y_time)
    heads["time"] = {"model": time_model, "names": names, "chosen": time_name}
    metrics["heads"]["time_overrun_months"] = {
        "description": "Months of slippage against the original completion date, one month ahead",
        "chosen_model": time_name,
        "comparison": time_table.to_dict("records"),
    }

    risk_table = score_classification(classifier_models(), X, y_risk, labels)
    print("\nrisk class - classification report")
    print(risk_table.drop(columns=["per_class"]).to_string(index=False))
    risk_name = risk_table["model"].iat[0]
    risk_model = classifier_models()[risk_name]
    risk_model.fit(X, y_risk)
    heads["risk"] = {"model": risk_model, "names": names, "chosen": risk_name, "labels": labels}
    metrics["heads"]["risk_class"] = {
        "description": "Whether a project lands in the high-risk band next month",
        "chosen_model": risk_name,
        "classes": labels,
        "comparison": [
            {k: v for k, v in row.items()} for row in risk_table.to_dict("records")
        ],
    }

    # ---- how much would newly captured fields be worth? -------------------
    print("\ndata gap: adding one candidate variable at a time (cost overrun MAE)")
    trial = XGBRegressor(
        n_estimators=420, max_depth=5, learning_rate=0.05, subsample=0.85,
        colsample_bytree=0.8, min_child_weight=6, reg_lambda=1.5,
        objective="reg:squarederror", n_jobs=-1, random_state=SEED)
    gap_splits = KFold(5, shuffle=True, random_state=11)
    base_mae = float(mean_absolute_error(
        y_cost, cross_val_predict(trial, X, y_cost, cv=gap_splits)))
    print(f"  {'Fields the portal captures today':<48} mae {base_mae:7.3f}   0.00%")
    steps = [{"step": "Fields the portal captures today", "added": None,
              "mae": round(base_mae, 3), "change_pct": 0.0}]

    CATEGORICAL = F.CATEGORICAL_FEATURES
    for candidate in F.UNCAPTURED_CANDIDATES:
        is_cat = candidate in F.UNCAPTURED_CATEGORICAL
        num = F.NUMERIC_FEATURES + ([] if is_cat else [candidate])
        cols = list(dict.fromkeys(num + CATEGORICAL + F.UNCAPTURED_CATEGORICAL + [candidate]))
        subset = make_prep(num, CATEGORICAL).fit_transform(X_aug_raw[cols])
        mae = float(mean_absolute_error(
            y_cost, cross_val_predict(trial, subset, y_cost, cv=gap_splits)))
        steps.append({"step": f"+ {candidate.replace('_', ' ')}", "added": candidate,
                      "mae": round(mae, 3),
                      "change_pct": round((mae / base_mae - 1) * 100, 2)})
        print(f"  {steps[-1]['step']:<48} mae {mae:7.3f}  {steps[-1]['change_pct']:+6.2f}%")

    full_mae = float(mean_absolute_error(
        y_cost, cross_val_predict(trial, X_aug, y_cost, cv=gap_splits)))
    steps.append({"step": "+ all candidate variables together", "added": "all",
                  "mae": round(full_mae, 3),
                  "change_pct": round((full_mae / base_mae - 1) * 100, 2)})
    print(f"  {steps[-1]['step']:<48} mae {full_mae:7.3f}  {steps[-1]['change_pct']:+6.2f}%")

    aug_cost = XGBRegressor(
        n_estimators=420, max_depth=5, learning_rate=0.05, subsample=0.85,
        colsample_bytree=0.8, min_child_weight=6, reg_lambda=1.5,
        objective="reg:squarederror", n_jobs=-1, random_state=SEED)
    aug_cost.fit(X_aug, y_cost)
    heads["cost_augmented"] = {"model": aug_cost, "names": names_aug}

    aug_risk_table = score_classification(
        {"XGBoost": classifier_models()["XGBoost"]}, X_aug, y_risk, labels)
    print("\nrisk accuracy with the extra variables:",
          round(float(aug_risk_table["accuracy"].iat[0]), 4))

    metrics["data_gap"] = {
        "note": "The candidate variables are simulated to size how much of the remaining "
                "error could be reached if they were captured. They are not measured today, "
                "so no accuracy claim is made for them.",
        "baseline_mae": base_mae,
        "steps": steps,
        "risk_accuracy_today": float(risk_table["accuracy"].iat[0]),
        "risk_accuracy_with_extra": float(aug_risk_table["accuracy"].iat[0]),
        "candidate_variables": F.UNCAPTURED_CANDIDATES,
    }

    importance = pd.concat([
        shap_table(cost_model, X, names, "cost_overrun_pct"),
        shap_table(time_model, X, names, "time_overrun_months"),
    ], ignore_index=True)
    importance.to_csv(ARTIFACTS / "shap_importance.csv", index=False)

    print("\ntop drivers")
    for target, block in importance.groupby("target"):
        print(f"  {target}")
        for _, row in block.head(7).iterrows():
            print(f"    {row['label']:<46} {row['mean_abs_shap']:.4f}")

    joblib.dump({"heads": heads, "labels": labels,
                "preprocessors": {"base": prep, "augmented": prep_aug}},
               ARTIFACTS / "models.joblib")
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print("\nwrote artifacts/models.joblib, artifacts/metrics.json, artifacts/shap_importance.csv")


if __name__ == "__main__":
    main()
