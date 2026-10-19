import type { CSSProperties } from "react";
import type { Card, Color } from "../shared/protocol.ts";

export const COLOR_CLASS: Record<Color, string> = { r: "red", y: "yellow", g: "green", b: "blue" };
export const COLOR_LABEL: Record<Color, string> = { r: "Red", y: "Yellow", g: "Green", b: "Blue" };

const SYMBOL: Record<string, string> = { S: "⊘", R: "⇄", D: "+2", W: "", W4: "+4" };
const NAME: Record<string, string> = { S: "Skip", R: "Reverse", D: "Draw Two", W: "Wild", W4: "Wild Draw Four" };

/** A face-up card drawn in CSS: colored face, white oval, the value in the middle and the corners. */
export function UnoCard(p: { card: Card; size?: "sm" | "md" | "lg"; playable?: boolean; dim?: boolean; onClick?: () => void; style?: CSSProperties; title?: string }) {
  const wild = p.card === "W" || p.card === "W4";
  const value = wild ? p.card : p.card.slice(1);
  const color = wild ? "wild" : COLOR_CLASS[p.card[0] as Color];
  const label = SYMBOL[value] ?? value;
  const name = wild ? NAME[value]! : `${COLOR_LABEL[p.card[0] as Color]} ${NAME[value] ?? value}`;
  const cls = `ucard ${color} ${p.size ?? "md"} ${p.playable ? "playable" : ""} ${p.dim ? "dim" : ""} ${p.onClick ? "clickable" : ""}`;
  const face = (
    <>
      <span className="corner tl">{label || "★"}</span>
      <span className="oval">
        {wild ? (
          <span className="wild-wheel">
            <i className="red" />
            <i className="blue" />
            <i className="yellow" />
            <i className="green" />
          </span>
        ) : null}
        <span className={`val ${label.length > 1 ? "long" : ""} ${value === "6" || value === "9" ? "underline" : ""}`}>{label}</span>
      </span>
      <span className="corner br">{label || "★"}</span>
    </>
  );
  return p.onClick ? (
    <button type="button" className={cls} style={p.style} onClick={p.onClick} aria-label={`Play ${name}`} title={p.title ?? name} disabled={p.dim}>
      {face}
    </button>
  ) : (
    <span className={cls} style={p.style} role="img" aria-label={name} title={p.title ?? name}>
      {face}
    </span>
  );
}

/** The back of a card. */
export function CardBack({ size = "sm", style }: { size?: "xs" | "sm" | "md" | "lg"; style?: CSSProperties }) {
  return (
    <span className={`ucard back ${size}`} style={style} aria-hidden="true">
      <span className="oval">
        <span className="back-logo">UNO</span>
      </span>
    </span>
  );
}
