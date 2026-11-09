// Sozlamalar: this device's push notifications, own account; for owners also users, vehicles and system.
// The open tab lives in the URL (?tab=).
import { get, post, patch, del, state } from '../api.js';
import { $, $$, html, setHtml, el, icon, when, ago, dur, num, toast, toastError, modal, confirmDialog } from '../ui.js';
import { replaceQuery } from './reports.js';

const TABS = [
  { id: 'bildirishnoma', label: 'Bildirishnomalar', render: renderPush },
  { id: 'hisob', label: 'Hisob', render: renderAccount },
  { id: 'foydalanuvchilar', label: 'Foydalanuvchilar', owner: true, render: renderUsers },
  { id: 'transportlar', label: 'Transportlar', owner: true, render: renderVehicles },
  { id: 'tizim', label: 'Tizim', owner: true, render: renderSystem },
];
const ROLE = { owner: 'Rahbar', dispatcher: 'Dispetcher' };
const VTYPES = { auto: 'Avto', mixer: 'Mikser', dump: 'Samosval', excavator: 'Ekskavator', car: 'Yengil', other: 'Boshqa' };
const DEFAULT_PREFS = { gateIn: true, gateOut: true, onlyFleet: false, alerts: true, system: true, quietFrom: '', quietTo: '' };

export default {
  async render(main, { query }) {
    const tabs = TABS.filter((t) => !t.owner || state.isOwner);
    let current = tabs.find((t) => t.id === query.tab) || tabs[0];
    let tabCleanup = null;
    let alive = true;

    setHtml(main, html`<div class="page settings-page">
      <div class="tabs" role="tablist" aria-label="Sozlamalar bo'limlari">
        ${tabs.map((t) => html`<button type="button" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="setPanel" aria-selected="false" tabindex="-1">${t.label}</button>`)}
      </div>
      <div id="setPanel" role="tabpanel" class="set-panel"></div>
    </div>`);
    const panel = $('#setPanel', main);

    const open = async (t, focus = false) => {
      try { tabCleanup?.(); } catch (e) { console.error(e); }
      tabCleanup = null;
      current = t;
      for (const b of $$('[role=tab]', main)) {
        const on = b.dataset.tab === t.id;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
        if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      panel.setAttribute('aria-labelledby', `tab-${t.id}`);
      replaceQuery('sozlamalar', { tab: t.id === tabs[0].id ? '' : t.id });
      // A fresh host per tab: listeners a tab attaches die with it.
      const host = document.createElement('div');
      host.className = 'set-host';
      setHtml(host, html`<div class="empty"><div class="spinner" style="margin:auto"></div></div>`);
      panel.replaceChildren(host);
      try {
        const c = await t.render(host);
        if (!alive || current !== t) { c?.(); return; }
        tabCleanup = c || null;
      } catch (e) {
        if (alive && current === t) setHtml(host, html`<div class="notice bad">Bo'limni ochib bo'lmadi: ${e.message}</div>`);
      }
    };

    const tablist = $('[role=tablist]', main);
    tablist.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b && b.dataset.tab !== current.id) open(tabs.find((t) => t.id === b.dataset.tab));
    });
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = tabs.indexOf(current);
      open(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
    });

    await open(current);
    return () => { alive = false; try { tabCleanup?.(); } catch { /* ignore */ } };
  },
};

// --- helpers ---------------------------------------------------------------------------------------

/** Modal with a form; onSubmit(form) may throw — its message is shown inside the modal. */
function formModal({ title, fields, submitLabel = 'Saqlash', danger = false, onSubmit }) {
  const id = `f${Math.random().toString(36).slice(2, 9)}`;
  const form = el(String(html`<form id="${id}" class="grid" style="gap:12px" novalidate autocomplete="off">${fields}<p class="form-error" role="alert" hidden></p></form>`));
  const m = modal({
    title, body: form, size: 'modal-sm',
    foot: html`<button class="btn" type="button" data-close>Bekor qilish</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit" form="${id}">${submitLabel}</button>`,
  });
  const err = $('.form-error', form);
  const btn = m.foot.querySelector('[type=submit]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      await onSubmit(form);
      m.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.disabled = false; }
  });
  (form.querySelector('[autofocus]') || form.querySelector('input, select'))?.focus();
  return m;
}

const passwordCheck = (a, b) => {
  if (a.length < 8) return "Parol kamida 8 belgidan iborat bo'lishi kerak";
  if (a !== b) return 'Parollar mos kelmadi';
  return null;
};

const switchHtml = (name, checked, label) => html`<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} aria-label="${label}" /><span></span></label>`;

// --- Bildirishnomalar --------------------------------------------------------------------------------

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const sameKey = (buf, key) => {
  if (!buf) return true;
  const a = new Uint8Array(buf);
  return a.length === key.length && a.every((x, i) => x === key[i]);
};

