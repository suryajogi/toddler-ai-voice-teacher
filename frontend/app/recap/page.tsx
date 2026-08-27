"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// Derived from the same env var as the voice WebSocket rather than a
// separate one — this way, whichever address the backend is actually
// reachable at (localhost, a LAN IP, or a cloudflared tunnel — see
// USAGE.md) only ever has to be configured in one place.
const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:8081/voice";
const BACKEND_HTTP_URL = BACKEND_WS_URL.replace(/^ws/, "http").replace(/\/voice$/, "");

interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  topics: string[];
  newWords: string[];
  strugglingWords: string[];
  summaryForParent: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Chip({ children, tone }: { children: string; tone: "topic" | "word" | "struggle" }) {
  const toneClass =
    tone === "topic"
      ? "bg-amber-100 text-amber-800"
      : tone === "word"
        ? "bg-emerald-100 text-emerald-800"
        : "bg-rose-100 text-rose-800";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${toneClass}`}>{children}</span>;
}

export default function RecapPage() {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BACKEND_HTTP_URL}/recap`)
      .then((res) => {
        if (!res.ok) throw new Error(`Backend returned ${res.status}`);
        return res.json();
      })
      .then((data) => setSessions(data.sessions ?? []))
      .catch((err) => setError((err as Error).message));
  }, []);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col px-6 py-12">
      <div className="mb-8">
        <Link href="/" className="text-sm text-amber-700 hover:underline">
          ← Back to the app
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-amber-800">For Parents: Recent Sessions</h1>
        <p className="mt-2 text-sm text-[color:var(--foreground)]/70">
          A short recap of each session, generated automatically from what was talked about. This is
          the same memory the AI teacher itself uses to build on past conversations —
          see the <Link href="https://github.com/suryajogi/toddler-ai-voice-teacher" className="underline">project docs</Link> for how.
        </p>
      </div>

      {error && (
        <p className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Couldn&apos;t reach the backend ({error}). Is it running at {BACKEND_HTTP_URL}?
        </p>
      )}

      {!error && sessions === null && <p className="text-sm text-[color:var(--foreground)]/60">Loading…</p>}

      {sessions?.length === 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No sessions recorded yet — have a conversation on the home page, then check back here.
        </p>
      )}

      <div className="grid gap-4">
        {sessions?.map((session) => (
          <div key={session.id} className="rounded-2xl border border-amber-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-600">
              {formatDate(session.startedAt)}
            </p>
            <p className="mt-1 text-base font-semibold text-[color:var(--foreground)]">
              {session.summaryForParent}
            </p>
            {(session.topics.length > 0 || session.newWords.length > 0 || session.strugglingWords.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {session.topics.map((t, i) => (
                  <Chip key={`topic-${i}-${t}`} tone="topic">
                    {t}
                  </Chip>
                ))}
                {session.newWords.map((w, i) => (
                  <Chip key={`word-${i}-${w}`} tone="word">
                    {w}
                  </Chip>
                ))}
                {session.strugglingWords.map((w, i) => (
                  <Chip key={`struggle-${i}-${w}`} tone="struggle">{`still practicing: ${w}`}</Chip>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
