'use strict';
/**
 * Telegram: gate alerts with photos, commands, scheduled reports and outage messages. It only listens: everything it
 * reacts to arrives on the bus, and everything it sends goes through the outbox. Without a bot token it isn't loaded.
 *
 * An alert is built once and the same text and photos go to every recipient, uploaded only for the first of them.
 */
const fs = require('node:fs');
const bus = require('../bus');
const T = require('../time');
const { TelegramClient, TelegramError } = require('./client');
const { Recipients } = require('./recipients');
const { Bot } = require('./bot');
const { registerCommands } = require('./commands');
const { gateCaption, systemText, escape } = require('./format');
const { GateDetails } = require('../gatedetails');
const { Reports } = require('../reports');

const CHANNEL = 'telegram';
const LATE_AFTER_MS = 6 * 60e3; // the normal way takes up to about 5.5 min (an exit waiting for GPS); later than that is news
const STUCK_MS = 10 * 60e3;
const CONFLICT_RECENT_MS = 2 * 60e3;
const GROUP_PARTS = new Set(['gps', 'site', 'nvr', 'camera', 'telegram']); // these outages also go to the alert groups
const KEEP_DAYS = 90;

class Telegram {
  constructor(ctx) {
    const { h, config, gate, gps, poller, analytics, places, health, outbox, log } = ctx;
    this.h = h;
    this.cfg = config.telegram;
    this.config = config;
    this.gate = gate;
    this.outbox = outbox;
    this.log = log;
    this.tg = ctx.telegramClient || new TelegramClient({ token: this.cfg.token, apiBase: this.cfg.apiBase, log });
    this.recipients = new Recipients({ h, configured: this.cfg.chatIds });
    this.details = new GateDetails({ h, gps, poller, config, log });
    this.reports = new Reports({ h, analytics, poller, gate, config, places, log });
    this.bot = new Bot({ tg: this.tg, h, recipients: this.recipients, adminIds: this.cfg.adminIds, log });
    registerCommands(this.bot, { ...ctx, tg: this.tg, recipients: this.recipients, reports: this.reports });
    outbox.register(CHANNEL, (row) => this.send(row), { onGiveUp: (row, e) => this.gaveUp(row, e) });
    this.listeners = {
      'gate:final': (ev) => this.onGate(ev),
      alert: (a) => this.onAlert(a),
    };
    this.timer = null;
    health?.addCheck('telegram', 'Telegram', (now) => this.problems(now));
    if (gate?.topView) health?.addCheck('topview', 'Yuqoridan rasm', (now) => this.topViewProblems(now));
    if (!this.cfg.adminIds.length) log.warn?.('ADMIN_IDS is empty: nobody can use bot commands or get reports');
  }

  // --- what goes out ---------------------------------------------------------------------------

  /** Runs inside the transaction that marks the event final: it is queued for everyone, or stays pending. */
  onGate(ev) {
    if (!ev || (!ev.vehicleId && !this.cfg.allVehicles)) return;
    const chats = this.recipients.all();
    if (!chats.length) this.log.warn?.(`gate event ${ev.id} not sent: no recipients (add the bot to a group and send /ulash there)`);
    for (const chat of chats) this.outbox.enqueue({ channel: CHANNEL, target: chat, kind: 'gate', ref: ev.id, dedupe: `gate:${ev.id}` });
  }

  /** Outage and recovery messages. Bot-related ones are queued like any other and arrive when Telegram is back. */
  onAlert(a) {
    if (a.type !== 'system' || a.silent) return;
    const chats = new Set(this.cfg.adminIds);
    if (GROUP_PARTS.has(a.data?.part)) for (const g of this.recipients.groups()) chats.add(g);
    for (const chat of chats) this.outbox.enqueue({ channel: CHANNEL, target: chat, kind: 'text', ref: a.id, payload: { text: systemText(a) }, dedupe: `alert:${a.id}` });
  }

  text(chats, text, dedupe) {
    for (const chat of new Set(chats)) this.outbox.enqueue({ channel: CHANNEL, target: chat, kind: 'text', payload: { text }, dedupe });
  }

