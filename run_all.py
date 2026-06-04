#!/usr/bin/env python3
"""Master runner for the job scraper.

Pipeline:
  1. Load credentials from credentials.csv
  2. Run all scrapers in sequence (each wrapped in try/except so one failure
     does not stop the others)
  3. Combine all results
  4. Deduplicate against jobs_output/jobs_master.csv
  5. Write the daily CSV (today's new finds) + update the master CSV
  6. Print a summary

Usage:
  python run_all.py                 # run every scraper
  python run_all.py --only dice,indeed   # run a subset (test no-login sources)
  python run_all.py --list          # list available scraper keys
"""
import argparse
import csv
import datetime
import os
import sys

from utils.csv_writer import write_rows
from utils.deduplicator import update_master

# Re-export the search/match config so the runner is the single discoverable
# place for tuning, while the canonical definitions live in utils/matching.py
# (importable by scrapers without a circular dependency).
from utils.matching import (  # noqa: F401
    MATCH_TOKENS,
    SEARCH_QUERIES,
    matches_any_token,
)

# Scraper imports.
from scrapers.linkedin_scraper import LinkedInScraper
from scrapers.indeed_scraper import IndeedScraper
from scrapers.glassdoor_scraper import GlassdoorScraper
from scrapers.dice_scraper import DiceScraper
from scrapers.ziprecruiter_scraper import ZipRecruiterScraper
from scrapers.handshake_scraper import HandshakeScraper
from scrapers.jobright_scraper import JobrightScraper
from scrapers.company_careers_scraper import CompanyCareersScraper

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
# The broad queries submitted to each job site's search bar live in
# utils/matching.py as SEARCH_QUERIES (imported above). Kept here as the
# canonical search list used by scrape_all sweeps.
SEARCH_KEYWORDS = SEARCH_QUERIES

LOCATIONS = [
    "United States",
    "Remote",
    "San Jose CA",
    "Santa Clara CA",
    "Austin TX",
    "Portland OR",
    "Seattle WA",
    "San Diego CA",
    "Boise ID",
    "Raleigh NC",
    "Boston MA",
]

JOB_TYPES = ["full-time", "new grad", "entry level"]
EXPERIENCE_YEARS_MAX = 5

# For the no-login smoke test we keep the sweep small and fast.
TEST_KEYWORDS = ["UVM verification"]
TEST_LOCATIONS = ["United States"]

OUTPUT_DIR = "jobs_output"
MASTER_PATH = os.path.join(OUTPUT_DIR, "jobs_master.csv")

# Registry of all scrapers keyed by platform name.
SCRAPER_REGISTRY = {
    "dice": DiceScraper,
    "indeed": IndeedScraper,
    "ziprecruiter": ZipRecruiterScraper,
    "jobright": JobrightScraper,
    "company_careers": CompanyCareersScraper,
    "linkedin": LinkedInScraper,
    "glassdoor": GlassdoorScraper,
    "handshake": HandshakeScraper,
}


# --------------------------------------------------------------------------- #
# Credentials
# --------------------------------------------------------------------------- #
def load_credentials(path="credentials.csv") -> dict:
    creds = {}
    if not os.path.exists(path):
        print(
            f"WARNING: {path} not found. Copy credentials_template.csv to "
            "credentials.csv and fill in your details."
        )
        return creds
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            platform = (row.get("platform") or "").strip().lower()
            if not platform:
                continue
            creds.setdefault(platform, []).append(row)
    return creds


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def run(selected=None, keywords=None, locations=None) -> list:
    creds = load_credentials()
    keywords = keywords or SEARCH_KEYWORDS
    locations = locations or LOCATIONS

    selected = selected or list(SCRAPER_REGISTRY.keys())
    all_rows = []
    for key in selected:
        scraper_cls = SCRAPER_REGISTRY.get(key)
        if scraper_cls is None:
            print(f"[runner] unknown scraper '{key}', skipping")
            continue
        print(f"\n=== Running {key} ===")
        try:
            scraper = scraper_cls(creds)
            rows = scraper.scrape_all(keywords, locations)
            print(f"[runner] {key}: {len(rows)} rows collected")
            all_rows.extend(rows)
        except Exception as exc:  # noqa: BLE001
            print(f"[runner] {key} failed entirely: {exc}")
    return all_rows


def main():
    parser = argparse.ArgumentParser(description="Nightly hardware/verification job scraper")
    parser.add_argument(
        "--only",
        help="Comma-separated scraper keys to run (e.g. dice,indeed). Default: all.",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Run a small no-login smoke test (dice,indeed; 'UVM verification' / US).",
    )
    parser.add_argument("--list", action="store_true", help="List scraper keys and exit.")
    args = parser.parse_args()

    if args.list:
        print("Available scrapers:")
        for key in SCRAPER_REGISTRY:
            print(f"  - {key}")
        return

    if args.test:
        selected = ["dice", "indeed"]
        keywords, locations = TEST_KEYWORDS, TEST_LOCATIONS
    else:
        selected = args.only.split(",") if args.only else None
        keywords = locations = None

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    all_rows = run(selected=selected, keywords=keywords, locations=locations)

    # Deduplicate against the master and split out today's new finds.
    result = update_master(all_rows, MASTER_PATH)
    new_rows = result["new"]

    today = datetime.date.today().isoformat()
    daily_path = os.path.join(OUTPUT_DIR, f"jobs_{today}.csv")
    write_rows(daily_path, new_rows)

    # Summary.
    platforms = sorted({r.get("platform", "") for r in all_rows if r.get("platform")})
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Scraped rows (raw):     {len(all_rows)}")
    print(f"New jobs (this run):    {len(new_rows)}")
    print(f"Duplicates skipped:     {result['duplicates']}")
    print(f"Master total:           {result['master_count']}")
    print(f"Platforms with results: {len(platforms)} -> {', '.join(platforms) or '(none)'}")
    print(f"Daily file:             {daily_path}")
    print(f"Master file:            {MASTER_PATH}")

    # Print first 5 rows of today's output for quick inspection.
    if new_rows:
        print("\nFirst 5 new rows:")
        for r in new_rows[:5]:
            print(
                f"  [{r.get('platform')}] {r.get('job_title')} @ "
                f"{r.get('company')} ({r.get('location')}) "
                f"-> {r.get('keywords_matched')}"
            )


if __name__ == "__main__":
    sys.exit(main())
