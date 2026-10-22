'use strict';

// End-to-end: a real express host wired like app.js (cors + body-parser, router mounted at /manie,
// legacy /manie/banners, catch-all), the real router and the real MemoryStore on ephemeral ports.
// Synthetic data only: every name, number, address and timestamp below is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const childProcess = require('node:child_process');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const {MemoryStore, StoreError} = require('../../lib/manie/store');
const {createManieRouter, RATE_LIMITS, LIMITS} = require('../../routes/manie');
const {mountManie} = require('../../lib/manie/mount');
const {anonymize, sanitizeSkeleton, canonicalSkeleton} = require('../../lib/manie/anonymize');
const {isNoiseSkeleton} = require('../../lib/manie/noise');
const {CHECK_NAMES} = require('../../lib/manie/gate');
const H = require('./_clientHarness');

const {describe, it, before, after} = test;

const ROOT = path.join(__dirname, '..', '..');
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'manie', 'sms-formats.json'), 'utf8'));
const BANNERS_FILE = path.join(ROOT, 'assets', 'manie', 'banners.json');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'assets', 'manie', 'admin.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const ADMIN_TOKEN = 'e2e-admin-token-0123456789-abcdefghijkl';
const SALT = 'e2e-hash-salt-0123456789';
const TRUSTED_ENV = {MANIE_ADMIN_TOKEN: ADMIN_TOKEN, MANIE_TRUST_PROXY: '1', MANIE_HASH_SALT: SALT};
const START = Date.parse('2026-10-21T10:00:00.000Z');

const logLines = [];
const originalConsole = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
        logLines.push(args.map(String).join(' '));
    };
}
after(() => {
    for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
});

/* ---------- host + helpers ---------- */

function buildApp({store, env, now, guard}) {
    const app = express();
    mountManie(app, cors(), createManieRouter({store, env, now, servedTtlMs: 0, guard}));
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(bodyParser.raw());
    app.get('/manie/banners', (req, res) => {
        res.sendFile(BANNERS_FILE);
    });
    app.use('*', (req, res) => {
        res.json({code: '#Undocumented', message: 'Nothing on this route yet'});
    });
    return app;
}

async function startApp({store = new MemoryStore(), env = TRUSTED_ENV, now, guard} = {}) {
    const clock = {ms: START};
    const app = buildApp({store, env, guard, now: now || (() => new Date(clock.ms))});
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url,
        store,
        clock,
        tick: ms => {
            clock.ms += ms;
        },
        close: () =>
            new Promise(resolve => {
                server.close(() => resolve());
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            }),
    };
}

async function call(srv, method, urlPath, {ip, token, body, raw, headers = {}} = {}) {
    const h = {...headers};
    if (ip) h['X-Forwarded-For'] = ip;
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) {
        payload = raw;
    } else if (body !== undefined) {
        payload = JSON.stringify(body);
        if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    }
    const res = await fetch(srv.url + urlPath, {method, headers: h, body: payload});
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (err) {
        json = null;
    }
    return {status: res.status, headers: res.headers, text, json};
}

const admin = (srv, method, urlPath, body, token = ADMIN_TOKEN) =>
    call(srv, method, `/manie/admin/api${urlPath}`, {token, body: method === 'GET' ? undefined : body || {}});
const served = (srv, headers) => call(srv, 'GET', '/manie/sms-formats', {headers});
const submit = (srv, items, ip, extra = {}) =>
    call(srv, 'POST', '/manie/submissions', {ip, body: {v: 1, items, app: {version: '1.0.4', platform: 'android'}, ...extra}});
const clone = value => JSON.parse(JSON.stringify(value));

function failingStore(failing, makeError = () => new Error('store down')) {
    const inner = new MemoryStore();
    return new Proxy(inner, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            return (...args) => (failing(String(prop), args) ? Promise.reject(makeError()) : value.apply(target, args));
        },
    });
}

/* ---------- synthetic traffic ---------- */

const NAMES = [
    'Alice Mukamana',
    'Bob Habimana',
    'Carol Uwase',
    'Dave Kamanzi',
    'Faith Ineza',
    'Eric Nkusi',
    'Olive Nyirahabimana',
    'Samuel Ndayisaba',
    'Jeanne Mukeshimana',
    'Patrick Niyonzima',
];
const PII = new Set(NAMES.flatMap(name => name.split(' ')));
const fmt = n => n.toLocaleString('en-US');

function variant(i) {
    const day = String(10 + (i % 18)).padStart(2, '0');
    const hh = String(8 + (i % 12)).padStart(2, '0');
    const mm = String((i * 7) % 60).padStart(2, '0');
    const v = {
        name: NAMES[i % NAMES.length],
        phone: `25078000${String(1000 + i).padStart(4, '0')}`,
        amt: fmt(4000 + i * 137 + 11),
        amtRaw: String(12000 + i * 137 + 11),
        fee: String(100 + (i % 5) * 50),
        bal: fmt(100000 + i * 17),
        balRaw: String(200000 + i * 17),
        ts: `2026-04-${day} ${hh}:${mm}:${String(i % 60).padStart(2, '0')}`,
        tid: `PP2604${day}.${hh}${mm}.${'ABCDEFGH'[i % 8]}${10001 + i}`,
    };
    for (const key of ['phone', 'amt', 'bal', 'ts', 'tid']) PII.add(v[key]);
    return v;
}

const FORMATS = {
    mtnTransfer: {
        carrier: 'mtn',
        build: v => `Sent ${v.amt} RWF to ${v.name} (${v.phone}) at ${v.ts}. Fee was: ${v.fee} RWF. New balance: ${v.bal} RWF`,
    },
    mtnReceive: {
        carrier: 'mtn',
        build: v => `You have received ${v.amt} RWF from ${v.name} (${v.phone}) on ${v.ts}. Your new balance: ${v.bal} RWF. Fee was ${v.fee} RWF`,
    },
    airtelSent: {
        carrier: 'airtel',
        build: v => `*165*TID ${v.tid}*S* Sent Rwf ${v.amtRaw} to ${v.name} ${v.phone}. Fee Rwf ${v.fee}. BAL Rwf ${v.balRaw}. *EN#`,
    },
    airtelReceiveRw: {
        carrier: 'airtel',
        locale: 'rw-RW',
        build: v => `*165*TXN ID ${v.tid}*S* Mwakiriye RWF ${v.amtRaw} avuye kuri ${v.name} ${v.phone}. Asigaye ni RWF ${v.balRaw}. *KR#`,
    },
    airtelSendRw: {
        carrier: 'airtel',
        locale: 'rw-RW',
        build: v => `*165*TID ${v.tid}*S* Kohereza Rwf ${v.amtRaw} kuri ${v.name} ${v.phone} neza. Fee Rwf${v.fee}. Ubu mufite Rwf ${v.balRaw}. *KR#`,
    },
    mtnDeposit: {
        carrier: 'mtn',
        build: v => `Cash deposited ${v.amt} RWF at ${v.ts} via agent ${v.name} (${v.phone}). Your new balance: ${v.bal} RWF. Fee was ${v.fee} RWF`,
    },
};

const NOISE_BODIES = [
    {carrier: 'mtn', build: v => `Your transaction of ${v.amt} RWF to ${v.name} has failed. Insufficient balance. Balance: ${v.bal} RWF`},
    {carrier: 'airtel', build: v => `Your verification code is ${v.phone.slice(-6)}. Do not share it with anyone`},
];

let vocabSet = null;

function skeletonOf(format, i) {
    const body = format.build(variant(i));
    return anonymize(body, vocabSet).skeleton;
}

function itemOf(format, i, extra = {}) {
    const item = {skeleton: skeletonOf(format, i), carrier: format.carrier, count: 2, ...extra};
    if (format.locale) item.locale = format.locale;
    return item;
}

/* ---------- A. the static file is preserved ---------- */

