const { InlineKeyboard } = require('grammy');
const db = require('./db');
const { CATEGORIES, formatModHeader, formatPost } = require('./format');

const MOD_CHAT_ID = () => process.env.MOD_CHAT_ID;
const CHANNEL_ID  = () => process.env.CHANNEL_ID;

// ─── Quick reject reasons ────────────────────────────────────────────────────

const REJECT_REASONS = [
  'Спам или реклама',
  'Оскорбления / нецензурная лексика',
  'Не по теме канала',
  'Дублирует другую анонимку',
];

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

function rejectReasonsKeyboard(subId) {
  const kb = new InlineKeyboard();
  REJECT_REASONS.forEach((reason, i) => {
    kb.text(reason, `rr:${subId}:${i}`).row();
  });
  kb.text('✏️ Другая причина', `rrc:${subId}`);
  return kb;
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
 * Retries once after 2s on failure.
 */
async function sendToModChat(api, submissionId, attempt = 1) {
  const sub = db.getSubmission.get(submissionId);
  if (!sub) return;

  const text = formatModHeader(sub);
  const kb   = modKeyboard(sub.id, sub.user_id);

  try {
    let msg;
    if (sub.media_file_id) {
      let send;
      if (sub.media_type === 'photo') {
        send = api.sendPhoto.bind(api);
      } else if (sub.media_type === 'animation') {
        send = api.sendAnimation.bind(api);
      } else {
        send = api.sendVideo.bind(api);
      }
      msg = await send(MOD_CHAT_ID(), sub.media_file_id, {
        caption: text, parse_mode: 'HTML', reply_markup: kb,
      });
    } else {
      msg = await api.sendMessage(MOD_CHAT_ID(), text, {
        parse_mode: 'HTML', reply_markup: kb,
      });
    }
    db.setModMsgId.run(msg.message_id, sub.id);
  } catch (err) {
    if (attempt < 2) {
      console.warn(`sendToModChat attempt ${attempt} failed, retrying…`, err.message);
      await new Promise((r) => setTimeout(r, 2000));
      return sendToModChat(api, submissionId, attempt + 1);
    }
    // После двух попыток — предупреждение в мод-чат
    try {
      await api.sendMessage(
        MOD_CHAT_ID(),
        `⚠️ Не удалось переслать анонимку #${submissionId} в чат модераторов.\nОшибка: ${err.message}`,
      );
    } catch (_) { /* ignore */ }
    throw err;
  }
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
    let send;
    if (submission.media_type === 'photo') {
      send = api.sendPhoto.bind(api);
    } else if (submission.media_type === 'animation') {
      send = api.sendAnimation.bind(api);
    } else {
      send = api.sendVideo.bind(api);
    }
    await send(CHANNEL_ID(), submission.media_file_id, {
      caption: postText, parse_mode: 'HTML', ...noPreview,
    });
  } else {
    await api.sendMessage(CHANNEL_ID(), postText, {
      parse_mode: 'HTML', ...noPreview,
    });
  }
}

// ─── Reject helper ────────────────────────────────────────────────────────────

