// The IANA zone the phone is set to ("Europe/Lisbon"), or null if the
// platform will not say. The server needs it to read quiet hours, "today"
// and "tomorrow morning" in the user's own time rather than in UTC.
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
