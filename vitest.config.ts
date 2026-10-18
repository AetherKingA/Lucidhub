import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test file gets its own in-memory database and never touches data/hub.db or Discord.
    env: { DB_PATH: ":memory:", DISCORD_BOT_TOKEN: "", ADMIN_DISCORD_IDS: "100" },
  },
});
