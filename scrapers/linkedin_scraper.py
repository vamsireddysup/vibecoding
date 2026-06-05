"""LinkedIn scraper.

# LinkedIn ToS prohibits scraping. This is for personal job search use only.

Uses undetected_chromedriver to log in (email/password from credentials) and
walk job search result pages filtered to entry level / associate roles posted
in the last 24 hours. LinkedIn actively detects automation, so delays are kept
generous and selectors are defensive.
"""
import datetime
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import matches_any_token

TODAY = datetime.date.today().isoformat()


class LinkedInScraper(BaseScraper):
    platform = "linkedin"
    requires_login = True

    def login(self):
        creds = self.my_credentials()
        username = (creds.get("username") or "").strip()
        password = (creds.get("password") or "").strip()
        if not username or not password:
            print("[linkedin] no credentials provided; skipping login")
            return False

        from selenium.webdriver.common.by import By

        driver = self.init_driver(headless=True)
        driver.get("https://www.linkedin.com/login")
        self.polite_sleep(2, 4)
        try:
            driver.find_element(By.ID, "username").send_keys(username)
            self.polite_sleep(1, 2)
            driver.find_element(By.ID, "password").send_keys(password)
            self.polite_sleep(1, 2)
            driver.find_element(By.CSS_SELECTOR, "button[type='submit']").click()
            self.polite_sleep(4, 7)
        except Exception as exc:  # noqa: BLE001
            print(f"[linkedin] login form interaction failed: {exc}")
            return False
        return "feed" in driver.current_url or "checkpoint" not in driver.current_url

    def search(self, keyword: str, location: str, page: int = 1):
        kw = urllib.parse.quote(keyword)
        loc = urllib.parse.quote(location)
        start = (page - 1) * 25  # LinkedIn pages in increments of 25
        # f_E=1,2 => internship + entry level; f_TPR=r86400 => last 24h.
        url = (
            f"https://www.linkedin.com/jobs/search/?keywords={kw}"
            f"&location={loc}&f_TPR=r86400&f_E=1%2C2&start={start}"
        )
        driver = self.init_driver(headless=True)
        driver.get(url)
        self.polite_sleep(3, 6)
        # If LinkedIn bounced us to the auth/login wall, signal "no results" so
        # pagination stops cleanly.
        cur = (driver.current_url or "").lower()
        if "authwall" in cur or "/login" in cur or "/checkpoint" in cur:
            print(f"[linkedin] login wall hit on page {page}; stopping")
            return ""
        # Scroll to load more cards.
        try:
            for _ in range(3):
                driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                self.polite_sleep(2, 4)
        except Exception:
            pass
        return driver.page_source

    def parse_results(self, raw) -> list:
        rows = []
        soup = BeautifulSoup(raw, "lxml")
        cards = (
            soup.select("div.job-card-container")
            or soup.select("li.jobs-search-results__list-item")
            or soup.select("div.base-card")
        )
        for card in cards:
            title_el = card.select_one(
                "a.job-card-list__title, h3.base-search-card__title, [class*='job-card-list__title']"
            )
            title = title_el.get_text(strip=True) if title_el else ""
            link_el = card.select_one("a[href*='/jobs/view/'], a.base-card__full-link")
            url = link_el.get("href", "").split("?")[0] if link_el else ""
            company_el = card.select_one(
                "span.job-card-container__primary-description, h4.base-search-card__subtitle, [class*='company-name']"
            )
            company = company_el.get_text(strip=True) if company_el else ""
            loc_el = card.select_one(
                "li.job-card-container__metadata-item, span.job-search-card__location"
            )
            location = loc_el.get_text(strip=True) if loc_el else ""
            easy_apply = bool(card.select_one("[class*='easy-apply'], li:-soup-contains('Easy Apply')"))

            matched = matches_any_token(title, "")
            if not matched:
                continue
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": company,
                "job_title": title,
                "location": location,
                "job_type": "full-time",
                "experience_required": "entry level / associate",
                "url": url,
                "date_posted": "last 24h",
                "description_snippet": "",
                "easy_apply": easy_apply,
                "keywords_matched": matched,
            })
        return rows
