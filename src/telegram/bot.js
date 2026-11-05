'use strict';
/**
 * Telegram commands: long polling, who may do what, and group membership. What a command does lives with the feature
 * that registers it (src/telegram/commands.js), so a new feature adds a command without touching this file.
 *
 * Access:
 *   public  anyone, in a private chat
 *   group   anyone in a connected alert group, and admins
 *   admin   admins (ADMIN_IDS), in their private chat or in a group
 * Anyone else gets their Telegram id from /start or /id, so that an admin can add them.
 */
const { TelegramError } = require('./client');
const { escape } = require('./format');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMMAND_RE = /^\/([A-Za-z0-9_]+)(?:@(\S+))?(?:\s+(.*))?$/s;

class Bot {
  constructor({ tg, h, recipients, adminIds, log = console }) {
    this.tg = tg;
    this.h = h;
    this.recipients = recipients;
    this.admins = new Set(adminIds.map(String));
    this.log = log;
    this.commands = new Map();
    this.aliases = new Map();
    this.me = {};
    this.stopped = true;
    this.conflict = 0; // when another program was last seen polling with our token
  }

  /**
   * @param {{name: string, description?: string, access?: 'public'|'group'|'admin', slow?: boolean, aliases?: string[],
   *   hidden?: boolean, run: (ctx: {args: string[], chat: object, user: string, msg: object, bot: Bot}) => string|Promise<string>}} c
   */
  command(c) {
    this.commands.set(c.name, { access: 'admin', ...c });
    for (const a of c.aliases || []) this.aliases.set(a, c.name);
    return this;
  }

  /** Menu entries for an access level. */
  menu(levels) {
    return [...this.commands.values()].filter((c) => c.description && !c.hidden && levels.includes(c.access)).map((c) => [c.name, c.description]);
  }

  // --- polling ---------------------------------------------------------------------------------

  start() {
    this.stopped = false;
    this.loop = this._run().catch((e) => this.log.error?.(`telegram bot stopped: ${e.stack || e.message}`));
  }

  stop() { this.stopped = true; }

  async _run() {
    await this.setup();
    let offset = this.h.kvGet('tg_offset');
    while (!this.stopped) {
      let updates;
      try {
        updates = await this.tg.getUpdates(offset);
      } catch (e) {
        if (e.conflict) {
          // Two programs with one token: every command goes to one of them at random, and alerts go out twice.
          this.conflict = Date.now();
          this.log.warn?.('telegram: another program is polling with this bot token');
          await sleep(30e3);
        } else {
          this.log.warn?.(`getUpdates failed: ${e.message}`);
          await sleep(10e3);
        }
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        this.h.kvSet('tg_offset', offset);
        if (u.my_chat_member) await this.membership(u.my_chat_member).catch((e) => this.log.warn?.(`membership: ${e.message}`));
        // Not awaited: a slow report doesn't hold up the next command or the polling.
        else if (u.message) this.handle(u.message).catch((e) => this.log.warn?.(`command failed: ${e.message}`));
      }
    }
  }

  /** Command menus: everyone sees the public ones, admins theirs in their private chat, alert groups the group ones. */
  async setup() {
    try {
      this.me = await this.tg.getMe();
      await this.tg.setCommands(this.menu(['public']));
      for (const admin of this.admins) await this.tg.setCommands(this.menu(['group', 'admin']), { type: 'chat', chat_id: admin });
      for (const group of this.recipients.groups()) await this.groupMenu(group, true);
    } catch (e) {
      this.log.warn?.(`telegram setup (command menus) failed: ${e.message}`);
    }
  }

  async groupMenu(chatId, on) {
    try {
      if (on) await this.tg.setCommands(this.menu(['group']), { type: 'chat', chat_id: chatId });
      else await this.tg.deleteCommands({ type: 'chat', chat_id: chatId });
    } catch (e) {
      this.log.warn?.(`command menu for ${chatId} failed: ${e.message}`);
    }
  }

  // --- commands --------------------------------------------------------------------------------

  async handle(msg) {
    const m = COMMAND_RE.exec((msg.text || '').trim());
    if (!m) return;
    const [, word, addressee, rest] = m;
    if (addressee && this.me.username && addressee.toLowerCase() !== this.me.username.toLowerCase()) return; // for another bot in the group
    const name = this.aliases.get(word.toLowerCase()) || word.toLowerCase();
    const chat = msg.chat;
    const user = String(msg.from?.id ?? '');
    const isPrivate = chat.type === 'private';
    const isAdmin = this.admins.has(user);
    const cmd = this.commands.get(name);
    const inAlertGroup = !isPrivate && this.recipients.groups().includes(String(chat.id));

    const allowed = cmd && (isAdmin || (cmd.access === 'public' && isPrivate) || (cmd.access === 'group' && inAlertGroup));
    if (!allowed) {
      if (isAdmin) await this.reply(chat.id, "Bunday buyruq yo'q. /yordam");
      else if (isPrivate) await this.reply(chat.id, 'Bu buyruqlar faqat administrator uchun.');
      if (!isAdmin) this.log.info?.(`telegram: /${name} from non-admin ${user} in chat ${chat.id} ignored`);
      return;
    }
    this.log.info?.(`telegram: /${name} from ${isAdmin ? 'admin ' : ''}${user} in chat ${chat.id}`);
    if (cmd.slow) await this.reply(chat.id, '⏳ Tayyorlanmoqda, biroz kuting...');
    let answer;
    try {
      answer = await cmd.run({ args: rest ? rest.trim().split(/\s+/) : [], chat, user, msg, bot: this, isAdmin, isPrivate });
    } catch (e) {
      this.log.warn?.(`telegram: /${name} failed: ${e.stack || e.message}`);
      answer = `Xatolik yuz berdi (${e.name || 'Error'}). Birozdan keyin qayta urinib ko'ring.`;
    }
    if (answer) await this.reply(chat.id, answer);
  }

  async reply(chat, text) {
    try {
      await this.tg.sendText(text, chat);
    } catch (e) {
      if (!(e instanceof TelegramError)) throw e;
      this.log.warn?.(`reply to ${chat} failed: ${e.message}`);
    }
  }

  // --- group membership ------------------------------------------------------------------------

  /** The bot was added to or removed from a group: tell the admins (adding needs their /ulash). */
  async membership(upd) {
    const chat = upd.chat || {};
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    const status = upd.new_chat_member?.status;
    const title = escape(chat.title || String(chat.id));
    let text;
    if (status === 'member' || status === 'administrator') {
      const command = this.me.username ? `/ulash@${this.me.username}` : '/ulash';
      text = `👥 Bot <b>${title}</b> guruhiga qo'shildi.\nXabarlar shu guruhga kelishi uchun guruhda ${command} yozing.`;
      await this.reply(chat.id, `👋 Salom! Mashina kirib-chiqishi haqidagi xabarlar shu guruhga kelishi uchun administrator ${command} yozsin.`);
    } else if (status === 'left' || status === 'kicked') {
      const removed = this.recipients.remove(chat.id);
      text = `👥 Bot <b>${title}</b> guruhidan chiqarildi.${removed ? " Xabar yuborish to'xtatildi." : ''}`;
    } else return;
    this.log.info?.(`telegram: membership in ${chat.id}: ${status}`);
    for (const admin of this.admins) await this.reply(admin, text);
  }
}

module.exports = { Bot };
