"""Company career-page scraper — no login required.

Company entries come from the "Career Pages" Google Sheet (columns: company,
ats_type, url). Each entry is routed by its ats_type:

  - workday    -> POST to the Workday JSON API
  - greenhouse -> GET https://boards.greenhouse.io/{company}/jobs.json
  - lever      -> GET the Lever postings JSON for that URL
  - other      -> Selenium + BeautifulSoup fallback (render then crawl links)

If the sheet is unavailable, the scraper falls back to the company_careers rows
in credentials.csv and auto-detects ats_type from each URL.

The keyword/location sweep is bypassed here (each career URL is crawled once),
so scrape_all is overridden.
"""
import datetime
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import MAX_AGE_DAYS, BaseScraper
from utils.enrich import parse_days_since_posted
from utils.matching import SEARCH_QUERIES, matches_any_token

TODAY = datetime.date.today().isoformat()

JOB_LINK_HINTS = ("job", "career", "position", "role", "opening", "requisition")


def detect_ats_type(url: str) -> str:
    """Infer ats_type from a URL (used when the sheet omits the column)."""
    host = urllib.parse.urlparse(url).netloc.lower()
    if "greenhouse.io" in host or "greenhouse" in url:
        return "greenhouse"
    if "lever.co" in host:
        return "lever"
    if "myworkdayjobs.com" in host or "workday" in host:
        return "workday"
    return "other"


