"""Google Sheets access for the scraper (runtime).

Reads two sheets in the "Job Search" Drive folder:
  - Career Pages : columns company, ats_type, url
  - Applied Jobs : a job_id column whose values are excluded from results

Authentication uses a Google **service account** JSON key (chosen runtime auth
method). The nightly cron job runs standalone — it cannot use any interactive
Google session — so the service account is the portable way in:

  1. Create a service account in Google Cloud, enable the Sheets + Drive APIs,
     download its JSON key.
  2. Share both sheets with the service account's client_email (Viewer is enough).
  3. Point the scraper at the key file (see run_all.py config / credentials.csv
     google_sheets row, or the GOOGLE_SERVICE_ACCOUNT_FILE env var).

Every function degrades gracefully: if gspread/google-auth aren't installed, the
key file is missing, or a sheet can't be opened, a warning is printed and an
empty result is returned so the scrape still runs.
"""
import os

# Sheets live in the "Job Search" folder of the candidate's Drive.
DEFAULT_CAREER_PAGES_SHEET_ID = "1juHBypajEDruUA_OL2oXR-kXv9XoN2flRfx_I06EIGI"
DEFAULT_APPLIED_JOBS_SHEET_ID = "1x0pTuDrsqnINicLCq6wcH-ZmEpKXtyNvKvt6QKqH_IQ"

_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]


def _client(service_account_file: str):
    """Return an authorized gspread client, or None if unavailable."""
    if not service_account_file or not os.path.exists(service_account_file):
        print(
            f"[sheets] service account key not found at "
            f"'{service_account_file}'. Skipping Google Sheets; using local "
            "fallbacks. See README for setup."
        )
        return None
    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        print("[sheets] gspread / google-auth not installed; skipping Google Sheets.")
        return None
    try:
        creds = Credentials.from_service_account_file(service_account_file, scopes=_SCOPES)
        return gspread.authorize(creds)
    except Exception as exc:  # noqa: BLE001
        print(f"[sheets] failed to authorize service account: {exc}")
        return None


def _open_records(client, sheet_id: str) -> list:
    """Open a sheet by id and return its first worksheet as list-of-dicts."""
    if client is None:
        return []
    try:
        ws = client.open_by_key(sheet_id).sheet1
        return ws.get_all_records()  # header row -> dict keys
    except Exception as exc:  # noqa: BLE001
        print(f"[sheets] could not read sheet {sheet_id}: {exc}")
        return []


def read_career_pages(service_account_file: str, sheet_id: str = None) -> list:
    """Return a list of {company, ats_type, url} dicts from Career Pages.

    Column names are matched case-insensitively. ats_type defaults to "other"
    when blank/missing. Returns [] when the sheet can't be read (caller should
    fall back to credentials.csv).
    """
    sheet_id = sheet_id or DEFAULT_CAREER_PAGES_SHEET_ID
    client = _client(service_account_file)
    records = _open_records(client, sheet_id)
    out = []
    for rec in records:
        norm = {str(k).strip().lower(): (str(v).strip() if v is not None else "")
                for k, v in rec.items()}
        url = norm.get("url") or norm.get("website link") or norm.get("career_url")
        if not url:
            continue
        out.append({
            "company": norm.get("company") or norm.get("company name") or "",
            "ats_type": (norm.get("ats_type") or norm.get("ats type") or "other").lower(),
            "url": url,
        })
    return out


def read_applied_job_ids(service_account_file: str, sheet_id: str = None) -> set:
    """Return a set of job_id strings from the Applied Jobs sheet.

    Returns an empty set when the sheet can't be read or has no rows (the
    exclusion feature is then a no-op).
    """
    sheet_id = sheet_id or DEFAULT_APPLIED_JOBS_SHEET_ID
    client = _client(service_account_file)
    records = _open_records(client, sheet_id)
    ids = set()
    for rec in records:
        for k, v in rec.items():
            if str(k).strip().lower() == "job_id" and v not in (None, ""):
                ids.add(str(v).strip())
    return ids
