"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// The email client lives at /email. Root just forwards there.
// (Client-side redirect — works with Next.js `output: "export"`.)
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/email");
  }, [router]);
  return null;
}
