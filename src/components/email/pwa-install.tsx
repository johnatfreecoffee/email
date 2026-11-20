"use client";

import { useEffect, useState, useCallback } from "react";
import { Download, X, Share, PlusSquare, Monitor, Smartphone, CheckCircle2 } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISS_KEY = "mc.email.pwaInstallDismissed";

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(true); // start true to prevent flash
  const [dismissed, setDismissed] = useState(false);
  const [platform, setPlatform] = useState<"mac-safari" | "ios" | "chromium" | "other">("other");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsStandalone(standalone);

    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      /* ignore */
    }

    const ua = window.navigator.userAgent || "";
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/i.test(ua);
    const isMac = /Macintosh|Mac OS X/i.test(ua);

    if (isIOS) setPlatform("ios");
    else if (isMac && isSafari) setPlatform("mac-safari");
    else if (/Chrome|Chromium|Edg/i.test(ua)) setPlatform("chromium");
    else setPlatform("other");

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setPlatform("chromium");
    };

    const onInstalled = () => {
      setIsStandalone(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const triggerNativeInstall = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return choice.outcome === "accepted";
  }, [deferredPrompt]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  return {
    isStandalone,
    canNativeInstall: !!deferredPrompt,
    showToolbarButton: !isStandalone && !dismissed,
    platform,
    triggerNativeInstall,
    dismiss,
  };
}

export function PwaInstallModal({
  open,
  onClose,
  canNativeInstall,
  platform,
  onNativeInstall,
}: {
  open: boolean;
  onClose: () => void;
  canNativeInstall: boolean;
  platform: "mac-safari" | "ios" | "chromium" | "other";
  onNativeInstall: () => Promise<boolean>;
}) {
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);

  if (!open) return null;

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const ok = await onNativeInstall();
      if (ok) {
        setInstalled(true);
        setTimeout(() => onClose(), 900);
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px] p-4"
      style={{ backgroundColor: "var(--mc-modal-overlay)" }}
      onClick={onClose}
    >
      <div
        className="mc-window-sheet w-full max-w-[420px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="mc-glass-bar flex items-center justify-between px-4 h-[46px]"
          style={{ borderBottom: "1px solid var(--mc-border-subtle)" }}
        >
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4" style={{ color: "var(--mc-accent)" }} />
            <span className="text-[14px] font-semibold tracking-[-0.015em]" style={{ color: "var(--mc-text)" }}>
              Install Mail App
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3.5">
            <div
              className="h-12 w-12 rounded-[14px] flex items-center justify-center flex-shrink-0 shadow-sm"
              style={{ backgroundColor: "#000000", border: "1px solid var(--mc-border)" }}
            >
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div>
              <div className="text-[14px] font-semibold" style={{ color: "var(--mc-text)" }}>
                Run Mail in its own window
              </div>
              <div className="text-[12px] mt-0.5 leading-snug" style={{ color: "var(--mc-text-muted)" }}>
                Launch straight from your Mac Dock or iPhone Home Screen with native push notifications and full keyboard shortcuts.
              </div>
            </div>
          </div>

          {installed ? (
            <div
              className="flex items-center gap-2.5 p-3.5 rounded-[10px] text-[13px] font-medium"
              style={{ backgroundColor: "rgba(52, 199, 89, 0.12)", color: "var(--mc-green)" }}
            >
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              Installed! Look for Mail in your Apps / Dock.
            </div>
          ) : canNativeInstall ? (
            <button
              type="button"
              onClick={handleInstall}
              disabled={installing}
              className="w-full py-2.5 rounded-[10px] text-white text-[13.5px] font-semibold flex items-center justify-center gap-2 hover:brightness-110 active:scale-[0.99] transition-all disabled:opacity-50"
              style={{ backgroundColor: "var(--mc-accent)" }}
            >
              <Download className="h-4 w-4" />
              {installing ? "Installing..." : "Install Desktop App"}
            </button>
          ) : (
            <div
              className="rounded-[12px] p-3.5 space-y-2.5 text-[12.5px]"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border-subtle)",
                color: "var(--mc-text-secondary)",
              }}
            >
              {platform === "ios" ? (
                <>
                  <div className="flex items-center gap-2 font-semibold" style={{ color: "var(--mc-text)" }}>
                    <Smartphone className="h-4 w-4" style={{ color: "var(--mc-accent)" }} />
                    Add to iPhone / iPad Home Screen
                  </div>
                  <ol className="list-decimal pl-5 space-y-1.5 leading-relaxed">
                    <li>Tap the <Share className="inline h-3.5 w-3.5 mx-0.5" /> <strong>Share</strong> button in Safari.</li>
                    <li>Scroll down and tap <PlusSquare className="inline h-3.5 w-3.5 mx-0.5" /> <strong>Add to Home Screen</strong>.</li>
                    <li>Open Mail from your Home Screen to enable iOS push notifications.</li>
                  </ol>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 font-semibold" style={{ color: "var(--mc-text)" }}>
                    <Monitor className="h-4 w-4" style={{ color: "var(--mc-accent)" }} />
                    Add to your Mac Dock
                  </div>
                  <ol className="list-decimal pl-5 space-y-1.5 leading-relaxed">
                    <li><strong>Safari (macOS Sonoma/Sequoia):</strong> Click <strong>File → Add to Dock…</strong> in the top menu bar.</li>
                    <li><strong>Chrome / Edge / Arc:</strong> Click the install icon in the address bar (or <strong>Menu → Cast, save, and share → Install page as app</strong>).</li>
                  </ol>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
