"""Indeed scraper — no login required for basic scraping.

Indeed's HTML structure changes frequently and it employs bot detection, so we
use multiple fallback CSS selectors and parse the embedded mosaic JSON state
when available. Login (if provided) is not required and is skipped here.
"""
import datetime
import json
import re
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import matches_any_token

TODAY = datetime.date.today().isoformat()


class IndeedScraper(BaseScraper):
    platform = "indeed"
    requires_login = False

    def search(self, keyword: str, location: str):
        q = urllib.parse.quote_plus(keyword)
        loc = urllib.parse.quote_plus("" if location.lower() == "united states" else location)
        url = (
            f"https://www.indeed.com/jobs?q={q}&l={loc}"
            "&explvl=entry_level&fromage=7"
        )
        resp = self.fetch(url)
        return resp.text

    def parse_results(self, raw) -> list:
        html = raw
        rows = self._parse_mosaic(html)
        if rows:
            return rows
        return self._parse_html(html)

    def _parse_mosaic(self, html: str) -> list:
        """Indeed embeds results in window.mosaic.providerData JSON."""
        match = re.search(
            r"_initialData\s*=\s*(\{.*?\});", html, re.DOTALL
        ) or re.search(
            r'"results":\s*(\[.*?\])\s*,\s*"', html, re.DOTALL
        )
        if not match:
            return []
        try:
            blob = match.group(1)
            data = json.loads(blob)
        except Exception:
            return []

        results = self._dig_results(data)
        rows = []
        for job in results:
            title = job.get("title") or job.get("displayTitle") or ""
            company = job.get("company") or job.get("companyName") or ""
            location = job.get("formattedLocation") or job.get("jobLocationCity") or ""
            snippet = (job.get("snippet") or job.get("jobDescription") or "")[:300]
            snippet = BeautifulSoup(snippet, "lxml").get_text(" ", strip=True)
            jk = job.get("jobkey") or job.get("jobKey") or ""
            url = f"https://www.indeed.com/viewjob?jk={jk}" if jk else ""
            matched = matches_any_token(title, snippet)
            if not matched:
                continue
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": company,
                "job_title": title,
                "location": location,
                "job_type": "full-time",
                "experience_required": "entry level",
                "url": url,
                "date_posted": job.get("formattedRelativeTime", ""),
                "description_snippet": snippet,
                "easy_apply": "",
                "keywords_matched": matched,
            })
        return rows

    def _parse_html(self, html: str) -> list:
        rows = []
        soup = BeautifulSoup(html, "lxml")
        # Multiple fallback selectors for Indeed result cards.
        cards = (
            soup.select("div.job_seen_beacon")
            or soup.select("a.tapItem")
            or soup.select("div.cardOutline")
        )
        for card in cards:
            title_el = (
                card.select_one("h2.jobTitle span[title]")
                or card.select_one("h2.jobTitle a")
                or card.select_one("[id^='jobTitle']")
            )
            title = title_el.get("title") if title_el and title_el.has_attr("title") else (
                title_el.get_text(strip=True) if title_el else ""
            )
            company_el = card.select_one(
                "span.companyName, span[data-testid='company-name'], div.company_location span"
            )
            company = company_el.get_text(strip=True) if company_el else ""
            loc_el = card.select_one(
                "div.companyLocation, div[data-testid='text-location']"
            )
            location = loc_el.get_text(strip=True) if loc_el else ""
            snip_el = card.select_one("div.job-snippet, [class*='jobCardShelfContainer']")
            snippet = snip_el.get_text(" ", strip=True)[:300] if snip_el else ""
            link_el = card.select_one("a[href]")
            href = link_el.get("href", "") if link_el else ""
            if href.startswith("/"):
                href = "https://www.indeed.com" + href

            matched = matches_any_token(title, snippet)
            if not matched:
                continue
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": company,
                "job_title": title,
                "location": location,
                "job_type": "full-time",
                "experience_required": "entry level",
                "url": href,
                "date_posted": "",
                "description_snippet": snippet,
                "easy_apply": "",
                "keywords_matched": matched,
            })
        return rows

    @staticmethod
    def _dig_results(data):
        found = []

        def walk(node):
            if isinstance(node, dict):
                if ("jobkey" in node or "jobKey" in node) and (
                    "title" in node or "displayTitle" in node
                ):
                    found.append(node)
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(data)
        return found
