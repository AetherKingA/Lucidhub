// The Discord bot: DMs prizes, posts announcements and alerts, and answers /prizes and /hub.

import {
  ChannelType,
  Client,
  DiscordAPIError,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  SlashCommandBuilder,
} from "discord.js";
import type { BotStatus } from "../shared/protocol.ts";
import { prizesForUser, renderAward } from "./awards.ts";
import { config } from "./config.ts";
import { db, getSettings } from "./db.ts";
import { DmClosedError, type Messenger } from "./delivery.ts";
import { listEvents } from "./events.ts";
import { listPrizes } from "./prizes.ts";

/** Discord errors that mean "this user can't be DM'd": DMs closed, blocked, or unknown user. */
const PERMANENT_DM_ERRORS = new Set([50007, 10013, 50278]);
/** View Channel + Send Messages + Embed Links. */
const BOT_PERMISSIONS = 1024 + 2048 + 16384;
/** Lucid mint green, used as the embed colour. */
const LUCID_GREEN = 0x30d68a;

const COMMANDS = [
  new SlashCommandBuilder().setName("prizes").setDescription("See the prizes you've won (only you can see the reply)"),
  new SlashCommandBuilder()
    .setName("hub")
    .setDescription("LucidHub admin tools")
    .addSubcommand((s) => s.setName("status").setDescription("Upcoming events, failed deliveries and low stock")),
].map((c) => c.toJSON());

export class Bot implements Messenger {
  client: Client | null = null;
  private registeredFor: string | null = null;

  async start() {
    if (!config.discord.botToken) {
      console.log("[bot] No DISCORD_BOT_TOKEN set — prizes will queue up until the bot is configured.");
      return;
    }
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client = client;
    client.once(Events.ClientReady, (c) => {
      console.log(`[bot] Online as ${c.user.tag}`);
      void this.registerCommands();
    });
    client.on(Events.InteractionCreate, (i) => void this.onInteraction(i));
    client.on(Events.Error, (err) => console.warn("[bot] Error:", err.message));
    try {
      await client.login(config.discord.botToken);
    } catch (err) {
      console.error("[bot] Login failed — check DISCORD_BOT_TOKEN:", (err as Error).message);
      this.client = null;
    }
  }

  async stop() {
    await this.client?.destroy();
  }

  ready() {
    return Boolean(this.client?.isReady());
  }

  /** Guild commands appear instantly; we register them for the configured server (or every server the bot is in). */
  async registerCommands() {
    const client = this.client;
    if (!client?.isReady()) return;
    const { guildId } = getSettings();
    const key = guildId || "*";
    if (this.registeredFor === key) return;
    try {
      const guilds = guildId ? [await client.guilds.fetch(guildId)] : [...client.guilds.cache.values()];
      for (const g of guilds) await g.commands.set(COMMANDS);
      this.registeredFor = key;
      console.log(`[bot] Slash commands ready in ${guilds.map((g) => g.name).join(", ") || "no servers yet"}`);
    } catch (err) {
      console.warn("[bot] Could not register slash commands:", (err as Error).message);
    }
  }

  async sendDm(discordId: string, message: { title: string; text: string; imageUrl: string | null }) {
    const client = this.client;
    if (!client?.isReady()) throw new Error("Bot is offline");
    try {
      const user = await client.users.fetch(discordId);
      const embed = new EmbedBuilder().setColor(LUCID_GREEN).setTitle(message.title).setDescription(message.text.slice(0, 4000));
      if (message.imageUrl) embed.setImage(message.imageUrl);
      await user.send({ embeds: [embed] });
    } catch (err) {
      if (err instanceof DiscordAPIError && typeof err.code === "number" && PERMANENT_DM_ERRORS.has(err.code)) throw new DmClosedError(err.message);
      throw err;
    }
  }

  async post(channelId: string, text: string) {
    const client = this.client;
    if (!client?.isReady()) throw new Error("Bot is offline");
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error("The bot can't post in that channel");
    await channel.send({ content: text.slice(0, 2000), allowedMentions: { parse: ["users"] } });
  }

