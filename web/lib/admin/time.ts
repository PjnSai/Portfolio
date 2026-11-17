const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long until a moment, in words: "23 h 59 min left". */
export function timeLeft(until: string, now: Date = new Date()): string {
  const left = new Date(until).getTime() - now.getTime();
  if (left <= 0) return "time is up";
  if (left > 2 * DAY) return `${Math.floor(left / DAY)} days left`;
  if (left < MINUTE) return "under a minute left";
  const hours = Math.floor(left / HOUR);
  const minutes = Math.floor((left % HOUR) / MINUTE);
  return hours ? `${hours} h ${minutes} min left` : `${minutes} min left`;
}

export function shortDate(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
