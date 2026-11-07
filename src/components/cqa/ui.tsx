import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "quiet" }) {
  const styles = {
    primary: "bg-accent text-on-accent hover:opacity-90",
    ghost: "bg-surface text-ink border border-line hover:bg-accent-soft",
    danger: "bg-critical text-on-accent hover:opacity-90",
    quiet: "bg-transparent text-ink hover:bg-accent-soft",
  }[variant];
  return (
    <button
      {...props}
      className={cx(
        "inline-flex h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition disabled:opacity-50",
        styles,
        className,
      )}
    />
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-muted">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent";

export function formatTotal(total: number | null | undefined): string {
  if (total === null || total === undefined) return "—";
  return total.toFixed(2);
}

export function channelLabel(channel: string): string {
  if (channel === "agent chat") return "чат";
  if (channel === "voice call") return "звонок";
  return channel;
}

export function sourceLabel(source: string): string {
  if (source === "ai" || source === "grok") return "AI";
  if (source === "heuristic" || source === "rules") return "эвристика";
  if (source === "demo") return "демо";
  return "вручную";
}
