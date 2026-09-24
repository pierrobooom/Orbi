"""Making the stored window match what the bank actually reports.

WHY PREVENTION IS NOT ENOUGH
Dedup decides what to INSERT. It cannot fix a row that is already wrong,
and it only ever knows the identity rule that looked correct on the day it
was written. That rule has now been wrong twice:

    1. entry_reference was treated as an id. Bankinter issues a new one on
       every fetch, so every sync re-imported the same week.
    2. The natural key used booking_date, which MOVES when a transaction
       settles. One dinner on the 23rd became a second dinner on the 24th.

Both were caught by a person noticing a number was wrong. This is the check
that would have caught them on the next sync instead.

THE RULE, AND THE LINE IT WILL NOT CROSS
The bank is authoritative about HOW MANY times something happened. Where we
hold more copies of a transaction than the feed reports, the extras are
ours, and they go.

It will never delete a transaction the feed does not mention at all. A feed
can come back short — a partial page, an outage mid-window, a bank quietly
narrowing its own history — and "the bank did not mention it" is not
evidence that it never happened. So a key the feed is silent about is left
exactly as it is. This only ever reduces a count the bank has confirmed,
which is precisely the duplicate case and nothing else.

Newest-created copies are dropped first, because the original import is the
one carrying anything the user has since done to it by hand, such as a
category they corrected.
"""

import logging
from typing import Callable

logger = logging.getLogger(__name__)


def surplus_ids(
    stored: list[dict],
    expected: dict[str, int],
    key_of: Callable[[dict], str],
) -> list[str]:
    """Ids of the rows we hold in excess of what the bank reports.

    Pure, and kept away from the database on purpose: this decides whether
    financial records are deleted, and that decision should be arguable in a
    test without a bank, a network or a table.

    `key_of` builds the identity from a stored row, so the caller keeps one
    definition of sameness rather than this module inventing a second one
    that can drift away from it.
    """
    by_key: dict[str, list[dict]] = {}
    for row in stored:
        by_key.setdefault(key_of(row), []).append(row)

    doomed: list[str] = []
    for key, rows in by_key.items():
        wanted = expected.get(key, 0)
        # Silence is not a denial — see the note above.
        if wanted <= 0:
            continue
        if len(rows) <= wanted:
            continue
        rows.sort(key=lambda row: str(row.get("created_at") or ""))
        doomed.extend(str(row["id"]) for row in rows[wanted:])
    return doomed
