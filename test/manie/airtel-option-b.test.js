'use strict';

// AIRTEL TID RULE, option B (owner decision): for an airtel-shortcode draft ONE capture group
// holds the full transaction code (e.g. PP260411.1430.A12345) and is used for BOTH
// captureMap.transactionId and timestamp.group. No nested group.
//
// Why it is safe: the full code is read correctly by every Android build from 0.0.32 on (the
// parseAirtelTimestamp that drops two characters and reads fixed offsets arrived with the commit of
// 2026-02-19), by the current build (parseAirtelShortcode accepts the code with or without its
// prefix) and by the current iOS parser; iOS builds from before the tolerant parseAirtelShort fall
// back to the time the message was processed. It is NOT safe on Android builds older than that:
// they read the two letters as part of the date, the timestamp is NaN, the row is dated 1970 and
// the same message is stored again on every rescan. The owner accepted that cohort (round3.test.js,
// F2, pins it and the gate warns about it). These tests run the real released and current client
// sources, port the Swift parser, and hold the gate to "a finite, correct date under every reader".
//
// Synthetic data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {draftFromShape} = require('../../lib/manie/draft');
const {TID_REGEX} = require('../../lib/manie/_fields');
const {
    runGate,
    testPattern,
    parseAirtelShipped,
    parseAirtelTolerant,
    airtelReferenceDate,
    airtelTimestampProblem,
    MALFORMED_AIRTEL_CODES,
} = require('../../lib/manie/gate');
const H = require('./_clientHarness');

globalThis.__DEV__ = false;

const base = require('../../assets/manie/sms-formats.json');
const EXISTING = base.patterns;
const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0).getTime();

const skipClient = H.unavailableReason() || false;
const RELEASED_REF = process.env.MANIE_RELEASED_REF || 'feat/sms-pattern-tool';
const RELEASED = skipClient ? null : H.extractReleasedClient(RELEASED_REF);
const skipReleased = skipClient || (RELEASED ? false : `the released client sources (git show ${RELEASED_REF}:src/lib/utils/classify.ts) are not available`);

const SHAPES = [
    {name: 'en transfer', skeleton: '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#', type: 'transfer'},
    {name: 'en receive', skeleton: '*{N}*Txn ID {TID}*R* Received Rwf {N} from {W+} {PH}. NEW BALANCE Rwf {N}. *EN#', type: 'receive'},
    {name: 'en payment, TID in brackets', skeleton: '*{N}*TXN ID ({TID})*S*Paid RWF {N} to {W+} OK. NEW BALANCE RWF {N}. *EN#', type: 'payment'},
    {name: 'en airtime, TID after a colon', skeleton: '*{N}*TID:{TID}*S* Airtime of Rwf {N} done to {PH}. Balance: Rwf {N} *EN#', type: 'payment'},
    {name: 'kinyarwanda transfer', skeleton: '*{N}*TID {TID}*S* Kohereza Rwf {N} kuri {W+} {PH} neza. Fee Rwf{N}. Ubu mufite Rwf {N}. *KR#', type: 'transfer'},
    {name: 'kinyarwanda receive', skeleton: '*{N}*TXN ID {TID}*S* Mwakiriye RWF {N} avuye kuri {W+} {PH}. Asigaye ni RWF {N}. *KR#', type: 'receive'},
    {name: 'kinyarwanda bundle', skeleton: '*{N}* TXN ID {TID}*S*Ubu mufite Rwf {N}. Kugura Inite ya Rwf {N} byagenze neza. *KR#', type: 'payment'},
    {name: 'withdrawal', skeleton: '*{N}*TID {TID}*S* Cash withdrawn Rwf {N} at agent {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#', type: 'withdraw'},
];

const draftOf = (shape, overrides, opts) =>
    draftFromShape({skeleton: shape.skeleton, carrier: 'airtel', count: 3}, {type: shape.type, ...overrides}, {existingPatterns: EXISTING, ...opts});

const EN_TRANSFER = SHAPES[0];

