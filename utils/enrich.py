"""Post-processing enrichment + filtering for scraped job rows.

Centralizes the per-row derivations the scrapers don't compute themselves so
every platform benefits without editing each scraper:

  - job_id            : stable per-platform identifier (see extract_job_id)
  - days_since_posted : integer days between date_posted and today
  - skills_required   : comma-separated skills parsed from title + description

Then applies two filters:
  - drop jobs posted more than MAX_AGE_DAYS (30) days ago
  - drop jobs whose job_id appears in the Applied Jobs set

NOTE: the prompt referenced an "Applied Jobs Exclusion section" defining
per-platform job_id extraction, but that section was not provided. The rules in
extract_job_id() are sensible defaults per platform; adjust here if a canonical
spec is supplied later.
"""
import datetime
import hashlib
import re
import urllib.parse

MAX_AGE_DAYS = 30

# Curated hardware/EDA skills surfaced into the skills_required column.
SKILL_TOKENS = [
    # Languages / methodologies
    "SystemVerilog", "Verilog", "VHDL", "UVM", "OVM", "SVA", "C++", "Python",
    "TCL", "Perl", "Assembly", "constrained random", "functional coverage",
    # Verification / formal / emulation
    "functional verification", "formal verification", "VC Formal", "JasperGold",
    "FPV", "CDC", "RDC", "emulation", "Veloce", "Palladium", "ZeBu", "SCEMI",
    "assertion", "scoreboard", "testbench", "DPI",
    # Design / synthesis / PD
    "RTL", "synthesis", "Design Compiler", "Genus", "place and route",
    "Innovus", "ICC2", "PrimeTime", "static timing analysis", "timing closure",
    "floorplanning", "clock tree", "DRC", "LVS", "physical design", "low power",
    "UPF", "CPF",
    # DFT
    "DFT", "ATPG", "scan", "MBIST", "boundary scan", "JTAG", "testability",
    # Tools / simulators
    "VCS", "Verdi", "Xcelium", "QuestaSim", "ModelSim", "Vivado", "Quartus",
    "Synopsys", "Cadence", "Siemens", "Mentor",
    # Protocols / interconnect / memory
    "AXI", "AHB", "APB", "AMBA", "PCIe", "Ethernet", "USB", "DDR", "LPDDR",
    "HBM", "memory controller", "cache coherence", "NoC", "SerDes", "I2C", "SPI",
    # Architecture / domains
    "ASIC", "SoC", "FPGA", "CPU", "GPU", "ISA", "RISC-V", "ARM", "pipeline",
    "post-silicon", "pre-silicon", "bring-up",
]


# --------------------------------------------------------------------------- #
# Skills
# --------------------------------------------------------------------------- #
def extract_skills(title: str, description: str) -> list:
    """Return the list of SKILL_TOKENS present in title + description.

    Case-insensitive substring match (same model as keyword matching).
    De-duplicated, original casing preserved, order follows SKILL_TOKENS.
    """
    text = ((title or "") + " " + (description or "")).lower()
    seen = set()
    out = []
    for skill in SKILL_TOKENS:
        key = skill.lower()
        if key in text and key not in seen:
            seen.add(key)
            out.append(skill)
    return out


# --------------------------------------------------------------------------- #
# days_since_posted
# --------------------------------------------------------------------------- #
def parse_days_since_posted(date_posted: str, today: datetime.date = None):
    """Best-effort conversion of a date_posted value to an integer day count.

    Handles relative strings ("3 days ago", "30+ days ago", "today",
    "yesterday", "Just posted", "last 24h", "2 hours ago", "1 week ago"),
    ISO / common date formats, and epoch (seconds or milliseconds).

    Returns an int >= 0, or "" when the value can't be interpreted.
    """
    today = today or datetime.date.today()
    if date_posted is None:
        return ""
    s = str(date_posted).strip().lower()
    if not s:
        return ""

    # Obvious "fresh" markers.
    if any(k in s for k in ("just posted", "just now", "today", "last 24h", "24 hours", "few hours")):
        return 0
    if "yesterday" in s:
        return 1

    # Relative units.
    m = re.search(r"(\d+)\s*\+?\s*hour", s)
    if m:
        return 0
    m = re.search(r"(\d+)\s*\+?\s*day", s)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d+)\s*\+?\s*week", s)
    if m:
        return int(m.group(1)) * 7
    m = re.search(r"(\d+)\s*\+?\s*month", s)
    if m:
        return int(m.group(1)) * 30

    # Epoch timestamp (seconds or milliseconds).
    if re.fullmatch(r"\d{10,13}", s):
        ts = int(s)
        if len(s) >= 13:
            ts = ts // 1000
        try:
            d = datetime.datetime.utcfromtimestamp(ts).date()
            return max((today - d).days, 0)
        except (ValueError, OverflowError):
            return ""

    # Explicit date formats.
    raw = str(date_posted).strip()
    # Trim ISO timestamps to the date part.
    iso_match = re.match(r"(\d{4}-\d{2}-\d{2})", raw)
    if iso_match:
        try:
            d = datetime.date.fromisoformat(iso_match.group(1))
            return max((today - d).days, 0)
        except ValueError:
            pass
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%b %d, %Y", "%B %d, %Y", "%d %b %Y"):
        try:
            d = datetime.datetime.strptime(raw, fmt).date()
            return max((today - d).days, 0)
        except ValueError:
            continue

    return ""


