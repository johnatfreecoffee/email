"use client";

import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { X } from "lucide-react";
import { apiFetch } from "@/lib/auth";

interface Contact {
  id: string;
  email: string;
  display_name: string | null;
  send_count: number;
  receive_count: number;
}

export interface AddressAutocompleteHandle {
  focus: () => void;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  /** Tab (forward) — chip any in-progress address then jump here. */
  onTabNext?: () => void;
  /** Shift+Tab — chip any in-progress address then jump here. */
  onTabPrev?: () => void;
}

/** Loose "looks like an email" check — enough to chip without forcing full RFC. */
function looksLikeEmail(s: string): boolean {
  const t = s.trim();
  return t.includes("@") && t.length >= 3 && !t.endsWith("@") && !t.startsWith("@");
}

function parseValue(value: string): { completedTags: string[]; activeInput: string } {
  // Prefer comma/semicolon separators; trailing separator means empty active input.
  const endsWithSep = /[,;]\s*$/.test(value);
  const parts = value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (endsWithSep) {
    return { completedTags: parts, activeInput: "" };
  }
  if (parts.length === 0) {
    return { completedTags: [], activeInput: "" };
  }
  return {
    completedTags: parts.slice(0, -1),
    activeInput: parts[parts.length - 1] || "",
  };
}

function serialize(tags: string[], active: string): string {
  if (tags.length === 0) return active;
  if (!active) return tags.join(", ") + ", ";
  return tags.join(", ") + ", " + active;
}

