// Decides whether the child is actually talking to the bot, or having a
// side conversation with someone else in the room (a sibling, a parent) —
// the bot should stay silent for the latter, per teacherPersona.ts's role
// as an educational teacher for THIS child, not a general room microphone.
//
// This does NOT do real audio speaker diarization (telling voices apart
// from the raw audio signal itself) — that would require a separate
// speech-processing pass ahead of Gemini Live, adding real latency to
// every single turn, which runs directly against this app's core design
// (see geminiSession.ts's module comment: one Gemini Live call handles
// listening, understanding, and speaking together, specifically so there's
// no separate STT stage slowing things down). Instead, this is a cheap,
// instant TEXT heuristic over whatever transcript segments are available —
// happy to occasionally be wrong in exchange for adding zero latency to
// the live conversation. If real diarization is ever added upstream (e.g.
// a multi-speaker transcription service feeding genuinely distinct
// `speaker` labels), this same function keeps working unchanged — the
// multi-speaker-label check below already handles that case.

export interface DiarizedSegment {
  speaker: string;
  text: string;
}

export interface SideConversationResult {
  isSideConversation: boolean;
  reason: string | null;
}

// Someone else being addressed by a family term — a strong signal the
// child is talking about/to another person in the room, not the bot.
const THIRD_PARTY_NAME = /\b(mom|dad|mommy|daddy|mama|papa|amma|nanna|akka|anna)\b/i;

// Commands that make sense directed at a person doing chores/behavior,
// not at a toy/bot.
const IMPERATIVE_TO_A_PERSON =
  /\b(clean (your|up)|go to your|come here|wait a minute|stop that|listen to me|put (that|it) (away|down))\b/i;

// "..., Name" or "Name, ..." — a direct address to someone by name, the
// classic shape of "Liam, dinner's ready" rather than anything a toddler
// would say to a voice assistant.
const DIRECT_NAME_ADDRESS = /^[A-Z][a-z]+,\s|,\s*[A-Z][a-z]+[.?!]?$/;

function looksAddressedToSomeoneElse(text: string): { matched: boolean; reason: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { matched: false, reason: null };
  if (THIRD_PARTY_NAME.test(trimmed)) {
    return { matched: true, reason: 'mentions a family member by role (e.g. "mom"/"dad")' };
  }
  if (IMPERATIVE_TO_A_PERSON.test(trimmed)) {
    return { matched: true, reason: "phrased as a command to a person, not the bot" };
  }
  if (DIRECT_NAME_ADDRESS.test(trimmed)) {
    return { matched: true, reason: "addressed directly to someone by name" };
  }
  return { matched: false, reason: null };
}

/**
 * Accepts an array of diarized transcript segments — the shape a real
 * multi-speaker pipeline would produce, e.g.
 * [{"speaker": "Speaker_0", "text": "Hi bot"},
 *  {"speaker": "Speaker_1", "text": "Go clean your room, Liam"}].
 *
 * If more than one distinct speaker label shows up in the same turn,
 * that alone means someone else in the room is talking — flagged as a
 * side conversation regardless of content. With a single speaker (this
 * app's actual current input, since Gemini's own transcription doesn't
 * diarize multiple humans), falls back to the text heuristics above.
 */
export function detectSideConversation(segments: DiarizedSegment[]): SideConversationResult {
  if (segments.length === 0) return { isSideConversation: false, reason: null };

  const speakers = new Set(segments.map((s) => s.speaker));
  if (speakers.size > 1) {
    return { isSideConversation: true, reason: "multiple speakers detected in the same turn" };
  }

  const combinedText = segments.map((s) => s.text).join(" ");
  const { matched, reason } = looksAddressedToSomeoneElse(combinedText);
  return { isSideConversation: matched, reason };
}
