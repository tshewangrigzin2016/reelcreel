import { useEffect } from "react";
import { Command } from "cmdk";
import {
  Delete02Icon,
  Download04Icon,
  FolderOpenIcon,
  HistoryIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  actions: Array<{ label: string; hint?: string; run: () => void }>;
}

export function CommandPalette({ open, onOpenChange, actions }: Props) {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command menu"
      className="fixed inset-0 z-50"
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed left-1/2 top-[20%] z-50 w-full max-w-md -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <Command.Input
          placeholder="Type a command…"
          className="w-full border-b border-border bg-transparent px-4 py-3.5 text-sm outline-none placeholder:text-faint"
        />
        <Command.List className="max-h-72 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-xs text-faint">
            No results.
          </Command.Empty>
          {actions.map((a) => (
            <Command.Item
              key={a.label}
              onSelect={() => {
                a.run();
                onOpenChange(false);
              }}
              className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm text-muted-foreground data-[selected=true]:bg-secondary data-[selected=true]:text-foreground"
            >
              <span>{a.label}</span>
              {a.hint ? (
                <span className="text-xs text-faint">{a.hint}</span>
              ) : null}
            </Command.Item>
          ))}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

export const commandIcons = {
  Download: Download04Icon,
  FolderOpen: FolderOpenIcon,
  History: HistoryIcon,
  Settings: Settings01Icon,
  Trash2: Delete02Icon,
};
