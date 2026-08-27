// Persists a running "learning profile" across sessions — words the child
// already knows, topics recently covered, and a short history of past
// session summaries. This is what lets the AI teacher build on earlier
// conversations instead of starting cold every time the app is opened.
//
// Stored as a single local JSON file rather than a database: this app has
// exactly one child using it, on one machine, so there's no multi-user or
// concurrent-write problem to solve. See buildMemoryContext() for how this
// turns into something the model actually reads.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const PROFILE_PATH = join(DATA_DIR, "learning-profile.json");

const MAX_KNOWN_WORDS = 200;
const MAX_RECENT_TOPICS = 8;
const MAX_SESSION_HISTORY = 20;

export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  topics: string[];
  newWords: string[];
  strugglingWords: string[];
  summaryForParent: string;
}

export interface LearningProfile {
  knownWords: string[];
  recentTopics: string[];
  sessions: SessionRecord[];
}

function emptyProfile(): LearningProfile {
  return { knownWords: [], recentTopics: [], sessions: [] };
}

export function loadProfile(): LearningProfile {
  try {
    const raw = readFileSync(PROFILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      knownWords: Array.isArray(parsed.knownWords) ? parsed.knownWords : [],
      recentTopics: Array.isArray(parsed.recentTopics) ? parsed.recentTopics : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    // No file yet, or it's corrupt — either way, start fresh rather than
    // crashing the backend over what is purely a "nice to have" feature.
    return emptyProfile();
  }
}

export function saveProfile(profile: LearningProfile): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), "utf-8");
}

function dedupeKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

/** Merges a freshly-summarized session into the profile and saves it. */
export function recordSession(
  profile: LearningProfile,
  summary: { topics: string[]; newWords: string[]; strugglingWords: string[]; summaryForParent: string },
  startedAt: Date,
  endedAt: Date
): LearningProfile {
  const record: SessionRecord = {
    id: randomUUID(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    topics: summary.topics,
    newWords: summary.newWords,
    strugglingWords: summary.strugglingWords,
    summaryForParent: summary.summaryForParent,
  };

  const updated: LearningProfile = {
    knownWords: dedupeKeepOrder([...profile.knownWords, ...summary.newWords]).slice(-MAX_KNOWN_WORDS),
    recentTopics: dedupeKeepOrder([...summary.topics, ...profile.recentTopics]).slice(0, MAX_RECENT_TOPICS),
    sessions: [record, ...profile.sessions].slice(0, MAX_SESSION_HISTORY),
  };

  saveProfile(updated);
  return updated;
}

/**
 * Turns the profile into a short block of text appended to the AI's system
 * instruction. Returns "" for a brand-new profile (first-ever session), so
 * the persona is completely unmodified until there's actually something to
 * remember.
 */
export function buildMemoryContext(profile: LearningProfile): string {
  if (profile.sessions.length === 0) return "";

  const lastSession = profile.sessions[0];
  const knownWords = profile.knownWords.slice(-30);
  const strugglingWords = dedupeKeepOrder(
    profile.sessions.slice(0, 5).flatMap((s) => s.strugglingWords)
  ).slice(0, 10);

  const lines = [
    "MEMORY OF PAST SESSIONS WITH THIS SPECIFIC CHILD",
    "(For your own reference only — never read this list aloud, never say",
    "\"according to my notes\" or otherwise mention that you're tracking this.",
    "Just let it quietly shape what you choose to teach next.)",
    "",
    `- Words this child has already learned: ${knownWords.join(", ") || "(none recorded yet)"}.`,
    `- Topics covered recently: ${profile.recentTopics.join(", ") || "(none recorded yet)"}.`,
  ];
  if (strugglingWords.length > 0) {
    lines.push(`- Words they were still practicing / found tricky: ${strugglingWords.join(", ")}. Gently revisit these when a natural opportunity comes up.`);
  }
  lines.push(`- What you talked about last time: ${lastSession.summaryForParent}`);
  lines.push(
    "",
    "Use this to build on what they already know — introduce words related to",
    "topics they've enjoyed, favor revisiting struggling words over brand-new",
    "ones early in the session, and don't re-teach something they've clearly",
    "already mastered as if it were new."
  );

  return lines.join("\n");
}
