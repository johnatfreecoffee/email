"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { X, User } from "lucide-react";
import { apiFetch } from "@/lib/auth";

interface Contact {
  id: string;
  email: string;
  display_name: string | null;
  send_count: number;
  receive_count: number;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
}

export function AddressAutocomplete({
  value,
  onChange,
  placeholder = "Recipients",
  label,
  autoFocus,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Parse current value into tags and active input
  const tags = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const activeInput = value.endsWith(",") ? "" : tags.pop() || "";
  const completedTags = value.endsWith(",") ? tags : tags.slice(0, -1);

  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.length < 1) {
      // Show recent contacts when empty
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

  // Debounced search
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

  const selectSuggestion = (contact: Contact) => {
    const newValue = [...completedTags, contact.email].join(", ") + ", ";
    onChange(newValue);
    setShowSuggestions(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  };

  const removeTag = (index: number) => {
    const newTags = [...completedTags];
    newTags.splice(index, 1);
    const newValue = newTags.length > 0
      ? newTags.join(", ") + (activeInput ? ", " + activeInput : ", ")
      : activeInput;
    onChange(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[selectedIndex]);
    } else if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      if (activeInput.includes("@")) {
        e.preventDefault();
        const newValue = [...completedTags, activeInput].join(", ") + ", ";
        onChange(newValue);
        setShowSuggestions(false);
      }
    } else if (e.key === "Backspace" && !activeInput && completedTags.length > 0) {
      // Remove last tag
      removeTag(completedTags.length - 1);
    }
  };

  // Filter out already-selected emails from suggestions
  const filteredSuggestions = suggestions.filter(
    (s) => !completedTags.includes(s.email)
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
        {/* Completed email tags */}
        {completedTags.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            className="inline-flex items-center gap-1 bg-[rgba(6,182,212,0.12)] text-[#06B6D4] text-[12px] px-2 py-0.5 rounded-full"
          >
            {tag}
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeTag(i);
              }}
              className="hover:text-foreground transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={activeInput}
          onChange={(e) => {
            const newVal = [...completedTags, e.target.value].join(", ");
            onChange(completedTags.length > 0 ? completedTags.join(", ") + ", " + e.target.value : e.target.value);
            setShowSuggestions(true);
            setSelectedIndex(-1);
          }}
          onFocus={() => {
            setInputFocused(true);
            setShowSuggestions(true);
            fetchSuggestions(activeInput);
          }}
          onBlur={() => {
            // Delay to allow click on suggestion
            setTimeout(() => {
              setInputFocused(false);
              setShowSuggestions(false);
            }, 200);
          }}
          onKeyDown={handleKeyDown}
          placeholder={completedTags.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] bg-transparent text-[13px] text-white placeholder-[#4B5563] focus:outline-none"
          autoFocus={autoFocus}
        />
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute left-0 right-0 top-full mt-1 bg-[#1A1F28] border border-border rounded-lg shadow-xl z-50 overflow-hidden"
        >
          {filteredSuggestions.map((contact, i) => (
            <button
              key={contact.id}
              onClick={() => selectSuggestion(contact)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                i === selectedIndex
                  ? "bg-[rgba(6,182,212,0.12)]"
                  : "hover:bg-muted/30"
              }`}
            >
              <div className="h-7 w-7 rounded-full bg-gradient-to-br from-[#06B6D4] to-[#34D399] flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0">
                {(contact.display_name || contact.email)[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                {contact.display_name ? (
                  <>
                    <div className="text-[12px] text-white font-medium truncate">
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