async function renderPush(panel) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let alive = true;
  let sub = null;
  let known = false; // the server has this device's subscription for the current user
  let prefs = { ...DEFAULT_PREFS };
  let busy = false;

  // Without permission there can be no subscription, so there's nothing to ask the browser's push service.
  if (supported && Notification.permission === 'granted') {
    try {
      // Some browsers never answer these (seen in WebKit): the rest of the page must not wait for them.
      const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 3000))]);
      const reg = await within(navigator.serviceWorker.getRegistration());
      sub = reg ? await within(reg.pushManager.getSubscription()) : null;
      if (sub) {
        const st = await post('/api/push/status', { endpoint: sub.endpoint });
        if (st.endpoint) { known = true; prefs = { ...DEFAULT_PREFS, ...st.prefs }; }
      }
    } catch (e) { toastError(e); }
  }

  const ready = () => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 5000))]);

  const statusPill = () => {
    if (!supported) return html`<span class="pill">Qo'llab-quvvatlanmaydi</span>`;
    if (Notification.permission === 'denied') return html`<span class="pill bad">Brauzerda bloklangan</span>`;
    if (sub && known) return html`<span class="pill good">${icon('check')}Yoqilgan</span>`;
    return html`<span class="pill">O'chirilgan</span>`;
  };
  const permText = () => (!supported ? '—' : { granted: 'berilgan', denied: 'rad etilgan', default: "hali so'ralmagan" }[Notification.permission] || Notification.permission);

  const draw = () => {
    const on = !!(sub && known);
    const denied = supported && Notification.permission === 'denied';
    setHtml(panel, html`<div class="grid" style="gap:16px;max-width:760px">
      <section class="card">
        <div class="card-head"><h3>Bu qurilmadagi bildirishnomalar</h3><span class="spacer"></span>${statusPill()}</div>
        <div class="card-body grid" style="gap:12px">
          ${!supported ? html`<div class="notice warn">
              ${ios && !standalone
                ? html`<b>iPhone/iPad:</b> bildirishnomalar faqat bosh ekranga qo'shilgan ilovada ishlaydi (iOS 16.4 yoki yangisi).
                  Safari'da <b>Ulashish</b> tugmasini bosing → <b>"Ekranga qo'shish"</b>, so'ng ilovani bosh ekrandagi belgidan oching va shu sahifaga qayting.`
                : html`Bu brauzer Web Push bildirishnomalarini qo'llab-quvvatlamaydi. Chrome, Edge yoki Firefox'ning yangi versiyasidan foydalaning; iPhone'da — ilovani bosh ekranga qo'shing (Ulashish → "Ekranga qo'shish", iOS 16.4+).`}
            </div>` : ''}
          ${denied ? html`<div class="notice bad">Bildirishnomalar brauzer sozlamalarida bloklangan. Manzil satridagi qulf belgisini bosib, "Bildirishnomalar"ga ruxsat bering va sahifani yangilang.</div>` : ''}
          ${supported && sub && !known ? html`<div class="notice warn">Bu qurilmada obuna bor, lekin serverda topilmadi (masalan, boshqa foydalanuvchi bilan yoqilgan). Qayta yoqish uchun "Yoqish"ni bosing.</div>` : ''}
          <dl class="kv"><dt>Ruxsat</dt><dd>${permText()}</dd><dt>Qurilma</dt><dd class="small">${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 120)}</dd></dl>
          <div class="form-row">
            ${supported && !on ? html`<button class="btn btn-primary" type="button" data-act="enable" ${denied || busy ? 'disabled' : ''}>${icon('bell')}<span>Yoqish</span></button>` : ''}
            ${on ? html`<button class="btn" type="button" data-act="test" ${busy ? 'disabled' : ''}>${icon('bell')}<span>Sinov xabari</span></button>
              <button class="btn btn-danger" type="button" data-act="disable" ${busy ? 'disabled' : ''}>${icon('close')}<span>O'chirish</span></button>` : ''}
          </div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Nimalar haqida xabar berilsin</h3>${on ? '' : html`<span class="small muted">yoqilganda qo'llanadi</span>`}</div>
        <div class="card-body" style="padding-top:2px;padding-bottom:2px">
          <div class="setting-row"><div><div><b>Kirishlar</b></div><div class="small muted">Darvozadan kirgan har bir mashina (rasm bilan)</div></div>${switchHtml('gateIn', prefs.gateIn, 'Kirishlar')}</div>
          <div class="setting-row"><div><div><b>Chiqishlar</b></div><div class="small muted">GPS chiqishni tasdiqlagandan keyin</div></div>${switchHtml('gateOut', prefs.gateOut, 'Chiqishlar')}</div>
          <div class="setting-row"><div><div><b>Faqat o'z transportlarimiz</b></div><div class="small muted">Begona mashinalar va o'qilmagan raqamlar haqida xabar bermaslik</div></div>${switchHtml('onlyFleet', prefs.onlyFleet, "Faqat o'z transportlarimiz")}</div>
          <div class="setting-row"><div><div><b>Ogohlantirishlar (yoqilg'i to'kilishi, tezlik, signal yo'q…)</b></div><div class="small muted">Qoidalar bo'yicha ogohlantirishlar</div></div>${switchHtml('alerts', prefs.alerts, 'Ogohlantirishlar')}</div>
          <div class="setting-row"><div><div><b>Tizim holati (kameralar, internet, GPS)</b></div><div class="small muted">Kamera, NVR, zavod interneti yoki GPS ishlamay qolsa — sababi bilan; tiklanganda ham xabar keladi. Tinch soatlarda ham yuboriladi</div></div>${switchHtml('system', prefs.system, 'Tizim holati')}</div>
          <div class="setting-row" style="flex-wrap:wrap">
            <div><div><b>Tinch soatlar</b></div><div class="small muted">Bu oraliqda bildirishnoma kelmaydi (masalan, 22:00 – 07:00)</div></div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0">
              <input type="time" name="quietFrom" value="${prefs.quietFrom}" aria-label="Tinch soatlar boshlanishi" />
              <span class="muted">–</span>
              <input type="time" name="quietTo" value="${prefs.quietTo}" aria-label="Tinch soatlar tugashi" />
              <button class="btn btn-ghost btn-sm" type="button" data-act="quietClear" title="Tinch soatlarni o'chirish" ${prefs.quietFrom || prefs.quietTo ? '' : 'disabled'}>Tozalash</button>
            </div>
          </div>
        </div>
      </section>
      <div class="notice">${icon('info')} Sahifa ochiq turganda barcha hodisalar (kirish/chiqish, ogohlantirishlar) har doim ekranning pastki burchagida jonli xabar sifatida ko'rinadi — bildirishnomalar yoqilmagan bo'lsa ham.</div>
    </div>`);
  };

  const savePrefs = async (patchPrefs) => {
    const before = { ...prefs };
    prefs = { ...prefs, ...patchPrefs };
    if (!(sub && known)) { draw(); return; }
    try {
      const r = await post('/api/push/prefs', { endpoint: sub.endpoint, prefs: patchPrefs });
      prefs = { ...DEFAULT_PREFS, ...r.prefs };
      toast({ title: 'Saqlandi', kind: 'good', timeout: 2000 });
    } catch (e) { prefs = before; toastError(e); }
    if (alive) draw();
  };

  const act = async (what) => {
    busy = true; draw();
    try {
      if (what === 'enable') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          toast({ title: 'Ruxsat berilmadi', body: 'Bildirishnomalarni yoqish uchun brauzer so\'roviga "Ruxsat berish"ni bosing.', kind: 'bad' });
          return;
        }
        const reg = await ready();
        if (!reg) throw new Error("Service worker ishga tushmadi. Sahifani yangilab, qayta urinib ko'ring.");
        const key = urlBase64ToUint8Array(state.me.pushKey);
        let s = await reg.pushManager.getSubscription();
        if (s && !sameKey(s.options?.applicationServerKey, key)) { await s.unsubscribe(); s = null; }
        s = s || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const r = await post('/api/push/subscribe', { subscription: s.toJSON(), prefs });
        sub = s; known = true; prefs = { ...DEFAULT_PREFS, ...r.prefs };
        toast({ title: 'Bildirishnomalar yoqildi', body: 'Tekshirish uchun "Sinov xabari"ni bosing.', kind: 'good' });
      } else if (what === 'test') {
        await post('/api/push/test', { endpoint: sub.endpoint });
        toast({ title: 'Sinov xabari yuborildi', body: "Bir necha soniyada bildirishnoma kelishi kerak. Kelmasa, tizim sozlamalarida brauzerga ruxsat berilganini tekshiring.", timeout: 6000 });
      } else if (what === 'disable') {
        const ep = sub.endpoint;
        try { await sub.unsubscribe(); } catch { /* already gone */ }
        await post('/api/push/unsubscribe', { endpoint: ep });
        sub = null; known = false;
        toast({ title: "Bildirishnomalar o'chirildi", timeout: 3000 });
      }
    } catch (e) {
      toastError(e);
    } finally {
      busy = false;
      if (alive) draw();
    }
  };

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'quietClear') savePrefs({ quietFrom: '', quietTo: '' });
    else act(b.dataset.act);
  });
  const onChange = (e) => {
    const t = e.target;
    if (t.type === 'checkbox' && t.name in DEFAULT_PREFS) savePrefs({ [t.name]: t.checked });
    else if (t.type === 'time') {
      const from = $('[name=quietFrom]', panel).value, to = $('[name=quietTo]', panel).value;
      if ((from && to) || (!from && !to)) savePrefs({ quietFrom: from, quietTo: to });
    }
  };
  panel.addEventListener('change', onChange);

  draw();
  return () => { alive = false; panel.removeEventListener('change', onChange); };
}

// --- Hisob -----------------------------------------------------------------------------------------

async function renderAccount(panel) {
  const u = state.me.user;
  setHtml(panel, html`<div class="grid grid-2" style="max-width:980px;align-items:start">
    <section class="card">
      <div class="card-head"><h3>Hisob</h3></div>
      <div class="card-body"><dl class="kv">
        <dt>Ism</dt><dd>${u.name}</dd>
        <dt>Login</dt><dd class="mono">${u.username}</dd>
        <dt>Rol</dt><dd><span class="pill ${u.role === 'owner' ? 'info' : ''}">${ROLE[u.role] || u.role}</span></dd>
      </dl>
      <p class="small muted" style="margin:12px 0 0">Ism yoki rolni rahbar o'zgartiradi (Sozlamalar → Foydalanuvchilar).</p></div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Parolni o'zgartirish</h3></div>
      <form class="card-body grid" style="gap:12px" id="pwForm" novalidate>
        <input type="text" name="username" value="${u.username}" autocomplete="username" hidden />
        <label class="field"><span>Joriy parol</span><input type="password" name="current" autocomplete="current-password" required /></label>
        <label class="field"><span>Yangi parol</span><input type="password" name="password" autocomplete="new-password" minlength="8" required /></label>
        <label class="field"><span>Yangi parol (takror)</span><input type="password" name="repeat" autocomplete="new-password" minlength="8" required /></label>
        <p class="small muted" style="margin:0">Kamida 8 belgi. O'zgartirilgandan keyin barcha qurilmalarda qaytadan kirish kerak bo'ladi.</p>
        <p class="form-error" role="alert" hidden></p>
        <div><button class="btn btn-primary" type="submit">Parolni o'zgartirish</button></div>
      </form>
    </section>
  </div>`);
  const form = $('#pwForm', panel);
  const err = $('.form-error', form);
  let timer = null;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const msg = !form.current.value ? 'Joriy parolni kiriting' : passwordCheck(form.password.value, form.repeat.value);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await post('/api/me/password', { current: form.current.value, password: form.password.value });
      toast({ title: "Parol o'zgartirildi", body: 'Yangi parol bilan qaytadan kiring.', kind: 'good' });
      timer = setTimeout(() => location.reload(), 1500);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false;
    }
  });
  return () => clearTimeout(timer);
}

// --- Foydalanuvchilar --------------------------------------------------------------------------------

async function renderUsers(panel) {
  let users = await get('/api/users');
  const me = state.me.user.id;

  const draw = () => {
    setHtml(panel, html`<section class="card">
      <div class="card-head"><h3>Foydalanuvchilar</h3><span class="small muted">${users.length} ta</span><span class="spacer"></span>
        <button class="btn btn-primary btn-sm" type="button" data-act="new">${icon('user')}<span>Yangi foydalanuvchi</span></button></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Ism</th><th scope="col">Login</th><th scope="col">Rol</th><th scope="col">Holat</th><th scope="col">Oxirgi kirish</th><th scope="col" aria-label="Amallar"></th></tr></thead>
        <tbody>${users.map((u) => html`<tr data-id="${u.id}">
          <td><b>${u.name}</b>${u.id === me ? html` <span class="small muted">(siz)</span>` : ''}</td>
          <td class="mono">${u.username}</td>
          <td><span class="pill ${u.role === 'owner' ? 'info' : ''}">${ROLE[u.role] || u.role}</span></td>
          <td>${u.disabled ? html`<span class="pill bad">O'chirilgan</span>` : html`<span class="pill good">Faol</span>`}</td>
          <td class="nowrap" title="${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' }) : ''}">${u.lastLoginAt ? when(u.lastLoginAt) : html`<span class="muted">hech qachon</span>`}</td>
          <td class="nowrap right">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">Tahrirlash</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="password">Parol</button>
            ${u.id !== me ? html`<button class="btn btn-ghost btn-sm ${u.disabled ? '' : 'btn-danger'}" type="button" data-act="toggle">${u.disabled ? 'Yoqish' : "O'chirish"}</button>
              <button class="btn btn-ghost btn-sm btn-danger" type="button" data-act="delete" title="Butunlay o'chirish">O'chirib tashlash</button>` : ''}
          </td></tr>`)}</tbody>
      </table></div>
    </section>
    <p class="small muted" style="margin:10px 2px 0">Rahbar hamma narsani ko'radi (tahlil, sozlamalar). Dispetcher — xarita, darvoza, ogohlantirishlar, transport va hisobotlar. "O'chirish" foydalanuvchini bloklaydi (tarix saqlanadi); "O'chirib tashlash" uni butunlay o'chiradi.</p>`);
  };
  const refresh = async () => { users = await get('/api/users'); draw(); };
  const roleSelect = (v) => html`<label class="field"><span>Rol</span><select name="role">
    <option value="dispatcher" ${v === 'dispatcher' ? 'selected' : ''}>Dispetcher</option><option value="owner" ${v === 'owner' ? 'selected' : ''}>Rahbar</option></select></label>`;

  const handlers = {
    new: () => formModal({
      title: 'Yangi foydalanuvchi', submitLabel: "Qo'shish",
      fields: html`<label class="field"><span>Login</span><input name="username" required autofocus autocapitalize="off" spellcheck="false" placeholder="masalan, dispetcher2" /></label>
        <label class="field"><span>Ism</span><input name="name" placeholder="Ism Familiya" /></label>
        ${roleSelect('dispatcher')}
        <label class="field"><span>Parol</span><input type="password" name="password" autocomplete="new-password" required /></label>
        <p class="small muted" style="margin:0">Login: 3–32 belgi (harf, raqam, . _ -). Parol kamida 8 belgi.</p>`,
      onSubmit: async (f) => {
        if (f.password.value.length < 8) throw new Error("Parol kamida 8 belgidan iborat bo'lishi kerak");
        await post('/api/users', { username: f.username.value.trim(), name: f.name.value.trim() || f.username.value.trim(), role: f.role.value, password: f.password.value });
        toast({ title: "Foydalanuvchi qo'shildi", kind: 'good', timeout: 3000 });
        await refresh();
      },
    }),
    edit: (u) => formModal({
      title: `Tahrirlash: ${u.username}`,
      fields: html`<label class="field"><span>Ism</span><input name="name" value="${u.name}" required autofocus /></label>${roleSelect(u.role)}`,
      onSubmit: async (f) => {
        const body = {};
        if (f.name.value.trim() && f.name.value.trim() !== u.name) body.name = f.name.value.trim();
        if (f.role.value !== u.role) body.role = f.role.value;
        if (Object.keys(body).length) await patch(`/api/users/${u.id}`, body);
        await refresh();
      },
    }),
    password: (u) => formModal({
      title: `Yangi parol: ${u.username}`, submitLabel: "Parolni o'rnatish",
      fields: html`<label class="field"><span>Yangi parol</span><input type="password" name="password" autocomplete="new-password" required autofocus /></label>
        <label class="field"><span>Takror</span><input type="password" name="repeat" autocomplete="new-password" required /></label>
        <p class="small muted" style="margin:0">Kamida 8 belgi. Foydalanuvchi barcha qurilmalarda qaytadan kirishi kerak bo'ladi.</p>`,
      onSubmit: async (f) => {
        const msg = passwordCheck(f.password.value, f.repeat.value);
        if (msg) throw new Error(msg);
        await patch(`/api/users/${u.id}`, { password: f.password.value });
        toast({ title: "Parol o'zgartirildi", body: u.id === me ? 'Qaytadan kiring.' : '', kind: 'good' });
        if (u.id === me) setTimeout(() => location.reload(), 1500);
      },
    }),
    toggle: async (u) => {
      if (!u.disabled && !await confirmDialog("Foydalanuvchini o'chirish", `${u.name} (${u.username}) tizimga kira olmaydi va barcha seanslari yopiladi.`, "O'chirish", true)) return;
      await patch(`/api/users/${u.id}`, { disabled: !u.disabled });
      await refresh();
    },
    delete: async (u) => {
      if (!await confirmDialog("Butunlay o'chirib tashlash", `${u.name} (${u.username}) butunlay o'chiriladi. Bu amalni qaytarib bo'lmaydi.`, "O'chirib tashlash", true)) return;
      await del(`/api/users/${u.id}`);
      toast({ title: "Foydalanuvchi o'chirildi", timeout: 3000 });
      await refresh();
    },
  };

  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const u = users.find((x) => x.id === Number(b.closest('tr')?.dataset.id));
    try { await handlers[b.dataset.act]?.(u); } catch (ex) { toastError(ex); }
  });
  draw();
  return null;
}

