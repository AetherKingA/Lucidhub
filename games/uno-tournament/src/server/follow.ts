// Spectators following a player: whenever that player sits down at a new table, their followers are
// taken there too. Kept per person (not per browser tab), so it survives page changes and reconnects.
// In memory only: a restart clears it.

export class FollowBook {
  /** "tournamentId:followerId" -> followed player's id. */
  private targets = new Map<string, number>();

  follow(tournamentId: number, follower: number, target: number) {
    this.targets.set(`${tournamentId}:${follower}`, target);
  }

  /** Stops following. Returns who they were following, if anyone. */
  unfollow(tournamentId: number, follower: number): number | null {
    const k = `${tournamentId}:${follower}`;
    const was = this.targets.get(k) ?? null;
    this.targets.delete(k);
    return was;
  }

  target(tournamentId: number, follower: number): number | null {
    return this.targets.get(`${tournamentId}:${follower}`) ?? null;
  }

  followers(tournamentId: number, target: number): number[] {
    const out: number[] = [];
    for (const [k, t] of this.targets) {
      const [tid, follower] = k.split(":").map(Number) as [number, number];
      if (tid === tournamentId && t === target) out.push(follower);
    }
    return out;
  }

  /** Everyone following `target` stops (they were knocked out or won). Returns those followers. */
  release(tournamentId: number, target: number): number[] {
    const out = this.followers(tournamentId, target);
    for (const f of out) this.targets.delete(`${tournamentId}:${f}`);
    return out;
  }

  /** The tournament is over: clears it. Returns everyone who was following someone in it. */
  dropTournament(tournamentId: number): number[] {
    const out: number[] = [];
    for (const k of [...this.targets.keys()]) {
      const [tid, follower] = k.split(":").map(Number) as [number, number];
      if (tid !== tournamentId) continue;
      out.push(follower);
      this.targets.delete(k);
    }
    return out;
  }

  /** What one person is following, in every tournament. */
  forUser(follower: number): { tournamentId: number; target: number }[] {
    const out: { tournamentId: number; target: number }[] = [];
    for (const [k, target] of this.targets) {
      const [tid, f] = k.split(":").map(Number) as [number, number];
      if (f === follower) out.push({ tournamentId: tid, target });
    }
    return out;
  }
}

/**
 * When a table closes, who starts following its winner automatically: the people who were watching it,
 * except the winner, anyone still playing in the tournament, and anyone already following someone.
 */
export function autoFollowers(
  watcherIds: Iterable<number>,
  winnerId: number | null,
  isStillPlaying: (userId: number) => boolean,
  isFollowing: (userId: number) => boolean,
): number[] {
  if (winnerId === null) return [];
  const out = new Set<number>();
  for (const id of watcherIds) if (id !== winnerId && !isStillPlaying(id) && !isFollowing(id)) out.add(id);
  return [...out];
}
