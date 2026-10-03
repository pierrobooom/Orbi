"""A collection's months: what each month is worth, what came in, when, and from whom."""

from datetime import date

from app.services.collections import month_summary, owed_before, ref_month

AUG = date(2026, 8, 1)
SEPT = date(2026, 9, 1)
OCT = date(2026, 10, 1)
TODAY = date(2026, 10, 3)


def test_rent_paid_in_arrears_is_for_the_month_before():
    assert ref_month(date(2026, 10, 5), "previous_month") == SEPT
    assert ref_month(date(2026, 1, 5), "previous_month") == date(2025, 12, 1)
    assert ref_month(date(2026, 10, 5), "due_month") == OCT
    assert ref_month(date(2026, 10, 5), None) == OCT


ROUTINES = [
    {"id": "r-ana", "resource_id": "q1", "title": "Renda", "kind": "amount", "direction": "income",
     "covers": "due_month", "amount": 550, "anchor_on": "2026-09-01", "frequency": "monthly",
     "interval_count": 1, "on_miss": "stay_overdue"},
    {"id": "r-marta", "resource_id": "q3", "title": "Renda", "kind": "amount", "direction": "income",
     "covers": "previous_month", "amount": 600, "anchor_on": "2026-09-05", "frequency": "monthly",
     "interval_count": 1, "on_miss": "stay_overdue"},
    {"id": "r-condo", "resource_id": "casa", "title": "Condomínio", "kind": "amount",
     "direction": "expense", "amount": 45, "anchor_on": "2026-09-05", "frequency": "monthly",
     "interval_count": 1, "on_miss": "stay_overdue"},
]
RESOURCES = {
    "casa": {"id": "casa", "name": "Casa 1", "parent_id": None},
    "q1": {"id": "q1", "name": "Quarto 1", "person_name": "Ana Silva", "parent_id": "casa"},
    "q3": {"id": "q3", "name": "Quarto 3", "person_name": "Marta Reis", "parent_id": "casa"},
}


def _occ(oid, routine, period, amount, completed=None):
    return {"id": oid, "routine_id": routine, "period_on": period, "due_at": f"{period}T08:00:00+00:00",
            "amount": amount, "completed_at": completed, "closed_reason": "paid" if completed else None}


OCCURRENCES = [
    _occ("o1", "r-ana", "2026-09-01", 550, "2026-09-03T10:00:00+00:00"),
    _occ("o2", "r-marta", "2026-09-05", 600, "2026-09-06T10:00:00+00:00"),  # August's rent
    _occ("o3", "r-condo", "2026-09-05", 45, "2026-09-05T09:00:00+00:00"),
    _occ("o4", "r-marta", "2026-10-05", 600),  # September's rent, part-paid, due in 2 days
    _occ("o5", "r-ana", "2026-10-01", 550),    # October's, already late
]
PAYMENTS = {
    "o1": [{"id": "p1", "amount": 550, "paid_on": "2026-09-03", "method": "mbway"}],
    "o2": [{"id": "p2", "amount": 600, "paid_on": "2026-09-06", "method": "transfer"}],
    "o3": [{"id": "p3", "amount": 45, "paid_on": "2026-09-05", "method": None}],
    "o4": [{"id": "p4", "amount": 200, "paid_on": "2026-09-27", "method": "cash"}],
}


def test_a_month_counts_what_is_for_it_whenever_it_is_paid():
    s = month_summary(SEPT, OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY)
    by_id = {i["id"]: i for i in s["items"]}
    # Marta's 5 October rent is September's; her 5 September rent is August's.
    assert set(by_id) == {"o1", "o3", "o4"}
    income, expense = s["totals"]["income"], s["totals"]["expense"]
    assert (income["target"], income["paid"], income["count"], income["done"]) == ("1150.00", "750.00", 2, 1)
    assert income["late"] == 0  # Marta's is not due until the 5th
    assert (expense["target"], expense["paid"], expense["done"]) == ("45.00", "45.00", 1)
    assert [i["id"] for i in month_summary(AUG, OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY)["items"]] == ["o2"]


def test_each_period_says_who_how_much_when_and_how_late():
    s = month_summary(SEPT, OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY)
    by_id = {i["id"]: i for i in s["items"]}
    ana, marta = by_id["o1"], by_id["o4"]
    assert (ana["person"], ana["place"], ana["paid_late_days"]) == ("Ana Silva", "Casa 1", 2)
    assert [p["paid_on"] for p in ana["payments"]] == ["2026-09-03"]
    assert (marta["ref_month"], marta["period_on"], marta["pct"], marta["late_days"]) == ("2026-09-01", "2026-10-05", 33, 0)
    october = month_summary(OCT, OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY)
    assert october["items"][0]["id"] == "o5" and october["items"][0]["late_days"] == 2  # late first


def test_paid_more_than_due_counts_only_what_was_due():
    payments = {**PAYMENTS, "o1": [{"id": "p1", "amount": 600, "paid_on": "2026-09-01", "method": None}]}
    s = month_summary(SEPT, OCCURRENCES, payments, ROUTINES, RESOURCES, TODAY)
    assert s["totals"]["income"]["paid"] == "750.00"


def test_an_empty_month_is_zero_not_an_error():
    s = month_summary(date(2026, 6, 1), OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY)
    assert s["items"] == [] and s["totals"]["income"]["count"] == 0


def test_a_month_is_complete_before_its_periods_exist():
    s = month_summary(OCT, OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY, project=True)
    rows = {(i["routine_id"], i["period_on"]): i for i in s["items"]}
    # Ana's October period exists; Marta's October rent is due 5 November
    # and the condomínio's 5 October — both not created yet, both counted.
    assert set(rows) == {("r-ana", "2026-10-01"), ("r-marta", "2026-11-05"), ("r-condo", "2026-10-05")}
    assert rows[("r-marta", "2026-11-05")]["scheduled"] is True
    assert rows[("r-marta", "2026-11-05")]["ref_month"] == "2026-10-01"
    assert s["totals"]["income"]["target"] == "1150.00" and s["totals"]["income"]["paid"] == "0.00"
    # Never into the past: September gains nothing it did not have.
    sept = month_summary(SEPT, OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY, project=True)
    assert {i["id"] for i in sept["items"]} == {"o1", "o3", "o4"}


def test_what_is_still_open_from_earlier_months_stays_in_sight():
    owed = owed_before(OCT, OCCURRENCES, PAYMENTS, ROUTINES, RESOURCES, TODAY)
    # Marta's September rent: open, due 5 October, for September.
    assert [(i["id"], i["person"], i["paid"], i["late_days"]) for i in owed] == [("o4", "Marta Reis", "200.00", 0)]
