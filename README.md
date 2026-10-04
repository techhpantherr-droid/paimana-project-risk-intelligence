# PRAGATI-AI · PAIMANA Project Risk Intelligence

SIH 2026, problem statement 26103. Forecasting cost pressure, schedule slippage and risk band
for centrally sponsored infrastructure projects, built entirely on data the PAIMANA portal
publishes.

Every number in the interface comes from the PAIMANA extract or from models trained on
it. Nothing is estimated at request time and the assistant will not produce a figure it
cannot read from the database.

## What the data actually contains

| | |
|---|---|
| Source | `paimana-proj.mospi.gov.in` monthly Flash Reports plus the live portal aggregates |
| Freeze range | July 2025 to August 2026 |
| Project-month rows | 9,321 |
| Distinct projects | 2,111 |
| Snapshots used for modelling | 5 (April to August 2026) |
| Sectors / states / ministries | 26 / 36 / 19 |
| August 2026 approved cost | Rs 3,071,947.05 crore |
| August 2026 expenditure | Rs 1,632,560.54 crore |

Those last two figures were checked against the published August 2026 report totals
(1,731 projects, Rs 3,071,947 crore approved, Rs 1,632,561 crore spent, 48.59%
utilisation) and match.

**One important caveat carried through the whole build.** The portal publishes a revised
cost per project only inside the narrow major-project tables. The overall detail tables
show 0.00 for revised cost. So a reported cost overrun exists for 161 of 1,731 projects.
For everything else this build reports **cost pressure** - how far cumulative
expenditure sits against the sanctioned cost - and labels it as such. It is a measured
figure from the same report, not an invented revision.

## Models

Three heads, each trained on **one-step-ahead rows**: features as of month *t* paired
with the outcome observed for the same project at month *t+1*. Revised cost and revised
completion date are excluded from the feature set because they are what is being
forecast. That yields 7,210 training rows across 2,042 projects.

| Head | Selected | Validation | Competing models |
|---|---|---|---|
| Cost pressure | Random forest | MAE **1.329** pp, R² 0.882 | XGBoost 1.352, linear 8.579, ridge 8.635, median baseline 5.157 |
| Schedule delay | XGBoost | MAE **2.225** months, R² 0.953 | Random forest 2.366, linear 7.209, median baseline 15.108 |
| Risk class | XGBoost | **94.3%** accuracy, macro F1 0.856, balanced accuracy 0.834 | Logistic regression 90.9%, random forest 90.7%, majority baseline 62.0% |

XGBoost was not assumed to be the answer. Every head was run against linear, ridge,
random-forest and statistical baselines under identical five-fold cross-validation, and
the winner is recorded in `artifacts/metrics.json`. Random forest won the cost head by a
narrow margin and the build keeps that result rather than overriding it.

SHAP decomposes every prediction into per-feature contributions, both globally
(`artifacts/shap_importance.csv`) and per project (`/api/projects/{code}/explain`).

## Data gap analysis

`python -m backend.train` also runs an experiment that answers a policy question: which
fields, if the ministry started capturing them, would actually improve the forecast. Each
candidate is simulated as a noisy function of what happened next, so the experiment is a
**best case** that sizes the prize rather than claiming accuracy for data that does not
exist yet.

| Candidate | Change in cost MAE |
|---|---|
| Material price index | **-9.76%** |
| Monthly expenditure run rate | **-4.41%** |
| Land acquisition status | +0.00% |
| Tender reopen count | +2.87% |
| Approval turnaround days | +3.36% |
| Contractor performance index | +7.25% |
| Environment clearance delay days | +7.98% |
| All candidates together | -8.90% |

The useful half of that table is the negative entries. Land acquisition and
environmental clearance add nothing because their effect is already visible in the
progress gap and elapsed share. Collecting everything would widen the reporting burden;
this says which fields would repay it.

## Features

All computed as of each freeze date from published fields only:

`original_cost`, `expenditure`, `physical_progress`, `expenditure_pct_of_cost`,
`financial_progress`, `spend_rate_ppm`, `project_age_months`,
`sanctioned_duration_months`, `months_to_original_doc`, `elapsed_pct`, `progress_gap`,
`spend_vs_progress_gap`, `unspent_balance`, `cost_log`, `is_mega_project`,
`doc_revision_flag`, plus `sector`, `ministry` and `state_group`.

Risk classes are cut from published fields on a documented 100-point scale: schedule
slippage up to 40, cost pressure up to 25, progress gap up to 20, and 15 for a sanctioned
duration already exceeded.

## Running it

```bash
pip install -r requirements.txt

# 1. extract (optional - processed CSVs are committed)
python -m scraper.build_dataset

# 2. train and write artifacts/
python -m backend.train

# 3. build the SQLite store
python -m backend.store

# 4. api on http://127.0.0.1:8000
python -m backend.main

# 5. site on http://localhost:5173
cd frontend && npm install && npm run dev
```

`python -m scraper.build_dataset` re-downloads the source PDFs and re-parses them.
That takes a long time because the report tables need `pdfplumber.find_tables()`. The
processed CSVs are committed, so steps 2 to 5 work without it.

## Deploy on Render

`render.yaml` defines a single web service that builds the React app and serves both it and
the API from one origin, so the frontend calls `/api/...` on the same host and no `VITE_API`
value is needed.

1. Push the repository to GitHub, then in Render choose **New -> Blueprint** and point it at
   the repository. Render reads `render.yaml` and creates the service.
2. Or create a **Web Service** manually with these settings:

   | Setting | Value |
   | --- | --- |
   | Runtime | Python 3.11 |
   | Build Command | `cd frontend && npm install && npm run build` |
   | Start Command | `uvicorn backend.main:app --host 0.0.0.0 --port $PORT` |
   | Health Check Path | `/api/health` |

3. Deploy. `artifacts/models.joblib` and `data/app.db` are committed, so the first boot scores
   the latest snapshot on startup and serves data immediately, with no training step in the
   deploy.

Once `frontend/dist` exists, `backend/main.py` mounts it: `/assets/*` is served statically and
every other path returns `index.html`, so client-side routes like `/projects` and
`/assistant` deep-link correctly.

Notes for the free plan: instances sleep after inactivity, so the first request after a pause
takes a few seconds while the service wakes up.

## Layout

```
scraper/          portal client, Flash Report table parser, dataset builder
backend/
  features.py     feature engineering and the one-step-ahead target join
  train.py        model comparison, fitting, SHAP, data-gap experiment
  store.py        SQLite build, scores the latest snapshot
  assistant.py    database-backed question answering
  main.py         FastAPI service
frontend/src/
  pages/          eleven screens, one per area
  ui.jsx          shared cards, tables, tiles, chart primitives
  api.js          typed-ish fetch wrapper and number formatting
```

## What the assistant does and does not do

The assistant maps a question to a fixed query and reports the numbers it finds. It
will not invent a figure when nothing matches, will not predict, will not claim a cost
overrun the portal has not published, and will not attribute a cause. Predictions come
from the models on their own pages, where the validation sits next to them.

## Known limitations

- Five snapshots is a thin panel. The one-step-ahead design is honest about it, but the
  validation mixes months rather than testing strictly forward in time. With more
  freezes the same code should switch to a time-ordered split.
- Ministry and sector labels are inferred from the report layout and are occasionally
  wrong where a section heading is ambiguous.
- Risk-band accuracy is high partly because the High class dominates the target
  distribution. Balanced accuracy and per-class precision/recall are reported alongside
  it for that reason.