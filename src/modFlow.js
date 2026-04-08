const { InlineKeyboard } = require('grammy');
const db = require('./db');
const { CATEGORIES, formatModHeader, formatPost } = require('./format');

const MOD_CHAT_ID = () => process.env.MOD_CHAT_ID;
const CHANNEL_ID  = () => process.env.CHANNEL_ID;

// ─── Keyboards ──────────────────────────────────────────────────────────────

function modKeyboard(subId, userId) {
  return new InlineKeyboard()
    .text('✅ Опубликовать', `approve:${subId}`).text('⏸ Отложить', `postpone:${subId}`).row()
    .text('❌ Отклонить',    `reject:${subId}`). text('🚫 Забанить',  `ban:${subId}:${userId}`);
}

function postponedKeyboard(subId, userId) {
  return new InlineKeyboard()
    .text('✅ Опубликовать',       `approve:${subId}`).text('❌ Отклонить', `reject:${subId}`).row()
    .text('🚫 Забанить',           `ban:${subId}:${userId}`)
    .text('🔄 Вернуть в очередь', `return:${subId}`);
}

const emptyKeyboard = new InlineKeyboard();

// ─── Helpers ────────────────────────────────────────────────────────────────

function modName(ctx) {
  const u = ctx.from;
  return u.username ? `@${u.username}` : (u.first_name || `id${u.id}`);
}

/**
 * Edits the text/caption of the mod message.
 * Pass `keyboard` to update buttons, or `null` to remove them.
 */
async function editModMsg(api, submission, newText, keyboard) {
  if (!submission.mod_message_id) return;
  const chatId = MOD_CHAT_ID();
  const msgId  = submission.mod_message_id;
  const kb     = keyboard ?? emptyKeyboard;

  try {
    if (submission.media_file_id) {
      await api.editMessageCaption(chatId, msgId, {
        caption:      newText,
        parse_mode:   'HTML',
        reply_markup: kb,
      });
    } else {
      await api.editMessageText(chatId, msgId, newText, {
        parse_mode:   'HTML',
        reply_markup: kb,
      });
    }
  } catch (err) {
    console.error('editModMsg error:', err.message);
  }
}

/**
 * Sends a new submission to the mod chat.
 * Called after the user confirms submission.
 */
