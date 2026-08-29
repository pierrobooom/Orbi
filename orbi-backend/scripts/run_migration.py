"""Apply a single migration file to the Supabase Postgres instance.

Usage:
    python scripts/run_migration.py migrations/0007_cluster_kind.sql

Every migration in this project is written to be idempotent (add column if
not exists, guarded constraint creation, etc.), so re-running one is safe.
That matters because there is no migrations-applied ledger table — the
files are the record, and the safest way to reconcile a fresh database is
to run all of them in order.

Connects with DATABASE_URL from .env, which points at Supabase's pooler.
"""

import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_BACKEND_ROOT / ".env")

import os  # noqa: E402 — must follow load_dotenv


def run(path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    dsn = os.environ["DATABASE_URL"]
    conn = psycopg2.connect(dsn)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(sql)
        print(f"applied: {path.name}")
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: run_migration.py <path-to-sql> [<path-to-sql> ...]")
        raise SystemExit(2)
    for arg in sys.argv[1:]:
        target = Path(arg)
        if not target.is_absolute():
            target = _BACKEND_ROOT / target
        if not target.exists():
            print(f"not found: {target}")
            raise SystemExit(1)
        run(target)
