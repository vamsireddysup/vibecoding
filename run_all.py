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
from utils.enrich import finalize_rows
from utils import sheets

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

# Skip jobs posted more than this many days ago.
MAX_AGE_DAYS = 30

# --- Google Sheets config (runtime auth = service account) ----------------- #
# Resolution order for each value: credentials.csv "google_sheets" row, then
# environment variable, then the default below.
#   credentials.csv row: platform=google_sheets,
#     username=<path to service_account.json>,
#     career_url=<Career Pages sheet id>, notes=<Applied Jobs sheet id>
DEFAULT_SERVICE_ACCOUNT_FILE = os.environ.get(
    "GOOGLE_SERVICE_ACCOUNT_FILE", "service_account.json"
)
DEFAULT_CAREER_PAGES_SHEET_ID = sheets.DEFAULT_CAREER_PAGES_SHEET_ID
DEFAULT_APPLIED_JOBS_SHEET_ID = sheets.DEFAULT_APPLIED_JOBS_SHEET_ID

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


def resolve_sheets_config(creds: dict) -> dict:
    """Resolve service-account key path + sheet ids from credentials/env/defaults."""
    row = (creds.get("google_sheets") or [{}])[0]
    sa_file = (row.get("username") or "").strip() or DEFAULT_SERVICE_ACCOUNT_FILE
    career_id = (row.get("career_url") or "").strip() or DEFAULT_CAREER_PAGES_SHEET_ID
    applied_id = (row.get("notes") or "").strip() or DEFAULT_APPLIED_JOBS_SHEET_ID
    return {
        "service_account_file": sa_file,
        "career_pages_sheet_id": career_id,
        "applied_jobs_sheet_id": applied_id,
    }


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def run(selected=None, keywords=None, locations=None, creds=None, career_pages=None) -> list:
    creds = creds if creds is not None else load_credentials()
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
            if key == "company_careers":
                scraper = scraper_cls(creds, career_pages=career_pages)
            else:
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

    creds = load_credentials()
    cfg = resolve_sheets_config(creds)

    # Career list comes from the "Career Pages" Google Sheet (company, ats_type,
    # url); falls back to credentials.csv company_careers rows if unavailable.
    career_pages = sheets.read_career_pages(
        cfg["service_account_file"], cfg["career_pages_sheet_id"]
    )
    if career_pages:
        print(f"[runner] loaded {len(career_pages)} companies from Career Pages sheet")
    else:
        print("[runner] Career Pages sheet unavailable; using credentials.csv fallback")

    # Applied Jobs sheet -> job_ids to exclude from results.
    applied_ids = sheets.read_applied_job_ids(
        cfg["service_account_file"], cfg["applied_jobs_sheet_id"]
    )
    print(f"[runner] {len(applied_ids)} applied job_ids loaded for exclusion")

    all_rows = run(
        selected=selected, keywords=keywords, locations=locations,
        creds=creds, career_pages=career_pages or None,
    )

    # Enrich (job_id, days_since_posted, skills_required) and filter
    # (drop >30 days old; drop already-applied job_ids).
    fin = finalize_rows(all_rows, applied_ids=applied_ids, max_age_days=MAX_AGE_DAYS)
    enriched_rows = fin["rows"]

    # Deduplicate against the master and split out today's new finds.
    result = update_master(enriched_rows, MASTER_PATH)
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
    print(f"Dropped (>30 days old): {fin['dropped_old']}")
    print(f"Dropped (already applied): {fin['dropped_applied']}")
    print(f"After enrich/filter:    {len(enriched_rows)}")
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
                f"| id={r.get('job_id')} | {r.get('days_since_posted')}d "
                f"| kw={r.get('keywords_matched')} | skills={r.get('skills_required')}"
            )


if __name__ == "__main__":
    sys.exit(main())
