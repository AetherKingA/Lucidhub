import { useEffect, useMemo, useRef, useState } from "react";
import { BIRD_X, TICK_MS, WORLD_W, birdWorldX, trace } from "../shared/engine/flappy.ts";
import type { Finale } from "../shared/protocol.ts";
import { serverNow, useGame } from "./App.tsx";
import { colorFor, drawCaption, drawScene, fitCanvas } from "./draw.ts";

interface Track {
  userId: number;
  username: string;
  distance: number;
  score: number;
  place: number;
  y: number[];
}

/**
 * Everyone's best run at once, as see-through birds, sped up. The camera follows the leader, birds
 * drop out as they crash, and the last one flying wins. Synced to the server clock, so everyone
 * watching sees the same moment. `replayFrom` restarts it locally ("Watch again").
 */
export function GhostFinale({ seed, finale, replayFrom }: { seed: number; finale: Finale; replayFrom: number | null }) {
  const { offset, user } = useGame();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tracks = useMemo<Track[]>(
    () => finale.ghosts.map((g) => ({ ...g, y: trace(seed, g.flaps, g.distance).y })),
    [seed, finale],
  );
  const longest = Math.max(0, ...tracks.map((t) => t.distance));
  const [status, setStatus] = useState({ flying: tracks.length, tick: 0, done: false });

  const live = useRef({ offset, replayFrom });
  live.current = { offset, replayFrom };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    let lastFlying = -1;
    let lastDone = false;

    const loop = () => {
      const { offset: off, replayFrom: from } = live.current;
      const startsAt = from ?? finale.startsAt;
      const now = from !== null ? Date.now() : serverNow(off);
      const elapsed = (now - startsAt) * finale.speed;
      const tick = Math.max(0, Math.min(longest, Math.floor(elapsed / TICK_MS)));
      const flying = tracks.filter((t) => t.distance > tick).length;
      const done = tick >= longest && now >= startsAt;

      // Follow the leader; keep the camera on the course end once everyone has crashed.
      const camera = Math.min(tick, longest);
      const birds = tracks.map((t) => {
        const own = Math.min(tick, t.distance);
        const dead = tick >= t.distance;
        const behind = birdWorldX(camera) - birdWorldX(own);
        return {
          tick: own,
          y: t.y[own] ?? t.y[t.y.length - 1]!,
          vy: (t.y[own] ?? 0) - (t.y[own - 1] ?? t.y[own] ?? 0),
          dead,
          alpha: dead ? Math.max(0, 0.6 - behind / (WORLD_W * 1.2)) : t.userId === user.id ? 0.95 : 0.6,
          color: colorFor(t.userId),
          label: dead && behind > BIRD_X ? undefined : t.username,
          highlight: (done && t.place === 1) || (!dead && t.userId === user.id),
        };
      });

      const scale = fitCanvas(canvas);
      drawScene(ctx, scale, seed, camera, birds);
      if (now < startsAt) drawCaption(ctx, String(Math.ceil((startsAt - now) / 1000)), 200, 64);
      else if (!done) drawCaption(ctx, `${flying} flying`, 60, 22);
      else if (tracks[0]) {
        drawCaption(ctx, "🏆 Winner", 150, 28);
        drawCaption(ctx, tracks[0].username, 190, 30);
      } else drawCaption(ctx, "Nobody flew", 200, 26);

      if (flying !== lastFlying || done !== lastDone) {
        lastFlying = flying;
        lastDone = done;
        setStatus({ flying, tick, done });
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [tracks, finale, seed, longest, user.id]);

  // Crashed so far, latest first: the last one flying wins.
  const crashed = tracks.filter((t) => t.distance <= status.tick).sort((a, b) => a.place - b.place);

  return (
    <div className="finale-layout">
      <canvas ref={canvasRef} className="playfield" aria-label="Ghost replay of every player's best run" />
      <div className="finale-side card">
        <h3>Ghost race</h3>
        <p className="muted small">
          {tracks.length} ghosts at {finale.speed.toFixed(1)}× speed. {status.done ? "The race is over." : `${status.flying} still flying.`}
        </p>
        <ol className="crash-list">
          {crashed.slice(0, 12).map((t) => (
            <li key={t.userId} className={t.userId === user.id ? "mine" : ""}>
              <span className="dot" style={{ background: colorFor(t.userId) }} />
              <span className="place">#{t.place}</span> {t.username} <span className="muted">· {t.score}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
