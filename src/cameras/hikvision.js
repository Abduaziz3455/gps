'use strict';
/**
 * Hikvision NVR client (ISAPI over HTTP digest auth). Port of the notifier's hikvision.py.
 *
 * Time: the NVR stores *local* time (Asia/Tashkent, UTC+5, no DST) but labels it "Z". Everything this
 * module hands out or takes is epoch milliseconds of the real instant; the conversion happens only at
 * the NVR boundary, in nvrToEpoch / epochToNvr.
 */
const crypto = require('node:crypto');
const { DigestClient } = require('./digest');

/** Minutes the NVR clock is ahead of UTC (Tashkent, no daylight saving). */
const TZ_OFFSET_MIN = 300;

const ALERT_END = Buffer.from('</EventNotificationAlert>');
const ANPR_TYPE = Buffer.from('<eventType>ANPR</eventType>');

/**
 * Parse an NVR timestamp ("2026-10-12T08:00:00Z" or the URI form "20261012T080000Z"; the trailing Z
 * is optional) as local time and return the epoch ms of that instant.
 * @param {string} str
 * @param {number} [tzOffsetMin]
 * @returns {number}
 */
function nvrToEpoch(str, tzOffsetMin = TZ_OFFSET_MIN) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})Z?$/.exec(String(str).trim());
  if (!m) throw new Error(`bad NVR time ${JSON.stringify(str)}`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) - tzOffsetMin * 60e3;
}

/**
 * Format epoch ms as the NVR's local "Z" time, whole seconds.
 * @param {number} ms
 * @param {'iso'|'uri'} [fmt] 'iso' = "2026-10-12T08:00:00Z" (search bodies), 'uri' = "20261012T080000Z".
 * @param {number} [tzOffsetMin]
 */
function epochToNvr(ms, fmt = 'iso', tzOffsetMin = TZ_OFFSET_MIN) {
  const iso = new Date(Math.floor((ms + tzOffsetMin * 60e3) / 1000) * 1000).toISOString().slice(0, 19) + 'Z';
  return fmt === 'uri' ? iso.replace(/[-:]/g, '') : iso;
}

/** Undo XML entity escaping (what Python's html.unescape does for the entities ISAPI uses). */
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });
}

/**
 * Captures in one search response page.
 * @returns {{channel: number, time: number, plate: string|null, name: string, uriPath: string}[]}
 */
function parseCaptures(channel, xml, tzOffsetMin = TZ_OFFSET_MIN) {
  const out = [];
  for (const [, raw] of xml.matchAll(/<playbackURI>([^<]+)<\/playbackURI>/g)) {
    const uri = unescapeXml(raw);
    const host = uri.indexOf('/', uri.indexOf('//') + 2); // drop scheme://host:port
    const uriPath = uri.slice(host);
    const ts = /starttime=(\w+)/.exec(uri)[1];
    const name = /name=(\w+)/.exec(uri)[1];
    // The record name ends with "_<PLATE>" when the camera read a plate (or "_UNKNOWN").
    const m = /^ch\d+_\d+_(\w+)$/.exec(name);
    out.push({ channel, time: nvrToEpoch(ts, tzOffsetMin), plate: m ? m[1].toUpperCase() : null, name, uriPath });
  }
  return out;
}

class NVR {
  /**
   * @param {{host: string, user: string, password: string, timeoutMs?: number, tzOffsetMin?: number,
   *   rejectUnauthorized?: boolean}} o  host is a base URL, e.g. "http://192.168.1.64:80".
   */
  constructor({ host, user, password, timeoutMs = 90000, tzOffsetMin = TZ_OFFSET_MIN, rejectUnauthorized }) {
    this.host = host.replace(/\/+$/, '');
    this.client = new DigestClient({ user, password, rejectUnauthorized });
    this.timeoutMs = timeoutMs;
    this.tzOffsetMin = tzOffsetMin;
    this.lastOk = 0; // Date.now() of the last successful request (health monitoring)
    this.lastStream = 0; // ... and of the last data on the live event stream
  }

