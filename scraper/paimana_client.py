"""Thin HTTP client for the public PAIMANA endpoints.

The portal is an ASP.NET MVC app: the dashboard filters are posted with an
antiforgery token that has to be lifted from the page first. Everything the
platform stores is pulled through here so there is a single place to change if
the government moves the URLs around.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import requests

PORTAL = "https://paimana-proj.mospi.gov.in"
DASHBOARD_PATH = "/Home/PublicDashboardNew"

TOKEN_RE = re.compile(r'name="__RequestVerificationToken" type="hidden" value="([^"]+)"')

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


class PaimanaClient:
    def __init__(self, base: str = PORTAL, pause: float = 0.4) -> None:
        self.base = base.rstrip("/")
        self.pause = pause
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self._token: str | None = None

    # -- plumbing ---------------------------------------------------------

    def _get(self, path: str, **kw: Any) -> requests.Response:
        resp = self.session.get(self.base + path, timeout=120, **kw)
        resp.raise_for_status()
        return resp

    def _ajax(self, path: str, **kw: Any) -> requests.Response:
        headers = dict(kw.pop("headers", {}))
        headers.update({"X-Requested-With": "XMLHttpRequest", "Referer": self.base + DASHBOARD_PATH})
        resp = self.session.get(self.base + path, headers=headers, timeout=120, **kw)
        resp.raise_for_status()
        return resp

    def token(self, refresh: bool = False) -> str:
        if self._token is None or refresh:
            page = self._get(DASHBOARD_PATH).text
            found = TOKEN_RE.search(page)
            if not found:
                raise RuntimeError("antiforgery token missing from the dashboard page")
            self._token = found.group(1)
        return self._token

    # -- reference data ----------------------------------------------------

    def freeze_dates(self) -> dict:
        return self._ajax("/Home/GetFreezeDates").json()

    def _options(self, path: str, **params: Any) -> list[dict]:
        return self._ajax(path, params=params or None).json()

    def sectors(self) -> list[dict]:
        return self._options("/Home/GetSectorList")

    def states(self) -> list[dict]:
        return self._options("/Home/GetStateList")

    def ministries(self, sector_id: int | None = None) -> list[dict]:
        return self._options("/Home/GetMinistryList", **({"sectorId": sector_id} if sector_id else {}))

    # -- dashboard payloads -------------------------------------------------

    def tiles(self, **filters: Any) -> dict:
        payload = {
            "Month": filters.get("month", ""),
            "Year": filters.get("year", ""),
            "MonthYear": filters.get("month_year", ""),
            "SectorId": filters.get("sector_id", ""),
            "PROJ_MINISTRY_ID": filters.get("ministry_id", ""),
            "StateId": filters.get("state_id", ""),
            "CostRange": filters.get("cost_range", ""),
            "__RequestVerificationToken": self.token(),
        }
        resp = self.session.post(
            self.base + "/Home/GetTileData",
            data=payload,
            headers={"Referer": self.base + DASHBOARD_PATH, "X-Requested-With": "XMLHttpRequest"},
            timeout=300,
        )
        if resp.status_code != 200 or not resp.text.lstrip().startswith("{"):
            raise RuntimeError(f"GetTileData returned {resp.status_code}")
        return resp.json()

    def dashboard(self, **filters: Any) -> dict:
        payload = {
            "Month": filters.get("month", ""),
            "Year": filters.get("year", ""),
            "MonthYear": filters.get("month_year", ""),
            "SectorId": filters.get("sector_id", ""),
            "PROJ_MINISTRY_ID": filters.get("ministry_id", ""),
            "StateId": filters.get("state_id", ""),
            "CostRange": filters.get("cost_range", ""),
            "__RequestVerificationToken": self.token(),
        }
        resp = self.session.post(
            self.base + "/Home/GetDashboardTileDataforChart",
            data=payload,
            headers={"Referer": self.base + DASHBOARD_PATH, "X-Requested-With": "XMLHttpRequest"},
            timeout=300,
        )
        resp.raise_for_status()
        body = resp.json()
        if not body.get("success"):
            raise RuntimeError("dashboard endpoint reported failure")
        return body["data"]

    # -- monthly flash reports ----------------------------------------------

    def financial_years(self) -> list[str]:
        return self._ajax("/ProjectMonitoring/GetFinancialYearList").json()

    def report_rows(self, fyear: str, month: int) -> list[dict]:
        """Rows of the archive table for one financial year / month."""
        resp = self._ajax("/ProjectMonitoring/Report", params={"fyear": fyear, "month": month})
        blob = resp.json().get("html", "")
        rows = []
        for row in re.findall(r"<tr>(.*?)</tr>", blob, re.S):
            cells = [re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
            href = re.search(r"""href=["']([^"']+)["']""", row)
            if len(cells) >= 3 and href:
                rows.append({"financial_year": cells[1], "month": cells[2], "raw_href": href.group(1)})
        return rows

    def report_catalog(self) -> list[dict]:
        """Every monthly report the archive knows about, oldest first."""
        seen: dict[str, dict] = {}
        for fyear in self.financial_years():
            for month in range(1, 13):
                key = f"{fyear}-{month:02d}"
                for row in self.report_rows(fyear, month):
                    raw = row["raw_href"]
                    path = raw.split("path=", 1)[1] if "path=" in raw else raw.lstrip("./")
                    seen[key] = {
                        "snapshot": key,
                        "financial_year": row["financial_year"],
                        "month_name": row["month"],
                        "path": path.replace("\\", "/"),
                    }
                time.sleep(self.pause)
        return sorted(seen.values(), key=lambda r: r["snapshot"])

    def download(self, path: str, dest: Path) -> bool:
        if dest.exists() and dest.stat().st_size > 4096:
            return True
        url = self.base + "/" + path.lstrip("/").replace(" ", "%20")
        resp = self.session.get(url, timeout=600)
        if resp.status_code == 200 and resp.content[:4] == b"%PDF":
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(resp.content)
            return True
        return False

    def save_json(self, payload: Any, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
