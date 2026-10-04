"""Turn the PAIMANA monthly Flash Report PDFs into project records.

Appendix tables are laid out as one pdfplumber row per project:

    Sl.No | Project Name (Agency) (Project Code) | State
          | Date of Approval (Start Date) | Original/Target DoC (Revised DoC)
          | Original Cost (Revised Cost) | Cumulative Expenditure | Physical Progress

Ministry and sector headings sit in the same table as full-width rows, so the
parser tracks them while walking down each table. Project names are re-read from
the cell rectangle because the raw text order inside a multi-line cell is not
reliable.

A second, narrower table ("Major On-going Projects") repeats the top projects of
each ministry with an explicit revised-cost column; those rows are kept too since
they are the only place the portal publishes a per-project revised cost.
"""

from __future__ import annotations

import re
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pdfplumber

SNAPSHOT_RE = re.compile(r"perf_(\d{4})-(\d{2})-(\d{2})")
MONTH_NAMES = {
    "01": "January", "02": "February", "03": "March", "04": "April",
    "05": "May", "06": "June", "07": "July", "08": "August",
    "09": "September", "10": "October", "11": "November", "12": "December",
}

TOTAL_RE = re.compile(r"^total\s*\(", re.I)
CODE_RE = re.compile(r"\((\d{5,7})\)")
MAJOR_HEADER_TOKENS = ("PROJECT ID", "REVISED COST", "PHYSICAL PROGRESS")


