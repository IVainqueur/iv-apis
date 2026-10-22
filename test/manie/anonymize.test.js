'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    anonymize,
    sanitizeSkeleton,
    sanitizeSkeletonDetailed,
    canonicalSkeleton,
    shapeId,
    MAX_SKELETON_LENGTH,
    MAX_INPUT_CHARS,
} = require('../../lib/manie/anonymize');
const fs = require('node:fs');
const path = require('node:path');
const names = require('../../lib/manie/_names');
const {NAME_STOPLIST, NAME_STOPSET, RESTRICTED_VOCAB_WORDS, isNameLike} = names;
const vectors = require('./vectors/anonymize-vectors.json');
const sanitizeVectors = require('./vectors/sanitize-vectors.json');
const seed = require('../../assets/manie/vocab-seed.json');

const SEED_VOCAB = new Set(seed);
const PLACEHOLDER_RE = /\{(?:N|PH|TS|TID|URL|EMAIL|W\+|W)\}/g;

function assertSkeletonInvariant(skeleton, vocab, label) {
    const ctx = label ? ' [' + label + ']' : '';
    assert.ok(!/[0-9]/.test(skeleton), 'digit survived' + ctx + ': ' + skeleton);
    assert.ok(!/[^A-Za-z{}+ .,:;()\-'\/!?%@#&*_=\[\]"]/.test(skeleton), 'bad char survived' + ctx + ': ' + skeleton);
    const stripped = skeleton.replace(PLACEHOLDER_RE, ' ');
    assert.ok(!/[{}]/.test(stripped), 'stray brace' + ctx + ': ' + skeleton);
    for (const word of stripped.match(/[A-Za-z][A-Za-z']*/g) || []) {
        assert.ok(vocab.has(word.toLowerCase()), 'out-of-vocabulary word "' + word + '" survived' + ctx + ': ' + skeleton);
    }
    assert.ok(!/ {2}/.test(skeleton), 'double space' + ctx + ': ' + skeleton);
    assert.equal(skeleton, skeleton.trim(), 'untrimmed' + ctx);
    assert.ok(!/\{W\+?\} \{W\+?\}/.test(skeleton), 'uncollapsed unknown-word run' + ctx + ': ' + skeleton);
}

function mulberry32(seedValue) {
    let a = seedValue >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SYLLABLES = ['ka', 'mu', 'ta', 'bi', 'ne', 'ro', 'zu', 'li', 'sho', 'qua', 'vex', 'ply', 'dro', 'gri', 'mon', 'jak', 'fel', 'wur', 'nix', 'bro'];
const ACCENTED = ['é', 'ï', 'ñ', 'ü', 'ô', 'ç', 'ø', 'å'];

function makeRng(seedValue) {
    const rnd = mulberry32(seedValue);
    const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = arr => arr[int(0, arr.length - 1)];
    return {rnd, int, pick};
}

function randomNameToken(r) {
    let w = '';
    const n = r.int(2, 4);
    for (let i = 0; i < n; i++) w += r.pick(SYLLABLES);
    const style = r.int(0, 5);
    if (style === 1) w = w.toUpperCase();
    else if (style === 2) w = w[0].toUpperCase() + w.slice(1);
    else if (style === 3) w = w.slice(0, 2) + r.pick(ACCENTED) + w.slice(2);
    else if (style === 4) w = w.slice(0, 2) + "'" + w.slice(2);
    else if (style === 5) w = w[0].toUpperCase() + w.slice(1, 3) + '-' + w.slice(3);
    return w;
}

function randomName(r) {
    const parts = [];
    const n = r.int(1, 4);
    for (let i = 0; i < n; i++) parts.push(randomNameToken(r));
    return parts.join(r.int(0, 9) === 0 ? '  ' : ' ');
}

function randomDigits(r, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String(r.int(0, 9));
    return s;
}

function randomPhone(r) {
    const local = '7' + r.pick(['2', '3', '8', '9']) + randomDigits(r, 7);
    switch (r.int(0, 7)) {
        case 0: return '250' + local;
        case 1: return '+250' + local;
        case 2: return '0' + local;
        case 3: return '+250 ' + local.slice(0, 3) + ' ' + local.slice(3, 6) + ' ' + local.slice(6);
        case 4: return '0' + local.slice(0, 3) + '-' + local.slice(3, 6) + '-' + local.slice(6);
        case 5: return '0' + local.slice(0, 2) + ' ' + local.slice(2, 4) + ' ' + local.slice(4, 6) + ' ' + local.slice(6);
        case 6: return '+250-' + local.slice(0, 3) + '-' + local.slice(3, 6) + '-' + local.slice(6);
        default: return local;
    }
}

function randomAmount(r) {
    const n = r.int(1, 8);
    const base = String(r.int(1, 9)) + randomDigits(r, n - 1);
    if (r.int(0, 2) === 0) return base.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return base;
}

function randomTid(r) {
    return r.pick(['PP', 'MP', 'CI', 'RC']) + randomDigits(r, 6) + '.' + randomDigits(r, 4) + '.' + r.pick(['A', 'B', 'C']) + r.int(1, 99);
}

function randomTimestamp(r) {
    return '2026-' + String(r.int(1, 12)).padStart(2, '0') + '-' + String(r.int(1, 28)).padStart(2, '0') + ' ' +
        String(r.int(0, 23)).padStart(2, '0') + ':' + String(r.int(0, 59)).padStart(2, '0') + ':' + String(r.int(0, 59)).padStart(2, '0');
}

const TEMPLATES = [
    ({name, phone, amt, bal, ts}) => amt + ' RWF transferred to ' + name + '(' + phone + ') at ' + ts + '.Fee was: 20 RWF. New balance: ' + bal + ' RWF',
    ({name, phone, amt, bal, ts}) => 'You have received ' + amt + ' RWF from ' + name + ' (' + phone + ') at ' + ts + ' Balance:' + bal + ' RWF',
    ({name, phone, amt, bal, tid}) => '*165* TID ' + tid + '*S* Money successfully sent to ' + name + ' ' + phone + ' Amt ' + amt + 'Fee RWF 100. BAL is RWF ' + bal + '. *EN#',
    ({name, phone, amt, bal, tid}) => '*165*Txn ID ' + tid + '*R* You received Rwf' + amt + ' from ' + name + ' ' + phone + '.Your NEW BALANCE is Rwf ' + bal + '. *EN#',
    ({name, phone, amt, bal, tid}) => '*165* TID ' + tid + '*S* Kohereza Rwf ' + amt + ' kuri ' + name + ' ' + phone + ' byakunze. Fee Rwf100. Ubu mufite Rwf ' + bal + '. *KR#',
    ({name, amt, bal, tid}) => '*161*TXN ID (' + tid + ')*S*Kwishyura RWF ' + amt + ' kuri ' + name + ' Kode byagenze neza.Ubu mufite RWF ' + bal + '. *KR#',
    ({name, phone, amt, bal, ts}) => 'You have via agent: ' + name + '(' + phone + ') withdrawn ' + amt + ' RWF from at ' + ts + ' Your new balance: ' + bal + ' RWF Fee paid: 300 RWF',
    ({name, phone}) => 'Contact ' + name + ' on ' + phone + ' or ' + phone.replace(/\D/g, '') + ' today',
];

function nameTokens(name) {
    return name.split(/[^A-Za-zÀ-ɏ]+/).filter(t => t.length >= 3);
}

function digitRuns(text) {
    return text.match(/\d+/g) || [];
}

test('conformance vectors', async t => {
    assert.ok(Array.isArray(vectors) && vectors.length >= 80, 'need at least 80 vectors, have ' + vectors.length);
    assert.equal(new Set(vectors.map(v => v.name)).size, vectors.length, 'vector names must be unique');

    for (const v of vectors) {
        await t.test(v.name, () => {
            assert.equal(typeof v.input, 'string');
            assert.ok(Array.isArray(v.vocab));
            const vocab = new Set(v.vocab);
            const got = anonymize(v.input, vocab);
            assert.equal(got.skeleton, v.expected);
            assert.deepEqual(got.slots.map(s => s.kind + ':' + s.index), v.slots);
            assert.ok(Array.isArray(v.spans) && v.spans.length === v.slots.length, 'every vector pins the exact text of each slot');
            assert.deepEqual(got.slots.map(s => v.input.slice(s.start, s.end)), v.spans, 'slot spans');
            if (v.expected !== '') {
                assertSkeletonInvariant(v.expected, vocab, v.name);
                if (v.expected.length <= MAX_SKELETON_LENGTH) {
                    const s = sanitizeSkeleton(v.expected, vocab);
                    assert.equal(s.ok, true, 'sanitize rejected anonymize output: ' + JSON.stringify(s));
                    assert.equal(s.skeleton, v.expected, 'sanitize(anonymize(x)) must equal anonymize(x)');
                }
            }
        });
    }
});

test('vectors cover the required categories', () => {
    const names = vectors.map(v => v.name).join('\n');
    for (const needle of ['apostrophe', 'hyphen', 'accented', 'allcaps', 'phone-plus-250', 'phone-hyphenated', 'phone-local-spaced', 'rwf-glued', 'amount-commas', 'amount-decimals', 'url-', 'email-', 'tid-', 'empty-string', 'only-whitespace', 'emoji', 'over-limit', 'airtel-', 'mtn-', 'kinyarwanda', 'alnum']) {
        assert.ok(names.includes(needle), 'missing vector category: ' + needle);
    }
});

test('anonymize returns spans that point at the replaced values', () => {
    const body = '1000 RWF transferred to Alice Fakename(250780000001) at 2026-01-01 10:00:00.Fee was: 20 RWF. New balance: 50,000 RWF';
    const {skeleton, slots} = anonymize(body, SEED_VOCAB);
    assert.equal(skeleton, '{N} RWF transferred to {W+}({PH}) at {TS}.Fee was: {N} RWF. New balance: {N} RWF');
    assert.deepEqual(slots.map(s => body.slice(s.start, s.end)), ['1000', 'Alice Fakename', '250780000001', '2026-01-01 10:00:00', '20', '50,000']);
    const plus = anonymize('to +250780000014 now', new Set(['to', 'now']));
    assert.equal('to +250780000014 now'.slice(plus.slots[0].start, plus.slots[0].end), '+250780000014');
});

test('hint slot indexes count only numeric/word placeholders', () => {
    const {slots} = anonymize('*165* TID PP260411.1430.A1*S* Money successfully sent to Aline Fakeperson 250780000005 Amt 5000Fee RWF 100. BAL is RWF 20000. *EN#', SEED_VOCAB);
    assert.deepEqual(slots.map(s => s.kind), ['N', 'TID', 'W+', 'PH', 'N', 'N', 'N']);
    assert.deepEqual(slots.map(s => s.index), [1, 0, 2, 3, 4, 5, 6]);
});

test('shapeId is 16 hex chars of sha256(skeleton)', () => {
    const sk = '{N} RWF transferred to {W+}({PH}) at {TS}';
    const id = shapeId(sk);
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(id, crypto.createHash('sha256').update(sk, 'utf8').digest('hex').slice(0, 16));
    assert.equal(shapeId(sk), id);
    assert.notEqual(shapeId(sk + ' '), id);
    assert.throws(() => shapeId(42), TypeError);
});

test('anonymize tolerates non-string and oversize input', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
        assert.deepEqual(anonymize(bad, SEED_VOCAB), {skeleton: '', slots: []});
    }
    assert.deepEqual(anonymize('x'.repeat(MAX_INPUT_CHARS + 1), SEED_VOCAB), {skeleton: '', slots: []});
    assert.equal(anonymize('x'.repeat(MAX_INPUT_CHARS), SEED_VOCAB).skeleton, '{W}');
    assert.equal(anonymize('Fee 5', ['fee']).skeleton, 'Fee {N}');
    assert.equal(anonymize('Fee 5', undefined).skeleton, '{W} {N}');
});

test('anonymize is linear-ish on adversarial input', () => {
    const inputs = [
        'a.'.repeat(1000), '1-'.repeat(1000), 'a@'.repeat(1000), 'http://'.repeat(285), ' '.repeat(2000), '1'.repeat(2000),
        'a'.repeat(1990) + '@b', 'a.b.'.repeat(500), 'x1.y2-'.repeat(330), '+'.repeat(2000), 'www.'.repeat(500), 'a.com'.repeat(400),
        '{W}'.repeat(600), '0788 '.repeat(400), 'é'.repeat(2000), '😀'.repeat(1000),
    ];
    const started = Date.now();
    for (const input of inputs) {
        const out = anonymize(input, SEED_VOCAB);
        assertSkeletonInvariant(out.skeleton, SEED_VOCAB, 'adversarial');
    }
    assert.ok(Date.now() - started < 2000, 'adversarial inputs took too long');
});

test('sanitizeSkeleton: guards', () => {
    const vocab = new Set(['fee', 'rwf', 'to', 'sent', 'money']);
    const cases = [
        [undefined, 'not_string'],
        [null, 'not_string'],
        [42, 'not_string'],
        ['', 'empty'],
        ['   ', 'empty'],
        ['Fee 100', 'digit'],
        ['Fee {N}5', 'digit'],
        ['Fee ٣', 'bad_char'],
        ['Fee １', 'bad_char'],
        ['Fee\n{N}', 'bad_char'],
        ['Fee\t{N}', 'bad_char'],
        ['Fee $ {N}', 'bad_char'],
        ['Fee < {N}', 'bad_char'],
        ['Fee ~ {N}', 'bad_char'],
        ['Fee | {N}', 'bad_char'],
        ['Fee ` {N}', 'bad_char'],
        ['Fee \\ {N}', 'bad_char'],
        ['Fee ^ {N}', 'bad_char'],
        ['José', 'bad_char'],
        ['Fee 😀', 'bad_char'],
        ['Fee {X}', 'bad_placeholder'],
        ['Fee {n}', 'bad_placeholder'],
        ['Fee {N', 'bad_placeholder'],
        ['Fee N}', 'bad_placeholder'],
        ['Fee {{N}}', 'bad_placeholder'],
        ['Fee { N }', 'bad_placeholder'],
        ['Fee {W++}', 'bad_placeholder'],
        ['Fee {PH }', 'bad_placeholder'],
        ['x'.repeat(MAX_SKELETON_LENGTH + 1), 'too_long'],
    ];
    for (const [input, reason] of cases) {
        const r = sanitizeSkeleton(input, vocab);
        assert.equal(r.ok, false, 'expected rejection for ' + JSON.stringify(input));
        assert.equal(r.reason, reason, 'wrong reason for ' + JSON.stringify(input));
    }
});

test('sanitizeSkeleton: rewrites out-of-vocabulary words and canonicalises', () => {
    const vocab = new Set(['fee', 'rwf', 'to', 'sent', 'money']);
    const run = (input, expected, extra) => {
        const r = sanitizeSkeleton(input, vocab);
        assert.equal(r.ok, true, JSON.stringify(input) + ' -> ' + JSON.stringify(r));
        assert.equal(r.skeleton, expected);
        if (extra) assert.deepEqual({slotCount: r.slotCount, placeholderCount: r.placeholderCount}, extra);
        const again = sanitizeSkeleton(r.skeleton, vocab);
        assert.deepEqual(again, r, 'not idempotent for ' + JSON.stringify(input));
    };
    run('Money sent to Alice {PH}', 'Money sent to {W} {PH}', {slotCount: 2, placeholderCount: 2});
    run('Money sent to Alice Fakename {PH}', 'Money sent to {W+} {PH}', {slotCount: 2, placeholderCount: 2});
    run('Money sent to {W} {W} {PH}', 'Money sent to {W+} {PH}');
    run('Money sent to {W} {W+} {W} {PH}', 'Money sent to {W+} {PH}');
    run('Money sent to {W+} {PH}', 'Money sent to {W+} {PH}');
    run('Money sent to {W} {PH}', 'Money sent to {W} {PH}');
    run('Money sent to Alice,Bob', 'Money sent to {W},{W}');
    run('Money sent to Alice-{W}', 'Money sent to {W}-{W}');
    run('MONEY SENT TO ALICE', 'MONEY SENT TO {W}');
    run('Money   sent  to   {W}', 'Money sent to {W}');
    run('  Money sent to {W}  ', 'Money sent to {W}');
    run("Money sent to y'igikorwa", 'Money sent to {W}');
    run('Fee {TS}{URL}{EMAIL}{TID}', 'Fee {TS}{URL}{EMAIL}{TID}', {slotCount: 0, placeholderCount: 4});
    run('{W}{W}', '{W}{W}');
    run('abc{W}', '{W}{W}');
    run('Fee [{N}] "{W}" (x) a=b;c:d/e #f @g &h *i _j !k ?l %m', 'Fee [{N}] "{W}" ({W}) {W}={W};{W}:{W}/{W} #{W} @{W} &{W} *{W} _{W} !{W} ?{W} %{W}');
    run('Rwf{N}', 'Rwf{N}');
    run('Abc{N}', '{W}{N}');
    run('+{N}', '+{N}');
});

test('sanitizeSkeleton: rewriting can only be rejected for length, never silently exceed it', () => {
    const vocab = new Set(['fee']);
    const grows = Array.from({length: 120}, () => 'x').join('-');
    assert.ok(grows.length <= MAX_SKELETON_LENGTH);
    const r = sanitizeSkeleton(grows, vocab);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'too_long');
});

test('sanitizeSkeleton accepts an array vocabulary', () => {
    assert.equal(sanitizeSkeleton('Fee {N}', ['fee']).skeleton, 'Fee {N}');
    assert.equal(sanitizeSkeleton('Fee {N}', []).skeleton, '{W} {N}');
});

test('property: fake names, phones, amounts and ids never survive anonymization', () => {
    const r = makeRng(20260421);
    const forbidden = new Set();
    for (let i = 0; i < 4000; i++) {
        const name = randomName(r);
        const phone = randomPhone(r);
        const values = {
            name,
            phone,
            amt: randomAmount(r),
            bal: randomAmount(r),
            tid: randomTid(r),
            ts: randomTimestamp(r),
        };
        const body = r.pick(TEMPLATES)(values);

        const tokens = nameTokens(name).filter(tok => !SEED_VOCAB.has(tok.toLowerCase()));
        const {skeleton, slots} = anonymize(body, SEED_VOCAB);
        assertSkeletonInvariant(skeleton, SEED_VOCAB, body);

        const skeletonWords = (skeleton.replace(PLACEHOLDER_RE, ' ').match(/[A-Za-z][A-Za-z']*/g) || []).map(w => w.toLowerCase());
        for (const tok of tokens) {
            forbidden.add(tok);
            assert.ok(!skeletonWords.includes(tok.toLowerCase()), 'name token survived: ' + tok + ' in ' + skeleton);
        }
        for (const run of [...digitRuns(phone), ...digitRuns(values.tid), ...digitRuns(values.ts)]) {
            if (run.length >= 3) assert.ok(!skeleton.includes(run), 'digits survived: ' + run + ' in ' + skeleton);
        }
        assert.ok(!skeleton.includes(phone), 'phone survived');

        const s = sanitizeSkeleton(skeleton, SEED_VOCAB);
        if (skeleton.length <= MAX_SKELETON_LENGTH) {
            assert.equal(s.ok, true, JSON.stringify(s) + ' for ' + skeleton);
            assert.equal(s.skeleton, skeleton);
            assert.equal(sanitizeSkeleton(s.skeleton, SEED_VOCAB).skeleton, s.skeleton);
        }
        for (const slot of slots) {
            assert.ok(slot.start >= 0 && slot.end > slot.start && slot.end <= body.length);
        }
    }
    assert.ok(forbidden.size > 1000, 'generator produced too few distinct names');
});

test('property: arbitrary garbage always yields a valid, idempotent skeleton', () => {
    const r = makeRng(7);
    const alphabet = [
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
        ...'0123456789',
        ...' \t\n\r  ',
        ...".,:;()-'/!?%@#&*_=[]\"+{}<>|\\^`~$",
        'é', 'Ü', 'ñ', '​', '﻿', '–', '’', '😀', '٣', '１', '\u0000', '\u007F',
    ];
    const extraWords = ['RWF', 'Fee', 'Balance', 'Kohereza', 'TID', 'http://', 'www.', '.com', '@', 'PP260411.1430.A1', '2026-01-01 10:00:00', '+250', '{N}', '{W+}'];
    for (let i = 0; i < 3000; i++) {
        let body = '';
        const len = r.int(0, 600);
        while (body.length < len) body += r.int(0, 11) === 0 ? r.pick(extraWords) : r.pick(alphabet);
        const a = anonymize(body, SEED_VOCAB);
        const b = anonymize(body, SEED_VOCAB);
        assert.deepEqual(a, b, 'anonymize must be deterministic');
        assertSkeletonInvariant(a.skeleton, SEED_VOCAB, JSON.stringify(body));
        if (a.skeleton.length > 0 && a.skeleton.length <= MAX_SKELETON_LENGTH) {
            const s = sanitizeSkeleton(a.skeleton, SEED_VOCAB);
            assert.equal(s.ok, true, JSON.stringify(s) + ' for ' + a.skeleton);
            assert.equal(s.skeleton, a.skeleton);
        }
    }
});

test('property: sanitizeSkeleton output is always valid and idempotent for arbitrary skeleton-ish input', () => {
    const r = makeRng(99);
    const pieces = ['{N}', '{PH}', '{TS}', '{TID}', '{URL}', '{EMAIL}', '{W}', '{W+}', ' ', ' ', ' ', 'Fee', 'RWF', 'to', 'Alice', 'Bob', "O'Brien", 'x', 'MTN', '-', '.', ',', ':', '*', '#', '(', ')', "'", '"', '_', '+'];
    const vocab = new Set(['fee', 'rwf', 'to', 'mtn']);
    for (let i = 0; i < 5000; i++) {
        let s = '';
        const n = r.int(1, 40);
        for (let k = 0; k < n; k++) s += r.pick(pieces);
        const out = sanitizeSkeleton(s, vocab);
        if (!out.ok) continue;
        assertSkeletonInvariant(out.skeleton, vocab, s);
        const twice = sanitizeSkeleton(out.skeleton, vocab);
        assert.equal(twice.ok, true);
        assert.equal(twice.skeleton, out.skeleton);
        assert.equal(twice.slotCount, out.slotCount);
    }
});

test('seed vocabulary supports every vector with the full vocabulary', () => {
    const full = vectors.filter(v => v.name.startsWith('mtn-') || v.name.startsWith('airtel-'));
    assert.ok(full.length >= 20);
    for (const v of full) {
        const out = anonymize(v.input, SEED_VOCAB);
        assertSkeletonInvariant(out.skeleton, SEED_VOCAB, v.name);
    }
});

test('sanitize conformance vectors (guards, rewrites, renumbered hint slots, name-like words)', async t => {
    assert.ok(sanitizeVectors.vectors.length >= 30);
    assert.equal(new Set(sanitizeVectors.vectors.map(v => v.name)).size, sanitizeVectors.vectors.length);
    for (const v of sanitizeVectors.vectors) {
        await t.test(v.name, () => {
            const vocab = new Set(v.vocab);
            const detailed = sanitizeSkeletonDetailed(v.skeleton, vocab);
            if (!v.expected.ok) {
                assert.deepEqual(detailed, {ok: false, reason: v.expected.reason});
                assert.deepEqual(sanitizeSkeleton(v.skeleton, vocab), {ok: false, reason: v.expected.reason});
                return;
            }
            assert.deepEqual(detailed, v.expected);
            const plain = sanitizeSkeleton(v.skeleton, vocab);
            assert.deepEqual(plain, {ok: true, skeleton: v.expected.skeleton, slotCount: v.expected.slotCount, placeholderCount: v.expected.placeholderCount});
            const again = sanitizeSkeleton(plain.skeleton, vocab);
            assert.deepEqual(again, plain, 'sanitize is idempotent');
        });
    }
});

test('the name lists published with the sanitize vectors are the library lists', () => {
    assert.deepEqual(sanitizeVectors.nameStoplist, NAME_STOPLIST);
    assert.deepEqual(sanitizeVectors.nameCueWords, names.NAME_CUE_WORDS);
    assert.equal(sanitizeVectors.nameEdgePunct, names.NAME_EDGE_PUNCT);
    assert.deepEqual(sanitizeVectors.nameGreetingWords, names.NAME_GREETING_WORDS);
    assert.deepEqual(sanitizeVectors.nameCollisionWords, names.NAME_COLLISION_WORDS);
    assert.deepEqual(sanitizeVectors.nameSoleCueWords, names.NAME_SOLE_CUE_WORDS);
    assert.equal(sanitizeVectors.nameSoleTerminators, names.NAME_SOLE_TERMINATORS);
    assert.deepEqual([...NAME_STOPLIST], [...NAME_STOPLIST].sort(), 'sorted, so that ports can diff it');
    assert.equal(new Set(NAME_STOPLIST).size, NAME_STOPLIST.length);
    for (const w of NAME_STOPLIST) assert.match(w, /^[a-z]{2,30}$/);
    for (const w of names.NAME_COLLISION_WORDS) assert.ok(!NAME_STOPSET.has(w), `${w} is a template word and must stay off the stoplist`);
});

test('no vocabulary word that is also a common given name escapes the stoplist (PRIV-1, PRIV2-2)', () => {
    const GIVEN_NAME_PROBE = [
        'april', 'art', 'august', 'bank', 'bill', 'blessing', 'cash', 'charity', 'christian', 'clement', 'dawn', 'destiny', 'diamond', 'eve',
        'faith', 'felix', 'gift', 'glory', 'grace', 'hope', 'innocent', 'ivy', 'jack', 'jade', 'jewel', 'joy', 'june', 'justice',
        'kanda', 'king', 'lily', 'love', 'lucky', 'mark', 'may', 'mercy', 'money', 'neza', 'pack', 'patience', 'peace', 'pearl', 'precious',
        'prince', 'princess', 'queen', 'rich', 'rose', 'ruby', 'sunday', 'sweet', 'trust', 'victor', 'victory', 'will', 'wisdom',
    ];
    const vocab = new Set(SEED_VOCAB);
    for (const w of GIVEN_NAME_PROBE) {
        if (vocab.has(w)) assert.ok(NAME_STOPSET.has(w) || names.isCollisionWord(w), `"${w}" is a given name and a vocabulary word, add it to NAME_STOPLIST (or to the collision words if it is also template text)`);
    }
    for (const w of ['bank', 'pack', 'may']) assert.ok(vocab.has(w) && NAME_STOPSET.has(w), w);
    assert.ok(vocab.has('money') && names.isCollisionWord('money') && !NAME_STOPSET.has('money'), '"Money successfully sent to" opens most Airtel notices, so it is positional, not stoplisted');
    for (const w of NAME_STOPLIST) assert.ok(RESTRICTED_VOCAB_WORDS.has(w));
    assert.ok(isNameLike('Will') && isNameLike('NEZA') && !isNameLike('balance') && !isNameLike(7));
});

test('stoplist words never survive next to an unknown word, in either order (PRIV-1)', () => {
    for (const w of NAME_STOPLIST) {
        const vocab = new Set(['sent', 'to', 'now', 'from', w]);
        for (const [text, label] of [
            [`Sent to ${w} Qwxzy now`, 'name first'],
            [`Sent to Qwxzy ${w} now`, 'surname last'],
            [`Sent to ${w.toUpperCase()} Qwxzy now`, 'uppercase'],
            [`Sent to Qwxzy-${w} now`, 'hyphenated'],
            [`Sent from ${w} ${w} now`, 'two of them'],
        ]) {
            const {skeleton} = anonymize(text, vocab);
            const literal = (skeleton.replace(/\{[^}]+\}/g, ' ').match(/[A-Za-z][A-Za-z']*/g) || []).map(x => x.toLowerCase());
            assert.ok(!literal.includes(w), `"${w}" leaked (${label}): ${skeleton}`);
        }
    }
});

test('stoplist words stay literal between vocabulary words so templates keep working', () => {
    const vocab = new Set(['byagenze', 'neza', 'cash', 'deposit', 'of', 'rwf', 'money', 'sent', 'in', 'now', 'will', 'be', 'unavailable', 'a']);
    assert.equal(anonymize('Byagenze neza', vocab).skeleton, 'Byagenze neza');
    assert.equal(anonymize('A cash deposit of 5 RWF', vocab).skeleton, 'A cash deposit of {N} RWF');
    assert.equal(anonymize('Money sent in cash now', vocab).skeleton, 'Money sent in cash now');
    assert.equal(anonymize('Will be unavailable', vocab).skeleton, 'Will be unavailable', 'will stays when only vocabulary words surround it');
    assert.equal(anonymize('Services will be unavailable', vocab).skeleton, '{W+} be unavailable', 'a noun before it makes it part of a name-like run');
});

test('single-letter vocabulary words never leak initials (PRIV-2)', () => {
    const vocab = new Set(['a', 'r', 's', 'f', 'from', 'to', 'received', 'rwf', 'agent', 'tid', 'sent']);
    const cases = [
        ['You received Rwf5000 from R. S. Habimana 0788123456.', ['r', 's']],
        ['You received 5 RWF from A Uwase 0788123456', ['a']],
        ['Sent to S.Habimana now', ['s']],
        ['Sent to J-Mutoni', ['j']],
        ['from F Uwase', ['f']],
    ];
    for (const [text, letters] of cases) {
        const {skeleton} = anonymize(text, vocab);
        const literal = (skeleton.replace(/\{[^}]+\}/g, ' ').match(/[A-Za-z][A-Za-z']*/g) || []).map(x => x.toLowerCase());
        for (const letter of letters) assert.ok(!literal.includes(letter), `initial "${letter}" leaked: ${skeleton}`);
    }
    assert.equal(anonymize('*165*TID PP260411.1430.A1*S* Sent 5', vocab).skeleton, '*{N}*TID {TID}*S* Sent {N}');
    assert.equal(anonymize('*165*TID PP260411.1430.A1*F* Sent 5', vocab).skeleton, '*{N}*TID {TID}*F* Sent {N}');
    assert.equal(anonymize('A transaction of 5 RWF', new Set(['a', 'transaction', 'of', 'rwf'])).skeleton, 'A transaction of {N} RWF');
});

test('sanitizeSkeleton applies the same name-like rule to what a device sends', () => {
    const vocab = new Set(['money', 'sent', 'to', 'will', 'amt', 'from', 'r', 's']);
    assert.equal(sanitizeSkeleton('Money sent to Will {W+} Amt {N}', vocab).skeleton, 'Money sent to {W+} Amt {N}');
    assert.equal(sanitizeSkeleton('Money sent to {W+} Will Amt {N}', vocab).skeleton, 'Money sent to {W+} Amt {N}');
    assert.equal(sanitizeSkeleton('from R. S. {W} {PH}', vocab).skeleton, 'from {W}. {W}. {W} {PH}');
    assert.equal(sanitizeSkeleton('Money sent to will Amt {N}', vocab).skeleton, 'Money sent to {W} Amt {N}', 'after a cue word a stoplist word is a name');
    assert.equal(sanitizeSkeleton('Money sent will Amt {N}', vocab).skeleton, 'Money sent will Amt {N}');
});

test('canonicalSkeleton folds literal case and leaves placeholders alone (R1-05)', () => {
    assert.equal(canonicalSkeleton('RECEIVED Balance MONEY {N} RWF {W+} {TID} {URL}'), 'received balance money {N} rwf {W+} {TID} {URL}');
    assert.equal(canonicalSkeleton("It's {PH}"), "it's {PH}");
    assert.equal(canonicalSkeleton(''), '');
    assert.equal(shapeId(canonicalSkeleton('Fee {N}')), shapeId(canonicalSkeleton('FEE {N}')));
});

test('sanitizeSkeletonDetailed reports where every device slot went (HINT-1)', () => {
    const vocab = new Set(['paid', 'rwf', 'at', 'fee', 'balance']);
    const r = sanitizeSkeletonDetailed('Paid {N} RWF at shop {N} fee {N} RWF balance {N} RWF', vocab);
    assert.equal(r.skeleton, 'Paid {N} RWF at {W} {N} fee {N} RWF balance {N} RWF');
    assert.deepEqual(r.slotMap, [1, 3, 4, 5], 'the rewritten word shifts every later slot by one');
    const merged = sanitizeSkeletonDetailed('Paid {W} {W} {N}', vocab);
    assert.deepEqual(merged.slotMap, [null, null, 2], 'slots merged into a run have no counterpart');
    const clean = sanitizeSkeletonDetailed('Paid {N} RWF at {W+} fee {N}', vocab);
    assert.deepEqual(clean.slotMap, [1, 2, 3], 'a skeleton that is already canonical keeps its numbering');
});

const literalWordsIn = skeleton =>
    (skeleton.replace(PLACEHOLDER_RE, ' ').match(/[A-Za-z][A-Za-z']*/g) || []).map(w => w.toLowerCase());

const NAME_SLOTS = [
    ['mtn transfer, sole name', n => `5000 RWF transferred to ${n}(0788123456) at 2026-01-01 10:00:00.Fee was: 20 RWF. New balance: 50000 RWF`],
    ['mtn transfer, first name', n => `5000 RWF transferred to ${n} Uwase(0788123456) at 2026-01-01 10:00:00.Fee was: 20 RWF. New balance: 50000 RWF`],
    ['mtn transfer, last name', n => `5000 RWF transferred to Uwase ${n}(0788123456) at 2026-01-01 10:00:00.Fee was: 20 RWF. New balance: 50000 RWF`],
    ['mtn receive', n => `You have received 5000 RWF from ${n} (250788123456) on your mobile money account at 2026-01-01 10:00:00 Your new balance:50000 RWF`],
    ['airtel english receive', n => `*165*Txn ID RC242927.5971.H75073*R* You received Rwf27 from ${n} 0788123456.Your NEW BALANCE is Rwf 232620. *EN#`],
    ['airtel kinyarwanda with phone', n => `Mwakiriye RWF 5000 avuye kuri ${n} 250788123456. Ubu mufite RWF 1000`],
    ['airtel kinyarwanda without phone', n => `Mwakiriye RWF 5000 avuye kuri ${n}. Ubu mufite RWF 1000`],
    ['greeting', n => `Dear ${n}, you have received 5000 RWF. Balance: 1000 RWF`],
    ['via agent', n => `You have via agent: ${n}(0788123456) withdrawn 5000 RWF from at 2026-01-01 10:00:00 Your new balance: 1000 RWF Fee paid: 100 RWF`],
];

test('vocabulary words that are also names never survive in the name slots of real templates (R2-ATK-2, PRIV2-2)', () => {
    const vocab = new Set([...SEED_VOCAB, 'may', 'money', 'bank', 'pack']);
    const words = ['May', 'Money', 'Bank', 'Pack', 'Cash', 'Neza', 'Kanda', 'Will', 'Grace', 'Momo', 'Merchant', 'Test', 'F', 'R', 'S'];
    for (const [slot, make] of NAME_SLOTS) {
        const canary = literalWordsIn(anonymize(make('Qzxvk'), vocab).skeleton);
        for (const w of words) {
            for (const written of [w, w.toUpperCase()]) {
                const {skeleton} = anonymize(make(written), vocab);
                const kept = literalWordsIn(skeleton);
                const leaked = kept.includes(w.toLowerCase()) && !canary.includes(w.toLowerCase());
                assert.ok(!leaked, `"${written}" leaked in the "${slot}" template: ${skeleton}`);
                const sanitized = sanitizeSkeleton(skeleton, vocab);
                assert.equal(sanitized.ok, true);
                assert.equal(sanitized.skeleton, skeleton, 'the server rewrite is a no-op on what the device already hid');
            }
        }
    }
});

test('the server rewrite hides the vocabulary names a device without the rules would still send (R2-ATK-2, PRIV2-1, PRIV2-2)', () => {
    const vocab = new Set([...SEED_VOCAB]);
    const send = (skeleton, hidden) => {
        const r = sanitizeSkeleton(skeleton, vocab);
        assert.equal(r.ok, true, skeleton);
        assert.ok(!literalWordsIn(r.skeleton).includes(hidden), `"${hidden}" survived in: ${r.skeleton}`);
        assert.equal(sanitizeSkeleton(r.skeleton, vocab).skeleton, r.skeleton, 'idempotent');
        return r.skeleton;
    };
    assert.equal(send('You have transferred {N} RWF to May {W} ({PH}). Balance {N} RWF', 'may'), 'You have transferred {N} RWF to {W+} ({PH}). Balance {N} RWF');
    assert.equal(send('you have sent {N} RWF to neza ({PH}) balance {N} RWF', 'neza'), 'you have sent {N} RWF to {W} ({PH}) balance {N} RWF');
    assert.equal(send('Your transfer of {N} RWF to Neza ({PH}) was completed at {TS}. Fee was: {N} RWF. New balance: {N} RWF. TxId: {PH}', 'neza'), 'Your transfer of {N} RWF to {W} ({PH}) was completed at {TS}. Fee was: {N} RWF. New balance: {N} RWF. TxId: {PH}');
    assert.equal(send('Your transfer of {N} RWF to Money ({PH}) was completed at {TS}', 'money'), 'Your transfer of {N} RWF to {W} ({PH}) was completed at {TS}');
    assert.equal(send('Your transfer of {N} RWF to momo ({PH}) was completed', 'momo'), 'Your transfer of {N} RWF to {W} ({PH}) was completed');
    send('Your transfer of {N} RWF to bank ({PH}) was completed', 'bank');
    send('Mwakiriye RWF {N} avuye kuri Kanda {PH}. Ubu mufite RWF {N}', 'kanda');
    send('you have sent {N} RWF to neza, balance {N} RWF', 'neza');
    send('Dear May, you have received {N} RWF.', 'may');
    send('Uwase May {W}', 'may');
    send('transferred to S ({PH}) now', 's');
    send('received from R {PH} now', 'r');
    send('Dear F. R., you have received {N} RWF', 'f');
});

test('template words that collide with names stay literal where they are template text (PRIV2-2)', () => {
    const vocab = new Set(SEED_VOCAB);
    assert.match(anonymize('You have via agent: Uwase(0788123456) withdrawn 5 RWF', vocab).skeleton, /^You have via agent: \{W\}\(\{PH\}\) withdrawn/);
    assert.match(anonymize('You have withdrawn 5 RWF at agent Uwase Habimana (0788123456) now', vocab).skeleton, /at agent \{W\+\} \(\{PH\}\)/, '"agent" is template text before a name and a phone');
    assert.equal(anonymize('Mwakiriye RWF 5 kuri MoMo advance yanyu', new Set([...SEED_VOCAB, 'advance'])).skeleton, 'Mwakiriye RWF {N} kuri MoMo advance yanyu');
    assert.match(anonymize('Your payment of 5 RWF to Fake Merchant Ltd', vocab).skeleton, /to \{W\} Merchant \{W\}$/);
    assert.match(anonymize('*165*TID PP260411.1430.A1*R* You received Rwf5 from Uwase 0788123456', vocab).skeleton, /\*R\*/);
    assert.match(anonymize('*165*TID PP260411.1430.A1*S* Money sent to Uwase 0788123456', vocab).skeleton, /\*S\* Money sent to/);
});

test('documented residual: a vocabulary name that sits next to template words ("to Merchant has been completed") is not hidden', {todo: 'positional rules cannot tell a one-word name from template text without a following placeholder or punctuation; the gate refuses to approve such a literal as regex text (name-slot check)'}, () => {
    const vocab = new Set(SEED_VOCAB);
    for (const w of ['Merchant', 'Momo', 'Test', 'Can']) {
        const {skeleton} = anonymize(`Your payment of 5 RWF to ${w} has been completed`, vocab);
        assert.ok(!literalWordsIn(skeleton).includes(w.toLowerCase()), `${w} survived: ${skeleton}`);
    }
});

test('documented residual (PRIV-05): a single-word given name that is also a vocabulary word survives where no cue word or delimiter sits next to it', {todo: 'six vocabulary words are also given names (bank, cash, kanda, may, neza, pack); a lone one at the start of a message, after "you" or beside a full stop has no context that tells it from template text. Accepted: the server stores only skeletons whose literal words are vocabulary, so the exposure is one common word, and the cue, delimiter and neighbour rules hide it everywhere else'}, () => {
    const vocab = new Set([...SEED_VOCAB, 'using', 'service']);
    for (const w of ['Bank', 'Cash', 'Kanda', 'May', 'Neza', 'Pack']) {
        for (const message of [`Thank you ${w} for using the service`, `${w} sent you 5000 RWF.`]) {
            const {skeleton} = anonymize(message, vocab);
            assert.ok(!literalWordsIn(skeleton).includes(w.toLowerCase()), `${w} survived: ${skeleton}`);
        }
    }
});

function loadAppPort() {
    const appRepo = process.env.MANIE_APP_REPO || '/Users/ivainqueur/Documents/Code/React/mobile/Manie';
    const source = path.join(appRepo, 'src/lib/utils/anonymize.ts');
    const tsModule = path.join(appRepo, 'node_modules/typescript');
    if (!fs.existsSync(source) || !fs.existsSync(tsModule)) return null;
    const ts = require(tsModule);
    const out = ts.transpileModule(fs.readFileSync(source, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019}}).outputText;
    const mod = {exports: {}};
    new Function('module', 'exports', out)(mod, mod.exports);
    return mod.exports;
}

const APP_PORT = loadAppPort();

// The app port is edited in its own repo, so this comparison with the live source is opt-in:
// MANIE_CHECK_APP_PORT=1 node --test test/manie/anonymize.test.js
const CHECK_APP_PORT = process.env.MANIE_CHECK_APP_PORT === '1';

test('the reference never keeps a literal word that the app port hides, on vectors and random input (PRIV2-1)', {skip: !CHECK_APP_PORT ? 'set MANIE_CHECK_APP_PORT=1 to compare with the live app port' : APP_PORT ? false : 'app repo (anonymize.ts + typescript) not available'}, () => {
    const vocabs = [SEED_VOCAB, new Set([...SEED_VOCAB, 'may', 'money', 'bank', 'pack'])];
    const check = (body, vocab, label) => {
        const port = APP_PORT.anonymize(body, vocab).skeleton;
        const ours = anonymize(body, vocab).skeleton;
        const kept = new Map();
        for (const w of literalWordsIn(ours)) kept.set(w, (kept.get(w) || 0) + 1);
        const hidden = new Map();
        for (const w of literalWordsIn(port)) hidden.set(w, (hidden.get(w) || 0) + 1);
        for (const [w, n] of kept) assert.ok(n <= (hidden.get(w) || 0), `reference keeps "${w}" that the port hides (${label}): ${JSON.stringify(body)}\n  port ${port}\n  ours ${ours}`);
    };
    for (const v of vectors) check(v.input, new Set(v.vocab), v.name);
    const r = makeRng(31337);
    for (let i = 0; i < 2500; i++) {
        const body = r.pick(TEMPLATES)({name: randomName(r), phone: randomPhone(r), amt: randomAmount(r), bal: randomAmount(r), tid: randomTid(r), ts: randomTimestamp(r)});
        for (const vocab of vocabs) check(body, vocab, 'template');
    }
    const extra = ['to', 'from', 'kuri', 'Dear', 'Cash', 'Neza', 'Will', 'May', 'Kanda', 'a', 'R', 'S', 'via', 'by', 'agent', 'Money', 'Momo', 'Qwxzy', 'Uwase', '0788123456', '(', ')', ',', '.', '&'];
    for (let i = 0; i < 2500; i++) {
        let body = '';
        const n = r.int(1, 14);
        for (let k = 0; k < n; k++) body += r.pick(extra) + (r.int(0, 3) === 0 ? '' : ' ');
        check(body.trim() || 'x', vocabs[1], 'random');
    }
});

test('every cue word and every edge character is pinned by a vector that fails without it (VEC-2)', () => {
    const run = v => anonymize(v.input, new Set(v.vocab)).skeleton;
    const find = name => {
        const v = vectors.find(x => x.name === name);
        assert.ok(v, `missing vector ${name}`);
        assert.equal(run(v), v.expected, name);
        return v;
    };
    const without = (sets, value, fn) => {
        const had = sets.map(set => set.has(value));
        sets.forEach(set => set.delete(value));
        try {
            return fn();
        } finally {
            sets.forEach((set, i) => had[i] && set.add(value));
        }
    };
    for (const cue of names.NAME_CUE_WORDS) {
        const v = find(`name-cue-${cue}-absorbs-a-stoplist-word`);
        const sets = cue === 'dear' ? [names.NAME_CUE_SET, names.NAME_GREETING_SET] : [names.NAME_CUE_SET];
        assert.notEqual(without(sets, cue, () => run(v)), v.expected, `cue word "${cue}" is not pinned by its vector`);
    }
    for (const greeting of names.NAME_GREETING_WORDS.filter(w => !names.NAME_CUE_SET.has(w))) {
        const v = find(`name-greeting-${greeting}-absorbs-a-stoplist-word`);
        assert.notEqual(without([names.NAME_GREETING_SET], greeting, () => run(v)), v.expected, `greeting "${greeting}"`);
    }
    for (const ch of names.NAME_EDGE_PUNCT) {
        const pinned = vectors.filter(v => v.name.startsWith('name-edge-') && v.input.includes(ch) && /^Sent [^ ]*cash[^ ]* now$/.test(v.input) && v.input.replace(/cash/, '').includes(ch));
        assert.ok(pinned.length >= (ch === "'" ? 1 : 2), `edge character ${JSON.stringify(ch)} has a vector on each side`);
        for (const v of pinned) {
            assert.equal(run(v), v.expected, v.name);
            assert.notEqual(without([names.NAME_EDGE_SET], ch, () => run(v)), v.expected, `edge character ${JSON.stringify(ch)} is not pinned by ${v.name}`);
        }
    }
    for (const word of names.NAME_COLLISION_WORDS) {
        for (const kind of ['before-a-parenthesised-phone', 'before-a-bare-phone', 'after-a-greeting', 'sole-word-after-a-preposition']) {
            const v = find(`name-collision-${word}-${kind}`);
            assert.notEqual(without([names.NAME_COLLISION_SET], word, () => run(v)), v.expected, `${word} ${kind}`);
        }
    }
});
