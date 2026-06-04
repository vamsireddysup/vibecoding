"""Keyword/token matching for scraped jobs.

SEARCH_QUERIES are the broad strings submitted to each site's search bar.
MATCH_TOKENS are checked against (title + description) after fetching a job.
A match on ANY single token qualifies the job; the matched tokens are stored
in the keywords_matched column.

This lives in utils/ (rather than run_all.py) so both run_all.py and every
scraper can import it without a circular import. run_all.py re-exports these
names so the configuration is discoverable from the runner as well.
"""

# Broad queries submitted to each job site's search bar.
SEARCH_QUERIES = [
    "DFT verification engineer",
    "ASIC verification engineer",
    "RTL design engineer",
    "formal verification engineer",
    "hardware verification engineer",
    "physical design engineer",
    "emulation engineer",
    "FPGA engineer",
    "hardware validation engineer",
    "SoC verification engineer",
]

# Tokens checked against job title + description after fetching.
# A match on ANY single token qualifies the job.
MATCH_TOKENS = [
    "DFT", "ATPG", "scan", "testability",
    "UVM", "SystemVerilog", "constrained random", "functional verification",
    "formal verification", "SVA", "VC Formal", "FPV", "CDC",
    "RTL", "ASIC", "SoC", "synthesis",
    "emulation", "Veloce", "SCEMI",
    "FPGA", "Vivado", "bring-up",
    "physical design", "place and route", "timing closure", "DRC", "LVS",
    "VCS", "Verdi", "Xcelium", "QuestaSim",
    "AXI", "AMBA", "cache coherence", "DDR", "memory controller",
    "hardware validation", "post-silicon", "pre-silicon",
    "verification engineer", "design engineer", "validation engineer",
    "new grad", "entry level", "0-2 years", "0-3 years", "0-5 years",
]


def matches_any_token(title: str, description: str) -> list:
    """Return the list of MATCH_TOKENS present in title+description.

    An empty list means no match (the job should be skipped).
    """
    text = ((title or "") + " " + (description or "")).lower()
    return [t for t in MATCH_TOKENS if t.lower() in text]
