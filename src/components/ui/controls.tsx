import * as React from "react";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  /** Id of the control this labels. Renders a real <label> so clicking the
   *  text focuses the control and screen readers announce it. */
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const generated = React.useId();
  const labelId = generated + "-label";
  const labelChildren = (nodes: React.ReactNode): React.ReactNode =>
    React.Children.map(nodes, (child) => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return child;
      const tag = typeof child.type === "string" ? child.type : "";
      const props = child.props;
      if (
        ["input", "select", "textarea"].includes(tag) ||
        props.onChange !== undefined ||
        props.role === "combobox" ||
        (typeof child.type === "object" &&
          (child.type as { displayName?: string }).displayName ===
            "SelectTrigger")
      )
        return React.cloneElement(child, {
          "aria-labelledby":
            props["aria-labelledby"] ??
            (props["aria-label"] ? undefined : labelId),
        });
      if (props.children)
        return React.cloneElement(
          child,
          {},
          labelChildren(props.children as React.ReactNode),
        );
      return child;
    });
  return (
    <div className="space-y-1.5">
      {htmlFor ? (
        <label
          id={labelId}
          htmlFor={htmlFor}
          className="micro block cursor-pointer"
        >
          {label}
        </label>
      ) : (
        <span id={labelId} className="micro block">
          {label}
        </span>
      )}
      {labelChildren(children)}
      {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}
