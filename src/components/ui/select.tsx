import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Select (Radix). Drop-in successor to the native <select> that used
 * to live in controls.tsx: same controlled `value` contract, but the
 * change handler emits the string directly (`onValueChange`) instead of a
 * ChangeEvent, and options become SelectItem children.
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, onClick, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-field px-3 py-1 text-sm text-foreground transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // Radix flips this when the value is unset and a placeholder is showing.
      "data-[placeholder]:text-faint",
      "[&>span]:min-w-0 [&>span]:truncate [&>span]:text-left",
      className,
    )}
    onClick={(event) => {
      // Radix opens the dropdown from `pointerdown`, but a click forwarded by
      // <label for> is synthetic — no pointerdown ever reaches the trigger, so
      // the dropdown stays shut. Replay those (detail === 0) as a real pointer
      // press. Guarded on the closed state so a label click always opens and
      // never toggles shut.
      if (
        event.detail === 0 &&
        event.currentTarget.getAttribute("aria-expanded") === "false"
      ) {
        const init = {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: "mouse",
        } as const;
        event.currentTarget.dispatchEvent(
          new PointerEvent("pointerdown", init),
        );
        event.currentTarget.dispatchEvent(new PointerEvent("pointerup", init));
      }
      onClick?.(event);
    }}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        className="h-3.5 w-3.5 shrink-0 text-faint"
      />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

const SelectScrollUpButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-faint",
      className,
    )}
    {...props}
  >
    <HugeiconsIcon icon={ArrowUp01Icon} className="h-3.5 w-3.5" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = "SelectScrollUpButton";

const SelectScrollDownButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-faint",
      className,
    )}
    {...props}
  >
    <HugeiconsIcon icon={ArrowDown01Icon} className="h-3.5 w-3.5" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = "SelectScrollDownButton";

const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={4}
      className={cn(
        // Above the dialog overlay (z-50) so selects inside SettingsDialog still open.
        "z-60 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl",
        "data-[state=open]:duration-150",
        position === "popper" && "w-full",
        className,
      )}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          "max-h-[var(--radix-select-content-available-height)] overflow-y-auto p-1",
          position === "popper" && "w-full",
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = "SelectContent";

const SelectLabel = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint",
      className,
    )}
    {...props}
  />
));
SelectLabel.displayName = "SelectLabel";

const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-pointer select-none items-center rounded-lg py-1.5 pl-2 pr-7 text-sm text-popover-foreground outline-none transition-colors",
      "data-[highlighted]:bg-secondary data-[highlighted]:text-secondary-foreground",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";

const SelectSeparator = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
));
SelectSeparator.displayName = "SelectSeparator";

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
