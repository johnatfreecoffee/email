"use client";

import { EmailLayout } from "@/components/email/email-layout";

// Fork note: MC's <Sidebar/> + <TopNav/> chrome were removed. EmailLayout is a
// self-contained three-panel client (folders | list | reader), so it fills the
// screen on its own. Add your own minimal nav here if/when you want one.
export default function EmailPage() {
  return (
    <div className="min-h-screen bg-background overflow-hidden">
      <EmailLayout />
    </div>
  );
}
