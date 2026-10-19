import { describe, expect, it } from "vitest";
import { FollowBook, autoFollowers } from "../src/server/follow.ts";

describe("following a player", () => {
  it("tracks one followed player per person per tournament", () => {
    const f = new FollowBook();
    f.follow(1, 10, 100);
    f.follow(1, 11, 100);
    f.follow(2, 10, 200);
    expect(f.target(1, 10)).toBe(100);
    expect(f.followers(1, 100).sort()).toEqual([10, 11]);
    // Following someone else replaces it.
    f.follow(1, 10, 101);
    expect(f.followers(1, 100)).toEqual([11]);
    expect(f.forUser(10).sort((a, b) => a.tournamentId - b.tournamentId)).toEqual([
      { tournamentId: 1, target: 101 },
      { tournamentId: 2, target: 200 },
    ]);
    expect(f.unfollow(1, 10)).toBe(101);
    expect(f.unfollow(1, 10)).toBeNull();
  });

  it("releases everyone following a player who is out, and clears a whole tournament", () => {
    const f = new FollowBook();
    f.follow(1, 10, 100);
    f.follow(1, 11, 100);
    f.follow(1, 12, 101);
    f.follow(2, 10, 100);
    expect(f.release(1, 100).sort()).toEqual([10, 11]);
    expect(f.target(1, 10)).toBeNull();
    expect(f.target(2, 10)).toBe(100);
    expect(f.dropTournament(1)).toEqual([12]);
    expect(f.forUser(12)).toEqual([]);
  });

  it("auto-follows a table's winner for watchers who are out and not following anyone", () => {
    const stillPlaying = new Set([2, 3]);
    const following = new Set([5]);
    const ids = autoFollowers([1, 2, 3, 4, 4, 5, 6], 1, (id) => stillPlaying.has(id), (id) => following.has(id));
    // 1 is the winner, 2-3 still play, 5 already follows someone; 4 counts once.
    expect(ids).toEqual([4, 6]);
    expect(autoFollowers([4], null, () => false, () => false)).toEqual([]);
  });
});
