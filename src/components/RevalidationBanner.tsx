import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { PlanBatchResult } from "@shared/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  planning: boolean;
  /** Null when no re-check has run for the current selection. */
  counts: PlanBatchResult["counts"] | null;
  /** How many entries were actually checked. */
  checked: number;
  error?: string | null;
  /** Container/format label, so "up to date" says up to date *as what*. */
  formatLabel?: string;
  onApply: () => void;
  onDismiss: () => void;
  className?: string;
}

/**
 * What the last re-check found, and the one click that acts on it.
 *
 * Shown rather than acted on automatically: re-evaluating is free and
 * reversible, but queueing downloads and re-encodes because a dropdown moved
 * is not. The system keeps the answer current on its own; starting the work
 * stays a decision.
 */
export function RevalidationBanner({
  planning,
  counts,
  checked,
  error,
  formatLabel,
  onApply,
  onDismiss,
  className,
}: Props) {
  if (planning) {
    return (
      <p
        className={cn(
          "flex items-center justify-center gap-1.5 text-[11px] text-faint",
          className,
        )}
      >
        <HugeiconsIcon
          icon={Loading03Icon}
          className="h-3 w-3 animate-spin"
        />
        Re-checking against {formatLabel || "the selected format"}…
      </p>
    );
  }

  if (error) {
    return (
      <p className={cn("text-[11px] text-destructive", className)}>{error}</p>
    );
  }

  if (!counts || checked === 0) return null;

  const needs = counts.convert + counts.download;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-field px-3 py-2",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {needs > 0 ? (
            <>
              <span className="font-semibold tabular-nums text-foreground">
                {needs}
              </span>
              {` of ${checked} already on disk ${needs === 1 ? "needs" : "need"} updating`}
              {counts.convert > 0 ? ` · ${counts.convert} convert` : ""}
              {counts.download > 0 ? ` · ${counts.download} re-download` : ""}
            </>
          ) : (
            <span className="inline-flex items-center gap-1">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                className="h-3 w-3 shrink-0"
              />
              {`All ${checked} already match ${formatLabel || "this format"}.`}
            </span>
          )}
        </p>

        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 cursor-pointer text-[11px] text-faint transition-colors hover:text-foreground"
        >
          Dismiss
        </button>
      </div>

      {needs > 0 ? (
        <Button size="sm" className="mt-2 w-full" onClick={onApply}>
          <HugeiconsIcon icon={RefreshIcon} className="mr-1.5 h-3.5 w-3.5" />
          {`Update ${needs}`}
        </Button>
      ) : null}
    </div>
  );
}
