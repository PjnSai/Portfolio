"use client";

import { useState } from "react";
import { Button } from "@/components/admin/ui";
import { ApiError } from "@/lib/admin/api";
import { shortDate } from "@/lib/admin/time";

export type Warning = { where: string; kind: string; text: string };

const KINDS: Record<string, string> = {
  email: "an email address",
  phone: "a phone number",
  postcode: "a postcode",
};

/** The warnings in a refused publish, or null if it was refused for another reason. */
export function privacyWarnings(error: unknown): Warning[] | null {
  if (error instanceof ApiError && error.code === "privacy_check") {
    return Array.isArray(error.body.warnings) ? (error.body.warnings as Warning[]) : [];
  }
  return null;
}

export function PublishBar({
  unpublished,
  publishedAt,
  warnings,
  publish,
}: {
  unpublished: boolean;
  publishedAt: string | null;
  warnings: Warning[];
  /** Publish; resolves to warnings if the API asks for confirmation first. */
  publish: (confirm: boolean) => Promise<Warning[] | null>;
}) {
  const [asking, setAsking] = useState<Warning[] | null>(null);

  async function start() {
    if (warnings.length) {
      setAsking(warnings);
      return;
    }
    setAsking(await publish(false));
  }

  return (
    <div className="mb-8 rounded-lg border-2 border-ink p-4">
      <div className="flex flex-wrap items-center gap-4">
        <p className="grow text-sm" data-testid="publish-state">
          {unpublished ? "The draft has changes that are not live yet." : "The live site shows this draft."}{" "}
          {publishedAt ? `Last published ${shortDate(publishedAt)}.` : "Never published."}
        </p>
        <Button variant="primary" onClick={start} disabled={asking !== null}>
          Publish
        </Button>
      </div>
      {asking && (
        <div role="alertdialog" aria-labelledby="privacy-title" className="mt-4 border-t-2 border-ink pt-4">
          <h2 id="privacy-title" className="mb-2 text-lg font-bold">
            Check before publishing
          </h2>
          <p className="mb-2 text-sm">
            This text looks like it holds contact details. The public site should not show your email
            address, phone number or home address.
          </p>
          <ul className="mb-4 list-disc space-y-1 pl-5 text-sm" data-testid="privacy-warnings">
            {asking.map((warning, index) => (
              <li key={index}>
                {warning.where}: {KINDS[warning.kind] ?? warning.kind}{" "}
                <code className="font-mono">{warning.text}</code>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAsking(null)}>Go back and edit</Button>
            <Button
              variant="danger"
              onClick={async () => {
                setAsking(null);
                await publish(true);
              }}
            >
              Publish anyway
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
