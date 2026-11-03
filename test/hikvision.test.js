'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { NVR, TZ_OFFSET_MIN, nvrToEpoch, epochToNvr } = require('../src/cameras/hikvision');
const { parseChallenge } = require('../src/cameras/digest');

const USER = 'admin';
const PASS = 'p@ss "word"';
const REALM = 'DS-7716NXI-K4';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

const NAME1 = 'ch00004_00010006506038967756800322951';
const NAME2 = 'ch00004_00010006506039033292800284144';
const NAME3 = 'ch00004_00000000616059695155200800336';

function item(start, name) {
  return `<searchMatchItem><sourceID>{0000000000-0000-0000-0000-000000000000}</sourceID><trackID>403</trackID>
<timeSpan><startTime>${start.replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, '$1-$2-$3T$4:$5:$6Z')}</startTime></timeSpan>
<mediaSegmentDescriptor><contentType>picture</contentType><codecType>jpeg</codecType>
<playbackURI>http://192.168.1.64:80/picture/Streaming/tracks/403/?starttime=${start}&amp;endtime=${start}&amp;name=${name}&amp;size=530291</playbackURI>
</mediaSegmentDescriptor><metadataMatches><metadataDescriptor>recordType.meta.hikvision.com/vehicleDetection</metadataDescriptor></metadataMatches>
</searchMatchItem>`;
}

function searchResult(status, items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<searchID>{X}</searchID><responseStatus>true</responseStatus><responseStatusStrg>${status}</responseStatusStrg>
<numOfMatches>${items.length}</numOfMatches><matchList>${items.join('\n')}</matchList></CMSearchResult>`;
}

function alert(channel, type, state) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<ipAddress>192.168.1.64</ipAddress><portNo>80</portNo><protocol>HTTP</protocol>
<channelID>${channel}</channelID><dateTime>2026-10-12T13:10:00+05:00</dateTime><activePostCount>1</activePostCount>
<eventType>${type}</eventType><eventState>${state}</eventState><eventDescription>${type} alarm</eventDescription>
</EventNotificationAlert>`;
  return `--boundary\r\nContent-Type: application/xml; charset="UTF-8"\r\nContent-Length: ${Buffer.byteLength(xml)}\r\n\r\n${xml}\r\n`;
}

