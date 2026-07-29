"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type StaffOption = {
  id: string;
  name: string | null;
  email: string;
  role: string;
};

function displayName(u: StaffOption): string {
  return (u.name?.trim() || u.email.split("@")[0] || u.email).trim();
}

/**
 * 技术支持：可搜索内部员工（ADMIN/USER）写入展示名，也允许手改任意文本。
 * 值仍是 Project.techSupport 字符串，不是 userId。
 *
 * 受控策略：失焦时用 props.value；聚焦时用本地 draft，避免 useEffect 同步 setState。
 */
export function TechSupportSelect({
  value,
  onChange,
  placeholder = "技术支持（默认自己，可转交）",
  disabled,
  className,
}: {
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = focused ? draft : value;

  const search = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term) {
      setOptions([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/users?search=${encodeURIComponent(term)}`);
      if (!res.ok) {
        setOptions([]);
        return;
      }
      const data = await res.json();
      const users = (data.users || []) as StaffOption[];
      setOptions(users.filter((u) => u.role === "ADMIN" || u.role === "USER"));
    } catch {
      setOptions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !focused) return;
    const t = setTimeout(() => {
      void search(draft);
    }, 200);
    return () => clearTimeout(t);
  }, [draft, open, focused, search]);

  useEffect(() => {
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  return (
    <div className={cn("relative", className)}>
      <Input
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => {
          if (blurTimer.current) {
            clearTimeout(blurTimer.current);
            blurTimer.current = null;
          }
          setDraft(value);
          setFocused(true);
          setOpen(true);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => {
            setOpen(false);
            setFocused(false);
            const next = draft.trim();
            if (next !== value) onChange(next);
            blurTimer.current = null;
          }, 150);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const next = draft.trim();
            onChange(next);
            setOpen(false);
            setFocused(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {open && focused && (loading || options.length > 0) && (
        <div className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {loading && options.length === 0 && (
            <div className="px-2 py-1.5 text-muted-foreground">搜索中…</div>
          )}
          {options.map((u) => {
            const label = displayName(u);
            return (
              <button
                key={u.id}
                type="button"
                className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(label);
                  setDraft(label);
                  setOpen(false);
                  setFocused(false);
                }}
              >
                <span>{label}</span>
                <span className="text-xs text-muted-foreground">{u.role}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
