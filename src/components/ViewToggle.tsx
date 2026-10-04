import { HugeiconsIcon } from "@hugeicons/react";
import { GridIcon, ListIcon } from "@hugeicons/core-free-icons";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The one place that decides whether rows render as a list or as cards.
 *
 * Deliberately styled to match the `Selection mode` pill group in
 * `PlaylistTable`, so the page has a single segmented-control idiom rather
 * than two near-identical ones.
 */
export function ViewToggle() {
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);

  return (
    <div
      role="group"
      aria-label="Layout"
      className="inline-flex rounded-lg border border-border bg-field p-0.5"
    >
      {(
        [
          ["list", ListIcon, "List"],
          ["grid", GridIcon, "Grid"],
        ] as const
      ).map(([id, Icon, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={layout === id}
          aria-label={label}
          title={`${label} view`}
          onClick={() => setLayout(id)}
          className={cn(
            "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors",
            layout === id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={Icon} className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