async function doReject(api, ctx, subId, reason) {
  const sub = db.getSubmission.get(subId);
  if (!sub) {
    await ctx.reply('Анонимка не найдена.');
    return;
  }

  db.updateStatus.run('rejected', reason, subId);
  db.incRejected.run();

  await notifyUser(api, sub.user_id, `❌ Твоя анонимка отклонена.\nПричина: ${reason}`);

  const name    = modName(ctx);
  const newText = `${formatModHeader(sub)}\n\n❌ Отклонено ${name}: ${reason}`;
  await editModMsg(api, sub, newText, null);

  await ctx.reply(`✅ Анонимка #${subId} отклонена.`);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

function setupModFlow(composer) {
  // /stats
  composer.command('stats', async (ctx) => {
    const s = db.getStats.get();
    const banned = db.getBannedCount.get().cnt;
    await ctx.reply(
      `📊 Статистика бота:\n\n` +
      `📨 Всего подано: ${s.total_submitted}\n` +
      `✅ Опубликовано: ${s.total_approved}\n` +
      `❌ Отклонено: ${s.total_rejected}\n` +
      `⏸ Отложено: ${s.total_postponed}\n` +
      `🚫 В бане: ${banned}`,
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

  // /get <id> — получить анонимку по ID
  composer.command('get', async (ctx) => {
    const subId = parseInt(ctx.match, 10);
    if (!subId) {
      await ctx.reply('Использование: /get <id>');
      return;
    }
    const sub = db.getSubmission.get(subId);
    if (!sub) {
      await ctx.reply(`Анонимка #${subId} не найдена.`);
      return;
    }

    const text = formatModHeader(sub);
    let kb;
    if (sub.status === 'pending')    kb = modKeyboard(sub.id, sub.user_id);
    else if (sub.status === 'postponed') kb = postponedKeyboard(sub.id, sub.user_id);
    else                             kb = emptyKeyboard;

    const statusLabel = { pending: 'В очереди', approved: '✅ Опубликована', rejected: '❌ Отклонена', postponed: '⏸ Отложена' }[sub.status] ?? sub.status;

    const fullText = `${text}\n\nСтатус: ${statusLabel}`;

    if (sub.media_file_id) {
      let send;
      if (sub.media_type === 'photo') {
        send = ctx.replyWithPhoto.bind(ctx);
      } else if (sub.media_type === 'animation') {
        send = ctx.replyWithAnimation.bind(ctx);
      } else {
        send = ctx.replyWithVideo.bind(ctx);
      }
      const msg = await send(sub.media_file_id, { caption: fullText, parse_mode: 'HTML', reply_markup: kb });
      if (sub.status === 'pending' || sub.status === 'postponed') {
        db.setModMsgId.run(msg.message_id, sub.id);
      }
    } else {
      const msg = await ctx.reply(fullText, { parse_mode: 'HTML', reply_markup: kb });
      if (sub.status === 'pending' || sub.status === 'postponed') {
        db.setModMsgId.run(msg.message_id, sub.id);
      }
    }
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

    // Считаем отложенные только один раз (не при повторном откладывании)
    if (sub.status !== 'postponed') db.incPostponed.run();

    db.updateStatus.run('postponed', null, subId);

    await notifyUser(ctx.api, sub.user_id, '⏸ Твоя анонимка отложена модераторами. Мы вернёмся к ней позже.');

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

  // ❌ Отклонить — показать быстрые причины
  composer.callbackQuery(/^reject:(\d+)$/, async (ctx) => {
    const subId = Number(ctx.match[1]);
    const sub   = db.getSubmission.get(subId);

    if (!sub) { await ctx.answerCallbackQuery('Анонимка не найдена'); return; }

    await ctx.answerCallbackQuery();
    ctx.session.awaitingRejectFor = null;
    ctx.session.awaitingBanFor   = null;
    await ctx.reply(
      `Выбери причину отклонения анонимки #${subId}:`,
      { reply_markup: rejectReasonsKeyboard(subId) },
    );
  });

  // ❌ Быстрая причина отклонения
  composer.callbackQuery(/^rr:(\d+):(\d+)$/, async (ctx) => {
    const subId      = Number(ctx.match[1]);
    const reasonIdx  = Number(ctx.match[2]);
    const reason     = REJECT_REASONS[reasonIdx];

    if (!reason) { await ctx.answerCallbackQuery('Неверный индекс'); return; }

    await ctx.answerCallbackQuery('Отклоняем…');
    await doReject(ctx.api, ctx, subId, reason);
  });

  // ❌ Своя причина отклонения — запросить текст
  composer.callbackQuery(/^rrc:(\d+)$/, async (ctx) => {
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

      await doReject(ctx.api, ctx, subId, reason);
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
