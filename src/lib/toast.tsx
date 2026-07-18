"use client";

// Minimal toast system — mc-token styled, bottom-center, auto-dismiss.
// Usage: toast("Notifications enabled"); mount <Toaster /> once (EmailLayout).

import { useState, useEffect } from "react";

interface ToastItem {
  id: number;
  message: string;
}

type Listener = (toasts: ToastItem[]) => void;

let nextId = 1;
let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(toasts);
}

export function toast(message: string, durationMs = 2600) {
  const item: ToastItem = { id: nextId++, message };
  toasts = [...toasts, item];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    emit();
  }, durationMs);
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>(toasts);

  useEffect(() => {
    const listener: Listener = (next) => setItems(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-16 md:bottom-6 left-1/2 -translate-x-1/2 z-[80] flex flex-col items-center gap-2 pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          className="px-4 py-2 rounded-full text-[13px] font-medium shadow-lg animate-toast-in"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            color: "var(--mc-text)",
            border: "1px solid var(--mc-border)",
            boxShadow: "var(--mc-shadow)",
          }}
        >
          {t.message}
        </div>
      ))}
      <style>{`
        @keyframes toastIn {
          from { transform: translateY(8px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .animate-toast-in { animation: toastIn 0.18s ease-out; }
      `}</style>
    </div>
  );
}
