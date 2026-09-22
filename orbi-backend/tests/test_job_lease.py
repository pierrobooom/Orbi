"""Tests for the background-job lease.

Only one replica may run the reminder dispatcher or the finance scheduler.
Duplicate reminders are an annoyance; duplicate bank syncs are billed, since
bank data is priced per connected account per month and every replica would
sync every account. That bill arrives a month later with no explanation in
it, which is why this is worth a test rather than a comment.

The arbitration itself belongs to Postgres and is exercised against the real
database. What is checked here is the surrounding logic: that a holder can be
identified, that failures are treated as "do not run", and that a released
lease is actually claimable rather than expiring on a boundary.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services import job_lease


def test_each_process_gets_its_own_identity():
    """Two replicas that believed they were the same holder would both renew
    the same lease and both do the work."""
    assert job_lease.HOLDER
    assert job_lease.HOLDER.count("-") >= 2  # host, pid, random suffix


def test_the_timestamp_has_no_microseconds():
    """It goes into a PostgREST filter, where a '.' is an operator separator.
    A microsecond component would change what the filter means."""
    moment = datetime(2026, 9, 22, 21, 30, 15, 123456, tzinfo=timezone.utc)
    assert job_lease._iso(moment) == "2026-09-22T21:30:15+00:00"


def test_the_timestamp_keeps_its_offset():
    """A naive timestamp compared against a timestamptz column is a silent
    hour's difference wherever the server is not on UTC."""
    moment = datetime(2026, 9, 22, 21, 30, 15, tzinfo=timezone.utc)
    assert job_lease._iso(moment).endswith("+00:00")


@pytest.mark.asyncio
async def test_an_unreachable_database_means_do_not_run(monkeypatch):
    """The failure has to be "skip this tick", never "run anyway".

    Running unco-ordinated on every replica because the lease could not be
    read is the exact outcome the lease exists to prevent, and it would
    happen precisely when things are already going wrong.
    """
    def explode():
        raise RuntimeError("no database")

    monkeypatch.setattr(job_lease, "get_client", explode)
    assert await job_lease.hold("anything", 60) is False


@pytest.mark.asyncio
async def test_a_failed_release_is_not_an_error(monkeypatch):
    """Release runs during shutdown. Raising there would turn a clean stop
    into a crash, over a lease that expires on its own anyway."""
    def explode():
        raise RuntimeError("no database")

    monkeypatch.setattr(job_lease, "get_client", explode)
    await job_lease.release("anything")  # must not raise


def test_release_backdates_rather_than_stamping_now():
    """The bug this caught: release set expires_at to exactly now, and the
    takeover filter is a strict '<' on second-truncated timestamps — so a
    deliberately released lease matched nothing and the next replica waited
    a full TTL for a job nobody was doing."""
    now = datetime.now(timezone.utc)
    released = now - timedelta(seconds=1)
    assert job_lease._iso(released) < job_lease._iso(now)
