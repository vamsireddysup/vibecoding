# CLAUDE.md — Job Scraper Project Context

## What this project does
Nightly job scraper targeting hardware/verification/ASIC/FPGA full-time and new-grad roles.
Saves deduplicated results to CSV. Reads credentials from credentials.csv (gitignored).

## Candidate profile
- Name: Vamsidhar Reddy Eraganeni
- Target roles: Design Verification Engineer, ASIC Verification, RTL Design, Physical Design,
  Formal Verification, Emulation Verification, DFT/Post-Silicon Validation, FPGA Verification,
  Hardware Validation, CPU/GPU Design Verification
- Experience filter: 0–5 years (new grad and early career)
- Job types: Full-time, New Grad
- Locations: US-wide + Remote
- Graduation: December 2026, M.S. ECE student, Portland State University
- Keywords: UVM, SystemVerilog, Verilog, ASIC, SoC, RTL, formal verification, FPGA,
  DFT, emulation, Veloce, VCS, Verdi, AXI, cache coherence, DDR, physical design,
  Synopsys, Cadence, Intel, AMD, Qualcomm, Apple, NVIDIA, Arm, Marvell, Broadcom

## Platforms targeted
LinkedIn, Indeed, Glassdoor, Dice, ZipRecruiter, Handshake, Jobright, plus company career pages

## Credential system
All login credentials stored in credentials.csv (gitignored). Format:
platform, username, password, career_url, notes
Scraper reads this file at runtime — never hardcode credentials in Python files.

## Output
jobs_output/jobs_YYYY-MM-DD.csv — new file each run (today's new finds)
jobs_output/jobs_master.csv — deduplicated running master list

## Output CSV schema (exact column order)
date_scraped, job_id, platform, company, job_title, location, job_type,
experience_required, url, date_posted, days_since_posted, description_snippet,
easy_apply, keywords_matched, skills_required
- job_id: stable per-platform id (utils/enrich.py extract_job_id); namespaced
  as "{platform}:{id}", hash fallback when no id can be parsed.
- days_since_posted: integer days from date_posted to today ("" if unknown).
- skills_required: comma-separated skills parsed from title+description
  (utils/enrich.py SKILL_TOKENS / extract_skills).

## Google Sheets integration (runtime = service account)
- Sheets live in the Drive "Job Search" folder:
  - Career Pages (id 1juHBypajEDruUA_OL2oXR-kXv9XoN2flRfx_I06EIGI): company, ats_type, url
  - Applied Jobs (id 1x0pTuDrsqnINicLCq6wcH-ZmEpKXtyNvKvt6QKqH_IQ): job_id column
- utils/sheets.py reads them via gspread + a service-account JSON key.
- ats_type routes each company (company_careers_scraper): workday | greenhouse |
  lever | other (Selenium+BS4 fallback). Blank ats_type is auto-detected from URL.
- Config resolution (run_all.resolve_sheets_config): credentials.csv "google_sheets"
  row (username=key path, career_url=Career Pages id, notes=Applied Jobs id) ->
  env GOOGLE_SERVICE_ACCOUNT_FILE -> defaults in utils/sheets.py.
- All sheet access degrades gracefully (missing key/gspread -> warn + local fallback).

## Filtering rules (run_all -> utils/enrich.finalize_rows)
- Skip jobs posted more than 30 days ago (MAX_AGE_DAYS).
- Skip jobs whose job_id appears in the Applied Jobs sheet.

## Search / matching model
- SEARCH_QUERIES: broad queries submitted to each job site's search bar (run_all.py)
- MATCH_TOKENS: tokens checked against title + description after fetch. A match on ANY
  single token qualifies the job. Matched tokens stored in keywords_matched column.
- See `matches_any_token(title, description)` in run_all.py.

## Key files
- scrapers/base_scraper.py     ← abstract base (Selenium/UA rotation/retry/delays)
- scrapers/linkedin_scraper.py
- scrapers/indeed_scraper.py
- scrapers/glassdoor_scraper.py
- scrapers/dice_scraper.py
- scrapers/ziprecruiter_scraper.py
- scrapers/handshake_scraper.py
- scrapers/jobright_scraper.py
- scrapers/company_careers_scraper.py
- utils/deduplicator.py
- utils/csv_writer.py
- utils/matching.py    ← SEARCH_QUERIES, MATCH_TOKENS, matches_any_token
- utils/enrich.py      ← job_id, days_since_posted, skills, 30-day + applied filters
- utils/sheets.py      ← Google Sheets (service account) reader
- run_all.py  ← master runner (config + orchestration)
- credentials.csv  ← gitignored, user fills in
- credentials_template.csv  ← committed, shows format with no real data
- cron_setup.sh  ← sets up nightly cron job

## How to run
- pip install -r requirements.txt
- cp credentials_template.csv credentials.csv  (then fill in passwords)
- python run_all.py
- No-login test: python run_all.py --only dice,indeed
- Nightly cron: bash cron_setup.sh

## Current status (initial build — 2026-06-04)
- Initial build complete. All scrapers, utils, runner, cron, README in place.
- VERIFIED:
  - `python run_all.py --test` runs end-to-end without crashing; per-scraper
    try/except keeps one failure from stopping others; summary + daily CSV written.
  - Dedup unit-tested: within-batch dups removed; re-running does NOT double the
    master count.
  - Output CSV columns match the canonical schema exactly.
  - Greenhouse ATS handler verified LIVE (boards.greenhouse.io) — real jobs fetched,
    token-matched, and emitted as schema-correct rows.
- KNOWN RUNTIME ISSUES (site-side, not code bugs):
  - Indeed returns HTTP 403 from datacenter IPs (anti-bot). Works better from a
    residential IP / logged-in browser.
  - Dice's public search API may return 0 rows or rotate its api-key; HTML fallback
    is in place.
- Login-required scrapers (LinkedIn/Glassdoor/Handshake) are best-effort and depend on
  site DOM + SSO flows, which change frequently and may need selector updates. They
  require Chrome/Chromium for undetected_chromedriver.
- KNOWN LIMITATION: matching uses case-insensitive substring per spec
  (`token.lower() in text`). Short acronym tokens (SoC, RTL, CDC, DRC, LVS, AXI...)
  can false-positive inside unrelated words (e.g. "SoC" in "Associate"). Kept as
  specified; tighten to word boundaries in utils/matching.py if precision matters.
- [Update this section after each working session]
