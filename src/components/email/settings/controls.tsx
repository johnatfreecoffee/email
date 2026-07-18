"use client";

// Shared building blocks for the settings tabs — Apple System Settings
// idiom: faint section titles over inset group cards of rows.

import * as Switch from "@radix-ui/react-switch";

export function SettingsSection({
  title,
  footnote,
  children,
}: {
  title?: string;
  footnote?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      {title && (
        <div className="text-[11px] font-semibold px-3 pb-1.5" style={{ color: "var(--mc-text-faint)" }}>
          {title}
        </div>
      )}
      <div
        className="rounded-[10px] overflow-hidden"
        style={{ backgroundColor: "var(--mc-bg-tertiary)" }}
      >
        {children}
      </div>
      {footnote && (
        <div className="text-[11px] px-3 pt-1.5 leading-4" style={{ color: "var(--mc-text-faint)" }}>
          {footnote}
        </div>
      )}
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  last = false,
}: {
  label: string;
  description?: string;
  control?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 min-h-[40px]"
      style={{ borderBottom: last ? "none" : "1px solid var(--mc-border-subtle)" }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px]" style={{ color: "var(--mc-text)" }}>{label}</div>
        {description && (
          <div className="text-[11px] mt-0.5 leading-4" style={{ color: "var(--mc-text-muted)" }}>
            {description}
          </div>
        )}
      </div>
      {control && <div className="flex-shrink-0 flex items-center">{control}</div>}
    </div>
  );
}

export function MCSwitch({
  checked,
  onCheckedChange,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="relative h-[22px] w-[38px] rounded-full transition-colors outline-none disabled:opacity-40"
      style={{ backgroundColor: checked ? "var(--mc-accent)" : "var(--mc-bg-active)" }}
    >
      <Switch.Thumb
        className="block h-[18px] w-[18px] rounded-full bg-white transition-transform"
        style={{
          transform: checked ? "translateX(18px)" : "translateX(2px)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}
      />
    </Switch.Root>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div
      className="inline-flex rounded-lg p-0.5 gap-0.5"
      style={{ backgroundColor: "var(--mc-bg-active)" }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => !o.disabled && onChange(o.value)}
            disabled={o.disabled}
            title={o.title}
            className="px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              backgroundColor: active ? "var(--mc-bg-elevated)" : "transparent",
              color: active ? "var(--mc-text)" : "var(--mc-text-muted)",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.15)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SelectRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="text-[12px] px-2 py-1 rounded-md outline-none cursor-pointer"
      style={{
        backgroundColor: "var(--mc-bg-elevated)",
        color: "var(--mc-text)",
        border: "1px solid var(--mc-border)",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
