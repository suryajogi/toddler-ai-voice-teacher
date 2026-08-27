// Looks up lyrics for a song, movie/show song, or rhyme (English or
// Telugu) for geminiSession.ts's get_song_lyrics tool to call out to when
// the child asks the AI teacher to sing something.
//
// IMPORTANT, learned the hard way: this deliberately does NOT force
// Google Search grounding (`tools: [{ googleSearch: {} }]`). Popular movie
// songs (tested with a well-known Telugu film song) came back NOT_FOUND
// when grounding was enabled, but returned complete, correct lyrics from
// the model's own trained knowledge when asked plainly — grounded
// responses that would cite a real lyrics webpage verbatim trigger
// noticeably stricter copyright caution than answering from memory. Since
// this app's actual use case is mostly well-known nursery rhymes and
// popular movie/show songs (both English and Telugu) — exactly what's
// well represented in training data — plain generation covers the real
// need better than forcing a search that makes things worse. Real
// internet lookup is nice in principle but isn't worth actively making
// the common case fail; if it becomes worth adding back for genuinely
// obscure requests, do it as a fallback *after* a plain miss, not as the
// default path.
//
// The content filter below is deliberately about AGE-APPROPRIATENESS
// (romantic/violent/adult themes), not copyright status — being a movie
// song is not, by itself, a reason to refuse.
//
// SECOND lesson, learned after the first fix still failed on real movie
// songs: exact prompt wording/ordering matters enormously here, not just
// whether search grounding is on. Leading with any appropriateness/
// copyright framing — even "being copyrighted is NOT a reason to refuse,"
// even just "this is for a young child" stated before the actual
// request — measurably made the model refuse a real, perfectly
// appropriate movie song it otherwise knows and will happily recite.
// What actually works, verified across multiple Telugu and English movie
// songs plus traditional rhymes: ask directly for the lyrics FIRST, with
// zero hedging, and only mention the safety/appropriateness angle
// afterward, as a lightweight "skip objectionable lines" instruction
// rather than an upfront gate the model has to justify passing.
// Don't restructure this prompt without re-testing against a real movie
// song request — it's easy to reintroduce the over-refusal by accident.

import { GoogleGenAI } from "@google/genai";

const LYRICS_MODEL = process.env.GEMINI_SUMMARY_MODEL ?? "gemini-3.6-flash";

const NOT_FOUND = "NOT_FOUND";

function buildPrompt(songName: string, language: string): string {
  return `What are the lyrics to the song "${songName}" (in ${language}, or
whichever language it's actually sung in — many Telugu songs are known by
an English-ish title, and vice versa)? It could be a movie or TV/show
song, a nursery rhyme, or a folk song. Return just the lyrics, verse by
verse, with no preamble, no translation, no commentary — just the words
as they're actually sung.

This is for a young child (2-5 years old). If the song contains any
romantic, sexual, violent, or scary lines, skip just those lines and
return the rest. If you don't know this song at all, say exactly
${NOT_FOUND} instead.`;
}

/**
 * Returns the lyrics text, or null if the song wasn't found / wasn't
 * appropriate / the lookup failed for any reason. Never throws — a failed
 * lookup should make the AI teacher say "I don't know that one," not
 * crash the live conversation.
 */
export async function fetchSongLyrics(apiKey: string, songName: string, language: string): Promise<string | null> {
  const trimmedName = songName.trim();
  if (!trimmedName) return null;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: LYRICS_MODEL,
      contents: buildPrompt(trimmedName, language || "English"),
    });

    const text = result.text?.trim();
    if (!text || text === NOT_FOUND || text.includes(NOT_FOUND)) return null;
    return text;
  } catch (err) {
    console.error("fetchSongLyrics failed (non-fatal):", err);
    return null;
  }
}