// --- Transportlar ------------------------------------------------------------------------------------

async function renderVehicles(panel) {
  let list = await get('/api/vehicles/all');
  const orig = new Map();
  const snapshot = (v) => ({ display: v.display || '', plate: v.plate || '', type: v.type || 'auto', fuelNorm: v.fuelNorm == null ? '' : String(v.fuelNorm), active: !!v.active });
  for (const v of list) orig.set(v.id, snapshot(v));

  const rowHtml = (v) => html`<tr data-id="${v.id}"${v.active ? '' : ' class="inactive"'}>
    <td style="min-width:150px"><div style="font-weight:650">${v.gpsName}</div>
      <div class="small muted">${v.model || '—'}${v.cameraOnly ? html` · <span class="pill">Faqat kamera</span>` : v.inGps ? '' : html` · <span class="pill warn">GPS'da yo'q</span>`}</div>
      ${v.linked?.length ? html`<div class="small muted" title="Rahbar shu transportga biriktirgan raqamlar">Raqam: ${v.linked.join(', ')}</div>` : ''}</td>
    <td><input name="display" value="${v.display}" placeholder="GPS nomi" maxlength="40" style="width:150px" aria-label="Ko'rinadigan nom: ${v.gpsName}" /></td>
    <td style="min-width:170px"><input name="plate" value="${v.plate}" placeholder="kiritilmagan" style="width:130px;font-family:var(--mono)" autocapitalize="characters" spellcheck="false" aria-label="Davlat raqami: ${v.gpsName}" />
      ${v.suggestedPlate ? html`<div><button class="btn btn-ghost btn-sm" type="button" data-suggest="${v.suggestedPlate}" title="Kamera shu transport uchun o'qigan raqam" style="padding:0 4px;height:24px;color:var(--accent)">Taklif: ${v.suggestedPlate}</button></div>` : ''}
      ${v.learned?.length ? html`<div class="small muted" title="Kamera o'qigan va shu transportga bog'langan raqamlar (necha marta)">Kamera: ${v.learned.map((l, i) => html`${i ? ', ' : ''}<span class="mono">${l.plate}</span> (${l.hits})`)}</div>` : ''}</td>
    <td><select name="type" aria-label="Turi: ${v.gpsName}">${Object.entries(VTYPES).map(([k, label]) => html`<option value="${k}" ${k === (v.type || 'auto') ? 'selected' : ''}>${label}</option>`)}</select></td>
    <td><input type="number" name="fuelNorm" value="${v.fuelNorm ?? ''}" min="0" step="0.1" placeholder="—" style="width:84px" aria-label="Yoqilg'i normasi, L/100 km: ${v.gpsName}" /></td>
    <td>${switchHtml('active', v.active, `Faol: ${v.gpsName}`)}</td>
    <td class="right"><button class="btn btn-sm btn-primary" type="button" data-save disabled>Saqlash</button></td>
  </tr>`;

  setHtml(panel, html`<div class="grid" style="gap:16px">
    <div class="notice">${icon('info')} <b>Nega haqiqiy davlat raqami muhim:</b> darvoza kameralari mashinani davlat raqamidan taniydi, GPS tizimida esa
      mashina boshqacha nomlangan bo'lishi mumkin (masalan, "15" yoki "10 870 HAD"). Raqam to'g'ri kiritilsa, kamera hodisalari shu transportga
      bog'lanadi va reyslar to'g'ri hisoblanadi. "Taklif" — kamera shu transport uchun o'qigan raqam. Yoqilg'i normasi kiritilsa, sarf normadan 15% oshganda hisobotda belgilanadi.
      Faol bo'lmagan transportlar xarita, hisobot va tahlilda ko'rsatilmaydi.</div>
    <section class="card" id="plateBox" hidden></section>
    <section class="card">
      <div class="card-head"><h3>Transportlar</h3><span class="small muted">${list.length} ta · ${list.filter((v) => v.active).length} ta faol</span></div>
      <div class="table-wrap"><table class="table veh-edit">
        <thead><tr><th scope="col">GPS nomi / model</th><th scope="col">Ko'rinadigan nom</th><th scope="col">Haqiqiy davlat raqami</th><th scope="col">Turi</th><th scope="col">Norma, L/100 km</th><th scope="col">Faol</th><th scope="col"></th></tr></thead>
        <tbody>${list.map(rowHtml)}</tbody>
      </table></div>
    </section>
  </div>`);

  const plateBox = plateDecisions($('#plateBox', panel), async () => {
    // A truck made for a plate, or one that went away: the list below follows.
    list = await get('/api/vehicles/all');
    orig.clear();
    for (const v of list) orig.set(v.id, snapshot(v));
    setHtml($('.veh-edit tbody', panel), html`${list.map(rowHtml)}`);
  });
  await plateBox.load();

  const read = (tr) => ({
    display: tr.querySelector('[name=display]').value.trim(),
    plate: tr.querySelector('[name=plate]').value.trim(),
    type: tr.querySelector('[name=type]').value,
    fuelNorm: tr.querySelector('[name=fuelNorm]').value.trim(),
    active: tr.querySelector('[name=active]').checked,
  });
  const changes = (tr) => {
    const o = orig.get(Number(tr.dataset.id)), c = read(tr), out = {};
    for (const k of Object.keys(c)) if (c[k] !== o[k]) out[k] = c[k];
    return out;
  };
  const mark = (tr) => { tr.querySelector('[data-save]').disabled = !Object.keys(changes(tr)).length; };

  const onInput = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) mark(tr); };
  panel.addEventListener('input', onInput);
  panel.addEventListener('change', onInput);
  panel.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const sug = e.target.closest('[data-suggest]');
    if (sug) { tr.querySelector('[name=plate]').value = sug.dataset.suggest; mark(tr); tr.querySelector('[name=plate]').focus(); return; }
    const save = e.target.closest('[data-save]');
    if (!save) return;
    const body = changes(tr);
    if ('fuelNorm' in body) {
      if (body.fuelNorm !== '' && !(Number(body.fuelNorm) > 0)) return toastError(new Error("Norma musbat son bo'lishi kerak"));
      body.fuelNorm = body.fuelNorm === '' ? null : Number(body.fuelNorm);
    }
    save.disabled = true;
    try {
      const r = await patch(`/api/vehicles/${tr.dataset.id}`, body);
      const id = Number(tr.dataset.id);
      const v = list.find((x) => x.id === id);
      Object.assign(v, { display: r.display || '', plate: r.plate || '', type: body.type ?? v.type, fuelNorm: r.fuelNorm, active: r.active, label: r.label });
      orig.set(id, snapshot(v));
      tr.querySelector('[name=plate]').value = v.plate;
      tr.querySelector('[name=fuelNorm]').value = v.fuelNorm ?? '';
      tr.classList.toggle('inactive', !v.active);
      mark(tr);
      toast({ title: `Saqlandi: ${r.label}`, kind: 'good', timeout: 2500 });
    } catch (ex) { save.disabled = false; toastError(ex); }
    return undefined;
  });
  return null;
}

