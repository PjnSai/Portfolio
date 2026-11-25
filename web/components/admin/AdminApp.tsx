"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { alertsApi } from "@/lib/admin/alerts";
import { api, ApiError, Cancelled, describeError } from "@/lib/admin/api";
import { shortDate } from "@/lib/admin/time";
import { signWithPasskey } from "@/lib/admin/webauthn";
import { UnseenBadge } from "./security/AlertViews";
import { Button, Notice } from "./ui";

export const ADMIN = "/desk";

export type PendingAction = {
  id: string;
  kind: string;
  target: Record<string, string | number | boolean>;
  state: "waiting" | "ready";
  requested_at: string;
  execute_after: string;
  expires_at: string;
};

type Status = "loading" | "signed-out" | "signed-in" | "unavailable";

type Admin = {
  status: Status;
  pending: PendingAction[];
  refresh: () => Promise<void>;
  refreshPending: () => Promise<void>;
  /** Check again how the last cache purge and site build went (after a publish). */
  refreshCache: () => Promise<void>;
  /** The alerts nobody has marked seen: null while not known or when it could not be read. */
  unseenAlerts: number | null;
  /** Read the unseen count again (the Alerts page does this on load and after Mark seen). */
  refreshAlerts: () => Promise<void>;
  /** Run a call that may need a fresh passkey confirmation. */
  vital: <T>(call: () => Promise<T>) => Promise<T>;
};

const AdminContext = createContext<Admin | null>(null);

export function useAdmin(): Admin {
  const admin = useContext(AdminContext);
  if (!admin) throw new Error("useAdmin outside AdminApp");
  return admin;
}

async function confirmWithPasskey() {
  const options = await api.post("/elevate/options");
  const credential = await signWithPasskey(options);
  await api.post("/elevate/verify", { credential });
}

/** The last call to the Pages deploy hook (see api/core/deploy.py). */
export type DeployStatus = {
  called_at: string | null;
  result: "ok" | "failed" | null;
  pending: boolean;
  retry_after: number;
};

type SessionState = {
  status: Status;
  pending: PendingAction[];
  purgeFailedAt: string | null;
  deploy: DeployStatus | null;
  unseenAlerts: number | null;
};

const alertsClient = alertsApi(api);

/** The unseen count, or null if it cannot be read: that must not look like "none". */
async function fetchUnseen(): Promise<number | null> {
  try {
    return await alertsClient.count();
  } catch {
    return null;
  }
}

async function fetchPending() {
  return (await api.get<{ actions: PendingAction[] }>("/vital-actions")).actions;
}

async function fetchPurgeFailedAt() {
  return (await api.get<{ purge_failed_at: string | null }>("/cache")).purge_failed_at;
}

async function fetchDeploy() {
  return api.get<DeployStatus>("/deploy");
}

async function checkSession(): Promise<SessionState> {
  try {
    await api.get("/session");
    const [pending, purgeFailedAt, deploy, unseenAlerts] = await Promise.all([
      fetchPending(),
      fetchPurgeFailedAt(),
      fetchDeploy(),
      fetchUnseen(),
    ]);
    return { status: "signed-in", pending, purgeFailedAt, deploy, unseenAlerts };
  } catch (error) {
    const signedOut = error instanceof ApiError && error.status === 401;
    return {
      status: signedOut ? "signed-out" : "unavailable",
      pending: [],
      purgeFailedAt: null,
      deploy: null,
      unseenAlerts: null,
    };
  }
}

const NAV = [
  ["sections", "Sections"],
  ["messages", "Messages"],
  ["contacts", "Contacts"],
  ["blocklist", "Blocklist"],
  ["cv", "CV"],
  ["abuse", "Abuse"],
  ["alerts", "Alerts"],
  ["media", "Media"],
  ["settings", "Settings"],
  ["trash", "Trash"],
  ["pending", "Pending actions"],
  ["audit", "Audit log"],
  ["security", "Security"],
] as const;

