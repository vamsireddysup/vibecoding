"""Jobright scraper.

Jobright is AI-curated and heavily JS-rendered. We try a plain requests fetch
first (in case server-rendered content or a JSON endpoint is available) and
fall back to Selenium / undetected_chromedriver to render the page.
"""
import datetime
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import matches_any_token

TODAY = datetime.date.today().isoformat()


class JobrightScraper(BaseScraper):
    platform = "jobright"
    requires_login = False  # login optional; not required for public search

    def search(self, keyword: str, location: str, page: int = 1):
        q = urllib.parse.quote_plus(keyword)
        loc = urllib.parse.quote_plus(location)
        url = f"https://jobright.ai/jobs/search?keyword={q}&location={loc}&page={page}"

        # Try requests first.
        try:
            resp = self.fetch(url)
            if "job" in resp.text.lower() and len(resp.text) > 2000:
                return ("html", resp.text)
        except Exception:
            pass

        # Fall back to Selenium-rendered HTML.
        try:
            driver = self.init_driver(headless=True)
            driver.get(url)
            self.polite_sleep(4, 7)
            html = driver.page_source
            return ("html", html)
        except Exception:
            return ("html", "")

    def parse_results(self, raw) -> list:
        _, html = raw
        rows = []
        soup = BeautifulSoup(html, "lxml")
        cards = (
            soup.select("[class*='job-card']")
            or soup.select("[data-testid*='job']")
            or soup.select("a[href*='/jobs/']")
        )
        seen_urls = set()
        for card in cards:
            title_el = card.select_one(
                "[class*='title'], h2, h3"
            ) or card
            title = title_el.get_text(strip=True) if title_el else ""
            link_el = card if card.name == "a" else card.select_one("a[href]")
            url = link_el.get("href", "") if link_el else ""
            if url and url.startswith("/"):
                url = "https://jobright.ai" + url
            if url in seen_urls:
                continue
            company_el = card.select_one("[class*='company']")
            company = company_el.get_text(strip=True) if company_el else ""
            loc_el = card.select_one("[class*='location']")
            location = loc_el.get_text(strip=True) if loc_el else ""

            matched = matches_any_token(title, "")
            if not matched:
                continue
            seen_urls.add(url)
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": company,
                "job_title": title,
                "location": location,
                "job_type": "full-time",
                "experience_required": "",
                "url": url,
                "date_posted": "",
                "description_snippet": "",
                "easy_apply": "",
                "keywords_matched": matched,
            })
        return rows
