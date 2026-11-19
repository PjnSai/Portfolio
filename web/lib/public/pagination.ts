// /projects split into pages at build time. Page 1 is /projects; page n is
// /projects/page/n. Pure functions, so the maths has unit tests.

export const PAGE_SIZE = 6;

export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

export function pageHref(page: number): string {
  return page <= 1 ? "/projects" : `/projects/page/${page}`;
}

export type PageInfo = {
  page: number;
  pages: number;
  outOfRange: boolean;
  /** Index of the first item on this page and one past the last. */
  start: number;
  end: number;
  prev?: string;
  next?: string;
  links: { page: number; href: string; current: boolean }[];
};

export function pageInfo(total: number, page: number, size = PAGE_SIZE): PageInfo {
  const pages = pageCount(total, size);
  const outOfRange = !Number.isInteger(page) || page < 1 || page > pages;
  const start = outOfRange ? 0 : (page - 1) * size;
  return {
    page,
    pages,
    outOfRange,
    start,
    end: outOfRange ? 0 : Math.min(total, start + size),
    prev: !outOfRange && page > 1 ? pageHref(page - 1) : undefined,
    next: !outOfRange && page < pages ? pageHref(page + 1) : undefined,
    links: Array.from({ length: pages }, (_, i) => ({
      page: i + 1,
      href: pageHref(i + 1),
      current: !outOfRange && i + 1 === page,
    })),
  };
}

/** The n values to build under /projects/page/. A static export needs at
    least one, so with a single page the first page past the end is built and
    says so. */
export function pageParams(total: number, size = PAGE_SIZE): { n: string }[] {
  const pages = pageCount(total, size);
  if (pages === 1) return [{ n: "2" }];
  return Array.from({ length: pages - 1 }, (_, i) => ({ n: String(i + 2) }));
}

/** "2" as 2; anything that is not a plain positive whole number as NaN. */
export function parsePage(value: string): number {
  return /^[1-9]\d{0,5}$/.test(value) ? Number(value) : Number.NaN;
}