  /** Alerts go to the alerts channel, or by DM to every admin if none is set. */
  async alert(message: string) {
    if (!this.ready()) return;
    const { alertsChannelId } = getSettings();
    if (alertsChannelId) return this.post(alertsChannelId, `⚠️ ${message}`);
    for (const id of config.adminDiscordIds) {
      try {
        await this.sendDm(id, { title: "⚠️ LucidHub", text: message, imageUrl: null });
      } catch (err) {
        console.warn(`[bot] Could not DM alert to admin ${id}:`, (err as Error).message);
      }
    }
  }

  async status(): Promise<BotStatus> {
    const client = this.client;
    const appId = client?.application?.id ?? config.discord.clientId;
    const inviteUrl = appId
      ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`
      : null;
    if (!client?.isReady()) return { configured: Boolean(config.discord.botToken), online: false, tag: null, inviteUrl, guilds: [], channels: [] };
    const guilds = [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
    const { guildId } = getSettings();
    let channels: BotStatus["channels"] = [];
    const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.size === 1 ? client.guilds.cache.first() : undefined;
    if (guild) {
      const all = await guild.channels.fetch();
      channels = [...all.values()]
        .filter((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
        .sort((a, b) => a!.rawPosition - b!.rawPosition)
        .map((c) => ({ id: c!.id, name: c!.name }));
    }
    return { configured: true, online: true, tag: client.user.tag, inviteUrl, guilds, channels };
  }

  // ---------------------------------------------------------------- slash commands

  private async onInteraction(i: Interaction) {
    if (!i.isChatInputCommand()) return;
    try {
      if (i.commandName === "prizes") await this.prizesCommand(i);
      else if (i.commandName === "hub") await this.hubCommand(i);
    } catch (err) {
      console.warn(`[bot] /${i.commandName} failed:`, (err as Error).message);
      const reply = { content: "Something went wrong — try again in a minute.", flags: MessageFlags.Ephemeral } as const;
      if (i.replied || i.deferred) await i.followUp(reply).catch(() => {});
      else await i.reply(reply).catch(() => {});
    }
  }

  private async prizesCommand(i: ChatInputCommandInteraction) {
    const prizes = prizesForUser(i.user.id);
    if (prizes.length === 0) {
      await i.reply({ content: "You haven't won any prizes yet. Good luck in the next event!", flags: MessageFlags.Ephemeral });
      return;
    }
    const embeds = prizes.slice(0, 10).map((p) => {
      const msg = renderAward(p.awardId);
      const embed = new EmbedBuilder().setColor(LUCID_GREEN).setTitle(`#${p.place} — ${p.eventName}`);
      if (p.status === "waiting_stock") return embed.setDescription(`**${msg?.prizeName}** — on its way. You'll get a DM as soon as it's ready.`);
      if (p.status === "pending") return embed.setDescription(`**${msg?.prizeName}** — sending now, check your DMs shortly.`);
      if (msg?.imageUrl) embed.setImage(msg.imageUrl);
      return embed.setDescription((msg?.text ?? "").slice(0, 4000));
    });
    await i.reply({ embeds, flags: MessageFlags.Ephemeral });
  }

  private async hubCommand(i: ChatInputCommandInteraction) {
    if (!config.adminDiscordIds.has(i.user.id)) {
      await i.reply({ content: "Only LucidHub admins can use this.", flags: MessageFlags.Ephemeral });
      return;
    }
    const upcoming = listEvents({ status: "registering", limit: 5 });
    const live = listEvents({ status: "running", limit: 5 });
    const failed = (db.prepare(`SELECT COUNT(*) AS n FROM awards WHERE status = 'dm_failed'`).get() as { n: number }).n;
    const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM awards WHERE status = 'waiting_stock'`).get() as { n: number }).n;
    const low = listPrizes().filter((p) => p.type === "code_pool" && p.stock <= p.lowStockThreshold);
    const fmt = (t: number | null) => (t ? `<t:${Math.floor(t / 1000)}:R>` : "");
    const lines = [
      `**Live:** ${live.map((e) => `${e.name} (${e.entrants} players)`).join(", ") || "none"}`,
      `**Upcoming:** ${upcoming.map((e) => `${e.name} ${fmt(e.startTime)}`).join(", ") || "none"}`,
      `**Failed DMs:** ${failed}   **Waiting for codes:** ${waiting}`,
      `**Low stock:** ${low.map((p) => `${p.name} (${p.stock})`).join(", ") || "none"}`,
      `Dashboard: ${config.publicUrl}`,
    ];
    await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }
}
