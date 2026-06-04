# Job Scraper — Hardware / Verification / ASIC / FPGA Roles

A Python job scraper that runs nightly, sweeps multiple job platforms and
company career pages for full-time and new-grad hardware roles (ASIC/FPGA
verification, RTL design, physical design, DFT, formal verification,
emulation, post-silicon validation), filters by relevance, deduplicates, and
saves results to CSV.

> **Legal notice:** This tool is for **personal job-search use only**. Several
> target sites (LinkedIn, Glassdoor, etc.) prohibit automated scraping in their
> Terms of Service. Use responsibly, respect rate limits, and do not
> redistribute scraped data.

## What it does

- Submits broad search queries (e.g. "ASIC verification engineer") to each
  platform.
- After fetching, filters each job by matching its title + description against a
  list of hardware/verification tokens (UVM, SystemVerilog, DFT, formal, RTL,
  FPGA, physical design, ...). A match on **any** token qualifies the job.
- Writes two outputs under `jobs_output/`:
  - `jobs_YYYY-MM-DD.csv` — today's **new** finds.
  - `jobs_master.csv` — the deduplicated running master list.

### Platforms

LinkedIn, Indeed, Glassdoor, Dice, ZipRecruiter, Handshake, Jobright, plus any
number of company career pages (with native support for Greenhouse, Lever, and
Workday ATS endpoints).

## Setup

```bash
pip install -r requirements.txt
cp credentials_template.csv credentials.csv   # then edit credentials.csv
```

Login-required scrapers (LinkedIn, Glassdoor, Handshake) use
`undetected_chromedriver`, which needs Google Chrome / Chromium installed. The
no-login scrapers (Dice, Indeed, ZipRecruiter, Jobright, company pages) only
need the Python packages.

Fill in `credentials.csv` (gitignored — never commit it). Format:

```
platform,username,password,career_url,notes
```

Leave username/password blank for no-login platforms.

## How to run

```bash
python run_all.py                    # run every scraper
python run_all.py --only dice,indeed # run a subset (no login needed)
python run_all.py --test             # quick no-login smoke test
python run_all.py --list             # list available scraper keys
```

## Output schema

Every row uses these exact columns:

```
date_scraped, job_id, platform, company, job_title, location, job_type,
experience_required, url, date_posted, days_since_posted, description_snippet,
easy_apply, keywords_matched, skills_required
```

- `job_id` — stable per-platform id (e.g. `linkedin:3856712345`,
  `company_careers:8437000002`), with a deterministic hash fallback. Used for
  the Applied Jobs exclusion.
- `days_since_posted` — integer days from `date_posted` to today (blank if the
  posting date couldn't be parsed).
- `keywords_matched` — comma-separated MATCH_TOKENS that qualified the job.
- `skills_required` — comma-separated skills parsed from the title + description.

### Filtering
- Jobs posted **more than 30 days ago** are skipped.
- Jobs whose `job_id` appears in the **Applied Jobs** sheet are skipped.

## Google Sheets integration

The company list and the applied-jobs exclusion list are read at runtime from
two sheets in your Drive **Job Search/** folder:

| Sheet | Columns | Purpose |
|-------|---------|---------|
| **Career Pages** | `company, ats_type, url` | companies to scrape + how to route them |
| **Applied Jobs** | `job_id` (+ any notes columns) | job_ids to exclude |

`ats_type` routes each company to the right scraper:

- `workday` → POST to the Workday JSON API
- `greenhouse` → `https://boards.greenhouse.io/{company}/jobs.json`
- `lever` → the Lever postings JSON
- `other` → Selenium + BeautifulSoup fallback (renders the page, crawls job links)

A blank `ats_type` is auto-detected from the URL.

### Runtime auth — service account

The nightly cron job runs standalone, so it authenticates with a Google
**service account** (not an interactive login):

1. In Google Cloud, create a service account, enable the **Google Sheets API**
   and **Google Drive API**, and download its JSON key as `service_account.json`
   in the project root (gitignored).
2. Share both sheets with the service account's `client_email` (Viewer is enough).
3. Tell the scraper where the key + sheets are. Either:
   - add a `google_sheets` row to `credentials.csv`:
     ```
     google_sheets,<path/to/service_account.json>,,<Career Pages sheet id>,<Applied Jobs sheet id>
     ```
     (`username`=key path, `career_url`=Career Pages id, `notes`=Applied Jobs id), or
   - set `GOOGLE_SERVICE_ACCOUNT_FILE` env var; sheet ids fall back to the
     defaults baked into `utils/sheets.py`.

If the key or `gspread` is missing, the scraper prints a warning and falls back
to the `company_careers` rows in `credentials.csv` (no applied-jobs exclusion).

## Add a new company career page

Add a row to the **Career Pages** Google Sheet: `company, ats_type, url`
(leave `ats_type` blank to auto-detect, or set `workday`/`greenhouse`/`lever`/`other`).

If you're not using Google Sheets, add a fallback row to `credentials.csv`:

```
company_careers,,,https://boards.greenhouse.io/yourcompany,No login
```

The scraper auto-detects Greenhouse / Lever / Workday URLs and uses their
structured endpoints; any other URL is crawled with Selenium + BeautifulSoup.

## Add / tune search keywords

- **Search queries** (submitted to each site's search bar): edit
  `SEARCH_QUERIES` in `utils/matching.py`.
- **Match tokens** (used to qualify a fetched job): edit `MATCH_TOKENS` in
  `utils/matching.py`.

Both are re-exported from `run_all.py` for convenience.

## Nightly cron

```bash
bash cron_setup.sh
```

Installs a crontab entry that runs the scraper every night at 11 PM and logs to
`logs/scraper.log`.

## Project layout

```
job-scraper/
├── CLAUDE.md                 # project context for future sessions
├── run_all.py                # master runner + config
├── credentials_template.csv  # committed template (no secrets)
├── credentials.csv           # your copy (gitignored)
├── cron_setup.sh
├── scrapers/                 # one module per platform + base class
├── utils/                    # matching, dedup, csv_writer
└── jobs_output/              # generated CSVs (gitignored)
```

See `CLAUDE.md` for full project context.