  /** The outbox's sender for this channel. */
  async send(row) {
    try {
      if (row.kind === 'gate') await this.sendGate(row);
      else if (row.kind === 'legacy') await this.sendLegacy(row);
      else await this.tg.sendText(row.payload.text, row.target);
    } catch (e) {
      if (e.moveTo) this.recipients.move(row.target, e.moveTo);
      throw e;
    }
  }

  async build(ev) {
    const have = this.h.get('SELECT * FROM tg_alerts WHERE event_id = ?', ev.id);
    if (have) return have;
    const details = await this.details.forEvent(ev);
    const late = Date.now() - ev.t;
    const caption = gateCaption(ev, details, { delayMs: late > LATE_AFTER_MS ? late : null });
    this.h.run('INSERT OR IGNORE INTO tg_alerts (event_id, caption, built_at) VALUES (?, ?, ?)', ev.id, caption, Date.now());
    return this.h.get('SELECT * FROM tg_alerts WHERE event_id = ?', ev.id);
  }

  async photos(ev) {
    const out = [];
    for (let i = 0; i < ev.photos.length; i++) {
      try {
        const file = await this.gate.photoFile(ev.id, i);
        if (file && fs.existsSync(file)) out.push({ name: ev.photos[i].name, data: fs.readFileSync(file) });
      } catch (e) {
        this.log.warn?.(`photo ${i} of event ${ev.id}: ${e.message}`);
      }
    }
    return out;
  }

  async sendGate(row) {
    const ev = this.gate.get(row.ref);
    if (!ev) return; // deleted meanwhile: nothing to say
    const alert = await this.build(ev);
    const ids = alert.file_ids ? JSON.parse(alert.file_ids) : null;
    if (ids?.length) {
      try {
        await this.tg.sendPhotos(alert.caption, [], row.target, ids);
        return;
      } catch (e) {
        if (e.permanent || e.moveTo || !/file/i.test(e.message)) throw e;
        this.log.warn?.(`reusing uploaded photos failed (${e.message}); uploading again`);
      }
    }
    const photos = await this.photos(ev);
    if (!photos.length) {
      await this.tg.sendText(alert.caption, row.target);
      return;
    }
    const fileIds = await this.tg.sendPhotos(alert.caption, photos, row.target);
    this.h.run('UPDATE tg_alerts SET file_ids = ? WHERE event_id = ?', JSON.stringify(fileIds), ev.id);
  }

  /** An alert the old notifier had queued but not sent when it was stopped (scripts/import-notifier.js). */
  async sendLegacy(row) {
    const { text, photos = [] } = row.payload;
    const files = photos.filter((p) => fs.existsSync(p.file)).map((p) => ({ name: p.name, data: fs.readFileSync(p.file) }));
    if (files.length) await this.tg.sendPhotos(text, files, row.target);
    else await this.tg.sendText(text, row.target);
  }

  gaveUp(row, e) {
    const why = /forbidden/i.test(e.message) ? 'bot bloklangan yoki /start bosilmagan' : /not found/i.test(e.message) ? 'chat topilmadi' : e.message.slice(0, 120);
    const text = `⚠️ Xabar yetkazilmadi: <code>${escape(row.target)}</code>: ${escape(why)}\nKerak bo'lmasa /uzish ID bilan ro'yxatdan olib tashlang.`;
    this.text(this.cfg.adminIds.filter((a) => a !== row.target), text, `gaveup:${row.target}:${T.today()}`);
  }

  // --- health ----------------------------------------------------------------------------------

  problems(now) {
    const out = [];
    if (now - this.bot.conflict < CONFLICT_RECENT_MS) {
      out.push({ key: 'telegram_conflict', part: 'telegram', severity: 'critical', title: 'Telegram bot tokeni boshqa dasturda ham ishlayapti',
        text: "Ikkita dastur bitta bot tokeni bilan ishlayapti: buyruqlar yo'qoladi, xabarlar ikki marta ketadi. Eski botni to'xtating." });
    }
    const oldest = this.outbox.oldestPending(CHANNEL);
    if (oldest && now - oldest > STUCK_MS) {
      out.push({ key: 'telegram_stuck', part: 'telegram', severity: 'critical', title: "Telegramga xabar yuborib bo'lmayapti",
        text: 'Xabarlar navbatda turibdi, Telegram tiklanganda yuboriladi.' });
    }
    return out;
  }

