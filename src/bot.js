require('dotenv').config();
const { Bot, session } = require('grammy');
const { setupUserFlow } = require('./userFlow');
const { setupModFlow }  = require('./modFlow');

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

// ─── Start ───────────────────────────────────────────────────────────────────

bot.start({
  onStart: (info) => console.log(`Bot @${info.username} started.`),
});
