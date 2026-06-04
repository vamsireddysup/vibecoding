"""Company career-page scraper — no login required.

Reads every credentials row where platform == "company_careers" and scrapes the
given career_url. Known ATS platforms are detected from the URL and handled via
their structured endpoints; everything else falls back to generic HTML link
discovery.

Known ATS patterns:
  - Greenhouse: https://boards.greenhouse.io/{company}/jobs.json
  - Lever:      https://api.lever.co/v0/postings/{company}?mode=json
  - Workday:    {base}/wday/cxs/{tenant}/{site}/jobs  (POST JSON)

Generic fallback:
  - Find <a> tags whose text/href hint at jobs ("job", "career", "position",
    "role", "opening"), then keep those whose title matches our tokens.

This scraper ignores the keyword/location sweep (it crawls each career_url
once) by overriding scrape_all.
"""
import datetime
import json
import re
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import SEARCH_QUERIES, matches_any_token

TODAY = datetime.date.today().isoformat()

JOB_LINK_HINTS = ("job", "career", "position", "role", "opening", "requisition")


class CompanyCareersScraper(BaseScraper):
    platform = "company_careers"
    requires_login = False

    def career_urls(self) -> list:
        rows = self.credentials.get(self.platform, [])
        urls = []
        for row in rows:
            url = (row.get("career_url") or "").strip()
            if url:
                urls.append(url)
        return urls

    # Override the keyword sweep: crawl each career URL once.
    def scrape_all(self, keywords=None, locations=None) -> list:
        results = []
        for url in self.career_urls():
            try:
                rows = self.scrape_career_url(url)
                results.extend(rows)
                print(f"[company_careers] {url}: {len(rows)} rows")
            except Exception as exc:  # noqa: BLE001
                print(f"[company_careers] error {url}: {exc}")
            self.polite_sleep()
        return results

    def scrape_career_url(self, url: str) -> list:
        host = urllib.parse.urlparse(url).netloc.lower()
        if "greenhouse.io" in host or "greenhouse" in url:
            return self._greenhouse(url)
        if "lever.co" in host:
            return self._lever(url)
        if "myworkdayjobs.com" in host or "workday" in host:
            return self._workday(url)
        return self._generic(url)

    # ------------------------------------------------------------------ #
    # ATS handlers
    # ------------------------------------------------------------------ #
    def _company_slug(self, url: str) -> str:
        path = urllib.parse.urlparse(url).path.strip("/").split("/")
        return path[0] if path and path[0] else ""

    def _greenhouse(self, url: str) -> list:
        company = self._company_slug(url)
        api = f"https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true"
        resp = self.fetch(api)
        data = resp.json()
        rows = []
        for job in data.get("jobs", []):
            title = job.get("title", "")
            location = (job.get("location") or {}).get("name", "")
            content = BeautifulSoup(job.get("content", "") or "", "lxml").get_text(" ", strip=True)
            snippet = content[:300]
            matched = matches_any_token(title, snippet)
            if not matched:
                continue
            rows.append(self._row(company, title, location, job.get("absolute_url", ""), snippet, matched))
        return rows

    def _lever(self, url: str) -> list:
        company = self._company_slug(url)
        api = f"https://api.lever.co/v0/postings/{company}?mode=json"
        resp = self.fetch(api)
        data = resp.json()
        rows = []
        for job in data:
            title = job.get("text", "")
            location = (job.get("categories") or {}).get("location", "")
            snippet = BeautifulSoup(job.get("descriptionPlain", "") or job.get("description", "") or "", "lxml").get_text(" ", strip=True)[:300]
            matched = matches_any_token(title, snippet)
            if not matched:
                continue
            rows.append(self._row(company, title, location, job.get("hostedUrl", ""), snippet, matched))
        return rows

    def _workday(self, url: str) -> list:
        """Workday exposes a JSON search endpoint at /wday/cxs/{tenant}/{site}/jobs.

        We derive the tenant/site from the public career site URL and POST a
        search for each of our broad queries.
        """
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc  # e.g. nvidia.wd5.myworkdayjobs.com
        tenant = host.split(".")[0]  # e.g. nvidia
        # The site id is the first path segment of the external career site.
        path_parts = [p for p in parsed.path.split("/") if p]
        site = path_parts[-1] if path_parts else tenant
        api = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"

        rows = []
        for query in SEARCH_QUERIES:
            payload = {
                "appliedFacets": {},
                "limit": 20,
                "offset": 0,
                "searchText": query,
            }
            try:
                resp = self.session.post(
                    api,
                    json=payload,
                    headers={"Accept": "application/json", "Content-Type": "application/json"},
                    timeout=20,
                )
                resp.raise_for_status()
                data = resp.json()
            except Exception:
                continue
            for job in data.get("jobPostings", []):
                title = job.get("title", "")
                location = job.get("locationsText", "")
                external = job.get("externalPath", "")
                job_url = f"https://{host}{external}" if external else url
                snippet = job.get("bulletFields", [""])
                snippet = " ".join(snippet) if isinstance(snippet, list) else str(snippet)
                matched = matches_any_token(title, snippet)
                if not matched:
                    continue
                rows.append(self._row(tenant, title, location, job_url, snippet[:300], matched))
            self.polite_sleep(1, 3)
        return rows

    def _generic(self, url: str) -> list:
        """Generic HTML crawl: discover job links and match by anchor text."""
        resp = self.fetch(url)
        soup = BeautifulSoup(resp.text, "lxml")
        company = urllib.parse.urlparse(url).netloc.replace("www.", "").split(".")[0]
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
            full = urllib.parse.urljoin(url, href)
            if full in seen:
                continue
            seen.add(full)
            rows.append(self._row(company, text, "", full, "", matched))
        return rows

    # ------------------------------------------------------------------ #
    def _row(self, company, title, location, url, snippet, matched) -> dict:
        return {
            "date_scraped": TODAY,
            "platform": self.platform,
            "company": company,
            "job_title": title,
            "location": location,
            "job_type": "full-time",
            "experience_required": "",
            "url": url,
            "date_posted": "",
            "description_snippet": snippet,
            "easy_apply": "",
            "keywords_matched": matched,
        }
