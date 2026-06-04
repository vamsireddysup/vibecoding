"""Glassdoor scraper.

# Glassdoor ToS prohibits scraping. For personal job search use only.

Glassdoor has aggressive bot detection, so we use undetected_chromedriver with
longer random delays (4-8s). Login (email/password from credentials) is
required for full results.
"""
import datetime
import urllib.parse

from bs4 import BeautifulSoup

from scrapers.base_scraper import BaseScraper
from utils.matching import matches_any_token

TODAY = datetime.date.today().isoformat()


class GlassdoorScraper(BaseScraper):
    platform = "glassdoor"
    requires_login = True

    def login(self):
        creds = self.my_credentials()
        username = (creds.get("username") or "").strip()
        password = (creds.get("password") or "").strip()
        if not username or not password:
            print("[glassdoor] no credentials provided; skipping login")
            return False

        from selenium.webdriver.common.by import By

        driver = self.init_driver(headless=True)
        driver.get("https://www.glassdoor.com/profile/login_input.htm")
        self.polite_sleep(4, 8)
        try:
            driver.find_element(By.ID, "inlineUserEmail").send_keys(username)
            self.polite_sleep(2, 4)
            driver.find_element(By.CSS_SELECTOR, "button[type='submit']").click()
            self.polite_sleep(3, 6)
            driver.find_element(By.ID, "inlineUserPassword").send_keys(password)
            self.polite_sleep(2, 4)
            driver.find_element(By.CSS_SELECTOR, "button[type='submit']").click()
            self.polite_sleep(4, 8)
        except Exception as exc:  # noqa: BLE001
            print(f"[glassdoor] login form interaction failed: {exc}")
            return False
        return True

    def search(self, keyword: str, location: str):
        kw = urllib.parse.quote(keyword)
        url = (
            "https://www.glassdoor.com/Job/jobs.htm?suggestCount=0"
            "&suggestChosen=false&clickSource=searchBtn"
            f"&typedKeyword={kw}&sc.keyword={kw}&locT=&locId=&jobType="
        )
        driver = self.init_driver(headless=True)
        driver.get(url)
        self.polite_sleep(4, 8)
        try:
            for _ in range(2):
                driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                self.polite_sleep(3, 6)
        except Exception:
            pass
        return driver.page_source

    def parse_results(self, raw) -> list:
        rows = []
        soup = BeautifulSoup(raw, "lxml")
        cards = (
            soup.select("li.react-job-listing")
            or soup.select("[data-test='jobListing']")
            or soup.select("li[class*='JobsList_jobListItem']")
        )
        for card in cards:
            title_el = card.select_one(
                "a.jobLink, [data-test='job-title'], a[class*='JobCard_jobTitle']"
            )
            title = title_el.get_text(strip=True) if title_el else ""
            url = title_el.get("href", "") if title_el else ""
            if url.startswith("/"):
                url = "https://www.glassdoor.com" + url
            company_el = card.select_one(
                "[data-test='employer-name'], a.job-search-key, [class*='EmployerProfile_employerName']"
            )
            company = company_el.get_text(strip=True) if company_el else ""
            rating_el = card.select_one("[data-test='detailRating'], [class*='rating']")
            rating = rating_el.get_text(strip=True) if rating_el else ""
            loc_el = card.select_one("[data-test='emp-location'], [class*='JobCard_location']")
            location = loc_el.get_text(strip=True) if loc_el else ""

            matched = matches_any_token(title, "")
            if not matched:
                continue
            rows.append({
                "date_scraped": TODAY,
                "platform": self.platform,
                "company": (company + (f" (rating {rating})" if rating else "")).strip(),
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
