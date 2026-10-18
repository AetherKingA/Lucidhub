const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

export type CardSize = "small" | "mine" | "board";

/** A card face (or its back for "??"). New cards slide in, so give each a key that changes per hand. */
export function PlayingCard({ card, size = "board" }: { card: string; size?: CardSize }) {
  if (card === "??") return <span className={`pcard back ${size}`} aria-label="Hidden card" />;
  const rank = card[0] === "T" ? "10" : card[0]!;
  const suit = card[1]!;
  return (
    <span className={`pcard ${size} ${suit === "h" || suit === "d" ? "red" : ""}`} aria-label={card}>
      <span className="corner">
        <span className="rank">{rank}</span>
        <span className="suit">{SUITS[suit]}</span>
      </span>
      <span className="pip">{SUITS[suit]}</span>
    </span>
  );
}
