"use client";

import { useCallback, useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import { Button, INPUT, Label, Notice } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import {
  checkLimits,
  EDITABLE_LIMITS,
  FIXED_LABEL,
  fixedText,
  LIMIT_LABEL,
  type LimitName,
  type Limits,
  limitsApi,
  type LimitTexts,
  textsFrom,
} from "@/lib/admin/limits";
import { useLoaded } from "@/lib/admin/use-loaded";

const client = limitsApi(api);

export function LimitsCard() {
  const fetcher = useCallback(() => client.read(), []);
  const { data, error: loadError } = useLoaded(fetcher);
  if (!data) {
    return loadError ? (
      <Notice kind="error">{describeError(loadError)}</Notice>
    ) : (
      <p className="text-muted">Loading…</p>
    );
  }
  return <LimitsForm key={JSON.stringify(textsFrom(data))} start={data} />;
}

function LimitsForm({ start }: { start: Limits }) {
  const { vital } = useAdmin();
  const [texts, setTexts] = useState<LimitTexts>(() => textsFrom(start));
  const [errors, setErrors] = useState<Partial<Record<LimitName, string>>>({});
  const [saved, setSaved] = useState("");
  const [failed, setFailed] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaved("");
    setFailed("");
    const checked = checkLimits(texts, start);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) return;
    if (!Object.keys(checked.changes).length) {
      setSaved("Nothing to save: no limit was changed.");
      return;
    }
    try {
      const result = await vital(() => client.save(checked.changes));
      setTexts(textsFrom(result));
      setSaved("Limits saved. They apply from the next message.");
    } catch (failure) {
      setFailed(describeError(failure));
    }
  }

  return (
    <LimitsFormView
      limits={start}
      texts={texts}
      errors={errors}
      saved={saved}
      failed={failed}
      onChange={(name, text) => setTexts({ ...texts, [name]: text })}
      onSubmit={save}
    />
  );
}

export function LimitsFormView({
  limits,
  texts,
  errors,
  saved,
  failed,
  onChange,
  onSubmit,
}: {
  limits: Limits;
  texts: LimitTexts;
  errors: Partial<Record<LimitName, string>>;
  saved: string;
  failed: string;
  onChange: (name: LimitName, text: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <div className="space-y-8">
      <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="Contact form limits">
        <p className="text-sm text-muted">
          The limits the contact form works to. Whole numbers only, within the
          range shown. They are private and apply from the next message, with no
          publishing. Saving asks for your passkey.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {EDITABLE_LIMITS.map((name) => {
            const info = limits.editable[name];
            const error = errors[name];
            return (
              <label key={name} className="block">
                <Label>{LIMIT_LABEL[name]}</Label>
                <input
                  className={INPUT}
                  inputMode="numeric"
                  value={texts[name]}
                  onChange={(event) => onChange(name, event.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={`limit-${name}-hint`}
                />
                <span
                  id={`limit-${name}-hint`}
                  className={`mt-1 block text-sm ${error ? "text-danger" : "text-muted"}`}
                >
                  {error ? `${error} ` : ""}
                  From {info.min} to {info.max}. Default {info.default}.
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-sm text-muted">
          A block lasts the number of months set here from the day it is added or
          renewed; entries already on the list keep their dates. The list holds{" "}
          {limits.fixed.find((row) => row.name === "blocklist_max_entries")?.value ?? ""}{" "}
          entries that still block.
        </p>
        <Notice kind="error">{failed}</Notice>
        <Notice kind="done">{saved}</Notice>
        <Button type="submit" variant="primary">
          Save limits
        </Button>
      </form>

      <section aria-labelledby="fixed-limits-title">
        <h3 id="fixed-limits-title" className="mb-2 text-lg font-bold">
          Fixed limits
        </h3>
        <p className="mb-3 text-sm text-muted">
          Set in the code and shown here to read. They cannot be changed from
          this page.
        </p>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[1fr_auto]">
          {limits.fixed.map((row) => (
            <div key={row.name} className="contents">
              <dt>{FIXED_LABEL[row.name] ?? row.name.replaceAll("_", " ")}</dt>
              <dd className="font-mono">{fixedText(row)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
