// Long-term, per-child memory: structured facts (favorite color, pets,
// family, hobbies, daily events) persisted in SQLite, plus a simple
// vocabulary-pacing signal derived from how long the child's utterances
// are.
//
// This is a different, more structured store than learningProfile.ts's
// session-level JSON summaries (topics/newWords/summaryForParent, used for
// the parent recap page). This one tracks durable facts *about* a child,
// keyed by child, the way a person actually remembers someone — the two
// are complementary, not competing: learningProfile.ts answers "what did
// we talk about lately," this answers "what do I know about this child."
//
// Uses Node's built-in `node:sqlite` (stable since Node 22) rather than a
// third-party driver, so nothing new needs installing.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { GoogleGenAI, Type } from "@google/genai";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const DB_PATH = join(DATA_DIR, "bot_memory.db");

export const FACT_CATEGORIES = [
  "Favorite Color",
  "Animal",
  "Hobby",
  "Pet Name",
  "Family",
  "Daily Event",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export type VocabularyTier = "Simple" | "Moderate" | "Advanced";

// This app has no multi-child login/identity concept anywhere else (the
// voice pipeline is one continuous session for whoever presses the
// button), so every session shares this one profile row rather than
// inventing an auth system this feature doesn't need yet.
const DEFAULT_CHILD_ID = "default-child";

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS child_profiles (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      age INTEGER,
      current_vocabulary_tier TEXT NOT NULL DEFAULT 'Moderate'
    );

    CREATE TABLE IF NOT EXISTS long_term_memories (
      id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL REFERENCES child_profiles(id),
      fact_category TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      last_mentioned_timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interaction_metrics (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      average_words_per_turn REAL NOT NULL,
      detected_speaker_count INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

/** Ensures the single shared child profile row exists, and returns its id. */
export function ensureDefaultChildProfile(): string {
  const database = getDb();
  const existing = database.prepare("SELECT id FROM child_profiles WHERE id = ?").get(DEFAULT_CHILD_ID);
  if (!existing) {
    database
      .prepare("INSERT INTO child_profiles (id, first_name, age, current_vocabulary_tier) VALUES (?, ?, ?, ?)")
      .run(DEFAULT_CHILD_ID, "Friend", null, "Moderate");
  }
  return DEFAULT_CHILD_ID;
}

export interface ChildContext {
  childId: string;
  firstName: string;
  age: number | null;
  vocabularyTier: VocabularyTier;
  memories: { category: FactCategory; value: string; lastMentioned: string }[];
}

interface ChildProfileRow {
  first_name: string;
  age: number | null;
  current_vocabulary_tier: string;
}

interface MemoryRow {
  fact_category: string;
  fact_value: string;
  last_mentioned_timestamp: string;
}

/** Queries SQLite to gather the child's age, vocabulary tier, and all saved
 * long-term memories — everything the system prompt needs to know about
 * this specific child. */
export function fetchChildContext(childId: string): ChildContext {
  const database = getDb();
  const profile = database
    .prepare("SELECT first_name, age, current_vocabulary_tier FROM child_profiles WHERE id = ?")
    .get(childId) as ChildProfileRow | undefined;

  const memoryRows = database
    .prepare(
      "SELECT fact_category, fact_value, last_mentioned_timestamp FROM long_term_memories WHERE child_id = ? ORDER BY last_mentioned_timestamp DESC"
    )
    .all(childId) as unknown as MemoryRow[];

  return {
    childId,
    firstName: profile?.first_name ?? "Friend",
    age: profile?.age ?? null,
    vocabularyTier: (profile?.current_vocabulary_tier as VocabularyTier | undefined) ?? "Moderate",
    memories: memoryRows.map((r) => ({
      category: r.fact_category as FactCategory,
      value: r.fact_value,
      lastMentioned: r.last_mentioned_timestamp,
    })),
  };
}

/** Turns a ChildContext into a short block of text for the system
 * instruction — the structured-fact sibling of learningProfile.ts's
 * buildMemoryContext (which covers session-level topics; this covers
 * durable per-child facts). Returns "" when there's nothing known yet. */
export function buildChildContextPrompt(context: ChildContext): string {
  const lines: string[] = [];

  if (context.memories.length > 0) {
    const byCategory = new Map<string, string[]>();
    for (const m of context.memories) {
      const list = byCategory.get(m.category) ?? [];
      list.push(m.value);
      byCategory.set(m.category, list);
    }
    lines.push(
      `KNOWN FACTS ABOUT ${context.firstName.toUpperCase()} (reference naturally when relevant — never recite this as a list, and never say "I remember" or "according to my notes"):`
    );
    for (const [category, values] of byCategory) {
      lines.push(`- ${category}: ${values.join(", ")}`);
    }
  }

  if (context.vocabularyTier === "Simple") {
    lines.push(
      "PACING: this child has been responding in very short bursts (under 4 words) — keep your own sentences brief and simple to match their pace; save longer explanations for when they start using longer sentences themselves."
    );
  }

  return lines.join("\n");
}

// --- Vocabulary pacing -----------------------------------------------------

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Measures how long the child's utterance is and flags a pacing tier.
 * Deliberately a pure, instant heuristic (no AI call) so it can run on
 * every single turn without adding any latency to the live conversation.
 */
export function calculateVocabularyPacing(userMessage: string): VocabularyTier {
  const words = wordCount(userMessage);
  if (words < 4) return "Simple";
  if (words <= 8) return "Moderate";
  return "Advanced";
}

interface InteractionMetricRow {
  id: string;
  average_words_per_turn: number;
}

/**
 * Records one turn's word count against a session's running average, and
 * refreshes the child's tracked vocabulary tier to match. The tier only
 * takes effect on the *next* session's system instruction (an already-open
 * Live session's persona can't be changed mid-conversation) — the same
 * once-per-session-refresh limitation buildMemoryContext in
 * learningProfile.ts already has.
 */
export function recordInteractionMetric(sessionId: string, userMessage: string, speakerCount: number = 1): void {
  const database = getDb();
  const words = wordCount(userMessage);
  const existing = database
    .prepare("SELECT id, average_words_per_turn FROM interaction_metrics WHERE session_id = ?")
    .get(sessionId) as InteractionMetricRow | undefined;

  if (existing) {
    // A simple running average is enough for a pacing signal — this
    // doesn't need to be a precise statistic.
    const newAverage = (existing.average_words_per_turn + words) / 2;
    database
      .prepare("UPDATE interaction_metrics SET average_words_per_turn = ?, detected_speaker_count = ? WHERE id = ?")
      .run(newAverage, speakerCount, existing.id);
  } else {
    database
      .prepare(
        "INSERT INTO interaction_metrics (id, session_id, average_words_per_turn, detected_speaker_count) VALUES (?, ?, ?, ?)"
      )
      .run(randomUUID(), sessionId, words, speakerCount);
  }

  database
    .prepare("UPDATE child_profiles SET current_vocabulary_tier = ? WHERE id = ?")
    .run(calculateVocabularyPacing(userMessage), DEFAULT_CHILD_ID);
}

// --- Fact extraction ---------------------------------------------------------

export interface TranscriptTurn {
  speaker: string;
  text: string;
}

const FACT_EXTRACTION_MODEL = process.env.GEMINI_SUMMARY_MODEL ?? "gemini-3.6-flash";

const FACT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    facts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING, enum: [...FACT_CATEGORIES] },
          value: { type: Type.STRING },
        },
        required: ["category", "value"],
      },
    },
  },
  required: ["facts"],
};

