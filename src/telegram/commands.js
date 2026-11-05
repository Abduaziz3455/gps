'use strict';
/** The bot's commands. A feature adds its command here, in one line of the list below. */
const T = require('../time');
const { hm } = T;
const { escape } = require('./format');

const HELP = `🚛 <b>TBB mashina nazorati</b> (administrator)

Mashina darvozadan kirsa yoki chiqsa, bot rasm bilan xabar yuboradi.

📊 /bugun — bugungi hisobot
📊 /kecha — kechagi hisobot
📅 /oy — shu oy hisoboti
🅿️ /hovli — hozir hovlida qaysi mashinalar bor
🔍 /tekshir — kamera raqamlari GPS bilan mosmi
ℹ️ /holat — tizim holati

👥 <b>Xabar oluvchilar</b>
/oluvchilar — ro'yxat
/ulash — guruhda yozing: xabarlar shu guruhga keladi
/uzish — guruhda yozing: bu guruhga xabar yuborish to'xtaydi
/qoshish ID — foydalanuvchini qo'shish (u avval botga /start bosishi kerak)
/uzish ID — foydalanuvchini olib tashlash

Ulangan guruhda hamma /bugun, /kecha va /hovli dan foydalana oladi.
Kunlik hisobot har kuni kechqurun avtomatik keladi, oylik hisobot oyning oxirgi kuni.`;

function statusText({ h, gate, recipients, outbox, poller, health }, now = Date.now()) {
  const s = T.localIso(now);
  const last = gate?.tracker.lastSightingTime();
  const box = outbox.counts('telegram');
  const lines = [`ℹ️ <b>Tizim holati</b> (${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 16)})`, '',
    last ? `📷 Oxirgi kamera yozuvi: ${T.localIso(last).slice(8, 10)}.${T.localIso(last).slice(5, 7)} ${hm(last)}` : '📷 Kamera yozuvi hali yo\'q',
    `👥 Xabar oluvchilar: ${recipients.all().length} ta (/oluvchilar)`,
    `📨 Xabarlar: ${box.sent} yuborildi, ${box.pending} navbatda${box.failed ? `, ⚠️ ${box.failed} yuborilmadi` : ''}`];
  if (gate?.topView) {
    const tv = gate.topViewStats(now - 24 * 3600e3);
    lines.push(`🖼 Yuqoridan rasm (24 soat): ${tv.done} ta olindi, ${tv.none} tasida mashina ko'rinmadi${tv.failed ? `, ⚠️ ${tv.failed} ta xato` : ''}${tv.pending ? `, ${tv.pending} ta navbatda` : ''}`);
  }
  if (poller) {
    const n = h.get('SELECT COUNT(*) n FROM vehicles WHERE in_gps = 1').n;
    lines.push(n ? `📡 GPS: ${n} ta mashina ro'yxatda` : "⚠️ GPS ro'yxati olinmadi");
  } else lines.push('📡 GPS ulanmagan');
  for (const p of health?.summary(now).problems || []) lines.push(`⚠️ ${escape(p.title)}`);
  return lines.join('\n');
}

function recipientsText(recipients) {
  const rows = recipients.listing();
  if (!rows.length) return "👥 Hozircha xabar oluvchi yo'q. Guruhda /ulash yozing yoki /qoshish ID.";
  return [`👥 <b>Xabar oluvchilar — ${rows.length} ta</b>`,
    ...rows.map((r) => `${r.kind === 'group' ? '👥' : '👤'} ${r.fromEnv ? '' : `${escape(r.title)} — `}<code>${escape(r.chatId)}</code>${r.fromEnv ? ' (.env)' : ''}`)].join('\n');
}

