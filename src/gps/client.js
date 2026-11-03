'use strict';
/**
 * GoGPS (baku.gps.az, API v3) client. Runs on the server only: the account's password never reaches a browser.
 *
 * The API rejects requests closer than ~1 s apart. Live polling and reports go through two lanes, each spaced
 * by `minGapMs` (what v1 did in production), so a 60 s report never delays the 10 s live update.
 * Period reports take naive local times plus the UTC offset in hours; their responses come back in local time.
 */
const { localIso } = require('../time');

class GpsError extends Error {}

class GpsClient {
  constructor({ baseUrl, login, password, minGapMs = 1000, tzOffsetMin = 300, fetchImpl = fetch, log = console }) {
    this.base = baseUrl.replace(/\/$/, '');
    this.login = login;
    this.password = password;
    this.minGapMs = minGapMs;
    this.tzHours = tzOffsetMin / 60;
    this.fetch = fetchImpl;
    this.log = log;
    this.token = null;
    this.lanes = { live: { chain: Promise.resolve(), last: 0 }, report: { chain: Promise.resolve(), last: 0 } };
    this.lastOk = 0;
    this.lastError = null;
  }

  async _auth() {
    const r = await this._fetch('/api/v3/auth/login', { login: this.login, password: this.password }, 30000, false);
    if (!r.ok) throw new GpsError(`GPS login failed (HTTP ${r.status})`);
    const data = await r.json().catch(() => ({}));
    if (!data.AuthId) throw new GpsError('GPS login failed: no AuthId');
    this.token = data.AuthId;
  }

  async _fetch(path, body, timeoutMs, withAuth = true) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (withAuth && this.token) headers['X-Auth'] = this.token;
    return this.fetch(this.base + path, {
      method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** POST with auth, one request at a time per lane, retries on network errors / 429 / 5xx. */
  request(path, body, { lane = 'live', timeoutMs = 60000, retries = 3 } = {}) {
    const l = this.lanes[lane];
    const run = async () => {
      let delay = 1000;
      for (let attempt = 1; ; attempt++) {
        const wait = l.last + this.minGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        l.last = Date.now();
        try {
          if (!this.token) { await this._auth(); l.last = Date.now(); await sleep(this.minGapMs); l.last = Date.now(); }
          const r = await this._fetch(path, body, timeoutMs);
          if (r.status === 401) { this.token = null; if (attempt < retries) continue; throw new GpsError(`${path}: not authorized`); }
          if (r.status === 429 || r.status >= 500) throw new GpsError(`${path}: HTTP ${r.status}`);
          if (!r.ok) {
            const text = (await r.text().catch(() => '')).slice(0, 200);
            const err = new GpsError(`${path}: HTTP ${r.status} ${text}`);
            err.permanent = true;
            throw err;
          }
          const data = await r.json();
          this.lastOk = Date.now();
          this.lastError = null;
          return data;
        } catch (e) {
          if (e.permanent || attempt >= retries) {
            this.lastError = e.message || String(e);
            throw e instanceof GpsError ? e : new GpsError(`${path}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
          }
          await sleep(delay);
          delay *= 2;
        }
      }
    };
    const p = l.chain.then(run, run);
    l.chain = p.catch(() => {});
    return p;
  }

  _period(path, ids, from, to, extra = {}, opts = {}) {
    const body = { vehicleIds: ids, from: localIso(from), to: localIso(to), timezone: this.tzHours, ...extra };
    return this.request(path, body, { lane: 'report', timeoutMs: 90000, ...opts }).then(asArray);
  }

  // --- API ---------------------------------------------------------------------------------------

  async vehicles() {
    const rows = asArray(await this.request('/api/v3/vehicles/find', {
      vehicleId: null, name: null, imei: null, sim: null, deviceTypeId: null, parentId: null, unitId: null, customFields: null,
    }));
    return rows.filter((v) => v.vehicleId).map((v) => ({
      id: Number(v.vehicleId), guid: v.vehicleGuid || null, name: String(v.name || '').trim(), model: v.modelName || '',
    }));
  }

  /** Raw last-data rows. The API wants {VehiclesIds: [...]} (a bare array is ignored). */
  async lastData(ids) {
    return asArray(await this.request('/api/v3/vehicles/getlastdata', { VehiclesIds: ids }, { timeoutMs: 25000, retries: 2 }));
  }

  moveStop(ids, from, to) { return this._period('/api/v3/vehicles/moveStop', ids, from, to); }
  mileage(ids, from, to, sampling = 86400) { return this._period('/api/v3/vehicles/mileageAndMotohours', ids, from, to, { sampling }); }
  fuel(ids, from, to, sampling = 86400) { return this._period('/api/v3/vehicles/fuelConsumption', ids, from, to, { sampling }); }
  fuelInOut(ids, from, to) { return this._period('/api/v3/vehicles/fuelInOut', ids, from, to); }
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const k of ['items', 'Items', 'data', 'Data', 'result', 'Result', 'vehicles', 'Vehicles']) {
      if (Array.isArray(payload[k])) return payload[k];
    }
  }
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { GpsClient, GpsError, asArray };