// Values deliberately different from the generator's own synthetic ones.
const MESSAGE = '*165*TID MP261002.0905.C77*S* Sent Rwf 7250 to Bob Example 0730000002. Fee Rwf 150. BAL Rwf 88000. *EN#';
const EXPECTED = {
    type: 'transfer',
    amount: 7250,
    fee: 150,
    balance: 88000,
    transactionId: 'MP261002.0905.C77',
    secondParty: 'Bob Example',
    accountNumber: '0730000002',
    timestamp: local(2026, 10, 2, 9, 5),
};

function projectDraft(draft) {
    return {
        id: draft.id,
        carrier: draft.carrier,
        locale: draft.locale,
        type: draft.type,
        pattern: draft.pattern,
        flags: draft.flags,
        captureMap: draft.captureMap,
        timestamp: draft.timestamp,
        tags: [...draft.tags, 'option-b-under-test'],
        status: 'active',
    };
}

async function clientWith(drafts, {released}) {
    const config = {version: 'regex-v20261022-optionb', defaultLocale: 'en-RW', fetchedAt: '2026-10-22T08:00:00Z', patterns: drafts.map(projectDraft)};
    const env = H.makeEnv({fetchImpl: async () => H.jsonResponse(config)});
    const client = H.loadClient(env, {root: released ? RELEASED : undefined, dropBuiltins: true});
    const synced = await client.rrc.syncRegexConfig({forceRefresh: true});
    assert.ok(synced && synced.patterns.length === drafts.length, 'the client accepted every pattern');
    return client;
}

// Faithful port of ios/RegexPatternProvider.swift parseAirtelShort as it is in the app checkout
// now: an optional two-letter ASCII prefix is dropped, then fixed offsets are read.
function swiftParseAirtelShortCurrent(value) {
    let code = value;
    if (code.length >= 2 && /^[A-Za-z]{2}/.test(code)) code = code.slice(2);
    if (code.length < 11) return null;
    const toInt = text => (/^[+-]?\d+$/.test(text) ? parseInt(text, 10) : null);
    const parts = [code.slice(0, 2), code.slice(2, 4), code.slice(4, 6), code.slice(7, 9), code.slice(9, 11)].map(toInt);
    if (parts.some(part => part === null)) return null;
    const [yy, mm, dd, hh, mi] = parts;
    return new Date(2000 + yy, mm - 1, dd, hh, mi, 0).getTime();
}

// The same function before the prefix was made optional (app builds already on iPhones).
function swiftParseAirtelShortReleased(value) {
    if (value.length < 11) return null;
    const toInt = text => (/^[+-]?\d+$/.test(text) ? parseInt(text, 10) : null);
    const parts = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6), value.slice(7, 9), value.slice(9, 11)].map(toInt);
    if (parts.some(part => part === null)) return null;
    const [yy, mm, dd, hh, mi] = parts;
    return new Date(2000 + yy, mm - 1, dd, hh, mi, 0).getTime();
}

/* ---------------------------- the draft: one group, two roles ---------------------------- */

test('every Airtel shape drafts ONE full-TID group used by transactionId and timestamp, and clears the gate with no switch', () => {
    for (const shape of SHAPES) {
        const draft = draftOf(shape);
        assert.equal(draft.timestamp.parser, 'airtel-shortcode', shape.name);
        assert.equal(draft.timestamp.group, draft.captureMap.transactionId, `${shape.name}: one group for both`);
        assert.ok(draft.pattern.includes(TID_REGEX), `${shape.name}: the TID is a single capture group`);
        assert.equal(draft.pattern.includes('(\\d+\\.\\d+)'), false, `${shape.name}: no nested group`);
        const groups = new RegExp(`${draft.pattern}|`, 'i').exec('').length - 1;
        assert.ok(draft.timestamp.group >= 1 && draft.timestamp.group <= groups, shape.name);
        assert.equal(draft.gate.ok, true, `${shape.name}: ${JSON.stringify(draft.gate.checks.filter(c => !c.ok))}`);
        const self = draft.gate.checks.find(c => c.name === 'self-match');
        assert.match(self.detail, new RegExp(`${MALFORMED_AIRTEL_CODES.length} malformed Airtel codes rejected`), shape.name);
    }
});

