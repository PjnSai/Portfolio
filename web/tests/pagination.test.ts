import { describe, expect, it } from "vitest";
import { pageCount, pageHref, pageInfo, pageParams, parsePage } from "@/lib/public/pagination";

describe("page counts", () => {
  it.each([
    [0, 1],
    [1, 1],
    [6, 1],
    [7, 2],
    [12, 2],
    [13, 3],
  ])("%i projects make %i pages", (total, pages) => {
    expect(pageCount(total)).toBe(pages);
  });

  it("takes another page size", () => {
    expect(pageCount(10, 3)).toBe(4);
  });
});

describe("page links", () => {
  it("page 1 is /projects and others sit under /projects/page/", () => {
    expect(pageHref(1)).toBe("/projects");
    expect(pageHref(2)).toBe("/projects/page/2");
  });

  it("the first page has a next link and no previous link", () => {
    const info = pageInfo(13, 1);
    expect(info.prev).toBeUndefined();
    expect(info.next).toBe("/projects/page/2");
    expect([info.start, info.end]).toEqual([0, 6]);
  });

  it("the last page has a previous link and no next link, and holds the rest", () => {
    const info = pageInfo(13, 3);
    expect(info.prev).toBe("/projects/page/2");
    expect(info.next).toBeUndefined();
    expect([info.start, info.end]).toEqual([12, 13]);
  });

  it("numbers every page and marks only the current one", () => {
    const info = pageInfo(13, 2);
    expect(info.links.map((l) => l.href)).toEqual(["/projects", "/projects/page/2", "/projects/page/3"]);
    expect(info.links.filter((l) => l.current).map((l) => l.page)).toEqual([2]);
  });

  it("one page has neither previous nor next", () => {
    const info = pageInfo(4, 1);
    expect(info.prev).toBeUndefined();
    expect(info.next).toBeUndefined();
    expect(info.outOfRange).toBe(false);
  });
});

describe("out of range", () => {
  it.each([0, -1, 4, 99, 1.5, Number.NaN])("page %s of 13 projects is out of range", (page) => {
    const info = pageInfo(13, page);
    expect(info.outOfRange).toBe(true);
    expect(info.end - info.start).toBe(0);
    expect(info.prev).toBeUndefined();
    expect(info.next).toBeUndefined();
    expect(info.links.some((l) => l.current)).toBe(false);
  });

  it("reads only plain page numbers", () => {
    expect(parsePage("2")).toBe(2);
    for (const bad of ["0", "02", "-1", "2.0", "two", "", "1e3"]) expect(parsePage(bad)).toBeNaN();
  });
});

describe("pages built", () => {
  it("builds page 2 onwards", () => {
    expect(pageParams(13)).toEqual([{ n: "2" }, { n: "3" }]);
  });

  it("with one page, builds page 2 to say it is out of range", () => {
    expect(pageParams(6)).toEqual([{ n: "2" }]);
    expect(pageInfo(6, 2).outOfRange).toBe(true);
  });
});
