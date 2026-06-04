"""Deduplication for scraped job rows.

Dedup key = (company.lower(), job_title.lower(), location.lower()).

On each run:
  - load jobs_master.csv (existing finds)
  - determine which freshly scraped rows are new (not already in master)
  - append new rows to master and rewrite it
  - return only today's new finds so the caller can write the daily file
"""
import os

from utils.csv_writer import read_rows, write_rows


def _key(row: dict) -> tuple:
    return (
        (row.get("company") or "").strip().lower(),
        (row.get("job_title") or "").strip().lower(),
        (row.get("location") or "").strip().lower(),
    )


def dedup_within(rows: list) -> list:
    """Remove duplicates *within* a freshly scraped batch, keeping first seen."""
    seen = set()
    unique = []
    for row in rows:
        k = _key(row)
        if k in seen:
            continue
        seen.add(k)
        unique.append(row)
    return unique


def update_master(new_rows: list, master_path: str) -> dict:
    """Merge new_rows into the master CSV.

    Returns a dict with:
      - "new":        rows that were not previously in master (today's finds)
      - "duplicates": count of scraped rows that were already in master
      - "master_count": total rows in master after the update
    """
    existing = read_rows(master_path)
    existing_keys = {_key(r) for r in existing}

    batch = dedup_within(new_rows)
    truly_new = []
    duplicates = 0
    for row in batch:
        if _key(row) in existing_keys:
            duplicates += 1
            continue
        existing_keys.add(_key(row))
        truly_new.append(row)

    if truly_new:
        # Append only the new rows; preserves existing master content.
        write_rows(master_path, truly_new, append=True)

    master_count = len(existing) + len(truly_new)
    return {
        "new": truly_new,
        "duplicates": duplicates,
        "master_count": master_count,
    }
