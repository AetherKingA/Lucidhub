// Draws the playfield on a canvas: sky, pipes, ground and any number of birds. Simple shapes only.

import { BIRD_R, BIRD_X, GROUND_Y, PIPE_GAP, PIPE_W, WORLD_H, WORLD_W, birdWorldX, pipesBetween } from "../shared/engine/flappy.ts";

export interface DrawBird {
  /** The bird's own tick (its x position on the course). */
  tick: number;
  y: number;
  vy?: number;
  alpha?: number;
  color?: string;
  label?: string;
  dead?: boolean;
  highlight?: boolean;
}

/** Sets the canvas up so world units fill it, sharp on high-DPI screens. Returns the scale. */
export function fitCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return Math.min(w / WORLD_W, h / WORLD_H);
}

/** A colour per player, the same every time. */
export function colorFor(userId: number) {
  return `hsl(${(userId * 137.5) % 360} 85% 62%)`;
}

export function drawScene(ctx: CanvasRenderingContext2D, scale: number, seed: number | null, cameraTick: number, birds: DrawBird[]) {
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0b1020";
  ctx.fillRect(0, 0, width, height);
  // Centre the world in the canvas.
  ctx.setTransform(scale, 0, 0, scale, (width - WORLD_W * scale) / 2, (height - WORLD_H * scale) / 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, WORLD_W, WORLD_H);
  ctx.clip();

  const camX = birdWorldX(cameraTick) - BIRD_X;

  // Sky and a slow city skyline.
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, "#4ec0ca");
  sky.addColorStop(1, "#b8ecf0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WORLD_W, GROUND_Y);
  ctx.fillStyle = "#9ad8c0";
  const par = camX * 0.25;
  for (let i = -1; i < 10; i++) {
    const bx = i * 40 - (par % 40);
    const bh = 30 + ((Math.floor(par / 40) + i) * 37 % 5) * 9;
    ctx.fillRect(bx, GROUND_Y - bh, 36, bh);
  }

  // Pipes.
  if (seed !== null) {
    for (const p of pipesBetween(seed, camX - PIPE_W, camX + WORLD_W)) {
      const x = p.x - camX;
      const top = p.gapY - PIPE_GAP / 2;
      const bottom = p.gapY + PIPE_GAP / 2;
      drawPipe(ctx, x, 0, top, true);
      drawPipe(ctx, x, bottom, GROUND_Y - bottom, false);
    }
  }

  // Ground.
  ctx.fillStyle = "#ded895";
  ctx.fillRect(0, GROUND_Y, WORLD_W, WORLD_H - GROUND_Y);
  ctx.fillStyle = "#73bf2e";
  ctx.fillRect(0, GROUND_Y, WORLD_W, 10);
  ctx.fillStyle = "#5a9e22";
  for (let i = -1; i < WORLD_W / 14 + 1; i++) ctx.fillRect(i * 14 - (camX % 14), GROUND_Y + 10, 7, 3);

  // Birds: dead ones first, highlighted last so it's on top.
  const order = [...birds].sort((a, b) => Number(!a.dead) - Number(!b.dead) || Number(Boolean(a.highlight)) - Number(Boolean(b.highlight)));
  for (const b of order) drawBird(ctx, birdWorldX(b.tick) - camX, b, cameraTick);

  ctx.restore();
}

function drawPipe(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, top: boolean) {
  ctx.fillStyle = "#74bf2e";
  ctx.fillRect(x, y, PIPE_W, h);
  ctx.fillStyle = "#9be15d";
  ctx.fillRect(x + 4, y, 6, h);
  ctx.strokeStyle = "#3d6b17";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, PIPE_W, h);
  // Lip.
  const ly = top ? y + h - 20 : y;
  ctx.fillStyle = "#74bf2e";
  ctx.fillRect(x - 3, ly, PIPE_W + 6, 20);
  ctx.strokeRect(x - 3, ly, PIPE_W + 6, 20);
}

function drawBird(ctx: CanvasRenderingContext2D, x: number, b: DrawBird, cameraTick: number) {
  if (x < -40 || x > WORLD_W + 40) return;
  const vy = b.vy ?? 0;
  ctx.save();
  ctx.globalAlpha = b.alpha ?? 1;
  ctx.translate(x, b.y);
  ctx.save();
  ctx.rotate(b.dead ? Math.PI / 2 : Math.max(-0.5, Math.min(1.2, vy / 8)));
  ctx.fillStyle = b.color ?? "#f8d73a";
  ctx.strokeStyle = "#3a2a10";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, BIRD_R + 2, BIRD_R, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Wing flaps with time.
  const wing = Math.sin((b.tick + cameraTick) * 0.5) * 3;
  ctx.fillStyle = "#fff8";
  ctx.beginPath();
  ctx.ellipse(-4, 2 + wing, 6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Eye and beak.
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(5, -4, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(6.5, -4, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f2742b";
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(17, 2);
  ctx.lineTo(9, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (b.highlight) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (b.label) {
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000a";
    ctx.strokeText(b.label, 0, -BIRD_R - 8);
    ctx.fillStyle = "#fff";
    ctx.fillText(b.label, 0, -BIRD_R - 8);
  }
  ctx.restore();
}

/** Big centred text over the playfield (score, "Tap to fly", countdowns). */
export function drawCaption(ctx: CanvasRenderingContext2D, text: string, y: number, size = 40) {
  ctx.save();
  ctx.font = `900 ${size}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.lineWidth = size / 6;
  ctx.strokeStyle = "#000";
  ctx.strokeText(text, WORLD_W / 2, y);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, WORLD_W / 2, y);
  ctx.restore();
}
