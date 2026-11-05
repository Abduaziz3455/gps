'use strict';
/**
 * Who gets the alerts: chats from the environment (TELEGRAM_CHAT_IDS) plus groups and users an admin added with bot
 * commands. Each recipient gets its own copy. Telegram gives a group a new id when it becomes a supergroup; that is
 * followed here.
 */
class Recipients {
  constructor({ h, configured = [] }) {
    this.h = h;
    this.configured = configured.map(String);
  }

  current(chatId) { return this.h.kvGet(`tg_moved:${chatId}`) || String(chatId); }

  /** {chat_id, kind, title}, oldest first. */
  added() { return this.h.all('SELECT chat_id, kind, title FROM tg_recipients ORDER BY added_at'); }

  all() {
    return [...new Set([...this.configured.map((c) => this.current(c)), ...this.added().map((r) => r.chat_id)])];
  }

  /** Group chats among the recipients: they also get reports, outage notices and the group commands. */
  groups() { return this.listing().filter((r) => r.kind === 'group').map((r) => r.chatId); }

  /** For display: {chatId, kind, title, fromEnv}. */
  listing() {
    const out = this.configured.map((c) => {
      const chatId = this.current(c);
      return { chatId, kind: chatId.startsWith('-') ? 'group' : 'user', title: '', fromEnv: true };
    });
    const seen = new Set(out.map((r) => r.chatId));
    for (const r of this.added()) if (!seen.has(r.chat_id)) out.push({ chatId: r.chat_id, kind: r.kind, title: r.title, fromEnv: false });
    return out;
  }

  add(chatId, kind, title, now = Date.now()) {
    this.h.run(`INSERT INTO tg_recipients (chat_id, kind, title, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET kind = excluded.kind, title = excluded.title`, String(chatId), kind, title, now);
  }

  /** Removes a chat added by command. Chats from the environment can only be removed there. */
  remove(chatId) { return this.h.run('DELETE FROM tg_recipients WHERE chat_id = ?', String(chatId)).changes === 1; }

  isConfigured(chatId) { return this.configured.some((c) => this.current(c) === String(chatId)); }

  move(oldId, newId) {
    this.h.kvSet(`tg_moved:${oldId}`, String(newId));
    this.h.run('UPDATE OR REPLACE tg_recipients SET chat_id = ? WHERE chat_id = ?', String(newId), String(oldId));
  }
}

module.exports = { Recipients };