  topViewProblems(now) {
    const s = this.gate.topViewStats(now - 3600e3);
    if (s.failed >= 5 && s.failed > s.done) {
      return [{ key: 'topview_failing', part: 'topview', severity: 'warning', title: "Yuqoridan rasm olib bo'lmayapti",
        text: `Oxirgi soatda ${s.failed} ta rasm olinmadi. NVR ning 554-porti yopilgan yoki yozuvlar o'qilmayapti bo'lishi mumkin. Xabarlar bitta rasm bilan ketadi.` }];
    }
    return [];
  }

  summary() {
    return { botUsername: this.bot.me.username || null, recipients: this.recipients.listing(), outbox: this.outbox.counts(CHANNEL), oldestPending: this.outbox.oldestPending(CHANNEL) };
  }

  // --- scheduled reports -----------------------------------------------------------------------

  reportTargets() {
    const chats = [...this.cfg.adminIds];
    if (this.cfg.reportTo === 'groups') chats.push(...this.recipients.groups());
    else if (this.cfg.reportTo === 'all') chats.push(...this.recipients.all());
    return chats;
  }

  /** One round of the schedule. The mark and the queueing are one transaction: never twice, never lost. */
  async schedule(now = Date.now()) {
    if (!this.cfg.reportTime) return;
    const day = T.today(now);
    if (T.minuteOfDay(now) < T.parseHm(this.cfg.reportTime)) return;
    if (this.h.kvGet('tg_daily_report') !== day) {
      let text = await this.reports.daily(day, now);
      try {
        const warn = this.reports.mismatchLine(1);
        if (warn) text += `\n\n${warn}`;
      } catch (e) { this.log.warn?.(`audit for the daily report: ${e.message}`); }
      this.h.tx(() => {
        this.text(this.reportTargets(), text, `daily:${day}`);
        this.h.kvSet('tg_daily_report', day);
      });
      this.log.info?.('daily report queued');
    }
    const month = day.slice(0, 7);
    if (T.addDays(day, 1).slice(0, 7) !== month && this.h.kvGet('tg_monthly_report') !== month) {
      const [y, m] = month.split('-').map(Number);
      const text = await this.reports.monthly(y, m, now);
      this.h.tx(() => {
        this.text(this.reportTargets(), text, `monthly:${month}`);
        this.h.kvSet('tg_monthly_report', month);
      });
      this.log.info?.('monthly report queued');
    }
  }

  housekeeping(now = Date.now()) {
    const day = T.today(now);
    if (this.h.kvGet('tg_cleanup') === day) return;
    const before = now - KEEP_DAYS * T.DAY;
    const a = this.outbox.prune(before);
    const b = this.h.run('DELETE FROM tg_alerts WHERE built_at < ?', before).changes;
    this.h.kvSet('tg_cleanup', day);
    if (a || b) this.log.info?.(`telegram housekeeping: removed ${a} deliveries and ${b} alerts older than ${KEEP_DAYS} days`);
  }

  // --- running ---------------------------------------------------------------------------------

  start() {
    for (const [k, fn] of Object.entries(this.listeners)) bus.on(k, fn);
    this.bot.start();
    const loop = async () => {
      let wait = 30e3;
      try {
        await this.schedule();
        this.housekeeping();
      } catch (e) {
        this.log.warn?.(`scheduled report failed (${e.message}), retrying in 5 min`);
        wait = 5 * 60e3;
      }
      this.timer = setTimeout(loop, wait);
    };
    this.timer = setTimeout(loop, 10e3);
  }

  stop() {
    clearTimeout(this.timer);
    for (const [k, fn] of Object.entries(this.listeners)) bus.off(k, fn);
    this.bot.stop();
    this.tg.close();
  }
}

module.exports = { Telegram, TelegramError, CHANNEL, LATE_AFTER_MS };