/** A fake NVR that requires digest auth (qop=auth) and rotates its nonce on request. */
function fakeNvr() {
  const state = {
    nonce: crypto.randomBytes(8).toString('hex'),
    challenges: 0, // 401s sent
    ncSeen: [], // nc values accepted
    searches: [], // POSTed search bodies
    paths: [], // authenticated request paths
    stream: null, // (socket) => void, how to serve the alert stream
    qop: true,
  };
  const deny = (res) => {
    state.challenges += 1;
    res.writeHead(401, {
      'WWW-Authenticate': [`Basic realm="${REALM}"`,
        `Digest realm="${REALM}", ${state.qop ? 'qop="auth", ' : ''}nonce="${state.nonce}", opaque="", stale="FALSE"`],
      'Content-Type': 'text/html',
    });
    res.end('<html>401 Unauthorized</html>');
  };
  const authOk = (req) => {
    const a = req.headers.authorization;
    if (!a) return false;
    const p = parseChallenge(a); // an Authorization header has the same key=value syntax as a challenge
    if (!p || p.nonce !== state.nonce || p.uri !== req.url || p.username !== USER) return false;
    const ha1 = md5(`${USER}:${REALM}:${PASS}`);
    const ha2 = md5(`${req.method}:${req.url}`);
    const want = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    if (p.response !== want) return false;
    if (p.qop) state.ncSeen.push(parseInt(p.nc, 16));
    return true;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!authOk(req)) return deny(res);
      const path = req.url;
      state.paths.push(path);
      if (path === '/ISAPI/System/deviceInfo') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end('<DeviceInfo><model>DS-7716NXI-K4</model></DeviceInfo>');
      }
      if (path === '/ISAPI/ContentMgmt/search' && req.method === 'POST') {
        state.searches.push(body);
        const pos = Number(/<searchResultPostion>(\d+)</.exec(body)[1]);
        const xml = pos === 0
          ? searchResult('MORE', [item('20261012T080000Z', `${NAME1}_10S264MB`), item('20261012T080512Z', `${NAME2}_85304RAA`)])
          : searchResult('OK', [item('20261012T081003Z', `${NAME3}_unknown`)]);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(xml);
      }
      if (path.startsWith('/picture/Streaming/tracks/403/') || /^\/ISAPI\/Streaming\/channels\/\d+0[12]\/picture$/.test(path)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(JPEG);
      }
      if (path === '/ISAPI/Event/notification/alertStream') {
        // Like the real NVR: multipart/mixed, no chunked encoding, no Content-Length. Write raw on the socket.
        const sock = req.socket;
        sock.write('HTTP/1.1 200 OK\r\nContent-Type: multipart/mixed; boundary=boundary\r\nConnection: close\r\n\r\n');
        return state.stream(sock);
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, host: `http://127.0.0.1:${server.address().port}` })));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('time conversion', () => {
  assert.equal(TZ_OFFSET_MIN, 300);
  // The NVR's "08:00Z" is 08:00 in Tashkent = 03:00 UTC.
  assert.equal(nvrToEpoch('2026-10-12T08:00:00Z'), Date.UTC(2026, 9, 12, 3, 0, 0));
  assert.equal(nvrToEpoch('20261012T080000Z'), Date.UTC(2026, 9, 12, 3, 0, 0));
  assert.equal(nvrToEpoch('2026-10-12T02:00:00Z'), Date.UTC(2026, 9, 11, 21, 0, 0)); // previous UTC day
  assert.equal(epochToNvr(Date.UTC(2026, 9, 12, 3, 0, 0, 999)), '2026-10-12T08:00:00Z');
  assert.equal(epochToNvr(Date.UTC(2026, 9, 12, 3, 0, 0), 'uri'), '20261012T080000Z');
  assert.equal(nvrToEpoch('2026-10-12T08:00:00Z', 0), Date.UTC(2026, 9, 12, 8, 0, 0));
  assert.throws(() => nvrToEpoch('yesterday'));
});

