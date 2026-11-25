// The CV manager: types, the hints the page mirrors from the API, and the
// calls. The API decides everything (api/core/cv.py, core/cv_views.py); the
// page only avoids offering what it would refuse. No address or email exists
// in the view log, so none is shown.

import { API_ORIGIN } from "@/lib/api-base";
import { type AdminApi, ApiError, describeError, type Page } from "@/lib/admin/api";

export type CvVersion = {
  id: string;
  size: number;
  sha256: string;
  created_at: string;
  is_live: boolean;
  file: string;
};

export type VersionList = { versions: CvVersion[]; max_versions: number };

export type Switches = { view: boolean; request: boolean; instant_download: boolean };
export type SwitchName = keyof Switches;

type Waiting = {
  id: string;
  kind: string;
  target: Record<string, string | number | boolean>;
  state: "waiting" | "ready";
  requested_at: string;
  execute_after: string;
  expires_at: string;
};

export type SwitchState = Switches & { pending: Waiting[] };

export type ViewKind = "view" | "download";
export type ViewRow = {
  id: string;
  at: string;
  version: string;
  kind: ViewKind;
  country: string;
  user_agent: string;
};
export type DayCount = { day: string; count: number };
export type DayCounts = { days: DayCount[]; total: number };

export const SWITCHES_KIND = "cv_switches";
export const CV_ENTITY = "cv_version";
export const CV_MAX_BYTES = 5 * 1024 * 1024;

export const SWITCH_NAMES: readonly SwitchName[] = ["view", "request", "instant_download"];

export const SWITCH_LABEL: Record<SwitchName, string> = {
  view: "Viewing",
  request: "Requests",
  instant_download: "Instant download",
};

export const SWITCH_HELP: Record<SwitchName, string> = {
  view: "Visitors can open the CV in a pop-up after the human check. There is no download button in it.",
  request:
    "Visitors can ask for a copy with their email. The request lands in your inbox, marked as a CV request.",
  instant_download:
    "Anyone who passes the human check and the limits when asking also gets a download link that works for a minute. Needs requests on.",
};

export function switchesPayload(now: Switches, name: SwitchName, value: boolean): Switches {
  return { view: now.view, request: now.request, instant_download: now.instant_download, [name]: value };
}

const on = (value: boolean) => (value ? "on" : "off");

export function switchesLine(target: Switches): string {
  return `View: ${on(target.view)}. Request: ${on(target.request)}. Instant download: ${on(target.instant_download)}.`;
}

export function isSwitches(target: unknown): target is Switches {
  if (!target || typeof target !== "object") return false;
  const t = target as Record<string, unknown>;
  return SWITCH_NAMES.every((name) => typeof t[name] === "boolean");
}

/** The waiting switch changes, with their targets, oldest first. */
export function pendingSwitches<T extends Waiting>(pending: readonly T[]) {
  return pending
    .filter((action) => action.kind === SWITCHES_KIND && isSwitches(action.target))
    .map((action) => ({ action, target: action.target as unknown as Switches }));
}

/** A waiting deletion of this version. */
export function pendingVersionDeletion<T extends Waiting>(pending: readonly T[], id: string): T | undefined {
  return pending.find(
    (action) =>
      action.kind === "permanent_delete" && action.target.entity === CV_ENTITY && action.target.id === id,
  );
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isFull(versions: readonly CvVersion[], max: number): boolean {
  return versions.length >= max;
}

export const LIVE_DELETE_REASON =
  "The live version cannot be deleted. Set another version live first, then delete this one.";

export function deleteBlocked(version: CvVersion): string {
  return version.is_live ? LIVE_DELETE_REASON : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the owner's browser downloads a version, to attach it to an email. */
export function versionFileHref(id: string): string {
  return UUID.test(id) ? `${API_ORIGIN}/api/v1/admin/cv/versions/${id}/file` : "";
}

export const UPLOAD_HINT = "A PDF, up to 5 MB, with no password and no scripts. It is not made live until you choose.";

/** A quick check before sending. The API checks the file properly. */
export function checkFile(file: { name: string; size: number; type: string }): string {
  if (!/\.pdf$/i.test(file.name) || (file.type !== "" && file.type !== "application/pdf")) {
    return "Choose a PDF file.";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > CV_MAX_BYTES) return "Use a PDF under 5 MB.";
  return "";
}

/** The API's own words for a refused upload; the general wording otherwise. */
export function uploadMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const file = error.fields.file?.[0];
    if (file) return file;
    if (error.code === "cv_versions_full") return error.message;
  }
  return describeError(error);
}

export function kindText(kind: ViewKind): string {
  return kind === "download" ? "Downloaded" : "Viewed";
}

export function countryText(country: string): string {
  return country || "Unknown";
}

export function dayCountText(day: DayCount): string {
  return `${day.count} ${day.count === 1 ? "visit" : "visits"}`;
}

export function cvApi(client: AdminApi) {
  return {
    versions: () => client.get<VersionList>("/cv/versions"),
    /** Needs a fresh passkey (wrap in vital()). */
    upload: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return client.upload<CvVersion>("/cv/versions", form);
    },
    /** Needs a fresh passkey. */
    setLive: (id: string) => client.post<CvVersion>(`/cv/versions/${id}/live`),
    switches: () => client.get<SwitchState>("/cv/switches"),
    /** A vital action: fresh passkey, then 24 hours. */
    requestSwitches: (payload: Switches) =>
      client.post("/vital-actions/request", { kind: SWITCHES_KIND, payload }),
    requestDelete: (id: string) =>
      client.post("/vital-actions/request", {
        kind: "permanent_delete",
        payload: { entity: CV_ENTITY, id },
      }),
    views: (page: number) => client.get<Page<ViewRow>>("/cv/views", { page: page > 1 ? page : undefined }),
    days: () => client.get<DayCounts>("/cv/views/days"),
  };
}

export type CvApi = ReturnType<typeof cvApi>;
