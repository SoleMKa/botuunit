/**
 * Escapes special HTML characters to prevent injection in parse_mode: 'HTML'.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Builds the final post text for the channel (used as message text or media caption).
 */
function formatPost(text) {
  return (
    `<b>💖Ответку в комментарии под постом!</b>\n\n` +
    `<blockquote>${escapeHtml(text)}</blockquote>\n\n` +
    `<b><a href="https://t.me/priznavashkiyynit">Признавашки НФ УУНИТ</a></b>`
  );
}

/**
 * Builds the moderator chat message header for a submission.
 */
function formatModHeader(submission) {
  const postText = formatPost(submission.text);
  const createdAt = new Date(submission.created_at).toLocaleString('ru-RU', {
    timeZone: 'Asia/Yekaterinburg',
  });
  return (
    `📨 Новая анонимка #${submission.id}\n\n` +
    `${postText}\n\n` +
    `⏰ ${createdAt}`
  );
}

module.exports = { escapeHtml, formatPost, formatModHeader };
