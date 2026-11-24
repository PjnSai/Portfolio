"use client";

import { useCallback, useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import {
  Button,
  FieldErrors,
  INPUT,
  Label,
  Notice,
} from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import { inboxApi, type Retention } from "@/lib/admin/inbox";
import { useLoaded } from "@/lib/admin/use-loaded";

const inbox = inboxApi(api);

/** Whole days within the limits, or an error message. */
export function checkDays(text: string, min: number, max: number): string {
  if (!/^[0-9]{1,5}$/.test(text.trim())) return "Enter a whole number of days.";
  const days = Number(text);
  return days < min || days > max ? `Use between ${min} and ${max} days.` : "";
}

export function RetentionCard() {
  const fetcher = useCallback(() => inbox.retention(), []);
  const { data, error: loadError } = useLoaded(fetcher);
  if (!data) {
    return loadError ? (
      <Notice kind="error">{describeError(loadError)}</Notice>
    ) : (
      <p className="text-muted">Loading…</p>
    );
  }
  return (
    <RetentionForm
      key={`${data.spam_days}-${data.message_days}`}
      start={data}
    />
  );
}

function RetentionForm({ start }: { start: Retention }) {
  const { vital } = useAdmin();
  const [spam, setSpam] = useState(String(start.spam_days));
  const [other, setOther] = useState(String(start.message_days));
  const [errors, setErrors] = useState<{ spam: string; other: string }>({
    spam: "",
    other: "",
  });
  const [saved, setSaved] = useState("");
  const [failed, setFailed] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaved("");
    setFailed("");
    const next = {
      spam: checkDays(spam, start.min_days, start.max_days),
      other: checkDays(other, start.min_days, start.max_days),
    };
    setErrors(next);
    if (next.spam || next.other) return;
    try {
      const result = await vital(() =>
        inbox.saveRetention(Number(spam), Number(other)),
      );
      setSpam(String(result.spam_days));
      setOther(String(result.message_days));
      setSaved(
        "Retention saved. Every message's removal date has been updated.",
      );
    } catch (failure) {
      setFailed(describeError(failure));
    }
  }

  return (
    <form
      onSubmit={save}
      noValidate
      className="space-y-4"
      aria-labelledby="retention-title"
    >
      <p className="text-sm text-muted">
        How long contact messages are kept before the daily clean-up may remove
        them. A message you mark as kept, or that has notes, is never removed
        automatically. These settings are private and take effect at once: they
        do not need publishing. Saving asks for your passkey.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <Label>Spam: days to keep</Label>
          <input
            className={INPUT}
            inputMode="numeric"
            value={spam}
            onChange={(event) => setSpam(event.target.value)}
            aria-invalid={errors.spam ? true : undefined}
            aria-describedby="retention-spam-error"
          />
          <span id="retention-spam-error">
            <FieldErrors messages={errors.spam ? [errors.spam] : []} />
          </span>
        </label>
        <label className="block">
          <Label>Other messages: days to keep</Label>
          <input
            className={INPUT}
            inputMode="numeric"
            value={other}
            onChange={(event) => setOther(event.target.value)}
            aria-invalid={errors.other ? true : undefined}
            aria-describedby="retention-other-error"
          />
          <span id="retention-other-error">
            <FieldErrors messages={errors.other ? [errors.other] : []} />
          </span>
        </label>
      </div>
      <Notice kind="error">{failed}</Notice>
      <Notice kind="done">{saved}</Notice>
      <Button type="submit" variant="primary">
        Save retention
      </Button>
    </form>
  );
}
