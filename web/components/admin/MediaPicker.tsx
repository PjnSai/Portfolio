"use client";

import { useCallback, useState } from "react";
import { Button, Pager } from "@/components/admin/ui";
import { api, describeError, type Page } from "@/lib/admin/api";
import { type MediaItem, previewUrl } from "@/lib/admin/media";
import { useLoaded } from "@/lib/admin/use-loaded";

/** A small preview of a library image, published or not. */
export function Thumbnail({ id, alt }: { id: string; alt: string }) {
  return (
    // The admin preview route needs the session cookie, so next/image is not used.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={previewUrl(id)}
      alt={alt}
      width={160}
      height={120}
      loading="lazy"
      className="h-24 w-32 rounded-md border border-line bg-paper object-cover"
      data-testid="thumbnail"
    />
  );
}

/** One page of the library at a time, with a button to use each image. */
export function MediaPicker({
  onPick,
  onClose,
}: {
  onPick: (item: MediaItem) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const fetcher = useCallback(() => api.get<Page<MediaItem>>("/media", { page }), [page]);
  const { data, error } = useLoaded(fetcher);

  return (
    <div className="rounded-lg border-2 border-ink bg-panel p-3" data-testid="media-picker">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-bold">Choose an image</p>
        <Button onClick={onClose}>Close</Button>
      </div>
      {error ? (
        <p className="text-sm text-danger">{describeError(error)}</p>
      ) : !data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : data.results.length === 0 ? (
        <p className="text-sm text-muted">
          The media library is empty. Upload images on the Media page first.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.results.map((item) => (
            <li key={item.id} className="flex items-center gap-3">
              <Thumbnail id={item.id} alt={item.alt} />
              <div className="min-w-0 grow">
                <p className="truncate text-sm">{item.alt}</p>
                <Button aria-label={`Use ${item.alt}`} onClick={() => onPick(item)}>
                  Use this image
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && <Pager page={data.page} pages={data.pages} onPage={setPage} />}
    </div>
  );
}
