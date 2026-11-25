import type { PendingAction } from "@/components/admin/AdminApp";
import { Button } from "@/components/admin/ui";
import {
  ERASE_KIND,
  ERASE_TITLE,
  eraseSummary,
  isEraseTarget,
} from "@/lib/admin/erase";
import { CV_ENTITY, isSwitches, SWITCHES_KIND, switchesLine } from "@/lib/admin/cv";
import { shortDate, timeLeft } from "@/lib/admin/time";

/** What a waiting action is, in words. Never the raw kind for one we know. */
export function describeAction(action: PendingAction): string {
  switch (action.kind) {
    case "permanent_delete":
      return action.target.entity === CV_ENTITY
        ? "Delete a CV version for good"
        : `Delete a ${action.target.entity ?? "record"} for good`;
    case SWITCHES_KIND:
      return "Change the CV switches";
    case "add_passkey":
      return `Add a passkey called “${action.target.name}”`;
    case "revoke_passkey":
      return "Remove a passkey";
    case ERASE_KIND:
      return ERASE_TITLE;
    default:
      return action.kind;
  }
}

export function PendingRow({
  action,
  now,
  onCancel,
  onRun,
}: {
  action: PendingAction;
  now: Date;
  onCancel: () => void;
  onRun: () => void;
}) {
  return (
    <li
      data-testid="pending-row"
      className="rounded-lg border-2 border-ink bg-panel p-4"
    >
      <p className="font-bold">{describeAction(action)}</p>
      {action.kind === ERASE_KIND && isEraseTarget(action.target) && (
        <p data-testid="erase-summary" className="mt-1 text-sm">
          {eraseSummary(action.target)}
        </p>
      )}
      {action.kind === SWITCHES_KIND && isSwitches(action.target) && (
        <p data-testid="cv-summary" className="mt-1 text-sm">
          {switchesLine(action.target)}
        </p>
      )}
      <p className="mb-4 text-sm text-muted">
        Requested {shortDate(action.requested_at)}.{" "}
        {action.state === "waiting" ? (
          <span data-testid="time-left">
            Can run in {timeLeft(action.execute_after, now).replace(" left", "")}.
          </span>
        ) : (
          <span data-testid="time-left">
            Ready. Expires unused in{" "}
            {timeLeft(action.expires_at, now).replace(" left", "")}.
          </span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" onClick={onCancel}>
          Cancel this action
        </Button>
        {action.state === "ready" && (
          <Button variant="primary" onClick={onRun}>
            Run now
          </Button>
        )}
      </div>
    </li>
  );
}
