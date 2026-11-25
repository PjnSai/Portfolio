// The abuse overview: counts of refusals and flags per kind and day. The API
// holds counts only (api/core/abuse.py), so nothing here can show an address or
// a message.

import { z } from "zod";
import { checked } from "@/lib/admin/answer";
import type { AdminApi } from "@/lib/admin/api";

export const KINDS = [
  "rate_limited",
  "blocked_sender",
  "turnstile_failed",
  "rejected_form",
  "spam",
  "honeypot_or_timing",
  "login_failed",
  "elevation_failed",
  "guard_refused",
  "notice_failed",
] as const;

export type AbuseKind = (typeof KINDS)[number];

export const KIND_WORDS: Record<AbuseKind, { label: string; help: string }> = {
  rate_limited: {
    label: "Too many requests",
    help: "A visitor or the admin went over a rate limit and was turned away.",
  },
  blocked_sender: {
    label: "Blocked sender",
    help: "A message came from an address on the blocklist.",
  },
  turnstile_failed: {
    label: "Human check failed",
    help: "The human check on a form was missing or failed.",
  },
  rejected_form: {
    label: "Form not accepted",
    help: "A public form had a missing or invalid field, or could not be read.",
  },
  spam: {
    label: "Held back as spam",
    help: "A message was held back for its links, a repeat or its spam score.",
  },
  honeypot_or_timing: {
    label: "Hidden field or too quick",
    help: "A form filled in the hidden field or was sent faster than a person could.",
  },
  login_failed: {
    label: "Failed sign-in",
    help: "A sign-in, first set-up or recovery attempt failed.",
  },
  elevation_failed: {
    label: "Failed passkey confirmation",
    help: "A passkey confirmation for a vital action failed.",
  },
  guard_refused: {
    label: "Refused at the door",
    help: "The request guard refused a request: wrong origin, no valid Access token, or too large.",
  },
  notice_failed: {
    label: "Notice not sent",
    help: "A notice to you could not be recorded or sent.",
  },
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY);
const count = z.number().int().min(0);
const kind = z.enum(KINDS);

const schema = z.object({
  from: day,
  to: day,
  kinds: z.array(kind).min(1),
  totals: z.partialRecord(kind, count),
  days: z.array(z.object({ day, counts: z.partialRecord(kind, count) })),
});

export type AbuseSummary = z.infer<typeof schema>;
export type Range = { from: string; to: string; kind?: AbuseKind };

export const MAX_DAYS = 366;
export const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** The last 30 days up to today, as the API counts them: in UTC. */
export function defaultRange(now: Date = new Date()): Range {
  const to = iso(now);
  return { from: iso(new Date(now.getTime() - (DEFAULT_DAYS - 1) * DAY_MS)), to };
}

function parsed(text: string): number | null {
  if (!DAY.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(time) || iso(new Date(time)) !== text ? null : time;
}

/** The problem with a range in words, or an empty string. */
export function checkRange(from: string, to: string): string {
  if (!from) return "Choose a start date.";
  if (!to) return "Choose an end date.";
  const start = parsed(from);
  const end = parsed(to);
  if (start === null || end === null) return "Use a real date.";
  if (start > end) return "The start date must be before the end date, or the same day.";
  if ((end - start) / DAY_MS >= MAX_DAYS) return `Choose at most ${MAX_DAYS} days.`;
  return "";
}

/** A bar's width as a whole percent of the busiest day; any count shows at least 2. */
export function barPercent(value: number, busiest: number): number {
  if (value <= 0 || busiest <= 0) return 0;
  return Math.max(2, Math.round((value / busiest) * 100));
}

export function abuseApi(client: AdminApi) {
  return {
    read: async ({ from, to, kind }: Range) =>
      checked(schema, await client.get("/abuse", { from, to, kind })),
  };
}

export type AbuseApi = ReturnType<typeof abuseApi>;