test('NVR client against a fake NVR', async (t) => {
  const { server, state, host } = await fakeNvr();
  const nvr = new NVR({ host: host + '/', user: USER, password: PASS, timeoutMs: 5000 });
  t.after(() => {
    nvr.close();
    server.closeAllConnections();
    server.close();
  });

  await t.test('digest: challenge, retry, then cached challenge with increasing nc', async () => {
    assert.match(await nvr.deviceInfo(), /DS-7716NXI-K4/);
    assert.equal(state.challenges, 1);
    assert.ok(nvr.lastOk > 0);
    await nvr.deviceInfo();
    assert.equal(state.challenges, 1, 'second request reuses the cached challenge');
    assert.deepEqual(state.ncSeen, [1, 2]);
  });

  await t.test('digest: a rotated nonce is re-challenged once', async () => {
    state.nonce = 'rotated';
    await nvr.deviceInfo();
    assert.equal(state.challenges, 2);
    assert.equal(state.ncSeen.at(-1), 1);
  });

  await t.test('digest: no-qop servers', async () => {
    state.qop = false;
    state.nonce = 'noqop';
    await nvr.deviceInfo();
    state.qop = true;
    state.nonce = 'qop-again';
  });

  await t.test('wrong password surfaces the 401', async () => {
    const bad = new NVR({ host, user: USER, password: 'nope', timeoutMs: 5000 });
    await assert.rejects(bad.deviceInfo(), (e) => e.status === 401);
    bad.close();
  });

  let caps;
  await t.test('searchCaptures pages on MORE and converts times', async () => {
    const start = nvrToEpoch('2026-10-12T07:30:00Z');
    const end = nvrToEpoch('2026-10-12T08:30:00Z');
    caps = await nvr.searchCaptures(4, start, end, 2);
    assert.equal(state.searches.length, 2);
    const [p1, p2] = state.searches;
    assert.match(p1, /<trackID>403<\/trackID>/);
    assert.match(p1, /<startTime>2026-10-12T07:30:00Z<\/startTime><endTime>2026-10-12T08:30:00Z<\/endTime>/);
    assert.match(p1, /<maxResults>2<\/maxResults><searchResultPostion>0</);
    assert.match(p2, /<searchResultPostion>2</);
    assert.match(p1, /\/\/recordType\.meta\.std-cgi\.com\/vehicleDetection/);
    assert.equal(/<searchID>([^<]+)</.exec(p1)[1], /<searchID>([^<]+)</.exec(p2)[1], 'one search id across pages');
    assert.deepEqual(caps.map((c) => [c.channel, c.time, c.plate, c.name]), [
      [4, Date.UTC(2026, 9, 12, 3, 0, 0), '10S264MB', `${NAME1}_10S264MB`],
      [4, Date.UTC(2026, 9, 12, 3, 5, 12), '85304RAA', `${NAME2}_85304RAA`],
      [4, Date.UTC(2026, 9, 12, 3, 10, 3), 'UNKNOWN', `${NAME3}_unknown`],
    ]);
    assert.equal(caps[0].uriPath,
      `/picture/Streaming/tracks/403/?starttime=20261012T080000Z&endtime=20261012T080000Z&name=${NAME1}_10S264MB&size=530291`);
  });

  await t.test('captureImage strips the plate suffix from the record name', async () => {
    const img = await nvr.captureImage(caps[0]);
    assert.deepEqual(img, JPEG);
    assert.equal(state.paths.at(-1),
      `/picture/Streaming/tracks/403/?starttime=20261012T080000Z&endtime=20261012T080000Z&name=${NAME1}&size=530291`);
  });

  await t.test('snapshot main and sub stream', async () => {
    assert.deepEqual(await nvr.snapshot(6), JPEG);
    assert.equal(state.paths.at(-1), '/ISAPI/Streaming/channels/601/picture');
    assert.deepEqual(await nvr.snapshot(5, { sub: true }), JPEG);
    assert.equal(state.paths.at(-1), '/ISAPI/Streaming/channels/502/picture');
  });

  await t.test('anprEvents: incremental parsing, ANPR only, rejects when the NVR closes', async () => {
    state.nonce = 'stream-nonce'; // the stream request itself gets re-challenged
    const before = state.challenges;
    state.stream = async (sock) => {
      const a = alert(4, 'ANPR', 'active');
      sock.write(alert(1, 'videoloss', 'inactive')); // heartbeat
      sock.write(a.slice(0, 100)); // one alert split across writes
      await delay(30);
      sock.write(a.slice(100) + alert(3, 'ANPR', 'active').slice(0, 50));
      await delay(30);
      sock.end();
    };
    const seen = [];
    nvr.lastStream = 0;
    await assert.rejects(nvr.anprEvents((ch) => seen.push(ch)), /closed by NVR/);
    assert.deepEqual(seen, [4]);
    assert.equal(state.challenges, before + 1);
    assert.ok(nvr.lastStream > 0);
  });

  await t.test('anprEvents: events arrive while the stream stays open; abort resolves', async () => {
    state.stream = (sock) => {
      sock.write(alert(1, 'videoloss', 'inactive'));
      setTimeout(() => sock.write(alert(3, 'ANPR', 'active')), 20);
      // never closes, like the real NVR
    };
    const ac = new AbortController();
    const seen = [];
    await nvr.anprEvents((ch) => {
      seen.push(ch);
      ac.abort();
    }, { signal: ac.signal });
    assert.deepEqual(seen, [3]);
  });

  await t.test('anprEvents: silence longer than idleMs rejects', async () => {
    state.stream = (sock) => sock.write(alert(1, 'videoloss', 'inactive'));
    const t0 = Date.now();
    await assert.rejects(nvr.anprEvents(() => {}, { idleMs: 150 }), /no data for 150 ms/);
    assert.ok(Date.now() - t0 >= 140);
  });
});
