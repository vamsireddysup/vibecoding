"""Dice scraper — no login required.

Dice exposes a structured search API (Algolia-backed) used by its frontend.
We try the public search API first; if its shape changes we fall back to
parsing the embedded JSON / HTML of the standard search results page.

Dice is tech-focused and tends to be a strong source for ASIC/FPGA/hardware
verification roles.
"""
import datetime
import json
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import matches_any_token

TODAY = datetime.date.today().isoformat()


class DiceScraper(BaseScraper):
    platform = "dice"
    requires_login = False

    # Public search API the Dice web app calls.
    API_URL = "https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search"

    def search(self, keyword: str, location: str, page: int = 1):
        params = {
            "q": keyword,
            "locationPrecision": "City",
            "radius": "30",
            "radiusUnit": "mi",
            "page": str(page),
            "pageSize": "20",
            "filters.postedDate": "ONE_WEEK",
            "filters.employmentType": "FULLTIME",
            "fields": (
                "id,title,companyName,jobLocation,postedDate,detailsPageUrl,"
                "summary,employmentType,easyApply"
            ),
        }
        if location and location.lower() not in ("united states", "remote"):
            params["location"] = location

        # Try the JSON API first.
        try:
            url = self.API_URL + "?" + urllib.parse.urlencode(params)
            resp = self.fetch(
                url,
                headers={
                    "x-api-key": "1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WLChIZ7",
                    "Accept": "application/json",
                },
            )
            return ("json", resp.json())
        except Exception:
            # Fall back to scraping the HTML search page.
            q = urllib.parse.quote_plus(keyword)
            loc = urllib.parse.quote_plus(location)
            html_url = (
                f"https://www.dice.com/jobs?q={q}&location={loc}"
                f"&radius=30&radiusUnit=mi&page={page}&pageSize=20"
                "&filters.postedDate=ONE_WEEK&filters.employmentType=FULLTIME"
            )
            resp = self.fetch(html_url)
            return ("html", resp.text)

    def parse_results(self, raw) -> list:
        kind, payload = raw
        if kind == "json":
            return self._parse_json(payload)
        return self._parse_html(payload)

    def _parse_json(self, payload: dict) -> list:
        rows = []
        for job in payload.get("data", []) or []:
            title = job.get("title", "")
            company = job.get("companyName", "")
            location = job.get("jobLocation", {})
            if isinstance(location, dict):
                location = location.get("displayName") or location.get("name") or ""
            snippet = (job.get("summary") or "")[:300]
            matched = matches_any_token(title, snippet)
            if not matched:
                continue
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": company,
                "job_title": title,
                "location": location,
                "job_type": job.get("employmentType", "") or "full-time",
                "experience_required": "",
                "url": job.get("detailsPageUrl", ""),
                "date_posted": job.get("postedDate", ""),
                "description_snippet": snippet,
                "easy_apply": job.get("easyApply", ""),
                "keywords_matched": matched,
            })
        return rows

    def _parse_html(self, html: str) -> list:
        rows = []
        soup = BeautifulSoup(html, "lxml")

        # Attempt to read the embedded Next.js / app state if present.
        for script in soup.find_all("script"):
            text = script.string or ""
            if "detailsPageUrl" in text and "{" in text:
                start = text.find("{")
                try:
                    data = json.loads(text[start:])
                    jobs = self._dig_jobs(data)
                    if jobs:
                        return self._parse_json({"data": jobs})
                except Exception:
                    pass

        # Plain HTML fallback: dice search result cards.
        cards = soup.select("[data-cy='card-title-link'], a.card-title-link")
        for card in cards:
            title = card.get_text(strip=True)
            url = card.get("href", "")
            matched = matches_any_token(title, "")
            if not matched:
                continue
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": "",
                "job_title": title,
                "location": "",
                "job_type": "full-time",
                "experience_required": "",
                "url": url,
                "date_posted": "",
                "description_snippet": "",
                "easy_apply": "",
                "keywords_matched": matched,
            })
        return rows

    @staticmethod
    def _dig_jobs(data):
        """Recursively look for a list of job dicts containing detailsPageUrl."""
        found = []

        def walk(node):
            if isinstance(node, dict):
                if "detailsPageUrl" in node and "title" in node:
                    found.append(node)
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(data)
        return found
