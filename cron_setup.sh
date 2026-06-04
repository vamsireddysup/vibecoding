#!/bin/bash
# Adds a cron job to run the scraper every night at 11 PM.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SCRIPT_DIR/logs"
CRON_JOB="0 23 * * * cd $SCRIPT_DIR && /usr/bin/python3 run_all.py >> $SCRIPT_DIR/logs/scraper.log 2>&1"

# Avoid adding a duplicate entry on repeated runs.
if crontab -l 2>/dev/null | grep -Fq "$SCRIPT_DIR && /usr/bin/python3 run_all.py"; then
    echo "Cron job already installed for $SCRIPT_DIR"
else
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
    echo "Cron job added: runs nightly at 11 PM"
fi
echo "View logs at: $SCRIPT_DIR/logs/scraper.log"
