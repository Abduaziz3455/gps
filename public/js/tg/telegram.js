// The Telegram app around the page (https://core.telegram.org/bots/webapps). Everything goes through here, so the
// rest of the mini app works the same when Telegram's script is missing or old: the features it lacks just do nothing.

const W = () => window.Telegram?.WebApp || null;
const at = (v) => { const w = W(); return !!w && (!w.isVersionAtLeast || w.isVersionAtLeast(v)); };

/** Telegram puts its data in the address the first time the page opens; its script reads it from there. */
const launch = new URLSearchParams(location.hash.slice(1));
const query = new URLSearchParams(location.search);

/** The signed description of who opened the app, or '' outside Telegram. */
export function initData() {
  return W()?.initData || launch.get('tgWebAppData') || '';
}

/** What the t.me link asked for: e123 (a gate event), v45 (a vehicle), a (alerts). */
export function startParam() {
  return W()?.initDataUnsafe?.start_param || launch.get('tgWebAppStartParam') || query.get('tgWebAppStartParam') || '';
}

export const platform = () => W()?.platform || launch.get('tgWebAppPlatform') || 'unknown';

export function ready() {
  const w = W();
  if (!w) return;
  try {
    w.ready();
    w.expand();
    if (at('7.7')) w.disableVerticalSwipes(); // the map and the lists scroll; a swipe down must not close the app
  } catch (e) { console.warn(e); }
}

/** Light or dark as Telegram shows it; follows changes. */
export function onTheme(fn) {
  const w = W();
  const apply = () => fn(w?.colorScheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  apply();
  w?.onEvent?.('themeChanged', apply);
}

/** Telegram's own header and background in the page's colours. */
export function colors(header, background) {
  const w = W();
  if (!at('6.1')) return;
  try { w.setHeaderColor(header); w.setBackgroundColor(background); if (at('7.10')) w.setBottomBarColor(background); } catch { /* old client */ }
}

let backFn = null;
/** Telegram's back button in its header: shown with a handler, hidden with null. */
export function back(fn) {
  const w = W();
  if (!w?.BackButton || !at('6.1')) return;
  if (backFn) w.BackButton.offClick(backFn);
  backFn = fn;
  if (fn) { w.BackButton.onClick(fn); w.BackButton.show(); } else w.BackButton.hide();
}

export function haptic(kind = 'light') {
  const h = W()?.HapticFeedback;
  if (!h || !at('6.1')) return;
  try { if (['success', 'warning', 'error'].includes(kind)) h.notificationOccurred(kind); else if (kind === 'select') h.selectionChanged(); else h.impactOccurred(kind); } catch { /* ignore */ }
}

/** Yes or no, in Telegram's own dialog when it has one. */
export function confirm(text) {
  const w = W();
  if (w?.showConfirm && at('6.2')) return new Promise((resolve) => w.showConfirm(text, (ok) => resolve(!!ok)));
  return Promise.resolve(window.confirm(text));
}

/** A link outside Telegram: the browser, or a maps app. */
export function openLink(url) {
  const w = W();
  if (w?.openLink) w.openLink(url); else window.open(url, '_blank', 'noopener');
}

export function close() { W()?.close?.(); }
