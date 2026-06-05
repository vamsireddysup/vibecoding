"""ZipRecruiter scraper — login optional, not required for basic scraping.

Uses requests + BeautifulSoup against the public search results page with
fallback selectors. Login credentials, if supplied, are not used here.
"""
import datetime
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import matches_any_token

TODAY = datetime.date.today().isoformat()


class ZipRecruiterScraper(BaseScraper):
    platform = "ziprecruiter"
    requires_login = False

    def search(self, keyword: str, location: str, page: int = 1):
        q = urllib.parse.quote_plus(keyword)
        loc = urllib.parse.quote_plus("" if location.lower() == "united states" else location)
        url = (
            f"https://www.ziprecruiter.com/jobs-search?search={q}"
            f"&location={loc}&days=7&page={page}"
        )
        resp = self.fetch(url)
        return resp.text

    def parse_results(self, raw) -> list:
        rows = []
        soup = BeautifulSoup(raw, "lxml")
        cards = (
            soup.select("article.job_result")
            or soup.select("div.job_content")
            or soup.select("[class*='job_result_wrapper']")
            or soup.select("li[class*='jobListing']")
        )
        for card in cards:
            title_el = card.select_one(
                "h2 a, a.job_link, [class*='job_title'] a, h2.title a"
            )
            title = title_el.get_text(strip=True) if title_el else ""
            url = title_el.get("href", "") if title_el else ""
            company_el = card.select_one(
                "a.company_name, [class*='company'] a, [class*='hiring_company']"
            )
            company = company_el.get_text(strip=True) if company_el else ""
            loc_el = card.select_one("[class*='location'], a.location")
            location = loc_el.get_text(strip=True) if loc_el else ""
            snip_el = card.select_one("p.job_snippet, [class*='snippet']")
            snippet = snip_el.get_text(" ", strip=True)[:300] if snip_el else ""

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
                "experience_required": "",
                "url": url,
                "date_posted": "",
                "description_snippet": snippet,
                "easy_apply": "",
                "keywords_matched": matched,
            })
        return rows