describe('A. empty store is identical to the static file', () => {
    let srv;
    let first;
    before(async () => {
        srv = await startApp();
        first = await served(srv);
    });
    after(() => srv.close());

    it('serves 200 JSON with the cache headers and a strong ETag, not degraded', () => {
        assert.equal(first.status, 200);
        assert.match(first.headers.get('content-type'), /^application\/json/);
        assert.equal(first.headers.get('cache-control'), 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
        assert.equal(first.headers.get('etag'), `"${first.json.contentHash}"`);
        assert.equal(first.headers.get('x-manie-degraded'), null);
        assert.equal(first.headers.get('access-control-allow-origin'), '*', 'the public config keeps the host CORS behaviour');
    });

    it('every existing pattern is deep-equal to the static file, in order and in key order', () => {
        const got = first.json.patterns;
        assert.equal(got.length, BASE.patterns.length);
        assert.deepStrictEqual(got, BASE.patterns);
        got.forEach((p, i) => assert.equal(JSON.stringify(p), JSON.stringify(BASE.patterns[i]), BASE.patterns[i].id));
    });

    it('keeps the legacy top-level fields and only adds vocabulary + contentHash', () => {
        const {version, defaultLocale, fetchedAt, patterns, vocabulary, contentHash, ...rest} = first.json;
        assert.deepEqual(rest, {});
        assert.equal(defaultLocale, BASE.defaultLocale);
        assert.equal(fetchedAt, BASE.fetchedAt);
        assert.equal(patterns.length, 39);
        assert.match(version, /^regex-v\d{8}-[0-9a-f]{8}$/);
        assert.ok(version.startsWith(`${BASE.version}-`), `${version} extends ${BASE.version}`);
        assert.match(contentHash, /^[0-9a-f]{64}$/);
        assert.ok(Array.isArray(vocabulary) && vocabulary.length > 100);
        assert.ok(vocabulary.every(w => /^[a-z][a-z']{0,29}$/.test(w)));
        assert.ok(vocabulary.includes('transferred') && vocabulary.includes('balance'));
    });

    it('is byte-stable between requests and answers conditional requests with 304', async () => {
        const second = await served(srv);
        assert.equal(second.text, first.text);
        const etag = first.headers.get('etag');
        for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
            const res = await served(srv, {'If-None-Match': header});
            assert.equal(res.status, 304, header);
            assert.equal(res.text, '');
        }
        assert.equal((await served(srv, {'If-None-Match': '"stale"'})).status, 200);
    });

    it('/manie/banners is still served by the host and unknown routes still fall through', async () => {
        const banners = await call(srv, 'GET', '/manie/banners');
        assert.equal(banners.status, 200);
        assert.deepEqual(banners.json, JSON.parse(fs.readFileSync(BANNERS_FILE, 'utf8')));
        const other = await call(srv, 'GET', '/manie/nothing-here');
        assert.equal(other.json.code, '#Undocumented');
    });
});

/* ---------- B. the real anonymizer on synthetic traffic ---------- */

describe('B. device-side anonymization against the served vocabulary', () => {
    let srv;
    before(async () => {
        srv = await startApp();
        const config = (await served(srv)).json;
        vocabSet = new Set(config.vocabulary);
    });
    after(() => srv.close());

    for (const [name, format] of Object.entries(FORMATS)) {
        it(`${name}: different values and names give one digit-free, PII-free skeleton`, () => {
            const skeletons = new Set([0, 1, 2, 3, 4, 5].map(i => skeletonOf(format, i)));
            assert.equal(skeletons.size, 1, [...skeletons].join(' || '));
            const [skeleton] = skeletons;
            assert.doesNotMatch(skeleton, /\d/);
            for (const word of PII) assert.ok(!skeleton.includes(word), `${word} leaked into ${skeleton}`);
            const checked = sanitizeSkeleton(skeleton, vocabSet);
            assert.equal(checked.ok, true);
            assert.equal(checked.skeleton, skeleton, 'a locally produced skeleton is a fixed point of the server sanitiser');
        });
    }

    it('the synthetic formats are novel: no built-in pattern matches the message or its server-side synthesis', () => {
        const fill = {N: '1000', PH: '250788123456', TS: '2026-01-02 03:04:05', TID: 'AB260102.0304.C12345', URL: 'https://example.com/x', EMAIL: 'a@example.com', W: 'Alice', 'W+': 'Alice Bob'};
        const synth = skeleton => skeleton.replace(/\{(N|PH|TS|TID|URL|EMAIL|W\+|W)\}/g, (m, k) => fill[k]);
        for (const [name, format] of Object.entries(FORMATS)) {
            for (const text of [format.build(variant(0)), synth(skeletonOf(format, 0))]) {
                for (const p of BASE.patterns) assert.equal(new RegExp(p.pattern, p.flags).test(text), false, `${name} is matched by ${p.id}`);
            }
        }
    });

    it('failed-transaction and OTP messages are recognised as noise by the server filter', () => {
        for (const noise of NOISE_BODIES) {
            const skeleton = anonymize(noise.build(variant(1)), vocabSet).skeleton;
            assert.equal(isNoiseSkeleton(skeleton).noise, true, skeleton);
        }
        for (const format of Object.values(FORMATS)) assert.equal(isNoiseSkeleton(skeletonOf(format, 0)).noise, false);
    });
});

/* ---------- C. submit -> review -> approve -> serve -> kill switch ---------- */

describe('C. full lifecycle through the public and admin APIs', () => {
    let srv;
    let v0;
    let shapes;
    const approved = {};
    const COUNTS = {mtnTransfer: 25, mtnReceive: 20, airtelSent: 15, airtelReceiveRw: 10, airtelSendRw: 5, mtnDeposit: 3};

    before(async () => {
        srv = await startApp();
        v0 = (await served(srv)).json;
        vocabSet = new Set(v0.vocabulary);
    });
    after(() => srv.close());

    it('accepts submissions from many different addresses and never echoes the input', async () => {
        const names = Object.keys(FORMATS);
        let last;
        for (let i = 0; i < 25; i++) {
            const items = [];
            for (const name of names) {
                if (i >= COUNTS[name]) continue;
                const extra =
                    name === 'mtnTransfer'
                        ? {hints: [{slot: 1, role: 'amount'}, {slot: 4, role: 'fee'}, {slot: 5, role: 'balance'}, {slot: 19, role: 'fee'}]}
                        : {};
                items.push(itemOf(FORMATS[name], i, extra));
            }
            if (i < 5) for (const noise of NOISE_BODIES) items.push({skeleton: anonymize(noise.build(variant(i)), vocabSet).skeleton, carrier: noise.carrier});
            const res = await submit(srv, items, `203.0.113.${i + 1}`);
            assert.equal(res.status, 202, JSON.stringify(res.json));
            const noisy = i < 5 ? NOISE_BODIES.length : 0;
            assert.deepEqual(Object.keys(res.json).sort(), ['accepted', 'deduped', 'discarded']);
            assert.equal(res.json.discarded, noisy, 'only the noise items are not stored, and they are reported as discarded');
            assert.equal(res.json.accepted, items.length - noisy);
            assert.equal(res.json.accepted + res.json.discarded, items.length);
            if (i === 0) assert.equal(res.json.deduped, 0, 'every stored item of the first sighting creates its shape');
            else assert.equal(res.json.deduped, items.length - noisy, 'every later stored item merges into an existing shape');
            for (const word of ['Sent', 'balance', 'Mwakiriye']) assert.ok(!res.text.includes(word));
            last = res;
        }
        assert.equal(last.json.accepted, 1, 'the last address only sends the most common shape');
    });

    it('rejects the admin API without a valid token (401) and with a non-bearer scheme', async () => {
        const none = await call(srv, 'GET', '/manie/admin/api/pending');
        assert.equal(none.status, 401);
        assert.match(none.headers.get('www-authenticate'), /^Bearer/);
        assert.equal(none.headers.get('cache-control'), 'no-store');
        assert.equal(none.headers.get('access-control-allow-origin'), null);
        for (const token of ['wrong-token', ADMIN_TOKEN.slice(0, -1), `${ADMIN_TOKEN}x`]) {
            assert.equal((await admin(srv, 'GET', '/pending', undefined, token)).status, 401, token);
        }
        const basic = await call(srv, 'GET', '/manie/admin/api/pending', {headers: {Authorization: `Basic ${Buffer.from(`a:${ADMIN_TOKEN}`).toString('base64')}`}});
        assert.equal(basic.status, 401);
        const inQuery = await call(srv, 'GET', `/manie/admin/api/pending?token=${ADMIN_TOKEN}`);
        assert.equal(inQuery.status, 401);
    });

    it('lists the pending queue by count with drafts and gates attached', async () => {
        const res = await admin(srv, 'GET', '/pending');
        assert.equal(res.status, 200, res.text);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.match(res.headers.get('content-type'), /^application\/json/);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        shapes = res.json.shapes;
        assert.equal(res.json.total, 6);
        assert.equal(res.json.nextCursor, null);
        assert.deepEqual(
            shapes.map(s => s.count),
            [25, 20, 15, 10, 5, 3],
            'one sighting per source address, whatever count the device declares'
        );
        assert.deepEqual(
            shapes.map(s => s.voters),
            [25, 20, 15, 10, 5, 3]
        );
        const expectedOrder = ['mtnTransfer', 'mtnReceive', 'airtelSent', 'airtelReceiveRw', 'airtelSendRw', 'mtnDeposit'];
        expectedOrder.forEach((name, i) => {
            assert.equal(shapes[i].skeleton, canonicalSkeleton(skeletonOf(FORMATS[name], 0)), name);
            assert.equal(shapes[i].carrier, FORMATS[name].carrier);
            assert.equal(shapes[i].status, 'pending');
            assert.ok(shapes[i].draft && shapes[i].gate, `${name} has a draft and a gate`);
            assert.equal(shapes[i].gate.checks.length, CHECK_NAMES.length);
            assert.match(shapes[i].shapeId, /^[0-9a-f]{16}$/);
            approved[name] = {shapeId: shapes[i].shapeId};
        });
        const first = shapes[0];
        assert.deepEqual(first.hintVotes, {1: {amount: 25 * 1}, 4: {fee: 25}, 5: {balance: 25}}, 'out-of-range hint slot 19 is ignored');
        assert.ok(first.appVersions.length >= 1 && first.appVersions.length <= 5);
        assert.equal(first.firstSeen, new Date(START).toISOString());
        assert.deepEqual(first.perDayCounts, {'2026-10-21': 25});
        assert.equal(first.draft.type, 'transfer');
        assert.equal(first.draft.carrier, 'mtn');
        assert.equal(first.draft.gate, undefined, 'the gate is reported next to the draft, not inside it');
        for (const role of ['amount', 'fee', 'balance', 'secondParty', 'accountNumber']) assert.ok(first.draft.captureMap[role] >= 1, role);
        assert.deepEqual(first.draft.timestamp.parser, 'iso8601');
        assert.equal(first.gate.ok, true, JSON.stringify(first.gate.checks.filter(c => !c.ok)));
    });

    it('pages the queue with a cursor and fetches one shape by id', async () => {
        const page1 = await admin(srv, 'GET', '/pending?limit=2');
        assert.equal(page1.json.shapes.length, 2);
        assert.equal(page1.json.nextCursor, '2');
        const page2 = await admin(srv, 'GET', `/pending?limit=2&cursor=${page1.json.nextCursor}`);
        assert.deepEqual(
            page2.json.shapes.map(s => s.shapeId),
            shapes.slice(2, 4).map(s => s.shapeId)
        );
        const one = await admin(srv, 'GET', `/shape/${shapes[0].shapeId}`);
        assert.equal(one.json.shape.skeleton, shapes[0].skeleton);
        assert.equal((await admin(srv, 'GET', '/shape/0123456789abcdef')).status, 404);
        assert.equal((await admin(srv, 'GET', '/shape/not-a-shape-id')).status, 404);
    });

    it('stores no raw value, address or token anywhere in the store', () => {
        const dump = JSON.stringify(srv.store.snapshot());
        for (const needle of PII) assert.ok(!dump.includes(needle), `store contains ${needle}`);
        for (let i = 1; i <= 25; i++) assert.ok(!dump.includes(`203.0.113.${i}`), 'raw IP stored');
        assert.ok(!dump.includes(ADMIN_TOKEN));
        for (const entry of srv.store.snapshot()) {
            assert.ok(entry.key.startsWith('manie:'), entry.key);
            assert.doesNotMatch(entry.key, /\d+\.\d+\.\d+\.\d+/);
            if (/^manie:shape:/.test(entry.key)) assert.doesNotMatch(entry.value.skeleton, /\d/, entry.key);
        }
    });

    it('refuses to approve a draft that fails the gate or breaks the contract', async () => {
        const {shapeId} = approved.mtnTransfer;
        const base = (await call(srv, 'GET', '/manie/sms-formats')).json;
        const draftOf = () => clone(shapes[0].draft);
        const approve = draft => admin(srv, 'POST', `/shape/${shapeId}/approve`, {draft});

        const noBalance = draftOf();
        delete noBalance.captureMap.balance;
        const r1 = await approve(noBalance);
        assert.equal(r1.status, 422);
        assert.equal(r1.json.error, 'gate_failed', 'the gate, not the store, catches a missing balance');
        assert.ok(r1.json.gate.checks.find(c => c.name === 'required-captures' && !c.ok));

        const broken = draftOf();
        broken.pattern = '(a+)+$';
        assert.equal((await approve(broken)).json.error, 'gate_failed');

        const swapped = draftOf();
        swapped.captureMap.amount = swapped.captureMap.fee;
        assert.equal((await approve(swapped)).status, 422);

        const extra = draftOf();
        extra.admin = true;
        assert.equal((await approve(extra)).status, 400);

        const builtin = draftOf();
        builtin.id = 'mtn-transfer-v1';
        assert.equal((await approve(builtin)).status, 409);

        assert.equal((await approve(undefined)).status, 400);
        const after = (await call(srv, 'GET', '/manie/sms-formats')).json;
        assert.equal(after.contentHash, base.contentHash, 'nothing was published');
        assert.equal(after.patterns.length, BASE.patterns.length);
    });

    async function approveShape(name) {
        const {shapeId} = approved[name];
        const shape = (await admin(srv, 'GET', `/shape/${shapeId}`)).json.shape;
        srv.tick(60 * 1000);
        const res = await admin(srv, 'POST', `/shape/${shapeId}/approve`, {draft: shape.draft});
        assert.equal(res.status, 200, res.text);
        approved[name].id = res.json.id;
        approved[name].pattern = res.json.pattern;
        approved[name].result = res.json;
        return res.json;
    }

    it('approves an MTN draft: version, ETag and patterns change, the legacy fields stay intact', async () => {
        const before = await served(srv);
        const result = await approveShape('mtnTransfer');
        assert.equal(result.ok, true);
        assert.match(result.id, /^auto-mtn-transfer-[0-9a-f]{8}$/);
        assert.equal(result.gate.ok, true);

        const res = await served(srv);
        assert.equal(res.status, 200);
        const cfg = res.json;
        assert.notEqual(cfg.version, before.json.version);
        assert.notEqual(cfg.contentHash, before.json.contentHash);
        assert.notEqual(res.headers.get('etag'), before.headers.get('etag'));
        assert.equal(result.version, cfg.version);
        assert.equal(result.contentHash, cfg.contentHash);
        assert.equal(cfg.defaultLocale, 'en-RW');
        assert.equal(cfg.fetchedAt, new Date(START + 60 * 1000).toISOString(), 'fetchedAt is the change time, not the request time');
        assert.equal(cfg.patterns.length, BASE.patterns.length + 1);
        assert.deepStrictEqual(cfg.patterns.slice(0, BASE.patterns.length), BASE.patterns, 'built-ins stay first and byte-identical');
        const added = cfg.patterns[cfg.patterns.length - 1];
        assert.equal(added.id, result.id);
        assert.equal(added.status, 'active');
        assert.equal(added.carrier, 'mtn');
        assert.equal(added.type, 'transfer');
        assert.deepEqual(Object.keys(added), ['id', 'carrier', 'locale', 'type', 'pattern', 'flags', 'captureMap', 'timestamp', 'tags', 'status', 'createdAt', 'updatedAt']);
        assert.ok(added.captureMap.balance >= 1 && added.captureMap.amount >= 1);
        for (const word of before.json.vocabulary) assert.ok(cfg.vocabulary.includes(word));

        const etag = res.headers.get('etag');
        assert.equal((await served(srv, {'If-None-Match': etag})).status, 304);
        assert.equal((await served(srv, {'If-None-Match': before.headers.get('etag')})).status, 200, 'the old ETag no longer matches');
    });

    it('the served pattern parses new messages of the approved format and rejects failures', () => {
        const cfg = approved.mtnTransfer.pattern;
        const v = variant(40);
        const message = FORMATS.mtnTransfer.build(v);
        const m = new RegExp(cfg.pattern, cfg.flags).exec(message);
        assert.ok(m, 'matches a message it has never seen');
        assert.equal(m[cfg.captureMap.amount], v.amt);
        assert.equal(m[cfg.captureMap.fee], v.fee);
        assert.equal(m[cfg.captureMap.balance], v.bal);
        assert.equal(m[cfg.captureMap.accountNumber], v.phone);
        assert.equal(m[cfg.captureMap.secondParty].trim(), v.name);
        assert.equal(m[cfg.timestamp.group], v.ts);
        const failed = `Failed to send ${v.amt} RWF to ${v.name}. Insufficient balance. Balance: ${v.bal} RWF`;
        assert.equal(new RegExp(cfg.pattern, cfg.flags).test(failed), false);
    });

    it('the real Manie client consumes the live served config and classifies the SMS', {skip: H.unavailableReason() || false}, async () => {
        const live = async () => {
            const res = await served(srv);
            return H.jsonResponse(res.json, {headers: {'x-manie-degraded': res.headers.get('x-manie-degraded') || ''}});
        };
        const env = H.makeEnv({fetchImpl: live});
        const client = H.loadClient(env, {fix: 'none'});
        const config = await client.rrc.syncRegexConfig();
        assert.ok(config, 'the client accepted the served config');
        const v = variant(41);
        const body = FORMATS.mtnTransfer.build(v);
        const {transactions, unmatched} = client.classify.classifyTransactions([{body}]);
        assert.equal(unmatched.length, 0);
        assert.equal(transactions.length, 1);
        const [tx] = transactions;
        assert.equal(tx.type, 'transfer');
        assert.equal(tx.amount, Number(v.amt.replace(/,/g, '')));
        assert.equal(tx.fee, Number(v.fee));
        assert.equal(tx.balance, Number(v.bal.replace(/,/g, '')));
        assert.ok(Number.isFinite(tx.timestamp));
        const failedBody = `Failed to send ${v.amt} RWF to ${v.name}. Insufficient balance. Balance: ${v.bal} RWF`;
        assert.equal(client.classify.classifyTransactions([{body: failedBody}]).transactions.length, 0);
    });

    it('approved and rejected shapes leave the queue, are never re-queued, and cannot be approved twice', async () => {
        const {shapeId} = approved.mtnTransfer;
        const queue = (await admin(srv, 'GET', '/pending')).json;
        assert.equal(queue.total, 5);
        assert.ok(!queue.shapes.some(s => s.shapeId === shapeId));
        const view = (await admin(srv, 'GET', `/shape/${shapeId}`)).json.shape;
        assert.equal(view.status, 'approved');
        assert.equal(view.approvedId, approved.mtnTransfer.id);
        const again = await admin(srv, 'POST', `/shape/${shapeId}/approve`, {draft: view.draft});
        assert.equal(again.status, 409);
        assert.equal((await admin(srv, 'POST', `/shape/${shapeId}/redraft`, {})).status, 409);

        const resubmit = await submit(srv, [itemOf(FORMATS.mtnTransfer, 7)], '198.51.100.7');
        assert.deepEqual(resubmit.json, {accepted: 1, deduped: 1, discarded: 0});
        assert.equal((await admin(srv, 'GET', '/pending')).json.total, 5);

        const reject = await admin(srv, 'POST', `/shape/${approved.mtnDeposit.shapeId}/reject`, {reason: 'unclear cash-in wording'});
        assert.equal(reject.status, 200);
        const rejectedView = (await admin(srv, 'GET', `/shape/${approved.mtnDeposit.shapeId}`)).json.shape;
        assert.equal(rejectedView.status, 'rejected');
        assert.equal(rejectedView.rejectReason, 'unclear cash-in wording');
        assert.equal((await admin(srv, 'GET', '/pending')).json.total, 4);
        const again2 = await submit(srv, [itemOf(FORMATS.mtnDeposit, 9)], '198.51.100.8');
        assert.deepEqual(again2.json, {accepted: 1, deduped: 1, discarded: 0});
        assert.equal((await admin(srv, 'GET', '/pending')).json.total, 4, 'a rejected shape stays rejected');
    });

    it('a new shape that an active served pattern already matches is not queued', async () => {
        const body = `Hello. ${FORMATS.mtnTransfer.build(variant(3))}`;
        const skeleton = anonymize(body, vocabSet).skeleton;
        assert.notEqual(skeleton, skeletonOf(FORMATS.mtnTransfer, 3));
        const res = await submit(srv, [{skeleton, carrier: 'mtn'}], '198.51.100.9');
        assert.deepEqual(res.json, {accepted: 0, deduped: 0, discarded: 1}, 'covered by an active pattern: not stored, so not accepted');
        assert.equal((await admin(srv, 'GET', '/pending')).json.total, 4);
    });

    it('approves Airtel English and Kinyarwanda drafts with the TID rule and the airtel tag', async () => {
        await approveShape('airtelSent');
        await approveShape('airtelReceiveRw');
        await approveShape('airtelSendRw');
        const cfg = (await served(srv)).json;
        assert.equal(cfg.patterns.length, BASE.patterns.length + 4);
        for (const name of ['airtelSent', 'airtelReceiveRw', 'airtelSendRw']) {
            const p = cfg.patterns.find(x => x.id === approved[name].id);
            assert.ok(p, name);
            assert.equal(p.status, 'active');
            assert.equal(p.carrier, 'airtel');
            assert.ok(p.tags.includes('airtel'));
            assert.equal(p.timestamp.parser, 'airtel-shortcode');
            assert.ok(p.captureMap.transactionId >= 1 && p.timestamp.group === p.captureMap.transactionId, 'one full-TID group is both the transaction id and the timestamp');
            const v = variant(50);
            const message = FORMATS[name].build(v);
            const m = new RegExp(p.pattern, p.flags).exec(message);
            assert.ok(m, `${name} matches an unseen message`);
            assert.equal(m[p.captureMap.transactionId], v.tid);
            assert.equal(m[p.timestamp.group], v.tid);
            assert.equal(m[p.captureMap.amount], v.amtRaw);
            assert.equal(m[p.captureMap.balance], v.balRaw);
        }
        const rw = cfg.patterns.find(x => x.id === approved.airtelReceiveRw.id);
        assert.equal(rw.locale, 'rw-RW');
        assert.equal(rw.type, 'receive');
        assert.equal(cfg.patterns.find(x => x.id === approved.airtelSendRw.id).type, 'transfer');
    });

    for (const [label, released] of [['current', false], ['released (shipped)', true]]) {
        it(`the ${label} client classifies an approved Airtel message with the right amount, balance, id and timestamp`, {skip: H.unavailableReason() || (released && !H.extractReleasedClient() ? 'released client sources not available' : false)}, async () => {
            const res = await served(srv);
            const env = H.makeEnv({fetchImpl: async () => H.jsonResponse(res.json)});
            const client = H.loadClient(env, {root: released ? H.extractReleasedClient() : undefined});
            await client.rrc.syncRegexConfig();
            const v = variant(51);
            const {transactions} = client.classify.classifyTransactions([{body: FORMATS.airtelSent.build(v), date: Date.UTC(2026, 3, 11, 9, 7)}]);
            assert.equal(transactions.length, 1);
            const [tx] = transactions;
            assert.equal(tx.type, 'transfer');
            assert.equal(tx.amount, Number(v.amtRaw));
            assert.equal(tx.balance, Number(v.balRaw));
            assert.equal(tx.transactionId, v.tid);
            assert.equal(tx.timestamp, new Date(2026, 3, Number(v.tid.slice(6, 8)), Number(v.tid.slice(9, 11)), Number(v.tid.slice(11, 13)), 0).getTime());
        });
    }

    it('stats reflect the lifecycle', async () => {
        const stats = (await admin(srv, 'GET', '/stats')).json;
        assert.equal(stats.pending, 1);
        assert.equal(stats.approved, 4);
        assert.equal(stats.rejected, 1);
        assert.equal(stats.disabled, 0);
        assert.ok(stats.submissions24h >= 25);
    });

    it('kill switch: disabling an approved pattern removes it at once and changes the version', async () => {
        const before = await served(srv);
        srv.tick(60 * 1000);
        const id = approved.mtnTransfer.id;
        const res = await admin(srv, 'POST', `/approved/${id}/disable`);
        assert.equal(res.status, 200);
        assert.equal(res.json.enabled, false);
        const after = await served(srv);
        assert.ok(!after.json.patterns.some(p => p.id === id), 'pattern disappeared');
        assert.equal(after.json.patterns.length, before.json.patterns.length - 1);
        assert.notEqual(after.json.version, before.json.version);
        assert.notEqual(after.json.contentHash, before.json.contentHash);
        assert.equal((await served(srv, {'If-None-Match': before.headers.get('etag')})).status, 200);
        assert.ok(after.json.patterns.some(p => p.id === approved.airtelSent.id), 'other approvals are untouched');
        assert.equal(res.json.version, after.json.version);

        const list = (await admin(srv, 'GET', '/approved')).json;
        assert.deepEqual(list.disabledIds, [id]);
        assert.equal(list.approved.find(p => p.id === id).enabled, false);
        assert.equal(list.approved.filter(p => p.enabled).length, 3);

        const client = await clientSees(after.json, approved.mtnTransfer, variant(60));
        if (client !== undefined) assert.equal(client, 0, 'the real client stops matching after the kill switch');

        srv.tick(60 * 1000);
        const back = await admin(srv, 'POST', `/approved/${id}/enable`);
        assert.equal(back.status, 200);
        const restored = await served(srv);
        assert.ok(restored.json.patterns.some(p => p.id === id));
        assert.notEqual(restored.json.version, after.json.version);
        assert.notEqual(restored.json.contentHash, after.json.contentHash);
        assert.equal((await admin(srv, 'POST', '/approved/does-not-exist/disable')).status, 404);
    });

    async function clientSees(config, pattern, v) {
        if (H.unavailableReason()) return undefined;
        const env = H.makeEnv({fetchImpl: async () => H.jsonResponse(config)});
        const client = H.loadClient(env, {fix: 'none'});
        await client.rrc.syncRegexConfig();
        return client.classify.classifyTransactions([{body: FORMATS.mtnTransfer.build(v)}]).transactions.length;
    }

    it('the kill switch also works on a pattern that only lives in the served base and restores it exactly', async () => {
        const before = (await served(srv)).json;
        const target = 'mtn-token-payment-v1';
        assert.equal((await admin(srv, 'POST', `/approved/${target}/disable`)).status, 200);
        const off = (await served(srv)).json;
        assert.ok(!off.patterns.some(p => p.id === target));
        assert.notEqual(off.version, before.version);
        await admin(srv, 'POST', `/approved/${target}/enable`);
        const on = (await served(srv)).json;
        assert.deepStrictEqual(on.patterns.slice(0, BASE.patterns.length), BASE.patterns);
    });

    it('refuses a kill switch that devices could not obey: patterns compiled into the app', async () => {
        const before = (await served(srv)).json;
        const res = await admin(srv, 'POST', '/approved/mtn-transfer-v4/disable');
        assert.equal(res.status, 409);
        assert.equal(res.json.error, 'builtin_pattern');
        assert.equal((await served(srv)).json.contentHash, before.contentHash);
    });

    it('admin vocabulary words reach the served config and move the version', async () => {
        const before = (await served(srv)).json;
        assert.ok(!before.vocabulary.includes('remitted'));
        const added = await admin(srv, 'POST', '/vocab', {add: ['Remitted']});
        assert.equal(added.status, 200);
        assert.deepEqual(added.json.words, ['remitted']);
        const withWord = (await served(srv)).json;
        assert.ok(withWord.vocabulary.includes('remitted'));
        assert.notEqual(withWord.version, before.version);
        assert.deepStrictEqual(withWord.patterns, before.patterns);
        assert.equal((await admin(srv, 'POST', '/vocab', {add: ['bad1']})).status, 400);
        assert.equal((await admin(srv, 'POST', '/vocab', {add: ['<script>']})).status, 400);
        await admin(srv, 'POST', '/vocab', {remove: ['remitted']});
        const without = (await served(srv)).json;
        assert.ok(!without.vocabulary.includes('remitted'));
        assert.notEqual(without.version, withWord.version);
    });
});

/* ---------- D. failure policy ---------- */

describe('D. a failing store never breaks the public config', () => {
    it('answers 503 (not a base-only 200) when every store call throws and nothing good is known', async () => {
        const srv = await startApp({store: failingStore(() => true)});
        try {
            const res = await served(srv);
            assert.equal(res.status, 503);
            assert.equal(res.headers.get('x-manie-degraded'), 'kv');
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.ok(Number(res.headers.get('retry-after')) > 0);
            assert.equal(res.json.patterns, undefined);
        } finally {
            await srv.close();
        }
    });

    it('answers 503 when the store answers with garbage', async () => {
        const store = new MemoryStore();
        await store.set('manie:approved', 'not-a-hash');
        const srv = await startApp({store});
        try {
            const res = await served(srv);
            assert.equal(res.status, 503);
            assert.equal(res.headers.get('cache-control'), 'no-store');
        } finally {
            await srv.close();
        }
    });

    it('keeps serving the last good config, uncacheable and flagged, while the store is down, and recovers afterwards (R1-04, R1-SERVED-3, REL-02)', async () => {
        let down = false;
        const srv = await startApp({store: failingStore(() => down), guard: {openMs: 0}});
        try {
            const good = await served(srv);
            assert.equal(good.status, 200);
            down = true;
            const stale = await served(srv);
            assert.equal(stale.status, 200);
            assert.equal(stale.headers.get('x-manie-degraded'), 'stale');
            assert.equal(stale.headers.get('cache-control'), 'no-store', 'a CDN must never pin a degraded response');
            assert.equal(stale.json.version, good.json.version, 'devices keep exactly the config they already have');
            assert.equal(stale.json.contentHash, good.json.contentHash);
            assert.equal((await served(srv, {'If-None-Match': good.headers.get('etag')})).status, 304);
            down = false;
            const fresh = await served(srv);
            assert.equal(fresh.status, 200);
            assert.equal(fresh.headers.get('x-manie-degraded'), null);
            assert.equal(fresh.headers.get('cache-control'), 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
        } finally {
            await srv.close();
        }
    });

    it('drops one corrupt approved record and keeps serving the rest', async () => {
        const store = new MemoryStore();
        await store.hset('manie:approved', {broken: {id: 'broken', carrier: 'mtn', type: 'transfer', status: 'active', pattern: '(', flags: 'i', captureMap: {amount: 1}}});
        const srv = await startApp({store});
        try {
            const res = await served(srv);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('x-manie-degraded'), null);
            assert.deepStrictEqual(res.json.patterns, BASE.patterns);
        } finally {
            await srv.close();
        }
    });

    it('maps store failures to 503 on the other routes, never to the store status or a crash', async () => {
        const storeErr = () => new StoreError('http', 'upstream refused', {status: 401});
        const srv = await startApp({store: failingStore(() => true, storeErr)});
        try {
            const pending = await admin(srv, 'GET', '/pending');
            assert.equal(pending.status, 503);
            assert.equal(pending.json.error, 'storage_unavailable');
            const sub = await submit(srv, [{skeleton: 'Sent {N} RWF to {W+} at {TS}. Balance: {N} RWF', carrier: 'mtn'}], '203.0.113.50');
            assert.equal(sub.status, 503);
            assert.equal(sub.json.error, 'storage_unavailable');
            const page = await call(srv, 'GET', '/manie/admin');
            assert.equal(page.status, 200, 'the admin page carries no data and does not need the store');
            assert.equal((await call(srv, 'GET', '/manie/admin/api/pending')).status, 401, 'a failing limiter store does not open the API');
        } finally {
            await srv.close();
        }
    });

    it('a failing rate-limiter fails open: submissions are still stored', async () => {
        const srv = await startApp({store: failingStore((method, args) => method === 'incr' && String(args[0]).includes(':rl:'))});
        try {
            vocabSet = new Set((await served(srv)).json.vocabulary);
            const res = await submit(srv, [itemOf(FORMATS.mtnTransfer, 1)], '203.0.113.60');
            assert.equal(res.status, 202);
            assert.equal((await admin(srv, 'GET', '/pending')).json.total, 1);
        } finally {
            await srv.close();
        }
    });
});

/* ---------- E. auth and rate limits ---------- */

describe('E. 401 / 503 / 429 / size limits', () => {
    it('503 on every admin API route when the token is unset or too short, while the page stays public', async () => {
        for (const env of [{MANIE_TRUST_PROXY: '1'}, {MANIE_ADMIN_TOKEN: 'short-token', MANIE_TRUST_PROXY: '1'}]) {
            const srv = await startApp({env});
            try {
                for (const [method, url] of [
                    ['GET', '/pending'],
                    ['GET', '/stats'],
                    ['GET', '/approved'],
                    ['GET', '/vocab'],
                    ['POST', '/vocab'],
                    ['POST', '/test'],
                    ['POST', '/shape/0123456789abcdef/approve'],
                    ['POST', '/approved/x/disable'],
                ]) {
                    const res = await call(srv, method, `/manie/admin/api${url}`, {token: ADMIN_TOKEN, body: method === 'POST' ? {} : undefined});
                    assert.equal(res.status, 503, `${method} ${url}`);
                    assert.equal(res.json.error, 'admin_disabled');
                }
                assert.equal((await call(srv, 'GET', '/manie/admin')).status, 200);
                assert.equal((await served(srv)).status, 200);
            } finally {
                await srv.close();
            }
        }
    });

    it('429 after 10 failed admin attempts per address, but the right token still gets in, and other addresses are unaffected', async () => {
        const srv = await startApp();
        try {
            for (let i = 0; i < 10; i++) {
                const res = await call(srv, 'GET', '/manie/admin/api/stats', {ip: '203.0.113.90', token: `wrong-${i}-xxxxxxxxxxxxxxxxxxxx`});
                assert.equal(res.status, 401, `attempt ${i}`);
            }
            const throttled = await call(srv, 'GET', '/manie/admin/api/stats', {ip: '203.0.113.90', token: 'wrong-eleven-xxxxxxxxxxxxxxxxxxxx'});
            assert.equal(throttled.status, 429);
            assert.ok(Number(throttled.headers.get('retry-after')) > 0);
            const admin90 = await call(srv, 'GET', '/manie/admin/api/stats', {ip: '203.0.113.90', token: ADMIN_TOKEN});
            assert.equal(admin90.status, 200, 'a shared address cannot lock the real admin out');
            const other = await call(srv, 'GET', '/manie/admin/api/stats', {ip: '203.0.113.91', token: ADMIN_TOKEN});
            assert.equal(other.status, 200);
            const noHeader = await call(srv, 'GET', '/manie/admin/api/stats', {ip: '203.0.113.92'});
            assert.equal(noHeader.status, 401);
            assert.equal((await call(srv, 'GET', '/manie/admin/api/stats', {ip: '203.0.113.92', token: ADMIN_TOKEN})).status, 200, 'requests without credentials are not counted as failures');
        } finally {
            await srv.close();
        }
    });

    it(`429 on item ${RATE_LIMITS.perIpPerHour + 1} in an hour per address, with Retry-After and nothing stored for the refused request`, async () => {
        const srv = await startApp();
        try {
            vocabSet = new Set((await served(srv)).json.vocabulary);
            const items = Array.from({length: LIMITS.maxItems}, () => itemOf(FORMATS.mtnTransfer, 1));
            for (let i = 0; i < RATE_LIMITS.perIpPerHour / LIMITS.maxItems; i++) assert.equal((await submit(srv, items, '203.0.113.100')).status, 202, `batch ${i}`);
            const limited = await submit(srv, [itemOf(FORMATS.airtelSent, 1)], '203.0.113.100');
            assert.equal(limited.status, 429);
            assert.equal(limited.json.error, 'rate_limited');
            assert.ok(Number(limited.headers.get('retry-after')) > 0);
            assert.equal((await submit(srv, [itemOf(FORMATS.airtelSent, 1)], '203.0.113.101')).status, 202, 'another address is not limited');
            assert.equal((await admin(srv, 'GET', '/pending')).json.total, 2, 'only the mtn shape and the second address airtel shape exist');
        } finally {
            await srv.close();
        }
    });

    it('X-Forwarded-For is ignored unless the proxy is trusted, so it cannot be used to dodge the limit', async () => {
        const srv = await startApp({env: {MANIE_ADMIN_TOKEN: ADMIN_TOKEN, MANIE_HASH_SALT: SALT}});
        try {
            vocabSet = new Set((await served(srv)).json.vocabulary);
            const items = Array.from({length: LIMITS.maxItems}, () => itemOf(FORMATS.mtnTransfer, 1));
            for (let i = 0; i < RATE_LIMITS.perIpPerHour / LIMITS.maxItems; i++) assert.equal((await submit(srv, items, `203.0.113.${110 + (i % 100)}`)).status, 202);
            assert.equal((await submit(srv, [itemOf(FORMATS.airtelSent, 1)], '203.0.113.200')).status, 429);
        } finally {
            await srv.close();
        }
    });

    it('rejects oversized and malformed bodies with 4xx and stores nothing', async () => {
        const srv = await startApp();
        try {
            vocabSet = new Set((await served(srv)).json.vocabulary);
            const good = itemOf(FORMATS.mtnTransfer, 1);
            const app = {version: '1.0.4', platform: 'android'};
            const big = await call(srv, 'POST', '/manie/submissions', {ip: '203.0.113.120', body: {v: 1, items: [good], app, pad: 'x'.repeat(20000)}});
            assert.equal(big.status, 413);
            assert.equal(big.json.error, 'payload_too_large');
            const huge = await call(srv, 'POST', '/manie/submissions', {ip: '203.0.113.120', body: {v: 1, items: [good], app, pad: 'x'.repeat(300000)}});
            assert.equal(huge.status, 413);

            const bodies = [
                [{v: 1, items: [], app}, 'no items'],
                [{v: 1, items: Array.from({length: 21}, () => good), app}, 'too many items'],
                [{v: 2, items: [good], app}, 'wrong version'],
                [{v: 1, items: [{...good, carrier: 'tigo'}], app}, 'unknown carrier'],
                [{v: 1, items: [{...good, count: 51}], app}, 'count too big'],
                [{v: 1, items: [{...good, count: 1.5}], app}, 'count not an integer'],
                [{v: 1, items: [{...good, locale: '<x>'}], app}, 'bad locale'],
                [{v: 1, items: [{...good, hints: [{slot: 1, role: 'password'}]}], app}, 'unknown hint role'],
                [{v: 1, items: [{...good, extra: 1}], app}, 'unknown item field'],
                [{v: 1, items: [good], app: {version: '<img src=x onerror=alert(1)>', platform: 'android'}}, 'markup in app.version'],
                [{v: 1, items: [good], app: {version: '1.0', platform: 'windows'}}, 'unknown platform'],
                [{v: 1, items: [{...good, skeleton: 5}], app}, 'non-string skeleton'],
                [{v: 1, items: [good], app, ['__proto__']: {polluted: true}}, 'proto key'],
            ];
            for (const [body, label] of bodies) {
                const res = await call(srv, 'POST', '/manie/submissions', {ip: '203.0.113.121', raw: JSON.stringify(body), headers: {'Content-Type': 'application/json'}});
                assert.equal(res.status, 400, `${label}: ${res.text.slice(0, 120)}`);
            }
            assert.equal((await call(srv, 'POST', '/manie/submissions', {ip: '203.0.113.121', raw: '{"v":1,', headers: {'Content-Type': 'application/json'}})).status, 400);
            assert.equal((await call(srv, 'POST', '/manie/submissions', {ip: '203.0.113.121', raw: 'v=1', headers: {'Content-Type': 'text/plain'}})).status, 400);
            assert.equal((await call(srv, 'POST', '/manie/submissions', {ip: '203.0.113.121', raw: '[1,2]', headers: {'Content-Type': 'application/json'}})).status, 400);
            assert.equal((await admin(srv, 'GET', '/pending')).json.total, 0);
        } finally {
            await srv.close();
        }
    });
});

/* ---------- F. PII guard and G. stored XSS ---------- */

describe('F/G. PII guard and inert storage', () => {
    let srv;
    before(async () => {
        srv = await startApp();
        vocabSet = new Set((await served(srv)).json.vocabulary);
    });
    after(() => srv.close());

    it('rejects a digit outside a placeholder with 400 pii_guard and the index, storing none of the request', async () => {
        const good = {skeleton: skeletonOf(FORMATS.mtnTransfer, 1), carrier: 'mtn'};
        const res = await submit(srv, [good, {skeleton: 'Sent 5,000 RWF to {W+} ({PH})', carrier: 'mtn'}], '203.0.113.130');
        assert.equal(res.status, 400);
        assert.deepEqual(res.json, {error: 'pii_guard', index: 1});
        assert.equal((await admin(srv, 'GET', '/pending')).json.total, 0, 'the valid first item was not stored');
    });

    it('rejects characters outside the allowed set and forged placeholders', async () => {
        const bad = [
            'Sent {N} RWF <b>now</b>',
            'Sent {N} RWF to Zoë {W+}',
            'Sent {N} RWF\nto {W+}\u0000',
            'Sent {x} RWF',
            'Sent {N RWF',
            'Sent {{N}} RWF',
            'Sent {N} RWF ‮ {W}',
            `Sent {N} RWF ${'a '.repeat(220)}`,
        ];
        for (const skeleton of bad) {
            const res = await submit(srv, [{skeleton, carrier: 'mtn'}], '203.0.113.131');
            assert.equal(res.status, 400, JSON.stringify(skeleton).slice(0, 60));
            assert.ok(res.json.error === 'pii_guard' || res.json.error === 'invalid_body', res.text);
        }
    });

    it('a raw SMS with real values is refused and the error does not echo it', async () => {
        const raw = `Sent ${variant(2).amt} RWF to ${variant(2).name} (${variant(2).phone})`;
        const res = await submit(srv, [{skeleton: raw, carrier: 'mtn'}], '203.0.113.132');
        assert.equal(res.status, 400);
        for (const word of PII) assert.ok(!res.text.includes(word));
    });

    it('a digit-free body that still carries a real name is rewritten server-side', async () => {
        const res = await submit(srv, [{skeleton: 'Sent {N} RWF to Alice Mukamana at {TS}. Balance: {N} RWF', carrier: 'mtn'}], '203.0.113.133');
        assert.equal(res.status, 202);
        const queue = (await admin(srv, 'GET', '/pending')).json.shapes;
        assert.equal(queue.length, 1);
        assert.equal(queue[0].skeleton, 'sent {N} rwf to {W+} at {TS}. balance: {N} rwf', 'rewritten and case-folded');
        assert.ok(!JSON.stringify(srv.store.snapshot()).includes('Alice'));
    });

    it('markup in a skeleton is either refused or stored as inert placeholders', async () => {
        const markup = ['<img src=x onerror=alert()> {N} RWF', '<script>alert()</script> {N} RWF', '"></script><svg/onload=alert()> {N} RWF'];
        for (const skeleton of markup) {
            assert.equal((await submit(srv, [{skeleton, carrier: 'mtn'}], '203.0.113.134')).status, 400, skeleton);
        }
        const payloads = ['"onmouseover="alert()" {N} RWF at {TS}. Balance: {N} RWF', 'javascript:alert() {N} RWF at {TS}. Balance: {N} RWF', "'-alert()-' {N} RWF at {TS}. Balance: {N} RWF"];
        for (const skeleton of payloads) {
            const res = await submit(srv, [{skeleton, carrier: 'mtn'}], '203.0.113.135');
            assert.equal(res.status, 202, skeleton);
        }
        const dump = JSON.stringify(srv.store.snapshot());
        for (const needle of ['onmouseover', 'javascript', 'alert', 'onerror', 'svg']) assert.ok(!dump.includes(needle), `${needle} reached the store`);
        for (const entry of srv.store.snapshot()) {
            if (/^manie:shape:/.test(entry.key)) assert.doesNotMatch(entry.value.skeleton, /[<>]/);
        }
        const listing = await admin(srv, 'GET', '/pending');
        for (const shape of listing.json.shapes) {
            assert.match(shape.skeleton, /^[A-Za-z{}+ .,:;()\-'\/!?%@#&*_=\[\]"]+$/);
            const checked = sanitizeSkeleton(shape.skeleton, vocabSet);
            assert.equal(checked.ok, true);
            assert.equal(checked.skeleton, shape.skeleton, 'stored skeletons are fixed points of the sanitiser');
        }
        assert.equal(listing.headers.get('x-content-type-options'), 'nosniff');
        assert.match(listing.headers.get('content-type'), /^application\/json/);
        assert.ok(!listing.text.includes('onmouseover') && !listing.text.includes('alert'));
    });

    it('admin-typed text is returned as JSON data under nosniff, and HTML in it is bounded', async () => {
        const shape = (await admin(srv, 'GET', '/pending')).json.shapes[0];
        const note = '<img src=x onerror=alert(1)>';
        const rejected = await admin(srv, 'POST', `/shape/${shape.shapeId}/reject`, {reason: note});
        assert.equal(rejected.status, 200);
        const view = await admin(srv, 'GET', `/shape/${shape.shapeId}`);
        assert.equal(view.json.shape.rejectReason, note, 'kept as text');
        assert.match(view.headers.get('content-type'), /^application\/json/);
        assert.equal(view.headers.get('x-content-type-options'), 'nosniff');
        assert.equal((await admin(srv, 'POST', `/shape/${shape.shapeId}/reject`, {reason: 'x'.repeat(201)})).status, 400);
    });
});

/* ---------- H. the admin page ---------- */

const BANNED_DOM = [
    /\.innerHTML\b/,
    /\.outerHTML\b/,
    /insertAdjacentHTML/,
    /document\.write/,
    /\beval\s*\(/,
    /new\s+Function\b/,
    /javascript:/i,
    /\bsrcdoc\b/,
    /createContextualFragment/,
    /\bimportScripts\b/,
    /new\s+Worker\b/,
    /setTimeout\s*\(\s*['"`]/,
    /setInterval\s*\(\s*['"`]/,
    /\bon[a-z]{3,}\s*=\s*["']/i,
];

describe('H. GET /manie/admin', () => {
    let srv;
    before(async () => {
        srv = await startApp();
    });
    after(() => srv.close());

    it('is served with a per-request nonce CSP and the hardening headers, without CORS headers', async () => {
        const a = await call(srv, 'GET', '/manie/admin', {headers: {Origin: 'https://evil.example'}});
        const b = await call(srv, 'GET', '/manie/admin');
        assert.equal(a.status, 200);
        assert.match(a.headers.get('content-type'), /^text\/html; charset=utf-8$/i);
        assert.equal(a.headers.get('cache-control'), 'no-store');
        assert.equal(a.headers.get('x-frame-options'), 'DENY');
        assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(a.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(a.headers.get('access-control-allow-origin'), null, 'the host cors() header is stripped on the admin page');
        assert.equal(a.headers.get('access-control-allow-credentials'), null);

        const csp = a.headers.get('content-security-policy');
        const directives = Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
        const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)[1];
        assert.ok(Buffer.from(nonce, 'base64').length >= 16);
        assert.deepEqual(directives['default-src'], ["'none'"]);
        assert.deepEqual(directives['script-src'], [`'nonce-${nonce}'`]);
        assert.deepEqual(directives['style-src'], [`'nonce-${nonce}'`]);
        assert.deepEqual(directives['connect-src'], ["'self'"]);
        assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
        assert.deepEqual(directives['base-uri'], ["'none'"]);
        assert.deepEqual(directives['form-action'], ["'none'"]);
        assert.doesNotMatch(directives['script-src'].join(' '), /unsafe/);
        assert.doesNotMatch(csp, /unsafe-eval|\*|https?:/);

        const tags = [...a.text.matchAll(/<(script|style)\b[^>]*>/gi)].map(m => m[0]);
        assert.ok(tags.length >= 3);
        for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
        const nonceB = /nonce-([A-Za-z0-9+/=]+)/.exec(b.headers.get('content-security-policy'))[1];
        assert.notEqual(nonceB, nonce, 'a fresh nonce per request');
        assert.ok(!b.text.includes(nonce));
    });

    it('carries no data and no secrets, loads nothing external, and uses no banned DOM API', async () => {
        const page = await call(srv, 'GET', '/manie/admin');
        assert.ok(!page.text.includes(ADMIN_TOKEN));
        assert.doesNotMatch(page.text, /<(?:script|link|img|iframe|object|embed|source)\b[^>]*\b(?:src|href)\s*=\s*["'](?!data:|#)/i);
        assert.doesNotMatch(page.text.replace(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g, ''), /https?:\/\//);
        for (const re of BANNED_DOM) {
            assert.doesNotMatch(ADMIN_HTML, re, `admin.html uses ${re}`);
            assert.doesNotMatch(page.text, re, `served page uses ${re}`);
        }
        assert.doesNotMatch(ADMIN_HTML, /document\.cookie|indexedDB|\bWebSocket\b|XMLHttpRequest|navigator\.sendBeacon/);
        assert.deepEqual(
            [...ADMIN_HTML.matchAll(/(local|session)Storage'?,?\s*,?\s*([A-Z_]+_KEY)/g)].map(m => `${m[1]}:${m[2]}`).sort(),
            ['local:THEME_KEY', 'local:THEME_KEY', 'session:TOKEN_KEY', 'session:TOKEN_KEY', 'session:TOKEN_KEY', 'session:TOKEN_KEY'].sort(),
            'the token only ever touches sessionStorage; localStorage only holds the theme'
        );
        assert.match(ADMIN_HTML, /textContent/);
        assert.match(ADMIN_HTML, /createElement/);
        assert.match(ADMIN_HTML, /var API_BASE = '\/manie\/admin\/api'/);
    });
});

/* ---------- K. device hints, L. concurrency ---------- */

describe('K. device role hints settle an otherwise ambiguous shape end to end', () => {
    it('three devices vote, the draft gains fee and balance, the gate passes and the approved pattern parses', async () => {
        const srv = await startApp();
        try {
            const config = (await served(srv)).json;
            vocabSet = new Set(config.vocabulary);
            const body = v => `Sent ${v.amt} RWF to ${v.name} (${v.phone}) at ${v.ts}. ${v.fee} RWF ${v.bal} RWF`;
            const skeleton = anonymize(body(variant(1)), vocabSet).skeleton;
            assert.equal(skeleton, 'Sent {N} RWF to {W+} ({PH}) at {TS}. {N} RWF {N} RWF');

            const first = await submit(srv, [{skeleton, carrier: 'mtn'}], '203.0.113.140');
            assert.equal(first.status, 202);
            const unlabeled = (await admin(srv, 'GET', '/pending')).json.shapes[0];
            assert.equal(unlabeled.draft.captureMap.balance, undefined, 'no keyword and no hint: no balance guessed');
            assert.equal(unlabeled.gate.ok, false);
            assert.ok(unlabeled.gate.checks.find(c => c.name === 'required-captures' && !c.ok));

            for (const ip of ['203.0.113.141', '203.0.113.142', '203.0.113.143']) {
                const res = await submit(srv, [{skeleton, carrier: 'mtn', hints: [{slot: 4, role: 'fee'}, {slot: 5, role: 'balance'}]}], ip);
                assert.equal(res.status, 202);
            }
            const shape = (await admin(srv, 'GET', '/pending')).json.shapes[0];
            assert.deepEqual(shape.hintVotes, {4: {fee: 3}, 5: {balance: 3}});
            assert.equal(shape.draft.sourceShape.count, 4, 'the cached draft was rebuilt with the accumulated votes and count');
            assert.ok(shape.draft.captureMap.fee >= 1 && shape.draft.captureMap.balance >= 1);
            assert.equal(shape.gate.ok, true, JSON.stringify(shape.gate.checks.filter(c => !c.ok)));

            const res = await admin(srv, 'POST', `/shape/${shape.shapeId}/approve`, {draft: shape.draft});
            assert.equal(res.status, 200, res.text);
            const pattern = (await served(srv)).json.patterns.pop();
            const v = variant(9);
            const m = new RegExp(pattern.pattern, pattern.flags).exec(body(v));
            assert.ok(m);
            assert.equal(m[pattern.captureMap.fee], v.fee);
            assert.equal(m[pattern.captureMap.balance], v.bal);
        } finally {
            await srv.close();
        }
    });

    it('an admin can fix a role by redrafting, and the edited draft re-passes the gate before it can be approved', async () => {
        const srv = await startApp();
        try {
            vocabSet = new Set((await served(srv)).json.vocabulary);
            const skeleton = 'Sent {N} RWF to {W+} ({PH}) at {TS}. {N} RWF {N} RWF';
            await submit(srv, [{skeleton, carrier: 'mtn'}], '203.0.113.150');
            const shape = (await admin(srv, 'GET', '/pending')).json.shapes[0];
            const redraft = await admin(srv, 'POST', `/shape/${shape.shapeId}/redraft`, {captureMap: {fee: 5, balance: 6}});
            assert.equal(redraft.status, 200, redraft.text);
            assert.equal(redraft.json.draft.captureMap.balance, 6);
            assert.equal(redraft.json.gate.ok, true, JSON.stringify(redraft.json.gate.checks.filter(c => !c.ok)));
            for (const ip of ['203.0.113.151', '203.0.113.152', '203.0.113.153']) {
                const contrary = [{slot: 4, role: 'balance'}, {slot: 5, role: 'fee'}];
                assert.equal((await submit(srv, [{skeleton, carrier: 'mtn', hints: contrary}], ip)).status, 202);
            }
            const kept = (await admin(srv, 'GET', '/pending')).json.shapes[0];
            assert.deepEqual(kept.hintVotes, {4: {balance: 3}, 5: {fee: 3}});
            assert.equal(kept.draft.captureMap.fee, 5, 'later device votes never overwrite an admin edit');
            assert.equal(kept.draft.captureMap.balance, 6);
            const reset = await admin(srv, 'POST', `/shape/${shape.shapeId}/redraft`, {});
            assert.equal(reset.json.draft.captureMap.balance, 5, 'an empty redraft goes back to the votes');
            assert.equal(reset.json.draft.captureMap.fee, 6);
            await admin(srv, 'POST', `/shape/${shape.shapeId}/redraft`, {captureMap: {fee: 5, balance: 6}});
            const clash = await admin(srv, 'POST', `/shape/${shape.shapeId}/redraft`, {captureMap: {fee: 6, balance: 6}});
            assert.equal(clash.status, 200);
            assert.equal(clash.json.gate.ok, false, 'two roles on one group are reported by the gate');
            assert.ok(clash.json.gate.checks.find(c => c.name === 'capture-map' && !c.ok));
            const refused = await admin(srv, 'POST', `/shape/${shape.shapeId}/approve`, {draft: clash.json.draft});
            assert.equal(refused.status, 422);
            assert.equal(refused.json.error, 'gate_failed');
            const test = await admin(srv, 'POST', '/test', {...redraft.json.draft, message: 'Sent 1,000 RWF to Zed Zebra (250780009999) at 2026-04-11 10:00:00. 50 RWF 9,000 RWF'});
            assert.equal(test.status, 400, 'the test endpoint only takes the documented fields');
            const ok = await admin(srv, 'POST', '/test', {
                pattern: redraft.json.draft.pattern,
                flags: redraft.json.draft.flags,
                captureMap: redraft.json.draft.captureMap,
                timestamp: redraft.json.draft.timestamp,
                message: 'Sent 1,000 RWF to Zed Zebra (250780009999) at 2026-04-11 10:00:00. 50 RWF 9,000 RWF',
            });
            assert.equal(ok.status, 200, ok.text);
            assert.equal(ok.json.matched, true);
            assert.equal(ok.json.timedOut, false);
            assert.equal(ok.json.fields.amount, 1000);
            assert.equal(ok.json.fields.fee, 50);
            assert.equal(ok.json.fields.balance, 9000);
            const hang = await admin(srv, 'POST', '/test', {pattern: '^(a+)+$', flags: 'i', captureMap: {amount: 1}, message: `${'a'.repeat(40)}!`});
            assert.equal(hang.status, 200);
            assert.equal(hang.json.timedOut, true, 'a catastrophic pattern is cut off by the sandbox timeout');
        } finally {
            await srv.close();
        }
    });
});

describe('L. concurrent submissions', () => {
    it('many parallel requests for one new shape produce one shape, no crash and a sane count', async () => {
        const srv = await startApp();
        try {
            vocabSet = new Set((await served(srv)).json.vocabulary);
            const item = itemOf(FORMATS.airtelSent, 2);
            const results = await Promise.all(Array.from({length: 12}, (_, i) => submit(srv, [item], `198.51.100.${i + 1}`)));
            for (const res of results) assert.equal(res.status, 202, res.text);
            const queue = (await admin(srv, 'GET', '/pending')).json;
            assert.equal(queue.total, 1);
            const [shape] = queue.shapes;
            assert.ok(shape.count >= 2 && shape.count <= 24, `count ${shape.count}`);
            assert.ok(shape.appVersions.length >= 1 && shape.appVersions.length <= 5);
        } finally {
            await srv.close();
        }
    });
});

/* ---------- I. wiring ---------- */

describe('I. app.js wiring and syntax', () => {
    it('mounts the router after dotenv, before the body parsers and the catch-all, and drops the static sms-formats route', () => {
        const dotenv = APP_JS.indexOf("require('dotenv').config()");
        const mount = APP_JS.indexOf('mountManie(app, cors())');
        const parsers = APP_JS.indexOf('app.use(bodyParser.json())');
        const banners = APP_JS.indexOf("app.get('/manie/banners'");
        const catchAll = APP_JS.indexOf("app.use('*'");
        assert.ok(dotenv >= 0 && mount > dotenv, 'mounted after dotenv so MANIE_* variables are loaded');
        assert.ok(parsers > mount, 'mounted before the host body parsers so malformed JSON gets the router JSON error');
        assert.ok(banners >= 0, 'banners route kept');
        assert.ok(catchAll > parsers && catchAll > banners, 'mounted before the catch-all');
        assert.ok(!APP_JS.includes("app.get('/manie/sms-formats'"), 'static route removed');
        assert.equal(APP_JS.match(/\/manie\/sms-formats/g), null);
        assert.ok(!APP_JS.includes('app.use(cors())'), 'cors goes through mountManie so submissions and admin stay CORS-free');
    });

    it('every new file passes node --check', () => {
        const files = [path.join(ROOT, 'app.js'), path.join(ROOT, 'routes', 'manie.js')];
        for (const dir of ['lib/manie', 'scripts']) {
            for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.js')) files.push(path.join(ROOT, dir, f));
        }
        for (const f of fs.readdirSync(path.join(ROOT, 'test', 'manie'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'test', 'manie', f));
        for (const file of files) {
            const res = childProcess.spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
            assert.equal(res.status, 0, `${file}: ${res.stderr}`);
        }
    });
});

/* ---------- J. nothing sensitive in the logs ---------- */

describe('J. logs', () => {
    it('contain no submitted text, no raw address, no value and no token', () => {
        const joined = logLines.join('\n');
        for (const needle of PII) assert.ok(!joined.includes(needle), `log contains ${needle}`);
        assert.ok(!/203\.0\.113\.\d+|198\.51\.100\.\d+/.test(joined), 'raw address in logs');
        assert.ok(!joined.includes(ADMIN_TOKEN));
        for (const fragment of ['New balance', 'Fee was', 'Mwakiriye', 'onmouseover']) assert.ok(!joined.includes(fragment), fragment);
    });
});