function buildFactExtractionPrompt(transcriptData: TranscriptTurn[]): string {
  const transcript = transcriptData.map((t) => `${t.speaker}: ${t.text}`).join("\n");
  return `Read this snippet of a conversation involving a young child and extract
any durable personal facts about the CHILD specifically (not the bot, not
other speakers) that are worth remembering for future conversations. Only
extract facts that fit one of these categories: ${FACT_CATEGORIES.join(", ")}.

Examples: "I like soccer" -> Hobby: soccer. "I got a new bike" -> Daily
Event: got a new bike. "My sister is Maya" -> Family: has a sister named
Maya. "My dog is Rex" -> Pet Name: Rex.

If nothing concrete is stated, return an empty facts array — never guess or
invent something that wasn't actually said.

CONVERSATION:
${transcript}`;
}

/**
 * Parses conversational turns and commits any extracted personal facts to
 * SQLite. Fire-and-forget by design (see geminiSession.ts/server.ts call
 * sites) — never throws, so a failed extraction can never interrupt the
 * live conversation or crash the caller.
 */
export async function analyzeAndExtractProfileFacts(childId: string, transcriptData: TranscriptTurn[]): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || transcriptData.length === 0) return;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: FACT_EXTRACTION_MODEL,
      contents: buildFactExtractionPrompt(transcriptData),
      config: { responseMimeType: "application/json", responseSchema: FACT_SCHEMA },
    });
    const text = response.text;
    if (!text) return;

    const parsed = JSON.parse(text) as { facts?: { category: string; value: string }[] };
    if (!parsed.facts?.length) return;

    const database = getDb();
    const now = new Date().toISOString();
    const insert = database.prepare(
      "INSERT INTO long_term_memories (id, child_id, fact_category, fact_value, last_mentioned_timestamp) VALUES (?, ?, ?, ?, ?)"
    );
    const findExisting = database.prepare(
      "SELECT id FROM long_term_memories WHERE child_id = ? AND fact_category = ? AND fact_value = ?"
    );
    const touch = database.prepare("UPDATE long_term_memories SET last_mentioned_timestamp = ? WHERE id = ?");

    for (const fact of parsed.facts) {
      if (!(FACT_CATEGORIES as readonly string[]).includes(fact.category) || !fact.value?.trim()) continue;
      // Refresh the timestamp on a near-duplicate rather than piling up
      // repeat rows every time the child mentions the same thing again.
      const existingRow = findExisting.get(childId, fact.category, fact.value) as { id: string } | undefined;
      if (existingRow) {
        touch.run(now, existingRow.id);
      } else {
        insert.run(randomUUID(), childId, fact.category, fact.value, now);
      }
    }
  } catch (err) {
    console.error("Fact extraction failed (non-fatal):", err);
  }
}
