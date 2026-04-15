const { InlineKeyboard, Keyboard } = require('grammy');
const db = require('./db');
const { formatPost } = require('./format');

const HOUR_LIMIT = 10;
const BTN_SEND = '📨 Отправить анонимку';

// Постоянная кнопка внизу чата (Reply Keyboard)
const MAIN_KB = new Keyboard().text(BTN_SEND).resized().persistent();

// ─── Keyboards ──────────────────────────────────────────────────────────────

function confirmKeyboard() {
  return new InlineKeyboard()
    .text('✅ Отправить', 'confirm').text('✏️ Изменить', 'edit').text('❌ Отмена', 'cancel');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resetSession(ctx) {
  Object.assign(ctx.session, {
    step: null, category: null, text: null,
    mediaFileId: null, mediaType: null,
  });
}

/**
 * Checks ban status and hourly submission limit.
 * Does NOT mutate the DB — call incrementCount separately on success.
 * @returns {{ banned: true } | { allowed: false, minutesLeft: number } | { allowed: true }}
 */
function checkLimit(userId) {
  db.createUser.run(userId);
  let user = db.getUser.get(userId);

  if (user.is_banned) return { banned: true };

  const now = Date.now();
  const resetAt = user.hour_reset_at ? new Date(user.hour_reset_at).getTime() : now;

  if (now - resetAt > 3_600_000) {
    db.resetUserHour.run(new Date().toISOString(), userId);
    user = db.getUser.get(userId);
  }

  if (user.submissions_count_hour >= HOUR_LIMIT) {
    const minutesLeft = Math.max(1, Math.ceil((resetAt + 3_600_000 - now) / 60_000));
    return { allowed: false, minutesLeft };
  }

  return { allowed: true };
}

async function showConfirmation(ctx) {
  const { text, mediaFileId, mediaType } = ctx.session;
  const postText = formatPost(text);
  const kb = confirmKeyboard();

  if (mediaFileId) {
    let sendMedia;
    if (mediaType === 'photo') {
      sendMedia = ctx.replyWithPhoto.bind(ctx);
    } else if (mediaType === 'animation') {
      sendMedia = ctx.replyWithAnimation.bind(ctx);
    } else {
      sendMedia = ctx.replyWithVideo.bind(ctx);
    }
    await sendMedia(mediaFileId, { caption: postText, parse_mode: 'HTML' });
    await ctx.reply('Всё верно?', { reply_markup: kb });
  } else {
    await ctx.reply(
      `Проверь свою анонимку:\n\n${postText}\n\nВсё верно?`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }
}

/** Запускает флоу отправки анонимки (общий код для кнопки и callback). */
async function startSendFlow(ctx) {
  const userId = ctx.from.id;
  db.createUser.run(userId);
  const user = db.getUser.get(userId);

  if (user.is_banned) {
    await ctx.reply('🚫 Ты заблокирован и не можешь отправлять анонимки.', {
      reply_markup: MAIN_KB,
    });
    return;
  }

  resetSession(ctx);
  ctx.session.step = 'text';
  await ctx.reply('Напиши текст своей анонимки (максимум 300 символов):');
}

// ─── Setup ──────────────────────────────────────────────────────────────────

function setupUserFlow(composer) {
  // /start
  composer.command('start', async (ctx) => {
    resetSession(ctx);
    await ctx.reply(
      '👋 Привет! Это бот канала Признавашки НФ УУНИТ.\n\n' +
      'Здесь ты можешь анонимно отправить признание, юмор, вопрос или жалобу.\n\n' +
      'Никто не узнает кто ты — твой аккаунт скрыт полностью.\n\n' +
      'Нажми кнопку ниже чтобы отправить анонимку 👇',
      { reply_markup: MAIN_KB },
    );
  });

  // /help
  composer.command('help', async (ctx) => {
    await ctx.reply(
      '📖 Команды бота:\n\n' +
      `${BTN_SEND} — отправить анонимку\n` +
      '/cancel — отменить текущую анонимку\n' +
      '/mystats — моя статистика\n' +
      '/start — приветствие',
      { reply_markup: MAIN_KB },
    );
  });

  // /cancel — сбросить флоу в любой момент
  composer.command('cancel', async (ctx) => {
    resetSession(ctx);
    await ctx.reply('Отменено. Нажми кнопку ниже чтобы попробовать снова 👇', {
      reply_markup: MAIN_KB,
    });
  });

  // /mystats — статистика пользователя
  composer.command('mystats', async (ctx) => {
    const userId = ctx.from.id;
    db.createUser.run(userId);
    const s = db.getUserStats.get(userId);
    if (!s || s.total === 0) {
      await ctx.reply('У тебя пока нет анонимок.', { reply_markup: MAIN_KB });
      return;
    }
    await ctx.reply(
      '📊 Твоя статистика:\n\n' +
      `📨 Всего отправлено: ${s.total}\n` +
      `✅ Опубликовано: ${s.approved}\n` +
      `⏸ На рассмотрении: ${s.pending}\n` +
      `❌ Отклонено: ${s.rejected}`,
      { reply_markup: MAIN_KB },
    );
  });

  // Медиа — прикрепить
  composer.callbackQuery('media_yes', async (ctx) => {
    if (ctx.session.step !== 'media_prompt') { await ctx.answerCallbackQuery(); return; }
    ctx.session.step = 'media_wait';
    await ctx.answerCallbackQuery();
    await ctx.reply('Отправь фото, GIF или видео (только один файл):');
  });

  // Медиа — пропустить
  composer.callbackQuery('media_no', async (ctx) => {
    if (ctx.session.step !== 'media_prompt') { await ctx.answerCallbackQuery(); return; }
    ctx.session.mediaFileId = null;
    ctx.session.mediaType = null;
    ctx.session.step = 'confirm';
    await ctx.answerCallbackQuery();
    await showConfirmation(ctx);
  });

  // Подтверждение — отправить
  composer.callbackQuery('confirm', async (ctx) => {
    if (ctx.session.step !== 'confirm') { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();

    const userId = ctx.from.id;
    const { text, mediaFileId, mediaType } = ctx.session;

    const check = checkLimit(userId);
    if (check.banned) {
      resetSession(ctx);
      await ctx.reply('🚫 Ты заблокирован и не можешь отправлять анонимки.', { reply_markup: MAIN_KB });
      return;
    }
    if (!check.allowed) {
      resetSession(ctx);
      await ctx.reply(
        `⏳ Ты уже отправил 10 анонимок за этот час.\nПопробуй через ${check.minutesLeft} минут.`,
        { reply_markup: MAIN_KB },
      );
      return;
    }

    // Антидубль: та же анонимка от того же юзера за последний час
    if (db.findDuplicateSubmission.get(userId, text)) {
      resetSession(ctx);
      await ctx.reply(
        '🔁 Ты уже отправлял точно такую же анонимку за последний час.\nПопробуй изменить текст.',
        { reply_markup: MAIN_KB },
      );
      return;
    }

    db.incrementCount.run(userId);
    const { lastInsertRowid: submissionId } = db.createSubmission.run(
      userId, text, mediaFileId ?? null, mediaType ?? null,
    );
    db.incSubmitted.run();

    resetSession(ctx);
    await ctx.reply('✅ Анонимка отправлена на модерацию! Мы уведомим тебя о результате.', {
      reply_markup: MAIN_KB,
    });

    const { sendToModChat } = require('./modFlow');
    await sendToModChat(ctx.api, submissionId).catch((err) =>
      console.error('sendToModChat error:', err),
    );
  });

  // Подтверждение — изменить
  composer.callbackQuery('edit', async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.step = 'text';
    ctx.session.text = null;
    ctx.session.mediaFileId = null;
    ctx.session.mediaType = null;
    await ctx.reply('Напиши текст своей анонимки (максимум 300 символов):');
  });

  // Подтверждение — отмена
  composer.callbackQuery('cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    resetSession(ctx);
    await ctx.reply('Отменено. Нажми кнопку ниже чтобы попробовать снова 👇', {
      reply_markup: MAIN_KB,
    });
  });

  // Текстовые сообщения
  composer.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;

    // Постоянная кнопка «Отправить анонимку» — запускает флоу в любой момент
    if (text === BTN_SEND) {
      await startSendFlow(ctx);
      return;
    }

    // Ввод текста анонимки
    if (ctx.session.step === 'text') {
      if (text.length > 300) {
        await ctx.reply(
          `❌ Слишком длинно! Максимум 300 символов. У тебя: ${text.length} символов.\nСократи и отправь снова.`,
        );
        return;
      }
      ctx.session.text = text;
      ctx.session.step = 'media_prompt';
      await ctx.reply('Хочешь прикрепить фото, GIF или видео?', {
        reply_markup: new InlineKeyboard()
          .text('📎 Прикрепить', 'media_yes')
          .text('➡️ Без медиа', 'media_no'),
      });
      return;
    }

    return next();
  });

  // Фото
  composer.on('message:photo', async (ctx) => {
    if (ctx.session.step !== 'media_wait') return;
    const photo = ctx.message.photo.at(-1);
    ctx.session.mediaFileId = photo.file_id;
    ctx.session.mediaType = 'photo';
    ctx.session.step = 'confirm';
    await showConfirmation(ctx);
  });

  // Видео
  composer.on('message:video', async (ctx) => {
    if (ctx.session.step !== 'media_wait') return;
    ctx.session.mediaFileId = ctx.message.video.file_id;
    ctx.session.mediaType = 'video';
    ctx.session.step = 'confirm';
    await showConfirmation(ctx);
  });

  // GIF / анимация
  composer.on('message:animation', async (ctx) => {
    if (ctx.session.step !== 'media_wait') return;
    ctx.session.mediaFileId = ctx.message.animation.file_id;
    ctx.session.mediaType = 'animation';
    ctx.session.step = 'confirm';
    await showConfirmation(ctx);
  });
}

module.exports = { setupUserFlow };
