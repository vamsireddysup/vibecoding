"""Base scraper class shared by all platform scrapers.

Provides:
  - credential storage
  - random user-agent rotation (10 real Chrome/Firefox UA strings)
  - polite random delays between requests (2-5s)
  - retry with exponential backoff on timeout/connection errors
  - lazy Selenium / undetected_chromedriver helpers for login-required sites
  - a `requests.Session` with a rotating UA for no-login sites

Concrete scrapers implement search() and parse_results(); scrape_all() drives
the keyword x location sweep and aggregates rows.

NOTE: Several target sites prohibit scraping in their Terms of Service. This
code is intended for personal job-search use only.
"""
import random
import time

import requests

# Import order matters; keep heavy/optional deps lazily imported in methods so
# that no-login scrapers can run in environments without a browser installed.

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
]


class BaseScraper:
    # Subclasses set this to a human-friendly platform key (lowercase).
    platform = "base"

    # Whether this scraper needs a logged-in browser session.
    requires_login = False

    def __init__(self, credentials: dict):
        """credentials: dict keyed by platform -> list of credential rows."""
        self.credentials = credentials or {}
        self.driver = None
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": self.random_user_agent()})

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    def random_user_agent(self) -> str:
        return random.choice(USER_AGENTS)

    def polite_sleep(self, lo: float = 2.0, hi: float = 5.0):
        time.sleep(random.uniform(lo, hi))

    def my_credentials(self) -> dict:
        """Return the first credential row for this platform, or {}."""
        rows = self.credentials.get(self.platform, [])
        return rows[0] if rows else {}

    def fetch(self, url: str, retries: int = 3, **kwargs) -> requests.Response:
        """GET a URL with UA rotation and exponential-backoff retry.

        Raises the last exception if all retries fail.
        """
        last_exc = None
        for attempt in range(retries):
            try:
                self.session.headers.update({"User-Agent": self.random_user_agent()})
                resp = self.session.get(url, timeout=20, **kwargs)
                resp.raise_for_status()
                return resp
            except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as exc:
                last_exc = exc
                backoff = 2 ** attempt
                time.sleep(backoff)
        raise last_exc

    # ------------------------------------------------------------------ #
    # Selenium / undetected_chromedriver (lazy)
    # ------------------------------------------------------------------ #
    def init_driver(self, headless: bool = True):
        """Create an undetected_chromedriver instance. Lazily imported so that
        no-login scrapers don't require a browser to be installed.
        """
        if self.driver is not None:
            return self.driver
        import undetected_chromedriver as uc

        options = uc.ChromeOptions()
        if headless:
            options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument(f"--user-agent={self.random_user_agent()}")
        self.driver = uc.Chrome(options=options)
        return self.driver

    def quit_driver(self):
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None

    # ------------------------------------------------------------------ #
    # Lifecycle methods (override in subclasses)
    # ------------------------------------------------------------------ #
    def login(self):
        """Override for login-required platforms. Default: no-op."""
        return False

    def search(self, keyword: str, location: str):
        """Return raw result payload (HTML/JSON/driver state) for one query."""
        raise NotImplementedError

    def parse_results(self, raw) -> list:
        """Parse a raw payload into a list of dicts matching the output schema."""
        raise NotImplementedError

    def scrape_all(self, keywords: list, locations: list) -> list:
        """Run search + parse for all keyword x location combos.

        Each combo is wrapped in try/except so a single failure does not abort
        the rest. Returns the combined list of parsed rows.
        """
        results = []
        if self.requires_login:
            try:
                self.login()
            except Exception as exc:  # noqa: BLE001
                print(f"[{self.platform}] login failed: {exc}")
                self.quit_driver()
                return results

        try:
            for keyword in keywords:
                for location in locations:
                    try:
                        raw = self.search(keyword, location)
                        rows = self.parse_results(raw) or []
                        # Tag platform on every row in case the parser forgot.
                        for r in rows:
                            r.setdefault("platform", self.platform)
                        results.extend(rows)
                        print(f"[{self.platform}] '{keyword}' @ '{location}': {len(rows)} rows")
                    except Exception as exc:  # noqa: BLE001
                        print(f"[{self.platform}] error '{keyword}' @ '{location}': {exc}")
                    self.polite_sleep()
        finally:
            self.quit_driver()
        return results
