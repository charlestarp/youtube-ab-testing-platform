"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { tests as testsApi } from "@/lib/api";

// TARPGPT's "Send to test edit" links here with ?ids=1,2,3,4. We queue those
// episodes, pitch whichever are already transcribed, and drop the user into the
// chat. The auto-sweep pitches any still-transcoding ones as they finish.
export default function PrereleasePitchPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const [status, setStatus] = useState("Sending your episodes to the Producer…");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const ids = (sp.get("ids") || "").split(",").map(Number).filter(Boolean);
    (async () => {
      try {
        const r = await testsApi.prereleaseQueue(ids);
        if (r.conversation_id) {
          setStatus("Opening your briefing…");
          router.replace(`/ai-chat/${r.conversation_id}`);
        } else {
          setStatus("Queued. The episodes will appear in your weekly chat as they finish transcribing.");
          setTimeout(() => router.replace("/ai-chat"), 2500);
        }
      } catch {
        setStatus("Something went wrong. Open AI Chat to see your pre-release briefing.");
      }
    })();
  }, [router, sp]);

  return (
    <div className="max-w-lg mx-auto px-6 py-24 text-center space-y-3">
      <div className="w-8 h-8 mx-auto rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      <p className="text-sm text-muted-foreground">{status}</p>
    </div>
  );
}