/** /ulash, /uzish, /qoshish: who gets the alerts. */
function manage({ recipients, tg }) {
  const isGroup = (chat) => chat.type === 'group' || chat.type === 'supergroup';
  return {
    async ulash({ chat, bot }) {
      if (!isGroup(chat)) return "Guruhni ulash uchun botni guruhga qo'shing va /ulash ni o'sha guruhda yozing.";
      recipients.add(chat.id, 'group', chat.title || '');
      await bot.groupMenu(chat.id, true);
      return `✅ <b>${escape(chat.title || '')}</b> guruhi ulandi. Mashina kirib-chiqishi haqidagi xabarlar, kunlik hisobot va aloqa uzilishlari shu yerga keladi.\nGuruhda hamma /bugun, /kecha va /hovli dan foydalana oladi.`;
    },
    async uzish({ args, chat, bot }) {
      const target = args[0] ?? (isGroup(chat) ? String(chat.id) : null);
      if (target === null) return 'Kimni olib tashlash kerak? /uzish ID (guruhda esa shunchaki /uzish).';
      if (recipients.remove(target)) {
        if (String(target).startsWith('-')) await bot.groupMenu(target, false);
        return `🔕 <code>${escape(target)}</code> ga xabar yuborish to'xtatildi.`;
      }
      if (recipients.isConfigured(target)) return 'Bu chat .env faylidagi TELEGRAM_CHAT_IDS da yozilgan: o\'sha yerdan olib tashlang.';
      return "Bu chat ro'yxatda yo'q. /oluvchilar";
    },
    async qoshish({ args }) {
      const target = args[0];
      if (!target || !/^-?\d+$/.test(target)) return 'Foydalanish: /qoshish ID (masalan /qoshish 123456789). ID ni foydalanuvchi botga /id yozib biladi.';
      let name = target, kind = target.startsWith('-') ? 'group' : 'user', note = '';
      try {
        const info = await tg.getChat(target);
        name = info.title || [info.first_name, info.last_name].filter(Boolean).join(' ') || target;
        kind = ['group', 'supergroup', 'channel'].includes(info.type) ? 'group' : 'user';
      } catch {
        note = "\n⚠️ Bot bu foydalanuvchiga hali yoza olmaydi: u botni ochib /start bosishi kerak.";
      }
      recipients.add(target, kind, name);
      return `✅ <b>${escape(name)}</b> (<code>${escape(target)}</code>) xabar oluvchilarga qo'shildi.${note}`;
    },
  };
}

function registerCommands(bot, ctx) {
  const { reports, recipients } = ctx;
  const m = manage(ctx);
  const today = () => T.today();
  bot
    .command({ name: 'bugun', access: 'group', slow: true, aliases: ['today'], description: "📊 Bugungi hisobot: km, yoqilg'i, reyslar", run: () => reports.daily(today()) })
    .command({ name: 'kecha', access: 'group', slow: true, aliases: ['yesterday'], description: '📊 Kechagi hisobot', run: () => reports.daily(T.addDays(today(), -1)) })
    .command({ name: 'oy', slow: true, aliases: ['month'], description: '📅 Shu oy hisoboti', run: () => { const [y, mo] = today().split('-').map(Number); return reports.monthly(y, mo); } })
    .command({ name: 'hovli', access: 'group', aliases: ['yard'], description: '🅿️ Hozir hovlida qaysi mashinalar bor', run: () => reports.yard() })
    .command({ name: 'tekshir', slow: true, description: '🔍 Kamera raqamlari GPS bilan mosmi', run: () => reports.auditText(3) })
    .command({ name: 'oluvchilar', description: "👥 Xabar oluvchilar ro'yxati", run: () => recipientsText(recipients) })
    .command({ name: 'qoshish', description: "➕ Foydalanuvchini qo'shish: /qoshish ID", run: m.qoshish })
    .command({ name: 'ulash', run: m.ulash })
    .command({ name: 'uzish', run: m.uzish })
    .command({ name: 'holat', aliases: ['status'], description: 'ℹ️ Tizim holati', run: () => statusText(ctx) })
    .command({ name: 'yordam', aliases: ['help'], description: '❓ Yordam', run: () => HELP })
    .command({ name: 'id', access: 'public', description: '🆔 Telegram ID raqamingiz', run: ({ user, chat, isAdmin, isPrivate }) => (isAdmin
      ? `🆔 Sizning ID: <code>${user}</code>${isPrivate ? '' : `\n👥 Guruh ID: <code>${chat.id}</code>`}`
      : `🆔 Sizning Telegram ID raqamingiz: <code>${user}</code>\n\nMashina kirib-chiqishi haqida xabar olish uchun shu raqamni administratorga yuboring.`) })
    .command({ name: 'start', access: 'public', hidden: true, run: ({ user, isAdmin }) => (isAdmin ? HELP
      : `🆔 Sizning Telegram ID raqamingiz: <code>${user}</code>\n\nMashina kirib-chiqishi haqida xabar olish uchun shu raqamni administratorga yuboring.`) });
}

module.exports = { registerCommands, statusText, recipientsText, HELP };
