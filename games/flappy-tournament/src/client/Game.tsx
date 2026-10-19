import { useEffect, useRef, useState } from "react";
import { type Bird, TICK_MS, newBird, step } from "../shared/engine/flappy.ts";
import type { ServerMessage, TournamentView } from "../shared/protocol.ts";
import { serverNow, useGame } from "./App.tsx";
import { drawCaption, drawScene, fitCanvas } from "./draw.ts";

type Phase = "ready" | "flying" | "dead";

/** The player's own game: tap to fly, crash, tap to go again. Only the flap ticks go to the server. */
export function Game({ view }: { view: TournamentView }) {
  const { send, offset, onRun } = useGame();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [lastRun, setLastRun] = useState<{ score: number; newBest: boolean } | null>(null);

  // Everything the animation loop reads lives in a ref, so the loop never restarts.
  const live = useRef({ view, offset });
  live.current = { view, offset };
  const run = useRef({ phase: "ready" as Phase, bird: newBird(), flaps: [] as number[], flapQueued: false, acc: 0, last: 0, deadAt: 0, sent: false });

  useEffect(() => {
    onRun.current = (msg: ServerMessage) => {
      if (msg.type === "runSaved" && msg.tournamentId === live.current.view.id) setLastRun({ score: msg.score, newBest: msg.newBest });
    };
    return () => {
      onRun.current = null;
    };
  }, [onRun]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;

    const endRun = () => {
      const r = run.current;
      if (r.sent) return;
      r.sent = true;
      send({ type: "runEnd", tournamentId: live.current.view.id, flaps: r.flaps });
    };

    const flap = () => {
      const r = run.current;
      const v = live.current.view;
      const playable = v.status === "running" && !v.paused && v.endsAt !== null && serverNow(live.current.offset) < v.endsAt;
      if (r.phase === "ready") {
        if (!playable || v.seed === null) return;
        r.phase = "flying";
        r.bird = newBird();
        r.flaps = [];
        r.acc = 0;
        r.sent = false;
        r.flapQueued = true;
        setLastRun(null);
        send({ type: "runStart", tournamentId: v.id });
      } else if (r.phase === "flying") {
        r.flapQueued = true;
      } else if (r.phase === "dead" && performance.now() - r.deadAt > 450) {
        r.phase = "ready";
        r.bird = newBird();
      }
    };

    const loop = (t: number) => {
      const r = run.current;
      const { view: v, offset: off } = live.current;
      const dt = r.last ? Math.min(250, t - r.last) : 0;
      r.last = t;
      if (r.phase === "flying" && v.seed !== null) {
        const now = serverNow(off);
        const stopped = v.paused || v.status !== "running" || (v.endsAt !== null && now >= v.endsAt);
        r.acc += dt;
        while (r.acc >= TICK_MS && !r.bird.dead && !stopped) {
          r.acc -= TICK_MS;
          const doFlap = r.flapQueued;
          r.flapQueued = false;
          if (doFlap) r.flaps.push(r.bird.tick);
          step(v.seed, r.bird, doFlap);
        }
        if (r.bird.dead || stopped) {
          r.phase = "dead";
          r.deadAt = performance.now();
          endRun();
        }
      }
      const scale = fitCanvas(canvas);
      const b: Bird = r.bird;
      drawScene(ctx, scale, v.seed, b.tick, [{ tick: b.tick, y: b.y, vy: b.vy, dead: b.dead }]);
      if (r.phase !== "ready") drawCaption(ctx, String(b.score), 70, 44);
      if (r.phase === "ready") drawCaption(ctx, v.paused ? "Paused" : "Tap to fly", 200, 30);
      if (r.phase === "dead") drawCaption(ctx, "Tap to retry", 260, 24);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
        e.preventDefault();
        if (!e.repeat) flap();
      }
    };
    const onPointer = (e: PointerEvent) => {
      e.preventDefault();
      flap();
    };
    canvas.addEventListener("pointerdown", onPointer);
    addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointer);
      removeEventListener("keydown", onKey);
      // Leaving mid-flight still counts the run so far.
      if (run.current.phase === "flying") endRun();
    };
  }, [send]);

  return (
    <div className="game">
      <canvas ref={canvasRef} className="playfield" aria-label="Flappy Bird. Tap, click or press space to flap." />
      <div className="game-foot">
        {lastRun ? (
          <span className={lastRun.newBest ? "ok" : "muted"}>
            {lastRun.newBest ? `New best: ${lastRun.score}!` : `That run: ${lastRun.score}`}
          </span>
        ) : (
          <span className="muted small">Tap, click or press space to flap</span>
        )}
      </div>
    </div>
  );
}
