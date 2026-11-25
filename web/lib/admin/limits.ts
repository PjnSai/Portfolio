// The contact form's limits: the editable ones with their bounds, and the
// fixed ones shown beside them. The API checks every value again.

import type { AdminApi } from "@/lib/admin/api";

export const EDITABLE_LIMITS = [
  "human_daily_cap",
  "spam_daily_cap",
  "per_address_per_hour",
  "per_email_per_day",
  "min_seconds",
  "max_links",
  "spam_threshold",
  "blocklist_months",
] as const;

export type LimitName = (typeof EDITABLE_LIMITS)[number];

export type LimitInfo = {
  value: number;
  default: number;
  min: number;
  max: number;
};

export type FixedLimit = {
  name: string;
  value: number;
  unit: "count" | "minutes";
};

export type Limits = {
  editable: Record<LimitName, LimitInfo>;
  fixed: FixedLimit[];
};

export const LIMIT_LABEL: Record<LimitName, string> = {
  human_daily_cap: "Messages a day (not held back)",
  spam_daily_cap: "Held-back messages stored a day",
  per_address_per_hour: "Messages an hour from one connection",
  per_email_per_day: "Messages a day from one email address",
  min_seconds: "Seconds before the form can be sent",
  max_links: "Links allowed in a message",
  spam_threshold: "Spam score that holds a message back",
  blocklist_months: "Months a block lasts",
};

export const FIXED_LABEL: Record<string, string> = {
  public_requests_per_minute: "Public requests a minute, per visitor",
  admin_requests_per_minute: "Admin requests a minute",
  sign_in_failures_per_client: "Failed sign-ins before a lock-out, per visitor",
  sign_in_failures_overall: "Failed sign-ins before a lock-out, all visitors",
  sign_in_failure_window: "Window for counting failed sign-ins",
  sign_in_lockout: "Sign-in lock-out",
  session_idle_timeout: "Admin session ends after no activity for",
  session_absolute_timeout: "Admin session ends after",
  passkey_confirmation_lasts: "A passkey confirmation lasts",
  vital_action_wait: "Wait before a vital action can run",
  blocklist_max_entries: "Blocklist size (entries that still block)",
};

export function fixedText(limit: FixedLimit): string {
  if (limit.unit === "count") return String(limit.value);
  const { value } = limit;
  if (value >= 60 && value % 60 === 0) {
    const hours = value / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return value === 1 ? "1 minute" : `${value} minutes`;
}

/** Whole numbers within the bounds, or a message. */
export function checkLimit(text: string, min: number, max: number): string {
  if (!/^[0-9]{1,5}$/.test(text.trim())) return "Enter a whole number.";
  const value = Number(text);
  return value < min || value > max ? `Use a number from ${min} to ${max}.` : "";
}

export type LimitTexts = Record<LimitName, string>;

export function textsFrom(limits: Limits): LimitTexts {
  return Object.fromEntries(
    EDITABLE_LIMITS.map((name) => [name, String(limits.editable[name].value)]),
  ) as LimitTexts;
}

/** The messages per limit and the changed values to send (only those changed). */
export function checkLimits(texts: LimitTexts, limits: Limits) {
  const errors: Partial<Record<LimitName, string>> = {};
  const changes: Partial<Record<LimitName, number>> = {};
  for (const name of EDITABLE_LIMITS) {
    const { min, max, value } = limits.editable[name];
    const problem = checkLimit(texts[name], min, max);
    if (problem) errors[name] = problem;
    else if (Number(texts[name]) !== value) changes[name] = Number(texts[name]);
  }
  return { errors, changes };
}

export function limitsApi(client: AdminApi) {
  return {
    read: () => client.get<Limits>("/limits"),
    /** Saving needs a fresh passkey. */
    save: (changes: Partial<Record<LimitName, number>>) =>
      client.patch<Limits>("/limits", changes),
  };
}

export type LimitsApi = ReturnType<typeof limitsApi>;
