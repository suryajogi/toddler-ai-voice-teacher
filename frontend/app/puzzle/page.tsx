"use client";

// A self-contained picture-matching (memory/concentration) game — flip two
// cards, find the pair, clear the board. Deliberately independent of the
// voice pipeline (no WebSocket, no Gemini): a toddler can play this
// without a microphone or an internet-connected AI session at all, and it
// needs no reading — every card is a picture, not a word.

import Link from "next/link";
import { useState } from "react";

interface Card {
  id: number;
  emoji: string;
  flipped: boolean;
  matched: boolean;
}

const EMOJI_POOL = ["🐶", "🐱", "🐰", "🐸", "🦁", "🐵", "🐮", "🐷", "🐼", "🦊", "🐨", "🐯"];
const PAIR_COUNT = 6;
const MISMATCH_DELAY_MS = 900;

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function newDeck(): Card[] {
  const chosenEmoji = shuffled(EMOJI_POOL).slice(0, PAIR_COUNT);
  const pairedAndShuffled = shuffled([...chosenEmoji, ...chosenEmoji]);
  return pairedAndShuffled.map((emoji, i) => ({ id: i, emoji, flipped: false, matched: false }));
}

export default function PuzzlePage() {
  const [cards, setCards] = useState<Card[]>(() => newDeck());
  const [flippedIds, setFlippedIds] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  // True for the brief pause where a non-matching pair is shown face-up
  // before flipping back — blocks input so a third tap can't interfere.
  const [busy, setBusy] = useState(false);

  const matchedCount = cards.filter((c) => c.matched).length / 2;
  const won = matchedCount === PAIR_COUNT;

  function handleFlip(id: number) {
    if (busy || won || flippedIds.length === 2) return;
    const tapped = cards.find((c) => c.id === id);
    if (!tapped || tapped.flipped || tapped.matched) return;

    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, flipped: true } : c)));
    const nextFlippedIds = [...flippedIds, id];
    setFlippedIds(nextFlippedIds);

    if (nextFlippedIds.length < 2) return;

    setMoves((m) => m + 1);
    const [firstId, secondId] = nextFlippedIds;
    const first = cards.find((c) => c.id === firstId);
    if (first && first.emoji === tapped.emoji) {
      setCards((prev) => prev.map((c) => (c.id === firstId || c.id === secondId ? { ...c, matched: true } : c)));
      setFlippedIds([]);
    } else {
      setBusy(true);
      setTimeout(() => {
        setCards((prev) => prev.map((c) => (c.id === firstId || c.id === secondId ? { ...c, flipped: false } : c)));
        setFlippedIds([]);
        setBusy(false);
      }, MISMATCH_DELAY_MS);
    }
  }

  function handleRestart() {
    setCards(newDeck());
    setFlippedIds([]);
    setMoves(0);
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-1 flex-col items-center gap-6 px-6 py-10 text-center">
      <div>
        <Link href="/" className="text-sm text-amber-700 hover:underline">
          ← Back
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-amber-800">Matching Game 🧩</h1>
        <p className="mt-1 text-sm text-[color:var(--foreground)]/60">Find all the matching pairs!</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {cards.map((card) => {
          const faceUp = card.flipped || card.matched;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => handleFlip(card.id)}
              disabled={faceUp || busy || won}
              aria-label={faceUp ? card.emoji : "face-down card"}
              className={`flex h-16 w-16 items-center justify-center rounded-2xl text-3xl shadow-sm transition sm:h-20 sm:w-20 sm:text-4xl ${
                faceUp
                  ? "bg-white"
                  : "bg-amber-300 hover:bg-amber-200 active:bg-amber-400 disabled:cursor-not-allowed"
              } ${card.matched ? "opacity-50" : ""}`}
            >
              {faceUp ? card.emoji : ""}
            </button>
          );
        })}
      </div>

      <p className="text-sm text-[color:var(--foreground)]/60">
        Pairs found: {matchedCount} / {PAIR_COUNT} · Tries: {moves}
      </p>

      {won && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-6 py-5">
          <p className="text-2xl">🎉 You did it! 🎉</p>
          <button
            type="button"
            onClick={handleRestart}
            className="mt-3 rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-white hover:bg-amber-300"
          >
            Play again
          </button>
        </div>
      )}
    </main>
  );
}