# --------------------------------------------------------------------------- #
# job_id
# --------------------------------------------------------------------------- #
def _fallback_id(row: dict) -> str:
    """Deterministic hash id when no platform id can be parsed from the URL."""
    basis = "|".join([
        (row.get("platform") or "").strip().lower(),
        (row.get("company") or "").strip().lower(),
        (row.get("job_title") or "").strip().lower(),
        (row.get("location") or "").strip().lower(),
    ])
    return "h_" + hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


def extract_job_id(platform: str, url: str, row: dict = None) -> str:
    """Extract a stable job id for a row, per platform.

    Sensible per-platform rules (the canonical spec was not provided):
      linkedin     -> numeric id from /jobs/view/{id}
      indeed       -> jk query param
      dice         -> trailing GUID/slug of detail URL
      greenhouse   -> gh_jid param or trailing numeric id
      lever        -> trailing UUID of hosted URL
      workday      -> requisition id (R-#####) or last path segment
      glassdoor    -> jobListingId param or trailing numeric id
      handshake    -> trailing numeric id of /jobs/{id}
      ziprecruiter -> trailing slug/id
      jobright     -> trailing slug/id
    Falls back to a deterministic hash of company|title|location.
    """
    platform = (platform or "").lower()
    url = url or ""
    row = row or {}
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    path = parsed.path.rstrip("/")
    last = path.split("/")[-1] if path else ""

    def q(name):
        vals = qs.get(name)
        return vals[0] if vals else ""

    jid = ""
    if platform == "linkedin":
        m = re.search(r"/jobs/view/(\d+)", url) or re.search(r"currentJobId=(\d+)", url)
        jid = m.group(1) if m else q("currentJobId")
    elif platform == "indeed":
        jid = q("jk") or q("vjk")
    elif platform == "dice":
        jid = last
    elif platform == "company_careers":
        # Could be greenhouse / lever / workday / generic.
        jid = q("gh_jid")
        if not jid:
            if "greenhouse" in url:
                m = re.search(r"/jobs/(\d+)", url)
                jid = m.group(1) if m else last
            elif "lever.co" in url:
                jid = last  # lever posting UUID
            elif "myworkdayjobs" in url or "workday" in url:
                m = re.search(r"(R-?\d{4,})", url)
                jid = m.group(1) if m else last
            else:
                jid = last
    elif platform == "glassdoor":
        jid = q("jobListingId")
        if not jid:
            m = re.search(r"jobListingId=(\d+)", url) or re.search(r"_(\d+)\.htm", url)
            jid = m.group(1) if m else last
    elif platform == "handshake":
        m = re.search(r"/jobs/(\d+)", url)
        jid = m.group(1) if m else last
    elif platform in ("ziprecruiter", "jobright"):
        jid = last
    else:
        jid = last

    jid = (jid or "").strip()
    if not jid:
        return _fallback_id(row)
    # Namespace by platform to avoid cross-platform collisions on bare numbers.
    return f"{platform}:{jid}"


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #
def finalize_rows(rows: list, applied_ids: set = None, max_age_days: int = MAX_AGE_DAYS,
                  today: datetime.date = None) -> dict:
    """Enrich rows and apply age + applied-jobs filters.

    Returns a dict:
      - "rows":           enriched, surviving rows
      - "dropped_old":    count removed for being older than max_age_days
      - "dropped_applied":count removed because job_id was already applied to
    """
    applied_ids = applied_ids or set()
    today = today or datetime.date.today()
    kept = []
    dropped_old = 0
    dropped_applied = 0

    for row in rows:
        platform = row.get("platform", "")
        row["job_id"] = extract_job_id(platform, row.get("url", ""), row)
        row["days_since_posted"] = parse_days_since_posted(row.get("date_posted", ""), today)
        if not row.get("skills_required"):
            row["skills_required"] = extract_skills(
                row.get("job_title", ""), row.get("description_snippet", "")
            )

        days = row["days_since_posted"]
        if isinstance(days, int) and days > max_age_days:
            dropped_old += 1
            continue
        if row["job_id"] in applied_ids:
            dropped_applied += 1
            continue
        kept.append(row)

    return {
        "rows": kept,
        "dropped_old": dropped_old,
        "dropped_applied": dropped_applied,
    }
