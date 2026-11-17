import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "plain" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-paper border-ink",
  plain: "bg-panel text-ink border-line",
  danger: "bg-panel text-danger border-danger",
};

export function Button({
  variant = "plain",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`min-h-11 rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-6 text-3xl font-extrabold tracking-tight">{children}</h1>;
}

export function Notice({
  kind = "info",
  children,
}: {
  kind?: "info" | "error" | "done";
  children: ReactNode;
}) {
  if (!children) return null;
  const tone =
    kind === "error"
      ? "border-danger text-danger"
      : kind === "done"
        ? "border-ok text-ok"
        : "border-line text-ink";
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={`my-4 rounded-md border-l-4 bg-panel px-4 py-3 text-sm ${tone}`}
    >
      {children}
    </p>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
      {children}
    </span>
  );
}

export const INPUT =
  "w-full min-h-11 rounded-md border border-line bg-panel px-3 py-2 text-base text-ink";

export function FieldErrors({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return <span className="mt-1 block text-sm text-danger">{messages.join(" ")}</span>;
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-4">{children}</div>
  );
}

export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="mt-6 flex items-center gap-3">
      <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="font-mono text-sm">
        Page {page} of {pages}
      </span>
      <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
