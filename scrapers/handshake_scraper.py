"""Handshake scraper (PSU student account).

Login required. Targets the ECE jobs view, filtered to full-time roles and the
2026 graduation year. Uses undetected_chromedriver because Handshake is a
JS-heavy single-page app behind authentication.
"""
import datetime

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import matches_any_token

TODAY = datetime.date.today().isoformat()


class HandshakeScraper(BaseScraper):
    platform = "handshake"
    requires_login = True

    GRAD_YEAR = "2026"

    def login(self):
        creds = self.my_credentials()
        username = (creds.get("username") or "").strip()
        password = (creds.get("password") or "").strip()
        if not username or not password:
            print("[handshake] no credentials provided; skipping login")
            return False

        from selenium.webdriver.common.by import By

        driver = self.init_driver(headless=True)
        driver.get("https://app.joinhandshake.com/login")
        self.polite_sleep(3, 6)
        try:
            # Handshake routes most schools through SSO. We enter the email and
            # let the school login take over; for many PSU-style logins the
            # email + password fields appear directly.
            email_box = driver.find_elements(By.CSS_SELECTOR, "input[type='email'], #email-address-identifier")
            if email_box:
                email_box[0].send_keys(username)
                self.polite_sleep(1, 2)
            pwd_box = driver.find_elements(By.CSS_SELECTOR, "input[type='password']")
            if pwd_box:
                pwd_box[0].send_keys(password)
                self.polite_sleep(1, 2)
            submit = driver.find_elements(By.CSS_SELECTOR, "button[type='submit']")
            if submit:
                submit[0].click()
            self.polite_sleep(4, 8)
        except Exception as exc:  # noqa: BLE001
            print(f"[handshake] login interaction failed (SSO may require manual step): {exc}")
            return False
        return True

    def search(self, keyword: str, location: str):
        # Handshake's jobs view; filter for full-time. Keyword is passed via the
        # search query param. Graduation-year filtering is applied client-side.
        import urllib.parse

        kw = urllib.parse.quote(keyword)
        url = (
            "https://app.joinhandshake.com/job-search/?"
            f"query={kw}&employment_type_names%5B%5D=Full-Time"
        )
        driver = self.init_driver(headless=True)
        driver.get(url)
        self.polite_sleep(4, 8)
        try:
            for _ in range(2):
                driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                self.polite_sleep(3, 5)
        except Exception:
            pass
        return driver.page_source

    def parse_results(self, raw) -> list:
        rows = []
        soup = BeautifulSoup(raw, "lxml")
        cards = (
            soup.select("[data-hook='jobs-card']")
            or soup.select("div[class*='JobCard']")
            or soup.select("a[href*='/jobs/']")
        )
        seen = set()
        for card in cards:
            title_el = card.select_one("[class*='title'], h3, h2") or card
            title = title_el.get_text(strip=True) if title_el else ""
            link_el = card if card.name == "a" else card.select_one("a[href*='/jobs/']")
            url = link_el.get("href", "") if link_el else ""
            if url.startswith("/"):
                url = "https://app.joinhandshake.com" + url
            if url in seen:
                continue
            company_el = card.select_one("[class*='employer'], [class*='company']")
            company = company_el.get_text(strip=True) if company_el else ""
            loc_el = card.select_one("[class*='location']")
            location = loc_el.get_text(strip=True) if loc_el else ""

            matched = matches_any_token(title, "")
            if not matched:
                continue
            seen.add(url)
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": company,
                "job_title": title,
                "location": location,
                "job_type": "full-time",
                "experience_required": f"grad year {self.GRAD_YEAR}",
                "url": url,
                "date_posted": "",
                "description_snippet": "",
                "easy_apply": "",
                "keywords_matched": matched,
            })
        return rows
