import { cn } from "@/lib/utils";

// Single source of truth for test status pills. Colour + label, both themes.
// Contrast-safe: solid readable text on a low-alpha tint of the same brand hue.
const STATUS_STYLES: Record<string, string> = {
  running:
    "bg-brand-green/15 text-[#0f7a4b] dark:text-[#4fd99b] border-brand-green/30",
  pending:
    "bg-brand-yellow/20 text-[#8a6a00] dark:text-[#f0be35] border-brand-yellow/40",
  completed:
    "bg-brand-blue/15 text-[#0a6d92] dark:text-[#5cc6ec] border-brand-blue/30",
  paused:
    "bg-brand-peach/25 text-[#a24a2c] dark:text-[#f3b19f] border-brand-peach/40",
  failed:
    "bg-brand-red/15 text-[#c23214] dark:text-[#f7876a] border-brand-red/30",
  scheduled:
    "bg-brand-sky/25 text-[#2f7a83] dark:text-[#9bd6dd] border-brand-sky/40",
};

const LABELS: Record<string, string> = {
  running: "Running",
  pending: "Pending",
  completed: "Completed",
  paused: "Paused",
  failed: "Failed",
  scheduled: "Scheduled",
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const key = status?.toLowerCase() ?? "";
  const style = STATUS_STYLES[key] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        style,
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden />
      {LABELS[key] ?? status}
    </span>
  );
}