export const AddressAutocomplete = forwardRef<AddressAutocompleteHandle, AddressAutocompleteProps>(
  function AddressAutocomplete(
    {
      value,
      onChange,
      placeholder = "Recipients",
      label,
      autoFocus,
      onTabNext,
      onTabPrev,
    },
    ref
  ) {
    const [suggestions, setSuggestions] = useState<Contact[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [inputFocused, setInputFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const suggestionsRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

    const { completedTags, activeInput } = parseValue(value);

    const fetchSuggestions = useCallback(async (query: string) => {
      if (query.length < 1) {
        try {
          const res = await apiFetch(`/api/email/contacts?limit=5`);
          if (res.ok) {
            const data = await res.json();
            setSuggestions(Array.isArray(data) ? data : []);
          }
        } catch {
          setSuggestions([]);
        }
        return;
      }

      try {
        const res = await apiFetch(`/api/email/contacts?q=${encodeURIComponent(query)}&limit=8`);
        if (res.ok) {
          const data = await res.json();
          setSuggestions(Array.isArray(data) ? data : []);
        }
      } catch {
        setSuggestions([]);
      }
    }, []);

    useEffect(() => {
      if (!inputFocused) return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        fetchSuggestions(activeInput);
      }, 150);

      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }, [activeInput, inputFocused, fetchSuggestions]);

    const commitTags = useCallback(
      (tags: string[], nextActive = "") => {
        onChange(serialize(tags, nextActive));
        setShowSuggestions(false);
        setSelectedIndex(-1);
      },
      [onChange]
    );

    const selectSuggestion = (contact: Contact) => {
      commitTags([...completedTags, contact.email], "");
      // Keep focus so user can add another recipient
      requestAnimationFrame(() => inputRef.current?.focus());
    };

    const removeTag = (index: number) => {
      const newTags = completedTags.filter((_, i) => i !== index);
      commitTags(newTags, activeInput);
      requestAnimationFrame(() => inputRef.current?.focus());
    };

    /** Chip the in-progress text if it looks like an email. Returns whether we chipped. */
    const tryChipActive = (): boolean => {
      const trimmed = activeInput.trim();
      if (!trimmed) return false;
      if (!looksLikeEmail(trimmed)) return false;
      commitTags([...completedTags, trimmed], "");
      return true;
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
        setShowSuggestions(true);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
        return;
      }

      // Enter / comma / semicolon → chip (or pick suggestion)
      if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex >= 0 && suggestions[selectedIndex]) {
          selectSuggestion(suggestions[selectedIndex]);
          return;
        }
        if (activeInput.trim()) {
          // Chip even without a perfect match when it has @; otherwise still
          // try so the user gets feedback (chip if looksLikeEmail).
          if (looksLikeEmail(activeInput) || activeInput.includes("@")) {
            const trimmed = activeInput.trim();
            commitTags([...completedTags, trimmed], "");
          }
        }
        return;
      }

      if (e.key === "," || e.key === ";") {
        if (activeInput.trim()) {
          e.preventDefault();
          const trimmed = activeInput.trim();
          if (looksLikeEmail(trimmed) || trimmed.includes("@")) {
            commitTags([...completedTags, trimmed], "");
          }
        }
        return;
      }

      // Tab advances fields (chip first if possible)
      if (e.key === "Tab") {
        if (e.shiftKey) {
          if (activeInput.trim() && (looksLikeEmail(activeInput) || activeInput.includes("@"))) {
            e.preventDefault();
            tryChipActive();
            onTabPrev?.();
            return;
          }
          if (onTabPrev) {
            e.preventDefault();
            onTabPrev();
          }
          return;
        }
        // Forward Tab
        if (activeInput.trim() && (looksLikeEmail(activeInput) || activeInput.includes("@"))) {
          e.preventDefault();
          tryChipActive();
          onTabNext?.();
          return;
        }
        if (onTabNext) {
          e.preventDefault();
          onTabNext();
        }
        return;
      }

      if (e.key === "Backspace" && !activeInput && completedTags.length > 0) {
        e.preventDefault();
        removeTag(completedTags.length - 1);
      }
    };

    const filteredSuggestions = suggestions.filter(
      (s) => !completedTags.some((t) => t.toLowerCase() === s.email.toLowerCase())
    );

    return (
      <div className="relative">
        {label && (
          <span className="text-[12px] text-muted-foreground mr-2">{label}</span>
        )}
        <div
          className="flex flex-wrap items-center gap-1 min-h-[36px] px-3 py-1.5 bg-transparent cursor-text"
          onClick={() => inputRef.current?.focus()}
        >
          {completedTags.map((tag, i) => (
            <span
              key={`${tag}-${i}`}
              className="inline-flex items-center gap-1 bg-mc-teal-dim text-mc-teal text-[12px] px-2 py-0.5 rounded-full max-w-full"
            >
              <span className="truncate">{tag}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(i);
                }}
                className="hover:text-foreground transition-colors flex-shrink-0"
                aria-label={`Remove ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <input
            ref={inputRef}
            type="text"
            value={activeInput}
            onChange={(e) => {
              onChange(serialize(completedTags, e.target.value));
              setShowSuggestions(true);
              setSelectedIndex(-1);
            }}
            onFocus={() => {
              setInputFocused(true);
              setShowSuggestions(true);
              fetchSuggestions(activeInput);
            }}
            onBlur={() => {
              // Chip pending address on blur (Gmail-style)
              setTimeout(() => {
                setInputFocused(false);
                setShowSuggestions(false);
                // Re-read from DOM to avoid stale closure fighting a click-to-select
                if (document.activeElement === inputRef.current) return;
              }, 200);
            }}
            onKeyDown={handleKeyDown}
            placeholder={completedTags.length === 0 ? placeholder : ""}
            className="flex-1 min-w-[120px] bg-transparent text-[13px] text-foreground placeholder-[#4B5563] focus:outline-none"
            autoFocus={autoFocus}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {showSuggestions && filteredSuggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="absolute left-0 right-0 top-full mt-1 bg-[var(--mc-bg-elevated)] border border-border rounded-lg shadow-xl z-50 overflow-hidden"
          >
            {filteredSuggestions.map((contact, i) => (
              <button
                type="button"
                key={contact.id}
                onMouseDown={(e) => {
                  // Prevent input blur before click registers
                  e.preventDefault();
                }}
                onClick={() => selectSuggestion(contact)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                  i === selectedIndex ? "bg-mc-teal-dim" : "hover:bg-muted/30"
                }`}
              >
                <div className="h-7 w-7 rounded-full bg-mc-teal flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0">
                  {(contact.display_name || contact.email)[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  {contact.display_name ? (
                    <>
                      <div className="text-[12px] text-foreground font-medium truncate">
                        {contact.display_name}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {contact.email}
                      </div>
                    </>
                  ) : (
                    <div className="text-[12px] text-foreground truncate">
                      {contact.email}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground/70 flex-shrink-0">
                  {(contact.send_count || 0) + (contact.receive_count || 0)}×
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
);
