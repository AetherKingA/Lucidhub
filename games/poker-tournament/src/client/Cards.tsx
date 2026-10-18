const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

export function PlayingCard({ card, small }: { card: string; small?: boolean }) {
  if (card === "??") return <span className={`pcard back ${small ? "small" : ""}`} aria-label="Hidden card" />;
  const rank = card[0] === "T" ? "10" : card[0]!;
  const suit = card[1]!;
  return (
    <span className={`pcard ${suit === "h" || suit === "d" ? "red" : ""} ${small ? "small" : ""}`} aria-label={card}>
      <span className="rank">{rank}</span>
      <span className="suit">{SUITS[suit]}</span>
    </span>
  );
}