// --- Noma'lum raqamlar: plates the cameras keep reading that no vehicle has -----------------------------

function plateDecisions(box, onVehiclesChanged) {
  let rows = [], decided = [];
  const vehicles = () => [...state.vehicles.values()].filter((v) => !v.cameraOnly).sort((a, b) => a.label.localeCompare(b.label));

  const hint = (r) => {
    const e = r.evidence;
    const x = e.suggestion;
    if (x) {
      return html`<div class="small plate-hint good" data-hint="gps">${x.basis === 'street'
        ? html`Taklif: <b>${x.label}</b>. Shu raqamning ${x.checked} ta o'tishidan ${x.hits} tasida bu transport hovli ko'chasida turgan`
        : html`Taklif: <b>${x.label}</b>. Shu raqam ${x.checked} marta chiqqanda ${x.hits} marta bu transport ham hovlidan chiqqan`}</div>`;
    }
    if (e.noGps) return html`<div class="small plate-hint" data-hint="nogps">Hech bir GPS transporti aniq mos kelmadi. GPS'siz bo'lishi mumkin</div>`;
    return html`<div class="small muted plate-hint" data-hint="none">GPS bilan solishtirish uchun ma'lumot hali yetarli emas</div>`;
  };
  const rowHtml = (r) => html`<tr data-plate="${r.plate}">
    <td class="plate-photo">${r.photoUrl ? html`<a href="#/darvoza?event=${r.eventId}" title="Oxirgi o'tishni ochish"><img loading="lazy" alt="" src="${r.photoUrl}"></a>` : ''}</td>
    <td><span class="plate-chip">${r.text}</span>
      <div class="small muted">${r.passes} marta · ${r.days} kunda · oxirgi: ${when(r.lastAt)}</div>
      ${hint(r)}
      ${r.similar.length ? html`<div class="small muted">Bir belgi farq qiladi: ${r.similar.map((x, i) => html`${i ? ', ' : ''}${x.label}`)}</div>` : ''}</td>
    <td class="plate-actions">
      <div class="plate-link"><select name="vehicle" aria-label="Qaysi transport: ${r.text}"><option value="">GPS transportini tanlang</option>${vehicles().map((v) => html`<option value="${v.id}" ${r.evidence.suggestion?.vehicleId === v.id ? 'selected' : ''}>${v.label}${v.gpsName !== v.label ? ` (GPS: ${v.gpsName})` : ''}</option>`)}</select>
        <button class="btn btn-sm btn-primary" type="button" data-act="link">Biriktirish</button></div>
      <div class="plate-other"><button class="btn btn-sm" type="button" data-act="truck">Bizniki, GPS'siz</button> <button class="btn btn-sm btn-ghost" type="button" data-act="outside">Begona</button></div></td>
  </tr>`;
  const kindText = (d) => (d.kind === 'outside' ? 'Begona' : d.created ? "Bizniki, GPS'siz" : d.label);

  const draw = () => {
    box.hidden = !rows.length && !decided.length;
    setHtml(box, html`<div class="card-head"><h3>Noma'lum raqamlar</h3><span class="small muted">kamera tez-tez o'qiydi, lekin hech bir transportga tegishli emas</span><span class="spacer"></span><span class="small muted" id="plateCount">${rows.length} ta</span></div>
      ${rows.length ? html`<div class="table-wrap"><table class="table plate-table"><tbody>${rows.map(rowHtml)}</tbody></table></div>` : html`<div class="empty small">Hal qilinmagan raqam yo'q</div>`}
      ${decided.length ? html`<details class="pl-ignored" id="plateDecided"><summary>Qaror qabul qilinganlar (${decided.length})</summary><div class="table-wrap"><table class="table"><tbody>${decided.map((d) => html`<tr data-plate="${d.plate}"><td><span class="plate-chip">${d.text}</span></td><td>${kindText(d)}</td><td class="num small muted">${d.passes} marta</td><td class="right"><button class="btn btn-sm" type="button" data-act="undo">Qaytarish</button></td></tr>`)}</tbody></table></div></details>` : ''}`);
  };

  const load = async () => {
    [rows, decided] = await Promise.all([get('/api/plates/unknown'), get('/api/plates/decided')]);
    draw();
  };

  const act = {
    link: async (r, tr) => {
      const id = Number(tr.querySelector('[name=vehicle]').value);
      if (!id) { toastError(new Error('Avval GPS transportini tanlang')); return undefined; }
      const v = state.vehicles.get(id);
      if (!await confirmDialog('Raqamni biriktirish', `${r.text} — ${v?.label}. O'tgan ${r.passes} ta o'tish shu transportga o'tadi va reyslar qayta hisoblanadi. Keyin qaytarish mumkin.`, 'Biriktirish')) return undefined;
      const x = await post(`/api/plates/${r.plate}/link`, { vehicleId: id });
      toast({ title: `Biriktirildi: ${r.text} — ${x.label}`, body: `${x.moved} ta o'tish ko'chirildi`, kind: 'good', timeout: 4000 });
      return true;
    },
    truck: async (r) => {
      if (!await confirmDialog("GPS'siz transport qo'shish", `${r.text} avtoparkka qo'shiladi. Reyslari faqat darvoza kameralari bo'yicha hisoblanadi: masofa va manzil bo'lmaydi. O'tgan ${r.passes} ta o'tish shu transportga o'tadi.`, "Qo'shish")) return undefined;
      const x = await post(`/api/plates/${r.plate}/link`, { newTruck: {} });
      toast({ title: `Qo'shildi: ${x.label}`, body: `${x.moved} ta o'tish ko'chirildi`, kind: 'good', timeout: 4000 });
      return true;
    },
    outside: async (r) => {
      await post(`/api/plates/${r.plate}/link`, { outside: true });
      toast({ title: `Begona: ${r.text}`, timeout: 2500 });
      return true;
    },
    undo: async (d) => {
      if (d.kind !== 'outside' && !await confirmDialog('Qarorni qaytarish', `${d.text}: ${d.passes} ta o'tish yana begona deb hisoblanadi.${d.created ? " Shu raqam uchun qo'shilgan transport o'chiriladi." : ''}`, 'Qaytarish', true)) return undefined;
      await del(`/api/plates/${d.plate}/link`);
      toast({ title: `Qaytarildi: ${d.text}`, timeout: 2500 });
      return true;
    },
  };

  // A photo the NVR can't give right now: no broken picture.
  box.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.hidden = true; }, true);
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const tr = b.closest('tr[data-plate]');
    const r = [...rows, ...decided].find((x) => x.plate === tr.dataset.plate);
    b.disabled = true;
    try {
      if (await act[b.dataset.act](r, tr)) {
        await load();
        await onVehiclesChanged();
        return;
      }
    } catch (ex) { toastError(ex); }
    b.disabled = false;
  });
  return { load };
}