def num(raw: str | None) -> float | None:
    """Parse the report's numbers: '1,712.00', '97', '-', 'NA', ''."""
    if raw is None:
        return None
    text = raw.replace(",", "").replace("₹", "").replace("%", "").strip()
    if text in {"", "-", "--", "NA", "N/A", "nil", "-", "()"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def date_pair(raw: str | None) -> tuple[str | None, str | None]:
    """'03/2025\\n(06/2026)' -> ('2025-03', '2026-06')."""
    parts = [p.strip() for p in (raw or "").split("\n") if p.strip()]
    if not parts:
        return None, None

    def norm(token: str) -> str | None:
        match = re.fullmatch(r"(\d{1,2})/(\d{4})", token.strip().strip("()").strip())
        if not match:
            return None
        month, year = int(match.group(1)), match.group(2)
        return f"{year}-{month:02d}" if 1 <= month <= 12 else None

    return norm(parts[0]), (norm(parts[1]) if len(parts) > 1 else None)


def split_identity(text: str) -> tuple[str, str | None, str | None]:
    """Split a project cell into (name, agency, project code)."""
    lines = [ln.strip() for ln in (text or "").split("\n") if ln.strip()]
    code = None
    match = CODE_RE.search(text or "")
    if match:
        code = match.group(1)
        lines = [ln for ln in lines if not CODE_RE.fullmatch(ln.strip())]

    agency = None
    for line in lines:
        if line.startswith("(") and line.endswith(")"):
            agency = line.strip("()").strip()
            lines = [ln for ln in lines if ln is not line]
            break

    return " ".join(lines).strip(), agency, code


def cell(row: list[str | None], index: int) -> str | None:
    return row[index] if index < len(row) else None


def cell_text(page, bbox) -> str:
    if not bbox:
        return ""
    return page.crop(bbox).extract_text(x_tolerance=1.5) or ""


def header_kind(row: list[str | None]) -> str:
    head = " ".join((c or "") for c in row).upper()
    if all(token in head for token in MAJOR_HEADER_TOKENS) and "ORIGINAL COST" in head:
        return "major"
    if "PROJECT NAME" in head and "STATE" in head:
        return "detail"
    return ""


def parse_report(pdf_path: Path, snapshot: str, ministry_names: set[str] | None = None,
                 sector_names: set[str] | None = None) -> list[dict]:
    records: list[dict] = []
    known = {name.strip().lower() for name in (ministry_names or set())}
    sectors = {name.strip().lower(): name.strip() for name in (sector_names or set())}
    ministry = sector = month_name = None

    def classify(label: str) -> None:
        nonlocal ministry, sector
        low = label.lower()
        if low in known or low.startswith(("ministry of", "department of")):
            ministry = label
        else:
            sector = label

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text() or ""
            if any(k in page_text for k in ("Ongoing Projects", "Newly Added Projects", "Completed Projects")):
                found = re.search(r"\b(" + "|".join(MONTH_NAMES.values()) + r")\s+(\d{4})\b", page_text)
                if found:
                    month_name = found.group(1)

            # Pages that hold only the narrow "major projects" table carry the
            # ministry and sector in the page heading instead of a group row.
            page_ministry = next((ln.strip() for ln in page_text.split("\n")[:4]
                                  if ln.strip().lower() in known), None)
            page_sector = next((name for low, name in sectors.items() if low in page_text.lower()), None)

            for table in page.find_tables():
                grid = table.extract()
                if not grid or not header_kind(grid[0]):
                    continue
                kind = header_kind(grid[0])
                ministry = ministry or page_ministry
                sector = sector or page_sector

                for index, row in enumerate(grid[1:], start=1):
                    sl = (cell(row, 0) or "").strip()
                    label = (cell(row, 1) or "").strip()

                    if not sl and label and (cell(row, 2) in (None, "")):
                        if not TOTAL_RE.match(label):
                            classify(label)
                        continue
                    if not sl.isdigit() or TOTAL_RE.match(label):
                        continue

                    if kind == "major":
                        name, agency, _ = split_identity(cell_text(page, table.rows[index].cells[2]))
                        record = {
                            "project_code": label or None,
                            "project_name": name,
                            "agency": agency,
                            "state": None,
                            "original_cost": num(cell(row, 3)),
                            "revised_cost": num(cell(row, 4)),
                            "expenditure": num(cell(row, 5)),
                            "physical_progress": num(cell(row, 6)),
                        }
                    else:
                        name, agency, code = split_identity(cell_text(page, table.rows[index].cells[1]))
                        cost_lines = [p for p in (cell(row, 5) or "").split("\n") if p.strip()]
                        original_cost = num(cost_lines[0] if cost_lines else None)
                        revised_cost = num(cost_lines[1] if len(cost_lines) > 1 else None)
                        approval, start = date_pair(cell(row, 3))
                        original_doc, revised_doc = date_pair(cell(row, 4))
                        record = {
                            "project_code": code,
                            "project_name": name,
                            "agency": agency,
                            "state": (cell(row, 2) or "").strip() or None,
                            "original_cost": original_cost,
                            "revised_cost": revised_cost if revised_cost else None,
                            "expenditure": num(cell(row, 6)),
                            "physical_progress": num(cell(row, 7)) if len(row) > 7 else None,
                            "approval_date": approval,
                            "start_date": start,
                            "original_doc": original_doc,
                            "revised_doc": revised_doc,
                        }

                    if not record["project_code"]:
                        continue
                    record.update({
                        "snapshot": snapshot,
                        "month_name": month_name or MONTH_NAMES.get(snapshot.split("-")[1], ""),
                        "ministry": ministry,
                        "sector": sector,
                        "source_table": kind,
                    })
                    records.append(record)
    return records


def snapshot_from_name(pdf_path: Path) -> str:
    """'perf_2026-27-04.pdf' -> '2026-04' (the April 2026 freeze month)."""
    found = SNAPSHOT_RE.search(pdf_path.name)
    if not found:
        return ""
    fy, fy_end, month = found.groups()
    year = int(fy) + (0 if int(month) >= 4 else 1)
    return f"{year}-{month}"


def parse_folder(folder: Path, ministry_names: set[str] | None = None,
                 sector_names: set[str] | None = None) -> list[dict]:
    paths = sorted(folder.glob("perf_*.pdf"))
    out: list[dict] = []
    if len(paths) == 1:
        return parse_report(paths[0], snapshot_from_name(paths[0]), ministry_names, sector_names)

    payload = [(str(p), snapshot_from_name(p), ministry_names or set(), sector_names or set()) for p in paths]
    with ProcessPoolExecutor(max_workers=min(len(paths), 5)) as pool:
        for rows in pool.map(_parse_one, payload):
            out.extend(rows)
    out.sort(key=lambda r: (r["snapshot"], str(r["project_code"])))
    return out


def _parse_one(args) -> list[dict]:
    path, snapshot, ministries, sectors = args
    rows = parse_report(Path(path), snapshot, ministries, sectors)
    detail = sum(1 for r in rows if r["source_table"] == "detail")
    print(f"  {Path(path).name}  {snapshot}  rows={len(rows)} (detail {detail})", flush=True)
    return rows
