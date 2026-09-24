// What needs the user today, and which one thing needs them first.
//
// Pure functions over the tasks already in the store: the universe header
// and the "Needs you first" card both answer from here, so they can never
// disagree about what counts. No request, no AI — these are date
// comparisons, and asking a model to compare dates costs money to be
// occasionally wrong.

import type { ServerTask } from "@/services/api";

/** The end of the calendar day `now` falls in, in the device's own zone. */
function endOfToday(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function isLive(task: ServerTask): boolean {
  return task.status === "active";
}

function dueAt(task: ServerTask): Date | null {
  return task.due_at ? new Date(task.due_at) : null;
}

/** How many tasks need the user today: overdue ones, plus anything due
 * before midnight.
 *
 * Overdue counts because "today" is when it has to be dealt with, however
 * long ago it was due. Undated tasks do not count — they have no today, and
 * counting them would make the number mean "everything you have" rather
 * than "what today asks of you".
 */
export function needsYouToday(tasks: ServerTask[], now = new Date()): number {
  const end = endOfToday(now);
  return tasks.filter((task) => {
    if (!isLive(task)) return false;
    const due = dueAt(task);
    return due !== null && due <= end;
  }).length;
}

/** The single task to surface above the mic, or null.
 *
 * Overdue beats due-today, and within overdue the OLDEST wins, not the
 * highest pressure: the question the card answers is "what have I let
 * slide", and the thing longest past its date is the truest answer. Among
 * tasks merely due today, pressure breaks the tie, since none of them is
 * late yet.
 *
 * Null when nothing is due today. The card then does not render at all —
 * an empty "nothing needs you" panel is a box of reassurance that pushes
 * the universe up for no information.
 */
export function firstPriority(
  tasks: ServerTask[],
  now = new Date(),
): ServerTask | null {
  const end = endOfToday(now);
  const live = tasks.filter(isLive);

  const overdue = live
    .filter((task) => {
      const due = dueAt(task);
      return due !== null && due < now;
    })
    .sort((a, b) => dueAt(a)!.getTime() - dueAt(b)!.getTime());
  if (overdue.length > 0) return overdue[0];

  const today = live
    .filter((task) => {
      const due = dueAt(task);
      return due !== null && due >= now && due <= end;
    })
    .sort((a, b) => (b.pressure_score ?? 0) - (a.pressure_score ?? 0));
  return today[0] ?? null;
}

/** Whole calendar days between two instants, in the device's zone.
 *
 * Calendar days rather than 24-hour periods: something due at 23:00
 * yesterday is "1 day late" at 08:00 today, even though only nine hours
 * have passed. That is how people count lateness, and a card saying
 * "0 days late" for yesterday's bill would be technically right and
 * useless.
 */
function calendarDaysBetween(earlier: Date, later: Date): number {
  const a = new Date(earlier);
  a.setHours(0, 0, 0, 0);
  const b = new Date(later);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** The due line under the task's title: "2 days late", "Due at 18:00". */
export function describeDue(
  task: ServerTask,
  t: (key: string, vars?: Record<string, string>) => string,
  now = new Date(),
): string {
  const due = dueAt(task);
  if (!due) return "";

  if (due < now) {
    const days = calendarDaysBetween(due, now);
    if (days <= 0) return t("Late today");
    if (days === 1) return t("1 day late");
    return t("{n} days late", { n: String(days) });
  }

  const time = due.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return t("Due at {time}", { time });
}
