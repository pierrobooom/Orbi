"""Which process gets to run a background job.

WHAT THIS PREVENTS
The reminder dispatcher and the finance scheduler run inside the API
process. On one instance that is fine. On two, both instances run both
loops: every reminder is sent twice, and every bank account is synced
twice — and bank data is billed per connected account per month, so the
provider invoice is multiplied by the replica count. That bill arrives a
month later with no clue as to why.

HOW IT WORKS
Each job has one row. A process claims it by conditionally updating that
row, and keeps it by renewing on every tick. Only the holder does the
work; everyone else skips the tick and tries again next time.

WHY THIS IS RACE-SAFE WITHOUT ANY LOCKING
The claim is `UPDATE ... WHERE job = ? AND expires_at < now`. Under
READ COMMITTED, a second updater trying the same thing blocks on the row
lock, and when it is released re-evaluates its WHERE clause against the
committed new version — where expires_at is now in the future, so it
matches nothing and reports zero rows updated. Postgres does the
arbitration; this module just asks the question in the right shape.

WHY A LEASE RATHER THAN A FLAG
Flags have to be released, and a process that is killed releases nothing.
A lease expires by itself, so the worst case for a crashed replica is that
the job pauses for one TTL — not for ever, and not until someone notices.
"""

import logging
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone

from app.db.client import get_client

logger = logging.getLogger(__name__)

# Identifies this process. The hostname makes it readable when looking at the
# table during an incident; the random suffix keeps two containers on one host
# from claiming to be the same holder.
HOLDER = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"


def _iso(moment: datetime) -> str:
    """Timestamp for a PostgREST filter, without microseconds.

    Trimmed because microseconds add nothing here and make the value harder
    to read in a table someone is squinting at while something is wrong.
    """
    return moment.replace(microsecond=0).isoformat()


async def hold(job: str, ttl_seconds: int) -> bool:
    """Try to hold the lease for `job`. True if this process may do the work.

    Renewing and claiming are separate statements rather than one clever
    query: the renew path is the common case and succeeds in a single round
    trip, and keeping them apart means neither needs an OR filter whose
    encoding would have to be reasoned about every time it is read.

    TTL must comfortably exceed the tick interval. Too short and the holder
    loses its own lease between ticks, handing the job back and forth; too
    long and a dead replica stalls the job for that whole period.
    """
    now = datetime.now(timezone.utc)
    expires = _iso(now + timedelta(seconds=ttl_seconds))
    patch = {"holder": HOLDER, "expires_at": expires, "updated_at": _iso(now)}

    try:
        # Inside the try: building the client can itself fail when the
        # database is unreachable or credentials are missing, and that has to
        # answer "do not run" like any other failure rather than propagating
        # out of a function whose contract is a boolean.
        client = get_client()

        # Renew: we already hold it.
        renewed = (
            client.table("job_leases")
            .update(patch)
            .eq("job", job)
            .eq("holder", HOLDER)
            .execute()
            .data
            or []
        )
        if renewed:
            return True

        # Claim: whoever held it is gone or never renewed.
        taken = (
            client.table("job_leases")
            .update(patch)
            .eq("job", job)
            .lt("expires_at", _iso(now))
            .execute()
            .data
            or []
        )
        if taken:
            logger.info("Took over %s (previous holder's lease expired)", job)
            return True

        # First run on a fresh database: nobody has ever held it. The primary
        # key is what settles a race here — the losers get a duplicate-key
        # error, which is the correct answer and not a failure.
        try:
            client.table("job_leases").insert({"job": job, **patch}).execute()
            logger.info("Claimed %s", job)
            return True
        except Exception:
            return False

    except Exception as exc:  # noqa: BLE001
        # A database that cannot be reached is not a reason to run the job
        # anyway. Skipping a tick costs a minute; running unco-ordinated on
        # every replica costs money.
        logger.warning("Could not take the %s lease: %s", job, exc)
        return False


async def release(job: str) -> None:
    """Give up the lease on a clean shutdown.

    Not required for correctness — the lease would expire on its own — but a
    deploy restarts every replica at once, and without this the job pauses
    for a TTL on every release for no reason.
    """
    try:
        # Backdated, not set to now. The takeover filter is a strict `<`, and
        # both sides are truncated to the second, so an expiry of exactly now
        # matches nothing and the next replica waits a full TTL for a lease
        # that was deliberately given up.
        released = datetime.now(timezone.utc) - timedelta(seconds=1)
        get_client().table("job_leases").update(
            {"expires_at": _iso(released)}
        ).eq("job", job).eq("holder", HOLDER).execute()
    except Exception as exc:  # noqa: BLE001 — shutdown must not fail on this
        logger.debug("Could not release the %s lease: %s", job, exc)