  async _req(path, { method = 'GET', body, headers, timeoutMs = this.timeoutMs } = {}) {
    const r = await this.client.request({ method, url: this.host + path, body, headers, timeoutMs });
    if (r.status >= 400) {
      const err = new Error(`NVR ${method} ${path.split('?')[0]}: HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    this.lastOk = Date.now();
    return r;
  }

  /** Raw deviceInfo XML (model, firmware); also a cheap reachability check. */
  async deviceInfo() {
    return (await this._req('/ISAPI/System/deviceInfo')).body.toString('utf8');
  }

  /** {channelId: name} of the NVR's IP camera channels. */
  async channels() {
    const xml = (await this._req('/ISAPI/ContentMgmt/InputProxy/channels')).body.toString('utf8');
    const out = {};
    for (const [, id, name] of xml.matchAll(/<InputProxyChannel[^>]*>\s*<id>(\d+)<\/id>\s*<name>([^<]*)<\/name>/g)) {
      out[Number(id)] = unescapeXml(name);
    }
    return out;
  }

  /** Current JPEG from the channel's main stream (or the sub stream: smaller, faster). */
  async snapshot(channel, { sub = false } = {}) {
    return (await this._req(`/ISAPI/Streaming/channels/${channel}0${sub ? 2 : 1}/picture`, { timeoutMs: 30000 })).body;
  }

  /**
   * Vehicle (ANPR) picture records stored on the NVR for a channel, oldest first.
   * The NVR returns at most `pageSize` per call and says "MORE" while further pages exist.
   * @param {number} channel
   * @param {number} start epoch ms
   * @param {number} end epoch ms
   * @returns {Promise<{channel: number, time: number, plate: string|null, name: string, uriPath: string}[]>}
   */
  async searchCaptures(channel, start, end, pageSize = 50) {
    const searchId = crypto.randomUUID().toUpperCase();
    const st = epochToNvr(start, 'iso', this.tzOffsetMin);
    const et = epochToNvr(end, 'iso', this.tzOffsetMin);
    const captures = [];
    for (;;) {
      const body = `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription><searchID>${searchId}</searchID>
<trackList><trackID>${channel}03</trackID></trackList>
<timeSpanList><timeSpan><startTime>${st}</startTime><endTime>${et}</endTime></timeSpan></timeSpanList>
<maxResults>${pageSize}</maxResults><searchResultPostion>${captures.length}</searchResultPostion>
<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com/vehicleDetection</metadataDescriptor></metadataList>
</CMSearchDescription>`;
      const r = await this._req('/ISAPI/ContentMgmt/search', {
        method: 'POST', body: Buffer.from(body), headers: { 'Content-Type': 'application/xml' },
      });
      const xml = r.body.toString('utf8');
      const page = parseCaptures(channel, xml, this.tzOffsetMin);
      captures.push(...page);
      if (!page.length || !xml.includes('<responseStatusStrg>MORE')) return captures;
    }
  }

  /** Full-size capture JPEG of a search result. */
  async captureImage(cap) {
    // The search returns the URI with a "_<PLATE>" suffix; the download wants the bare record name.
    const path = cap.uriPath.replace(/(name=ch\d+_\d+)_\w+/g, '$1');
    return (await this._req(path)).body;
  }

  /**
   * Call `onChannel(channelId)` for every ANPR event on the NVR's live alert stream.
   *
   * Never resolves while connected. It rejects when the stream drops, errors, or is silent for `idleMs`
   * (the NVR sends a heartbeat roughly every 9 s, so 90 s of silence means a dead stream); the caller
   * reconnects. It resolves only when `signal` aborts.
   *
   * The NVR sends multipart/mixed with neither chunked encoding nor a length, so the body has to be read
   * as it arrives ('data' events) and split on the closing tag of each alert; waiting for the end of the
   * body would wait forever.
   * @param {(channel: number) => void} onChannel  called synchronously; if it throws, the stream is closed
   *   and the promise rejects with that error.
   * @param {{signal?: AbortSignal, idleMs?: number, connectTimeoutMs?: number}} [opts]
   * @returns {Promise<void>}
   */
  async anprEvents(onChannel, { signal, idleMs = 90000, connectTimeoutMs = 10000 } = {}) {
    if (signal?.aborted) return;
    const path = '/ISAPI/Event/notification/alertStream';
    const res = await this.client.request({ url: this.host + path, stream: true, timeoutMs: connectTimeoutMs });
    if (res.statusCode >= 400) {
      res.resume();
      const err = new Error(`NVR GET ${path}: HTTP ${res.statusCode}`);
      err.status = res.statusCode;
      throw err;
    }
    this.lastOk = this.lastStream = Date.now();
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let timer = null;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        res.destroy();
        err ? reject(err) : resolve();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`event stream: no data for ${idleMs} ms`)), idleMs);
      };
      const onAbort = () => finish();
      signal?.addEventListener('abort', onAbort, { once: true });
      arm();
      res.on('data', (chunk) => {
        if (done) return;
        this.lastOk = this.lastStream = Date.now();
        arm();
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let end;
        while ((end = buf.indexOf(ALERT_END)) !== -1) {
          const alert = buf.subarray(0, end);
          buf = buf.subarray(end + ALERT_END.length);
          if (alert.includes(ANPR_TYPE)) {
            const m = /<channelID>(\d+)<\/channelID>/.exec(alert.toString('latin1'));
            if (m) {
              try {
                onChannel(Number(m[1]));
              } catch (e) {
                return finish(e);
              }
              if (done) return; // onChannel aborted the signal
            }
          }
        }
      });
      res.on('end', () => finish(new Error('event stream closed by NVR')));
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('event stream closed by NVR')));
    });
  }

  /** Close idle keep-alive sockets. */
  close() {
    this.client.close();
  }
}

module.exports = { NVR, TZ_OFFSET_MIN, nvrToEpoch, epochToNvr, parseCaptures };