test('the options object of the old compat switch is ignored: the gate result does not depend on it', () => {
    const draft = draftOf(EN_TRANSFER);
    for (const clientTimestampCompat of [undefined, 'shipped', 'patched']) {
        const result = runGate(draft, {existingPatterns: EXISTING, clientTimestampCompat});
        assert.equal(result.ok, true, String(clientTimestampCompat));
    }
});

/* ---------------------------- the readers the gate relies on ---------------------------- */

const READER_CORPUS = [
    'PP260411.1430.A12345',
    'MP261002.0905.C77',
    'rc260502.1015.h75073',
    'CI261231.2359.Z9',
    'NP260101.0000.A1',
    '260411.1430',
    '260411.1430.A12345',
    'PP260411.1430',
    'PP261311.1430.A1',
    'PP260011.1430.A1',
    'PP260400.1430.A1',
    'PP260432.1430.A1',
    'PP260431.1430.A1',
    'PP260229.1200.A1',
    'PP240229.1200.A1',
    'PP260411.2430.A1',
    'PP260411.1460.A1',
    'PP2604111.1430.A1',
    'PP26041.1430.A1',
    'PP260411.143.A1',
    'garbage',
    'PP',
    '',
    '12345678901',
];

const sameNumber = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

test('the gate reader of the SHIPPED parser is the real released parseAirtelTimestamp, input for input', {skip: skipReleased}, () => {
    const old = H.loadClient(H.makeEnv(), {root: RELEASED});
    for (const text of READER_CORPUS) {
        assert.ok(sameNumber(parseAirtelShipped(text), old.classify.__parseAirtelTimestamp(text)), `${JSON.stringify(text)}`);
    }
});

test('the gate reader of the CURRENT parser is the real parseAirtelShortcode, input for input', {skip: skipClient}, () => {
    const current = H.loadClient(H.makeEnv());
    assert.equal(typeof current.classify.parseAirtelShortcode, 'function');
    for (const text of READER_CORPUS) {
        assert.ok(sameNumber(parseAirtelTolerant(text), current.classify.parseAirtelShortcode(text)), `${JSON.stringify(text)}`);
    }
});

test('a timestamp passes the gate only if the reference reading, the shipped parser and the current parser agree on a finite time', () => {
    for (const good of ['PP260411.1430.A12345', 'MP261002.0905.C77', 'CI261231.2359.Z9', 'NP260101.0000.A1']) {
        assert.equal(airtelTimestampProblem(good), null, good);
        const t = airtelReferenceDate(good);
        assert.ok(Number.isFinite(t));
        assert.equal(parseAirtelShipped(good), t);
        assert.equal(parseAirtelTolerant(good), t);
    }
    assert.equal(airtelReferenceDate('PP260411.1430.A12345'), local(2026, 4, 11, 14, 30));
    assert.match(airtelTimestampProblem('260411.1430'), /no two-letter prefix/, 'the bare form works on the current app only');
    for (const bad of MALFORMED_AIRTEL_CODES.concat(['PP260431.1430.A1', 'PP260229.1200.A1', 'garbage', ''])) {
        assert.notEqual(airtelTimestampProblem(bad), null, `${bad} must not pass`);
    }
});

test('released builds roll an impossible date over instead of refusing it, which is why the gate does not rely on them to notice', () => {
    for (const bad of ['PP261301.1430.A1', 'PP260432.1430.A1', 'PP260411.2430.A1']) {
        assert.ok(Number.isFinite(parseAirtelShipped(bad)), `${bad}: finite but wrong on a released build`);
        assert.ok(Number.isNaN(parseAirtelTolerant(bad)), `${bad}: refused by the current build`);
        assert.ok(Number.isNaN(airtelReferenceDate(bad)));
    }
});

/* ---------------------------- the gate holds the line ---------------------------- */

const clone = (draft, patch = {}) => {
    const copy = JSON.parse(JSON.stringify(draft));
    delete copy.gate;
    return {...copy, ...patch};
};
const check = (result, name) => result.checks.find(c => c.name === name);

