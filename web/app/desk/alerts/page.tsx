"use client";

import { useEffect, useRef, useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import { AlertFilter, AlertRows, AlertsNote } from "@/components/admin/security/AlertViews";
import { Button, Notice, PageTitle } from "@/components/admin/ui";
import { type Alert, type AlertList, alertsApi, PAGE_SIZE } from "@/lib/admin/alerts";
import { api, describeError } from "@/lib/admin/api";

const alerts = alertsApi(api);

export default function AlertsPage() {
  const { refreshAlerts } = useAdmin();
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [list, setList] = useState<Alert[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const focusNext = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    alerts.list({ unseenOnly, limit: PAGE_SIZE }).then(
      (answer: AlertList) => {
        if (!live) return;
        setList(answer.alerts);
        setMore(answer.next_before);
        setError("");
        void refreshAlerts();
      },
      (failure: unknown) => {
        if (!live) return;
        setList(null);
        setError(describeError(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [unseenOnly, refreshAlerts]);

  // After the list changes, put focus where the owner was working (the alert's
  // own row is still there, or the next one waiting, or the heading).
  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    const target = id === "heading" ? heading.current : document.getElementById(`alert-${id}`);
    (target ?? heading.current)?.focus();
  }, [list]);

  async function older() {
    if (!more) return;
    setLoadingMore(true);
    setError("");
    try {
      const answer = await alerts.list({ unseenOnly, before: more, limit: PAGE_SIZE });
      setList((now) => [...(now ?? []), ...answer.alerts]);
      setMore(answer.next_before);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoadingMore(false);
    }
  }

  async function markSeen(alert: Alert) {
    if (!list) return;
    setBusyId(alert.id);
    setError("");
    setDone("");
    try {
      const updated = await alerts.markSeen(alert.id);
      const index = list.findIndex((each) => each.id === alert.id);
      const next = unseenOnly
        ? list.filter((each) => each.id !== alert.id)
        : list.map((each) => (each.id === alert.id ? updated : each));
      // Keep the place: the next alert still waiting, else the one before, else the heading.
      const waiting = (each: Alert) => !each.seen && each.id !== alert.id;
      const neighbour = [...list.slice(index + 1), ...list.slice(0, index).reverse()].find(waiting);
      setList(next);
      setDone("Marked as seen.");
      focusNext.current = unseenOnly ? (neighbour?.id ?? "heading") : alert.id;
      await refreshAlerts();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageTitle>Alerts</PageTitle>
      <AlertsNote />
      <AlertFilter
        unseenOnly={unseenOnly}
        onChange={(value) => {
          setDone("");
          setUnseenOnly(value);
        }}
      />
      <h2 ref={heading} id="alerts-heading" tabIndex={-1} className="mb-3 text-xl font-bold outline-offset-2">
        {unseenOnly ? "Unseen alerts, newest first" : "Alerts, newest first"}
      </h2>
      <Notice kind="done">{done}</Notice>
      <Notice kind="error">{error}</Notice>
      {list === null ? (
        error ? null : <p className="text-muted">Loading…</p>
      ) : list.length === 0 ? (
        <p data-testid="alerts-empty" className="text-muted">
          {unseenOnly ? "No unseen alerts." : "No alerts have been raised yet."}
        </p>
      ) : (
        <>
          <AlertRows alerts={list} busyId={busyId} onSeen={(alert) => void markSeen(alert)} />
          {more && (
            <div className="mt-6">
              <Button disabled={loadingMore} onClick={() => void older()}>
                Show older alerts
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
