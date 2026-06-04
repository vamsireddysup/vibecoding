"""CSV writing utilities for the job scraper.

All scrapers emit dicts using the canonical output schema defined here.
csv_writer normalizes rows (fills missing columns, drops extras) and writes
the daily file plus the running master file.
"""
import csv
import os

# The exact column order every output CSV uses.
OUTPUT_COLUMNS = [
    "date_scraped",
    "platform",
    "company",
    "job_title",
    "location",
    "job_type",
    "experience_required",
    "url",
    "date_posted",
    "description_snippet",
    "easy_apply",
    "keywords_matched",
]


def normalize_row(row: dict) -> dict:
    """Return a dict containing exactly OUTPUT_COLUMNS keys.

    Missing keys are filled with "". List values (e.g. keywords_matched) are
    joined with commas. Everything else is stringified and trimmed.
    """
    out = {}
    for col in OUTPUT_COLUMNS:
        val = row.get(col, "")
        if isinstance(val, (list, tuple)):
            val = ", ".join(str(v) for v in val)
        if val is None:
            val = ""
        out[col] = str(val).replace("\r", " ").replace("\n", " ").strip()
    return out


def write_rows(path: str, rows: list, append: bool = False) -> int:
    """Write rows (list of dicts) to ``path`` as CSV with the canonical schema.

    Returns the number of rows written. When ``append`` is True and the file
    already exists, rows are appended without rewriting the header.
    """
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    file_exists = os.path.exists(path) and os.path.getsize(path) > 0
    mode = "a" if append and file_exists else "w"
    with open(path, mode, newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS)
        if mode == "w" or not file_exists:
            writer.writeheader()
        for row in rows:
            writer.writerow(normalize_row(row))
    return len(rows)


def read_rows(path: str) -> list:
    """Read a CSV file written by write_rows into a list of dicts.

    Returns an empty list if the file does not exist.
    """
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))