test('gate: a pattern that captures the TID without its prefix on the timestamp group is refused (released builds read it as an invalid date)', () => {
    const draft = draftOf(EN_TRANSFER);
    const bare = draft.pattern.replace(TID_REGEX, '[A-Za-z]{2}(\\d{6}\\.\\d{4})\\.[A-Za-z]\\d+');
    assert.notEqual(bare, draft.pattern);
    const result = runGate(clone(draft, {pattern: bare}), {existingPatterns: EXISTING});
    assert.equal(result.ok, false);
    assert.equal(check(result, 'self-match').ok, false);
    assert.match(check(result, 'self-match').detail, /no two-letter prefix/);
});

test('gate: the old nested-group shape (timestamp on the inner group) is refused', () => {
    const draft = draftOf(EN_TRANSFER);
    const nested = draft.pattern.replace(TID_REGEX, '([A-Za-z]{2}(\\d+\\.\\d+)\\.[A-Za-z]\\d+)');
    const tid = draft.captureMap.transactionId;
    const captureMap = Object.fromEntries(Object.entries(draft.captureMap).map(([k, v]) => [k, v > tid ? v + 1 : v]));
    const result = runGate(clone(draft, {pattern: nested, captureMap, timestamp: {group: tid + 1, parser: 'airtel-shortcode'}}), {existingPatterns: EXISTING});
    assert.equal(result.ok, false);
    assert.match(check(result, 'self-match').detail, /no two-letter prefix/);
});

