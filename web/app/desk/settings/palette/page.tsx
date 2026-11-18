"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { ADMIN } from "@/components/admin/AdminApp";
import { PaletteEditor } from "@/components/admin/palettes/PaletteEditor";
import { Notice, PageTitle } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import { useLoaded } from "@/lib/admin/use-loaded";
import type { AdminPalette } from "@/lib/palettes";

// One static page; the palette id comes from the query string because custom
// palettes are made after the site is built.
const ID = /^[0-9a-f-]{36}$/;

export default function PaletteEditorPage() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <FromQuery />
    </Suspense>
  );
}

function BackLink() {
  return (
    <Link href={`${ADMIN}/settings#palettes`} className="underline">
      Back to palettes
    </Link>
  );
}

function FromQuery() {
  const id = useSearchParams().get("id") ?? "";
  if (!ID.test(id)) {
    return (
      <Notice kind="error">
        No palette chosen. <BackLink />
      </Notice>
    );
  }
  return <Loaded key={id} id={id} />;
}

function Loaded({ id }: { id: string }) {
  const fetcher = useCallback(() => api.get<AdminPalette>(`/palettes/${id}`), [id]);
  const { data, error } = useLoaded(fetcher);

  if (!data) {
    return error ? (
      <Notice kind="error">
        {describeError(error)} <BackLink />
      </Notice>
    ) : (
      <p className="text-muted">Loading…</p>
    );
  }
  if (data.kind === "preset") {
    return (
      <>
        <PageTitle>{data.name}</PageTitle>
        <Notice>
          Presets cannot be changed. Use “Duplicate to edit” on the palette list to make your own copy. <BackLink />
        </Notice>
      </>
    );
  }
  return (
    <>
      <PageTitle>Edit palette: {data.name}</PageTitle>
      <PaletteEditor palette={data} />
    </>
  );
}
