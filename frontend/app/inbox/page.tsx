// Legacy /inbox URL. After the unified-messenger refactor the inbox is the
// sidebar of /messages, so anyone who lands here (older bookmark, old
// email link) gets bounced to the new surface. Kept as a client redirect
// rather than a route group rewrite because the messenger needs the
// browser to follow with the SIWE cookie, which a server redirect would
// also do but a client redirect plays better with our auth state hook.

"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function InboxRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/messages");
  }, [router]);
  return (
    <div className="text-sm text-slate-500">
      Inbox has moved to <a href="/messages" className="text-blue-700 underline">/messages</a>.
    </div>
  );
}