export function AdminApp({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<Status>("loading");
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [purgeFailedAt, setPurgeFailedAt] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<DeployStatus | null>(null);
  const [unseenAlerts, setUnseenAlerts] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const answer = useRef<{ resolve: () => void; reject: (e: Error) => void }>(null);

  const refreshPending = useCallback(async () => {
    setPending(await fetchPending());
  }, []);

  const refreshCache = useCallback(async () => {
    const [failedAt, deployed] = await Promise.all([fetchPurgeFailedAt(), fetchDeploy()]);
    setPurgeFailedAt(failedAt);
    setDeploy(deployed);
  }, []);

  const refreshAlerts = useCallback(async () => {
    setUnseenAlerts(await fetchUnseen());
  }, []);

  const apply = useCallback((state: SessionState) => {
    setStatus(state.status);
    setPending(state.pending);
    setPurgeFailedAt(state.purgeFailedAt);
    setDeploy(state.deploy);
    setUnseenAlerts(state.unseenAlerts);
  }, []);

  useEffect(() => {
    let live = true;
    void checkSession().then((state) => {
      if (live) apply(state);
    });
    return () => {
      live = false;
    };
  }, [apply]);

  const refresh = useCallback(async () => apply(await checkSession()), [apply]);

  const vital = useCallback(
    <T,>(call: () => Promise<T>) =>
      api.withPasskey(
        call,
        () =>
          new Promise<void>((resolve, reject) => {
            answer.current = { resolve, reject };
            setAsking(true);
          }),
      ),
    [],
  );

  const admin = {
    status,
    pending,
    refresh,
    refreshPending,
    refreshCache,
    unseenAlerts,
    refreshAlerts,
    vital,
  };
  const open = pathname === `${ADMIN}/setup`;

  return (
    <AdminContext.Provider value={admin}>
      <div className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <header className="flex flex-wrap items-baseline justify-between gap-4 border-b-2 border-ink py-4">
          <Link href={`${ADMIN}/sections`} className="text-lg font-extrabold">
            Site admin
          </Link>
          {status === "signed-in" && (
            <nav aria-label="Admin" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {NAV.map(([path, label]) => {
                const href = `${ADMIN}/${path}`;
                const here = pathname.startsWith(href);
                return (
                  <Link
                    key={path}
                    href={href}
                    aria-current={here ? "page" : undefined}
                    className={here ? "font-bold underline underline-offset-4" : ""}
                  >
                    {label}
                    {path === "alerts" && <UnseenBadge count={unseenAlerts} />}
                  </Link>
                );
              })}
            </nav>
          )}
        </header>
        {status === "signed-in" && pending.length > 0 && (
          <PendingBanner count={pending.length} />
        )}
        {status === "signed-in" && purgeFailedAt && (
          <CacheBanner onRetry={async () => {
            const result = await api.post<{ purge_failed_at: string | null }>("/cache/purge");
            setPurgeFailedAt(result.purge_failed_at);
          }} />
        )}
        {status === "signed-in" && deploy && (
          <DeployState
            deploy={deploy}
            onDeploy={async () => setDeploy(await api.post<DeployStatus>("/deploy"))}
          />
        )}
        <main className="pt-8">
          {open ? (
            children
          ) : status === "loading" ? (
            <p className="text-muted">Loading…</p>
          ) : status === "unavailable" ? (
            <Notice kind="error">
              The admin cannot reach the server. Check your connection and reload.
            </Notice>
          ) : status === "signed-out" ? (
            <SignIn onDone={refresh} />
          ) : (
            children
          )}
        </main>
      </div>
      {asking && (
        <PasskeyDialog
          onConfirmed={() => {
            setAsking(false);
            answer.current?.resolve();
          }}
          onCancel={() => {
            setAsking(false);
            answer.current?.reject(new Cancelled());
          }}
        />
      )}
    </AdminContext.Provider>
  );
}

function PendingBanner({ count }: { count: number }) {
  return (
    <div
      role="status"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-notice px-4 py-3 text-sm font-semibold text-on-notice"
    >
      <span>
        {count === 1 ? "1 vital action is waiting." : `${count} vital actions are waiting.`}{" "}
        You can cancel any of them before it runs.
      </span>
      <Link href={`${ADMIN}/pending`} className="underline underline-offset-4">
        Review pending actions
      </Link>
    </div>
  );
}

function CacheBanner({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div
      role="status"
      data-testid="cache-banner"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-notice px-4 py-3 text-sm font-semibold text-on-notice"
    >
      <span>
        Your last change is saved and live, but the cache could not be cleared, so some visitors may
        still see the old version. {error}
      </span>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await onRetry();
          } catch (failure) {
            setError(describeError(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        Clear the cache again
      </Button>
    </div>
  );
}

function DeployState({
  deploy,
  onDeploy,
}: {
  deploy: DeployStatus;
  onDeploy: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needed = deploy.pending || deploy.result === "failed";
  const last = deploy.called_at
    ? `Last site build requested ${shortDate(deploy.called_at)}${
        deploy.result === "failed" ? ", but Cloudflare did not accept it" : ""
      }.`
    : "No site build requested yet.";
  return (
    <div
      role="status"
      data-testid="deploy-state"
      className={`mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md px-4 py-3 text-sm ${
        needed ? "bg-notice font-semibold text-on-notice" : "text-muted"
      }`}
    >
      <span>
        {last}{" "}
        {deploy.pending &&
          (deploy.retry_after > 0
            ? `A later change waits for the next build, possible in ${deploy.retry_after} seconds.`
            : "A later change waits for the next build.")}{" "}
        {error}
      </span>
      {needed && (
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onDeploy();
            } catch (failure) {
              setError(describeError(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          Build the site now
        </Button>
      )}
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const options = await api.post("/login/options");
      const credential = await signWithPasskey(options);
      await api.post("/login/verify", { credential });
      await onDone();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 401
          ? "That passkey was not accepted."
          : describeError(failure),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sign-in" className="max-w-md">
      <h1 id="sign-in" className="mb-4 text-3xl font-extrabold">
        Sign in
      </h1>
      <p className="mb-6 text-muted">Use the passkey on this device or your security key.</p>
      <Button variant="primary" onClick={signIn} disabled={busy}>
        Sign in with passkey
      </Button>
      <Notice kind="error">{error}</Notice>
      <p className="mt-8 text-sm text-muted">
        First time? <Link href={`${ADMIN}/setup`} className="underline">Set up your first passkey</Link>.
      </p>
    </section>
  );
}

function PasskeyDialog({
  onConfirmed,
  onCancel,
}: {
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await confirmWithPasskey();
      onConfirmed();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "That passkey was not accepted."
          : describeError(failure),
      );
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-ink/60 p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-lg border-2 border-ink bg-paper p-6"
      >
        <h2 id="confirm-title" className="mb-2 text-xl font-extrabold">
          Confirm with your passkey
        </h2>
        <p className="mb-6 text-sm text-muted">
          This is a vital action, so your passkey is needed again. The confirmation
          lasts five minutes.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={confirm} disabled={busy}>
            Use passkey
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Not now
          </Button>
        </div>
        <Notice kind="error">{error}</Notice>
      </div>
    </div>
  );
}
