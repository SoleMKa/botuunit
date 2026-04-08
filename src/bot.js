require('dotenv').config();
const { Bot, session } = require('grammy');
const { limit } = require('@grammyjs/ratelimiter');
const { setupUserFlow } = require('./userFlow');
const { setupModFlow }  = require('./modFlow');
const { sessionStorage } = require('./db');

// ─── Validate env ────────────────────────────────────────────────────────────

const requiredEnv = ['BOT_TOKEN', 'MOD_CHAT_ID', 'CHANNEL_ID'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ─── Bot setup ───────────────────────────────────────────────────────────────

const bot = new Bot(process.env.BOT_TOKEN);

// Flood protection: не более 1 сообщения в секунду на пользователя
bot.use(limit());

// SQLite-backed session storage — переживает рестарты бота
bot.use(session({
  initial: () => ({
    // User flow state
    step:        null,   // null | 'category' | 'text' | 'media_prompt' | 'media_wait' | 'confirm'
    category:    null,
    text:        null,
    mediaFileId: null,
    mediaType:   null,
    // Mod flow state
    awaitingRejectFor: null,  // submission id
    awaitingBanFor:    null,  // { subId, userId }
  }),
  storage: sessionStorage,
}));

// ─── Route by chat type ──────────────────────────────────────────────────────

// Private chats → user flow
const privateBot = bot.filter((ctx) => ctx.chat?.type === 'private');

// Moderator group chat → mod flow
const modBot = bot.filter(
  (ctx) => ctx.chat?.id?.toString() === process.env.MOD_CHAT_ID,
);

setupUserFlow(privateBot);
setupModFlow(modBot);

// ─── Error handler ───────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error(`Unhandled error for update ${err.ctx?.update?.update_id}:`, err.error);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`${signal} received, stopping bot…`);
  await bot.stop();
  process.exit(0);
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ───────────────────────────────────────────────────────────────────

bot.start({
  onStart: (info) => console.log(`Bot @${info.username} started.`),
});