test('gate: a TID regex that lets malformed codes through is refused, naming the code', () => {
    const draft = draftOf(EN_TRANSFER);
    const loose = draft.pattern.replace(TID_REGEX, '([A-Za-z]{2}\\d+\\.\\d+\\.[A-Za-z]\\d+)');
    const result = runGate(clone(draft, {pattern: loose}), {existingPatterns: EXISTING});
    assert.equal(result.ok, false);
    const self = check(result, 'self-match');
    assert.equal(self.ok, false);
    assert.match(self.detail, /accepts the malformed Airtel code "PP2613|accepts the malformed Airtel code "PP2600|accepts the malformed Airtel code "PP2604/);

    const widthOnly = draft.pattern.replace(TID_REGEX, '([A-Za-z]{2}\\d{6}\\.\\d{4}\\.[A-Za-z]\\d+)');
    const second = runGate(clone(draft, {pattern: widthOnly}), {existingPatterns: EXISTING});
    assert.equal(check(second, 'self-match').ok, false, 'fixed widths alone still let month 13 through');
    assert.match(check(second, 'self-match').detail, /malformed Airtel code "PP261301\.1430\.A12345"/);
});

test('gate: only the transaction id may share a group with an airtel-shortcode timestamp', () => {
    const draft = draftOf(EN_TRANSFER);
    const tid = draft.captureMap.transactionId;
    assert.equal(check(draft.gate, 'capture-map').ok, true);

    const feeOnTid = draftOf(EN_TRANSFER, {captureMap: {fee: tid}});
    const feeCheck = check(feeOnTid.gate, 'capture-map');
    assert.equal(feeCheck.ok, false);
    assert.match(feeCheck.detail, /group \d+ used by both fee and timestamp/);

    const isoOnTid = draftOf(EN_TRANSFER, {timestamp: {group: tid, parser: 'iso8601'}});
    assert.equal(check(isoOnTid.gate, 'capture-map').ok, false, 'an ISO timestamp cannot read a transaction code');

    const stale = clone(draft, {captureMap: {...draft.captureMap, amount: tid}});
    assert.equal(check(runGate(stale, {existingPatterns: EXISTING}), 'capture-map').ok, false, 'amount on the same group as the timestamp');

    const bothMapped = clone(draft, {captureMap: {...draft.captureMap, agentName: tid}});
    assert.equal(check(runGate(bothMapped, {existingPatterns: EXISTING}), 'capture-map').ok, false);
});

test('gate: the airtel-shortcode parser on a group that is not a transaction code is refused', () => {
    const draft = draftOf(EN_TRANSFER);
    const onAmount = runGate(clone(draft, {timestamp: {group: draft.captureMap.amount, parser: 'airtel-shortcode'}}), {existingPatterns: EXISTING});
    assert.equal(onAmount.ok, false);
    assert.equal(check(onAmount, 'capture-map').ok, false);

    const dropId = draftOf(EN_TRANSFER, {captureMap: {transactionId: null}});
    assert.equal(dropId.captureMap.transactionId, undefined);
    assert.deepEqual(dropId.timestamp, {group: draft.timestamp.group, parser: 'airtel-shortcode'});
    assert.equal(dropId.gate.ok, true, 'the full code alone still identifies the transaction through its timestamp');
});

test('the iOS timestamp check reports, as a warning and not a failure, that released iOS builds cannot read the prefix', () => {
    const draft = draftOf(EN_TRANSFER);
    const ios = check(draft.gate, 'ios-timestamp');
    assert.equal(ios.ok, true);
    assert.equal(ios.warn, true);
    assert.match(ios.detail, /processed/);
});

test('shadow check still sees Airtel built-ins now that the TID group only accepts real dates', () => {
    const skeleton = '*{N}*TID {TID}*S*Mwakiriye RWF {N} avuye kuri {W+} {PH}.Kuri konti ubu mufite RWF {N}.*KR#';
    const asReceive = draftFromShape({skeleton, carrier: 'airtel'}, undefined, {existingPatterns: EXISTING});
    assert.equal(check(asReceive.gate, 'no-shadow').ok, true);
    const asTransfer = draftFromShape({skeleton, carrier: 'airtel'}, {type: 'transfer'}, {existingPatterns: EXISTING});
    assert.equal(check(asTransfer.gate, 'no-shadow').ok, false);
    assert.match(check(asTransfer.gate, 'no-shadow').detail, /airtel-receive-aa-rw/);
});

/* ---------------------------- both clients and both iOS parsers ---------------------------- */

function assertFields(tx, label) {
    for (const [key, value] of Object.entries(EXPECTED)) assert.equal(tx[key], value, `${label}: ${key}`);
}

test('a drafted Airtel pattern classifies a synthetic message with the right amount, balance, transactionId and timestamp on the RELEASED client', {skip: skipReleased}, async () => {
    const draft = draftOf(EN_TRANSFER);
    const client = await clientWith([draft], {released: true});
    const old = client.classify.__parseAirtelTimestamp;
    assert.ok(Number.isNaN(old('260411.1430')), 'sanity: this really is the old parser (the bare form is invalid on it)');
    const {transactions, unmatched} = client.classify.classifyTransactions([{body: MESSAGE}]);
    assert.equal(unmatched.length, 0);
    assert.equal(transactions.length, 1);
    assertFields(transactions[0], 'released client');
    assert.ok(transactions[0].tags.includes('option-b-under-test'), 'classified by the draft, not a built-in');
    assert.ok(Number.isFinite(transactions[0].timestamp));
});

test('a drafted Airtel pattern classifies the same message identically on the CURRENT client', {skip: skipClient}, async () => {
    const draft = draftOf(EN_TRANSFER);
    const client = await clientWith([draft], {released: false});
    assert.equal(typeof client.classify.parseAirtelShortcode, 'function', 'sanity: this is the current parser');
    const {transactions, unmatched} = client.classify.classifyTransactions([{body: MESSAGE}]);
    assert.equal(unmatched.length, 0);
    assert.equal(transactions.length, 1);
    assertFields(transactions[0], 'current client');
});

test('every Airtel shape gives the same correct fields on the released client, the current client and the gate reader', {skip: skipReleased}, async () => {
    for (const shape of SHAPES) {
        const draft = draftOf(shape);
        const message = testPatternMessage(draft);
        const expected = testPattern(draft, message, {timeoutMs: 3000});
        assert.equal(expected.matched, true, shape.name);
        assert.deepEqual(expected.warnings, [], shape.name);
        for (const released of [true, false]) {
            const client = await clientWith([draft], {released});
            const {transactions} = client.classify.classifyTransactions([{body: message}]);
            assert.equal(transactions.length, 1, `${shape.name} (${released ? 'released' : 'current'})`);
            const [tx] = transactions;
            assert.equal(tx.amount, expected.fields.amount, `${shape.name} amount`);
            assert.equal(tx.balance, expected.fields.balance, `${shape.name} balance`);
            assert.equal(tx.transactionId, expected.fields.transactionId, `${shape.name} transactionId`);
            assert.equal(tx.timestamp, expected.fields.timestampMs, `${shape.name} timestamp (${released ? 'released' : 'current'})`);
            assert.equal(tx.timestamp, local(2026, 4, 11, 14, 30), shape.name);
        }
    }
});

function testPatternMessage(draft) {
    const {synthesize} = require('../../lib/manie/_synth');
    const {layoutOf} = require('../../lib/manie/_fields');
    const layout = layoutOf(draft.sourceShape.skeleton);
    const roleByOrdinal = new Map();
    for (const [role, group] of Object.entries(draft.captureMap)) {
        const slot = layout.slots.find(s => s.group === group);
        if (slot) roleByOrdinal.set(slot.ordinal, role);
    }
    return synthesize(draft.sourceShape.skeleton, {roleByOrdinal}).message;
}

test('iOS rule: the full TID the draft captures parses with the tolerant parseAirtelShort, and released iOS falls back to the processing time', () => {
    const draft = draftOf(EN_TRANSFER);
    const match = new RegExp(draft.pattern, draft.flags).exec(MESSAGE);
    assert.ok(match, 'the native side runs the same regex');
    const raw = match[draft.timestamp.group].trim();
    assert.equal(raw, 'MP261002.0905.C77');
    assert.equal(match[draft.captureMap.transactionId], raw, 'the transaction id is the same group');
    assert.equal(swiftParseAirtelShortCurrent(raw), local(2026, 10, 2, 9, 5), 'current iOS parser');
    assert.equal(H.swiftParseAirtelShortTolerant(raw), swiftParseAirtelShortCurrent(raw), 'agrees with the harness port');
    assert.equal(swiftParseAirtelShortReleased(raw), null, 'released iOS parser cannot read the prefix: nil, so extractTimestamp falls back to now');
    assert.equal(H.swiftParseAirtelShort(raw), swiftParseAirtelShortReleased(raw));
    assert.equal(swiftParseAirtelShortCurrent('260411.1430.A1'), local(2026, 4, 11, 14, 30), 'the bare form still parses on current iOS');
    assert.equal(swiftParseAirtelShortCurrent('PP26041.14'), null);
});

test('iOS rule: every Airtel shape captures a code that the current iOS parser and the JS reference agree on', () => {
    for (const shape of SHAPES) {
        const draft = draftOf(shape);
        const res = testPattern(draft, testPatternMessage(draft), {timeoutMs: 3000});
        const raw = res.captures[draft.timestamp.group].trim();
        assert.equal(swiftParseAirtelShortCurrent(raw), airtelReferenceDate(raw), shape.name);
        assert.equal(swiftParseAirtelShortCurrent(raw), local(2026, 4, 11, 14, 30), shape.name);
    }
});

test('the Swift port above still mirrors RegexPatternProvider.swift (optional two-letter prefix, then fixed offsets)', t => {
    const file = path.join(H.APP_REPO, 'ios/RegexPatternProvider.swift');
    if (!fs.existsSync(file)) return t.skip('ios/RegexPatternProvider.swift not available');
    const source = fs.readFileSync(file, 'utf8');
    const body = source.slice(source.indexOf('func parseAirtelShort'));
    assert.match(body, /code\.prefix\(2\)\.allSatisfy\(\{ \$0\.isASCII && \$0\.isLetter \}\)/, 'optional ASCII-letter prefix');
    assert.match(body, /code\.count >= 11/);
    assert.match(body, /code\.dropFirst\(2\)\.prefix\(2\)/);
    assert.match(body, /code\.dropFirst\(4\)\.prefix\(2\)/);
    assert.match(body, /code\.dropFirst\(7\)\.prefix\(2\)/);
    assert.match(body, /code\.dropFirst\(9\)\.prefix\(2\)/);
});