async function sendToModChat(api, submissionId) {
  const sub = db.getSubmission.get(submissionId);
  if (!sub) return;

  const text = formatModHeader(sub);
  const kb   = modKeyboard(sub.id, sub.user_id);

  let msg;
  if (sub.media_file_id) {
    const send = sub.media_type === 'photo'
      ? api.sendPhoto.bind(api)
      : api.sendVideo.bind(api);
    msg = await send(MOD_CHAT_ID(), sub.media_file_id, {
      caption: text, parse_mode: 'HTML', reply_markup: kb,
    });
  } else {
    msg = await api.sendMessage(MOD_CHAT_ID(), text, {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  db.setModMsgId.run(msg.message_id, sub.id);
}

// ─── Notify user ─────────────────────────────────────────────────────────────

async function notifyUser(api, userId, text) {
  try {
    await api.sendMessage(userId, text);
  } catch (err) {
    console.error(`Failed to notify user ${userId}:`, err.message);
  }
}

// ─── Publish to channel ──────────────────────────────────────────────────────

async function publishToChannel(api, submission) {
  const postText = formatPost(submission.text);
  const noPreview = { link_preview_options: { is_disabled: true } };

  if (submission.media_file_id) {
    const send = submission.media_type === 'photo'
      ? api.sendPhoto.bind(api)
      : api.sendVideo.bind(api);
    await send(CHANNEL_ID(), submission.media_file_id, {
      caption: postText, parse_mode: 'HTML', ...noPreview,
    });
  } else {
    await api.sendMessage(CHANNEL_ID(), postText, {
      parse_mode: 'HTML', ...noPreview,
    });
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

function setupModFlow(composer) {
  // /stats
  composer.command('stats', async (ctx) => {
    const s = db.getStats.get();
    await ctx.reply(
      `📊 Статистика бота:\n\n` +
      `📨 Всего подано: ${s.total_submitted}\n` +
      `✅ Опубликовано: ${s.total_approved}\n` +
      `❌ Отклонено: ${s.total_rejected}\n` +
      `⏸ Отложено: ${s.total_postponed}`,
    );
  });

  // /unban <user_id>
  composer.command('unban', async (ctx) => {
    const userId = parseInt(ctx.match, 10);
    if (!userId) {
      await ctx.reply('Использование: /unban <user_id>');
      return;
    }
    db.unbanUser.run(userId);
    await ctx.reply(`✅ Пользователь ${userId} разбанен.`);
  });

  // /bans
  composer.command('bans', async (ctx) => {
    const list = db.getBannedUsers.all();
    if (!list.length) {
      await ctx.reply('Список заблокированных пуст.');
      return;
    }
    const text = list.map((u) => `• ${u.user_id} — ${u.ban_reason || 'без причины'}`).join('\n');
    await ctx.reply(`🚫 Заблокированные пользователи:\n\n${text}`);
  });

  // ✅ Опубликовать
  composer.callbackQuery(/^approve:(\d+)$/, async (ctx) => {
    const subId = Number(ctx.match[1]);
    const sub   = db.getSubmission.get(subId);

    if (!sub) { await ctx.answerCallbackQuery('Анонимка не найдена'); return; }
    if (sub.status === 'approved') { await ctx.answerCallbackQuery('Уже опубликовано'); return; }

    await ctx.answerCallbackQuery('Публикуем…');

    try {
      await publishToChannel(ctx.api, sub);
    } catch (err) {
      console.error('publish error:', err.message);
      await ctx.reply(`❗ Ошибка при публикации анонимки #${subId}: ${err.message}`);
      return;
    }

    db.updateStatus.run('approved', null, subId);
    db.incApproved.run();

    await notifyUser(ctx.api, sub.user_id, '✅ Твоя анонимка опубликована в канале!');

    const name = modName(ctx);
    const time = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
    const newText = `${formatModHeader(sub)}\n\n✅ Опубликовано ${name} в ${time}`;
    await editModMsg(ctx.api, sub, newText, null);
  });

  // ⏸ Отложить
  composer.callbackQuery(/^postpone:(\d+)$/, async (ctx) => {
    const subId = Number(ctx.match[1]);
    const sub   = db.getSubmission.get(subId);

    if (!sub) { await ctx.answerCallbackQuery('Анонимка не найдена'); return; }

    await ctx.answerCallbackQuery('Отложено');

    db.updateStatus.run('postponed', null, subId);
    db.incPostponed.run();

    const name    = modName(ctx);
    const newText = `${formatModHeader(sub)}\n\n⏸ Отложено ${name}`;
    const kb      = postponedKeyboard(subId, sub.user_id);
    await editModMsg(ctx.api, sub, newText, kb);
  });

  // 🔄 Вернуть в очередь
  composer.callbackQuery(/^return:(\d+)$/, async (ctx) => {
    const subId = Number(ctx.match[1]);
    const sub   = db.getSubmission.get(subId);

    if (!sub) { await ctx.answerCallbackQuery('Анонимка не найдена'); return; }

    await ctx.answerCallbackQuery('Возвращено в очередь');

    db.updateStatus.run('pending', null, subId);

    const name    = modName(ctx);
    const newText = `${formatModHeader(sub)}\n\n🔄 Возвращено в очередь ${name}`;
    const kb      = modKeyboard(subId, sub.user_id);
    await editModMsg(ctx.api, sub, newText, kb);
  });

  // ❌ Отклонить — запрос причины
  composer.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
    const subId = Number(ctx.match[1]);
    const sub   = db.getSubmission.get(subId);

    if (!sub) { await ctx.answerCallbackQuery('Анонимка не найдена'); return; }

    await ctx.answerCallbackQuery();
    ctx.session.awaitingRejectFor = subId;
    ctx.session.awaitingBanFor   = null;
    await ctx.reply(`✏️ Напиши причину отклонения анонимки #${subId}:`);
  });

  // 🚫 Забанить — запрос причины
  composer.callbackQuery(/^ban:(\d+):(\d+)$/, async (ctx) => {
    const subId  = Number(ctx.match[1]);
    const userId = Number(ctx.match[2]);
    const sub    = db.getSubmission.get(subId);

    if (!sub) { await ctx.answerCallbackQuery('Анонимка не найдена'); return; }

    await ctx.answerCallbackQuery();
    ctx.session.awaitingBanFor   = { subId, userId };
    ctx.session.awaitingRejectFor = null;
    await ctx.reply(`✏️ Напиши причину бана автора анонимки #${subId}:`);
  });

  // Текстовые сообщения в чате модераторов — причины отклонения/бана
  composer.on('message:text', async (ctx, next) => {
    const { awaitingRejectFor, awaitingBanFor } = ctx.session;

    // ── Причина отклонения ────────────────────────────────────────────────
    if (awaitingRejectFor != null) {
      const subId  = awaitingRejectFor;
      const reason = ctx.message.text;
      ctx.session.awaitingRejectFor = null;

      const sub = db.getSubmission.get(subId);
      if (!sub) { await ctx.reply('Анонимка не найдена.'); return; }

      db.updateStatus.run('rejected', reason, subId);
      db.incRejected.run();

      await notifyUser(ctx.api, sub.user_id, `❌ Твоя анонимка отклонена.\nПричина: ${reason}`);

      const name    = modName(ctx);
      const newText = `${formatModHeader(sub)}\n\n❌ Отклонено ${name}: ${reason}`;
      await editModMsg(ctx.api, sub, newText, null);

      await ctx.reply(`✅ Анонимка #${subId} отклонена.`);
      return;
    }

    // ── Причина бана ──────────────────────────────────────────────────────
    if (awaitingBanFor != null) {
      const { subId, userId } = awaitingBanFor;
      const reason = ctx.message.text;
      ctx.session.awaitingBanFor = null;

      const sub = db.getSubmission.get(subId);
      if (!sub) { await ctx.reply('Анонимка не найдена.'); return; }

      db.banUser.run(reason, userId);
      db.updateStatus.run('rejected', `Бан: ${reason}`, subId);
      db.incRejected.run();

      const name    = modName(ctx);
      const newText = `${formatModHeader(sub)}\n\n🚫 Забанен ${name}: ${reason}`;
      await editModMsg(ctx.api, sub, newText, null);

      await ctx.reply(`✅ Пользователь ${userId} забанен, анонимка #${subId} отклонена.`);
      return;
    }

    return next();
  });
}

module.exports = { setupModFlow, sendToModChat };
