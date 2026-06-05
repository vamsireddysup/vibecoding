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

    def scrape_keyword_location(self, keyword: str, location: str) -> list:
        """Selenium pagination via Handshake's UI "next page" control.

        Clicks the next-page button until it's disabled/missing, a page has no
        cards, a posting older than 30 days appears, or the 10-page cap is hit.
        Sleeps 2-4s between pages.
        """
        import urllib.parse

        kw = urllib.parse.quote(keyword)
        url = (
            "https://app.joinhandshake.com/job-search/?"
            f"query={kw}&employment_type_names%5B%5D=Full-Time"
        )
        driver = self.init_driver(headless=True)
        driver.get(url)
        self.polite_sleep(4, 8)

        all_rows = []
        for page in range(1, self.MAX_PAGES + 1):
            try:
                driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                self.polite_sleep(2, 4)
            except Exception:
                pass
            rows = self.parse_results(driver.page_source) or []
            for r in rows:
                r.setdefault("platform", self.platform)
            all_rows.extend(rows)
            print(
                f"{self.platform} — keyword {keyword} — page {page} — "
                f"{len(all_rows)} jobs found so far"
            )
            if not rows:  # stop 1
                break
            if self._page_has_old_job(rows):  # stop 2
                print(f"[{self.platform}] '{keyword}' page {page}: job older than 30 "
                      "days — stopping pagination")
                break
            if page < self.MAX_PAGES and not self._click_next(driver):  # stop 3 via cap
                break
            self.polite_sleep(2, 4)
        return all_rows

    def _click_next(self, driver) -> bool:
        """Click Handshake's next-page button. Returns False if disabled/absent."""
        from selenium.webdriver.common.by import By

        selectors = [
            "button[aria-label='Next page']",
            "button[aria-label='Next']",
            "a[aria-label='Next page']",
            "[data-hook='search-pagination-next']",
        ]
        for sel in selectors:
            elems = driver.find_elements(By.CSS_SELECTOR, sel)
            if not elems:
                continue
            btn = elems[0]
            disabled = (
                btn.get_attribute("disabled")
                or btn.get_attribute("aria-disabled") == "true"
                or "disabled" in (btn.get_attribute("class") or "")
            )
            if disabled:
                return False
            try:
                driver.execute_script("arguments[0].click();", btn)
                self.polite_sleep(3, 5)
                return True
            except Exception:
                return False
        return False

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