class CompanyCareersScraper(BaseScraper):
    platform = "company_careers"
    requires_login = False

    def __init__(self, credentials: dict, career_pages: list = None):
        """career_pages: optional list of {company, ats_type, url} from the
        Career Pages sheet. When None, falls back to credentials.csv rows.
        """
        super().__init__(credentials)
        self.career_pages = career_pages

    # ------------------------------------------------------------------ #
    def career_entries(self) -> list:
        """Return the list of {company, ats_type, url} entries to scrape."""
        if self.career_pages:
            entries = []
            for e in self.career_pages:
                url = (e.get("url") or "").strip()
                if not url:
                    continue
                ats = (e.get("ats_type") or "").strip().lower() or detect_ats_type(url)
                entries.append({
                    "company": e.get("company", "") or self._slug(url),
                    "ats_type": ats,
                    "url": url,
                })
            return entries

        # Fallback: credentials.csv company_careers rows, auto-detect ats_type.
        entries = []
        for row in self.credentials.get(self.platform, []):
            url = (row.get("career_url") or "").strip()
            if url:
                entries.append({
                    "company": self._slug(url),
                    "ats_type": detect_ats_type(url),
                    "url": url,
                })
        return entries

    # Override the keyword sweep: crawl each career entry once, routed by ats_type.
    def scrape_all(self, keywords=None, locations=None) -> list:
        results = []
        try:
            for entry in self.career_entries():
                url, ats = entry["url"], entry["ats_type"]
                try:
                    if ats == "workday":
                        rows = self._workday(entry)
                    elif ats == "greenhouse":
                        rows = self._greenhouse(entry)
                    elif ats == "lever":
                        rows = self._lever(entry)
                    else:
                        rows = self._other(entry)
                    results.extend(rows)
                    print(f"[company_careers] ({ats}) {url}: {len(rows)} rows")
                except Exception as exc:  # noqa: BLE001
                    print(f"[company_careers] error ({ats}) {url}: {exc}")
                self.polite_sleep()
        finally:
            self.quit_driver()
        return results

    # ------------------------------------------------------------------ #
    # ATS handlers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _is_old(date_posted: str) -> bool:
        """True if a posting date parses to more than MAX_AGE_DAYS ago."""
        days = parse_days_since_posted(date_posted)
        return isinstance(days, int) and days > MAX_AGE_DAYS

    @staticmethod
    def _slug(url: str) -> str:
        path = urllib.parse.urlparse(url).path.strip("/").split("/")
        return path[0] if path and path[0] else urllib.parse.urlparse(url).netloc

    def _greenhouse(self, entry: dict) -> list:
        company = self._slug(entry["url"])
        name = entry.get("company") or company
        api = f"https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true"
        data = self.fetch(api).json()
        rows = []
        for job in data.get("jobs", []):
            title = job.get("title", "")
            location = (job.get("location") or {}).get("name", "")
            content = BeautifulSoup(job.get("content", "") or "", "lxml").get_text(" ", strip=True)
            snippet = content[:300]
            matched = matches_any_token(title, snippet)
            if not matched:
                continue
            rows.append(self._row(
                name, title, location, job.get("absolute_url", ""), snippet, matched,
                date_posted=job.get("updated_at", "") or job.get("first_published", ""),
            ))
        return rows

    def _lever(self, entry: dict) -> list:
        company = self._slug(entry["url"])
        name = entry.get("company") or company
        api = f"https://api.lever.co/v0/postings/{company}?mode=json"
        data = self.fetch(api).json()
        rows = []
        for job in data:
            title = job.get("text", "")
            location = (job.get("categories") or {}).get("location", "")
            snippet = BeautifulSoup(
                job.get("descriptionPlain", "") or job.get("description", "") or "", "lxml"
            ).get_text(" ", strip=True)[:300]
            matched = matches_any_token(title, snippet)
            if not matched:
                continue
            rows.append(self._row(
                name, title, location, job.get("hostedUrl", ""), snippet, matched,
                date_posted=job.get("createdAt", ""),
            ))
        return rows

    def _workday(self, entry: dict) -> list:
        """Workday JSON API at /wday/cxs/{tenant}/{site}/jobs (POST)."""
        url = entry["url"]
        name = entry.get("company", "")
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc  # e.g. nvidia.wd5.myworkdayjobs.com
        tenant = host.split(".")[0]
        path_parts = [p for p in parsed.path.split("/") if p]
        site = path_parts[-1] if path_parts else tenant
        api = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"

        limit = 20
        rows = []
        for query in SEARCH_QUERIES:
            # Page by incrementing offset; stop on total<=offset, empty page,
            # a >30-day-old posting, or the MAX_PAGES cap.
            offset = 0
            for page in range(1, self.MAX_PAGES + 1):
                payload = {"appliedFacets": {}, "limit": limit, "offset": offset,
                           "searchText": query}
                try:
                    resp = self.session.post(
                        api, json=payload,
                        headers={"Accept": "application/json", "Content-Type": "application/json"},
                        timeout=20,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                except Exception:
                    break
                postings = data.get("jobPostings", []) or []
                if not postings:  # stop 1
                    break
                page_old = False
                for job in postings:
                    title = job.get("title", "")
                    location = job.get("locationsText", "")
                    external = job.get("externalPath", "")
                    job_url = f"https://{host}{external}" if external else url
                    bullets = job.get("bulletFields", [])
                    snippet = " ".join(bullets) if isinstance(bullets, list) else str(bullets)
                    posted = job.get("postedOn", "")
                    if not page_old and self._is_old(posted):
                        page_old = True
                    matched = matches_any_token(title, snippet)
                    if not matched:
                        continue
                    rows.append(self._row(
                        name or tenant, title, location, job_url, snippet[:300], matched,
                        date_posted=posted,
                    ))
                print(f"company_careers — keyword {query} — page {page} — "
                      f"{len(rows)} jobs found so far ({name or tenant})")
                offset += limit
                total = data.get("total", 0)
                if total and total <= offset:  # stop: Workday total reached
                    break
                if page_old:  # stop 2
                    break
                self.polite_sleep(2, 4)
        return rows

    def _other(self, entry: dict) -> list:
        """Generic career page: Selenium + BeautifulSoup fallback.

        Renders the page with undetected_chromedriver (to execute JS-driven
        listings) and discovers job links from the rendered DOM. If the browser
        is unavailable, falls back to a plain requests fetch.
        """
        url = entry["url"]
        html = ""
        try:
            driver = self.init_driver(headless=True)
            driver.get(url)
            self.polite_sleep(3, 6)
            try:
                driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                self.polite_sleep(2, 4)
            except Exception:
                pass
            html = driver.page_source
        except Exception as exc:  # noqa: BLE001
            print(f"[company_careers] Selenium unavailable for {url} ({exc}); using requests")
            try:
                html = self.fetch(url).text
            except Exception as exc2:  # noqa: BLE001
                print(f"[company_careers] requests fallback failed for {url}: {exc2}")
                return []
        return self._parse_links(html, url, entry.get("company", ""))

    def _parse_links(self, html: str, base_url: str, name: str) -> list:
        soup = BeautifulSoup(html, "lxml")
        company = name or urllib.parse.urlparse(base_url).netloc.replace("www.", "").split(".")[0]
        rows = []
        seen = set()
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(" ", strip=True)
            blob = (href + " " + text).lower()
            if not any(h in blob for h in JOB_LINK_HINTS):
                continue
            if not text or len(text) < 4:
                continue
            matched = matches_any_token(text, "")
            if not matched:
                continue
            full = urllib.parse.urljoin(base_url, href)
            if full in seen:
                continue
            seen.add(full)
            rows.append(self._row(company, text, "", full, "", matched))
        return rows

    # ------------------------------------------------------------------ #
    def _row(self, company, title, location, url, snippet, matched, date_posted="") -> dict:
        return {
            "date_scraped": TODAY,
            "platform": self.platform,
            "company": company,
            "job_title": title,
            "location": location,
            "job_type": "full-time",
            "experience_required": "",
            "url": url,
            "date_posted": date_posted,
            "description_snippet": snippet,
            "easy_apply": "",
            "keywords_matched": matched,
        }