// --- Tizim -------------------------------------------------------------------------------------------

async function renderSystem(panel) {
  let alive = true;
  const health = (lastOk, okS, warnS) => {
    if (!lastOk) return html`<span class="pill bad">Aloqa yo'q</span>`;
    const age = (Date.now() - lastOk) / 1000;
    return age < okS ? html`<span class="pill good">Ishlayapti</span>` : age < warnS ? html`<span class="pill warn">Kechikmoqda</span>` : html`<span class="pill bad">Aloqa yo'q</span>`;
  };
  const mb = (b) => (b == null ? '—' : `${num(b / 1048576, 1)} MB`);

  const draw = (s) => {
    const c = s.config;
    // Three groups, top to bottom: is it working, what it holds, how it is set up.
    setHtml(panel, html`<div class="set-system">
      ${state.me.mock ? html`<div class="notice warn">Demo rejim: GPS va kameralar simulyatsiya qilinmoqda (MOCK=1).</div>` : ''}

      <div class="set-group-head"><h3>Holat</h3><span class="small muted">Ma'lumot holati: ${when(s.time)}</span><span class="spacer"></span>
        <button class="btn btn-sm" type="button" data-act="reload">${icon('refresh')}<span>Yangilash</span></button></div>
      <div class="set-cards">
        <section class="card">
          <div class="card-head"><h3>GPS (GoGPS)</h3><span class="spacer"></span>${s.gps ? health(s.gps.lastOk, 60, 300) : html`<span class="pill">Ulanmagan</span>`}</div>
          <div class="card-body">${s.gps ? html`<dl class="kv">
            <dt>Oxirgi so'rov</dt><dd>${ago(s.gps.lastOk)}${s.gps.lastOk ? html` <span class="muted">(${when(s.gps.lastOk)})</span>` : ''}</dd>
            <dt>Transportlar (jonli)</dt><dd>${num(s.gps.vehicles)}</dd>
            <dt>Oxirgi xato</dt><dd>${s.gps.error ? html`<span style="color:var(--bad)">${s.gps.error}</span>` : html`<span class="muted">yo'q</span>`}</dd>
          </dl>` : html`<p class="muted" style="margin:0">GPS hisobi .env faylida sozlanmagan.</p>`}</div>
        </section>
        <section class="card">
          <div class="card-head"><h3>Kameralar (NVR)</h3><span class="spacer"></span>${s.nvr ? health(s.nvr.lastOk, 120, 600) : html`<span class="pill">Ulanmagan</span>`}</div>
          <div class="card-body">${s.nvr ? html`<dl class="kv">
            <dt>Oxirgi so'rov</dt><dd>${ago(s.nvr.lastOk)}</dd>
            <dt>Jonli oqim</dt><dd>${s.nvr.lastStream ? ago(s.nvr.lastStream) : html`<span class="muted">yo'q</span>`}</dd>
            <dt>Qidiruv (arxiv)</dt><dd>${s.nvr.searchOk == null ? '—' : s.nvr.searchOk ? 'ishlayapti' : html`<span style="color:var(--bad)">ishlamayapti</span>`}</dd>
            <dt>Oxirgi raqam</dt><dd>${s.nvr.lastCapture ? html`${when(s.nvr.lastCapture)} <span class="muted">(${ago(s.nvr.lastCapture)})</span>` : '—'}</dd>
            <dt>Oxirgi xato</dt><dd>${s.nvr.error ? html`<span style="color:var(--bad)">${s.nvr.error}</span>` : html`<span class="muted">yo'q</span>`}</dd>
          </dl>` : html`<p class="muted" style="margin:0">NVR .env faylida sozlanmagan.</p>`}</div>
        </section>
        <section class="card">
          <div class="card-head"><h3>Push bildirishnomalar</h3></div>
          <div class="card-body"><dl class="kv">
            <dt>Qurilmalar</dt><dd>${num(s.counts.pushSubscriptions)}</dd>
            <dt>Yuborilgan</dt><dd>${num(s.push.sent)}</dd>
            <dt>Xato</dt><dd>${s.push.failed ? html`<span style="color:var(--bad)">${num(s.push.failed)}</span>` : '0'}</dd>
          </dl><p class="small muted" style="margin:10px 0 0">Server ishga tushganidan beri.</p></div>
        </section>
        <section class="card" id="sysTelegram">
          <div class="card-head"><h3>Telegram</h3><span class="spacer"></span>${s.telegram ? (s.telegram.outbox.pending > 5 ? html`<span class="pill warn">Navbatda ${num(s.telegram.outbox.pending)}</span>` : html`<span class="pill good">Ishlayapti</span>`) : html`<span class="pill">Ulanmagan</span>`}</div>
          <div class="card-body">${s.telegram ? html`<dl class="kv">
            <dt>Xabar oluvchilar</dt><dd>${s.telegram.recipients.length ? s.telegram.recipients.map((r) => html`<div>${r.title || r.chatId}</div>`) : html`<span class="muted">yo'q</span>`}</dd>
            <dt>Yuborilgan</dt><dd>${num(s.telegram.outbox.sent)}</dd>
            <dt>Yetkazilmagan</dt><dd>${s.telegram.outbox.failed ? html`<span style="color:var(--bad)">${num(s.telegram.outbox.failed)}</span>` : '0'}</dd>
            ${s.topViews ? html`<dt>Yuqoridan rasm (24 soat)</dt><dd>${num(s.topViews.done)} ta olindi${s.topViews.none ? `, ${num(s.topViews.none)} tasida mashina yo'q` : ''}${s.topViews.failed ? html`, <span style="color:var(--bad)">${num(s.topViews.failed)} ta xato</span>` : ''}</dd>` : ''}
          </dl><p class="small muted" style="margin:10px 0 0">Oluvchilar botda boshqariladi: /ulash, /qoshish, /uzish.</p>` : html`<p class="muted" style="margin:0">TELEGRAM_BOT_TOKEN .env faylida sozlanmagan.</p>`}</div>
        </section>
      </div>

      <div class="set-group-head"><h3>Ma'lumotlar</h3></div>
      <section class="card">
        <div class="card-body set-columns">
          <dl class="kv">
            <dt>GPS nuqtalari</dt><dd>${num(s.counts.positions)}</dd>
            <dt>Darvoza hodisalari</dt><dd>${num(s.counts.gateEvents)}</dd>
            <dt>Ogohlantirishlar</dt><dd>${num(s.counts.alerts)}</dd>
            <dt>Foydalanuvchilar</dt><dd>${num(s.counts.users)}</dd>
          </dl>
          <dl class="kv">
            <dt>Statistika kunlari</dt><dd>${num(s.counts.daysOfStats)}</dd>
            <dt>Baza hajmi</dt><dd>${mb(s.dbBytes)}</dd>
            <dt>Server ishlayapti</dt><dd>${dur(s.uptimeS)}</dd>
            <dt>Oxirgi hisob-kitob</dt><dd>${s.rollupAt ? html`${ago(s.rollupAt)} <span class="muted">(${when(s.rollupAt)})</span>` : '—'}</dd>
          </dl>
        </div>
        <div class="set-card-foot">
          <span class="small muted">Bugungi kun har 10 daqiqada avtomatik hisoblanadi. Tugma buni darhol bajaradi.</span>
          <button class="btn btn-sm" type="button" data-act="recompute">${icon('refresh')}<span>Bugungi hisobni qayta hisoblash</span></button>
        </div>
      </section>

      <div class="set-group-head"><h3>Sozlamalar</h3><span class="small muted">Serverning .env faylida o'zgartiriladi, keyin server qayta ishga tushiriladi</span></div>
      <div class="set-cards">
        <section class="card">
          <div class="card-head"><h3>Hovli</h3></div>
          <div class="card-body"><dl class="kv">
            <dt>Nomi</dt><dd>${c.yard.name}</dd>
            <dt>Markaz</dt><dd class="mono">${c.yard.lat}, ${c.yard.lng}</dd>
            <dt>Radius</dt><dd>${num(c.yard.radiusM)} m</dd>
          </dl></div>
        </section>
        <section class="card">
          <div class="card-head"><h3>Chegaralar</h3></div>
          <div class="card-body"><dl class="kv">
            <dt>Signal yo'q</dt><dd>${num(c.offlineMinutes)} daqiqadan keyin</dd>
            <dt>Uzoq to'xtash</dt><dd>${num(c.longStopMinutes)} daqiqadan ortiq</dd>
            <dt>Ish vaqti</dt><dd>${c.workHours}</dd>
          </dl></div>
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h3>Kamera kanallari</h3><span class="small muted">${c.cameras.length} ta</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th scope="col">Kanal</th><th scope="col">Nomi</th><th scope="col">Yo'nalish</th><th scope="col">Umumiy ko'rinish kamerasi</th></tr></thead>
          <tbody>${c.cameras.map((cam) => html`<tr><td class="num" style="text-align:left">${cam.channel}</td><td>${cam.name}</td>
            <td><span class="dir ${cam.direction}">${cam.direction === 'in' ? 'KIRISH' : 'CHIQISH'}</span></td>
            <td>${cam.contextChannel ? html`${cam.contextName || ''} <span class="muted">(kanal ${cam.contextChannel})</span>` : html`<span class="muted">—</span>`}</td></tr>`)}</tbody>
        </table></div>
      </section>
    </div>`);
  };

  const load = async () => { const s = await get('/api/system'); if (alive) draw(s); };
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.act === 'recompute') {
        const r = await post('/api/analytics/recompute', {});
        toast({ title: 'Qayta hisoblandi', body: `Kun: ${r.day}`, kind: 'good', timeout: 3000 });
      }
      await load();
    } catch (ex) { toastError(ex); b.disabled = false; }
  });
  await load();
  return () => { alive = false; };
}
