'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {draftFromShape: rawDraftFromShape} = require('../../lib/manie/draft');
const {
    runGate: rawRunGate,
    testPattern: rawTestPattern,
    loadNegativeCorpus,
    findNestedUnboundedQuantifier,
    samplesFor,
    CHECK_NAMES,
    MAX_SOURCE_LENGTH,
} = require('../../lib/manie/gate');
const {sampleFromRegex} = require('../../lib/manie/_synth');
const {NUMBER_REGEX} = require('../../lib/manie/_fields');
const base = require('../../assets/manie/sms-formats.json');
const corpusFile = require('../../assets/manie/negative-corpus.json');

globalThis.__DEV__ = false;

const draftFromShape = rawDraftFromShape;
const runGate = rawRunGate;

const testPattern = (def, message, options) => rawTestPattern(def, message, options === undefined ? {timeoutMs: 3000} : options);

const APP = process.env.MANIE_APP_REPO || '/Users/ivainqueur/Documents/Code/React/mobile/Manie';
const HAVE_APP =
    fs.existsSync(path.join(APP, 'tools/sms-pattern-tool/lib/loadClassify.js')) &&
    fs.existsSync(path.join(APP, 'node_modules/typescript'));

const EXISTING = base.patterns;
const SKELETON = 'You sent {N} RWF to {W+} ({PH}) on {TS}. Charge: {N} RWF. Balance: {N} RWF.';
const AIRTEL_SKELETON = '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#';

function goodDraft(skeleton = SKELETON, carrier = 'mtn', overrides) {
    return draftFromShape({skeleton, carrier, count: 3}, overrides, {existingPatterns: EXISTING});
}

function clone(draft, patch = {}) {
    const copy = JSON.parse(JSON.stringify(draft));
    delete copy.gate;
    return {...copy, ...patch};
}

function check(result, name) {
    return result.checks.find(c => c.name === name);
}

function failedNames(result) {
    return result.checks.filter(c => !c.ok).map(c => c.name);
}

test('gate returns every check in order and passes a good draft', () => {
    const result = runGate(goodDraft(), {existingPatterns: EXISTING});
    assert.deepEqual(result.checks.map(c => c.name), CHECK_NAMES);
    assert.equal(result.checks.length, CHECK_NAMES.length);
    assert.equal(CHECK_NAMES.length, 14);
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter(c => !c.ok)));
    for (const c of result.checks) {
        assert.equal(typeof c.detail, 'string');
        assert.ok(c.detail.length > 0);
    }
});

test('gate is fast enough to run on every redraft and approve', () => {
    const draft = goodDraft(AIRTEL_SKELETON, 'airtel');
    const started = Date.now();
    for (let i = 0; i < 10; i++) assert.equal(runGate(draft, {existingPatterns: EXISTING}).ok, true);
    assert.ok(Date.now() - started < 30000, `10 gate runs took ${Date.now() - started} ms`);
});

test('gate never throws on garbage input', () => {
    const garbage = [
        null,
        undefined,
        42,
        'x',
        [],
        {},
        {pattern: 123},
        {pattern: '('},
        {pattern: '(a)', flags: 5, captureMap: 'nope'},
        {pattern: '(a)', captureMap: {amount: 1}, timestamp: 'now', type: 'payment', id: 'ab'},
        {pattern: '(a)', captureMap: null, sourceShape: {skeleton: 7}},
        {pattern: '(a)', captureMap: {amount: 1}, timestamp: {group: 1, parser: 'iso8601'}, type: 'payment', id: 'abc', sourceShape: {skeleton: '5 digits'}},
    ];
    for (const draft of garbage) {
        let result;
        assert.doesNotThrow(() => {
            result = runGate(draft, {existingPatterns: [null, 5, {pattern: 7}, {id: 'x', pattern: '(', type: 'receive'}]});
        }, JSON.stringify(draft));
        assert.equal(result.ok, false);
        assert.deepEqual(result.checks.map(c => c.name), CHECK_NAMES);
    }
    assert.doesNotThrow(() => runGate(goodDraft()));
    assert.doesNotThrow(() => runGate(goodDraft(), {existingPatterns: 'nope'}));
    assert.doesNotThrow(() => runGate(goodDraft(), null));
    assert.doesNotThrow(() => runGate(goodDraft(), undefined));
    assert.doesNotThrow(() => testPattern({pattern: 'a'}, 'a', null));
});

/* ---------- 1. compiles ---------- */

test('check 1: regex must compile; g and y flags are stripped; other flags rejected', () => {
    const draft = goodDraft();
    assert.equal(check(runGate(clone(draft, {pattern: '(((['})), 'regex-compiles').ok, false);
    assert.equal(check(runGate(clone(draft, {pattern: ''})), 'regex-compiles').ok, false);
    assert.equal(check(runGate(clone(draft, {pattern: 5})), 'regex-compiles').ok, false);
    assert.equal(check(runGate(clone(draft, {pattern: 'a'.repeat(20001)})), 'regex-compiles').ok, false);

    const stripped = runGate(clone(draft, {flags: 'gi'}));
    assert.equal(check(stripped, 'regex-compiles').ok, true);
    assert.match(check(stripped, 'regex-compiles').detail, /flags "i"/);
    assert.equal(runGate(clone(draft, {flags: 'giy'})).ok, true);
    assert.equal(runGate(clone(draft, {flags: undefined})).ok, true);
    assert.equal(check(runGate(clone(draft, {flags: 'ii'})), 'regex-compiles').ok, false);
    assert.equal(check(runGate(clone(draft, {flags: 'v'})), 'regex-compiles').ok, false);
    assert.equal(check(runGate(clone(draft, {flags: 'd'})), 'regex-compiles').ok, false);
});

test('a compile failure marks the dependent checks as skipped, not as passed', () => {
    const result = runGate(clone(goodDraft(), {pattern: '(['}));
    assert.equal(result.ok, false);
    for (const name of ['capture-map', 'redos-guard', 'self-match', 'negative-corpus', 'no-shadow']) {
        assert.equal(check(result, name).ok, false, name);
    }
    assert.match(check(result, 'redos-guard').detail, /skipped/);
});

/* ---------- 2. capture map ---------- */

test('check 2: capture indices must be integers within the group count and unique', () => {
    const draft = goodDraft();
    const groups = new RegExp(`${draft.pattern}|`).exec('').length - 1;
    const run = captureMap => check(runGate(clone(draft, {captureMap: {...draft.captureMap, ...captureMap}})), 'capture-map');
    assert.equal(run({}).ok, true);
    assert.equal(run({fee: groups + 1}).ok, false);
    assert.equal(run({fee: 0}).ok, false);
    assert.equal(run({fee: -1}).ok, false);
    assert.equal(run({fee: 1.5}).ok, false);
    assert.equal(run({fee: 'abc'}).ok, false);
    assert.equal(run({fee: null}).ok, false);
    assert.equal(run({fee: draft.captureMap.amount}).ok, false);
    assert.match(run({fee: draft.captureMap.amount}).detail, /used by both/);
    assert.equal(run({bogus: 2}).ok, false);
    assert.match(run({bogus: 2}).detail, /unknown role/);
    assert.equal(run({fee: String(draft.captureMap.fee)}).ok, true, 'numeric strings are accepted like the client does');
    assert.equal(check(runGate(clone(draft, {captureMap: undefined})), 'capture-map').ok, false);
    assert.equal(check(runGate(clone(draft, {captureMap: []})), 'capture-map').ok, false);
});

test('check 2: timestamp needs a valid group, a known parser and its own group', () => {
    const draft = goodDraft();
    const run = timestamp => check(runGate(clone(draft, {timestamp})), 'capture-map');
    assert.equal(run(draft.timestamp).ok, true);
    assert.equal(run({group: 99, parser: 'iso8601'}).ok, false);
    assert.equal(run({group: 0, parser: 'iso8601'}).ok, false);
    assert.equal(run({group: draft.timestamp.group, parser: 'epoch'}).ok, false);
    assert.equal(run({parser: 'iso8601'}).ok, false);
    assert.equal(run({group: draft.captureMap.amount, parser: 'iso8601'}).ok, false);
    assert.equal(run('now').ok, false);
    assert.equal(run({group: String(draft.timestamp.group), parser: 'iso8601'}).ok, true);
});

/* ---------- 3. required captures ---------- */

test('check 3: amount is required, and so is a transactionId or a timestamp', () => {
    const draft = goodDraft(AIRTEL_SKELETON, 'airtel');
    const run = (mutate, timestamp) => {
        const captureMap = {...draft.captureMap};
        mutate(captureMap);
        return check(runGate(clone(draft, {captureMap, timestamp: timestamp === undefined ? draft.timestamp : timestamp})), 'required-captures');
    };
    assert.equal(run(() => {}).ok, true);
    assert.equal(run(m => delete m.amount).ok, false);
    assert.match(run(m => delete m.amount).detail, /amount capture is required/);
    assert.equal(run(() => {}, null).ok, true, 'transactionId alone is enough');
    assert.match(run(() => {}, null).detail, /transactionId/);
    assert.equal(run(m => delete m.transactionId).ok, true, 'timestamp alone is enough');
    assert.equal(run(m => delete m.transactionId, null).ok, false);
    assert.match(run(m => delete m.transactionId, null).detail, /transactionId or timestamp/);

    const merchant = goodDraft('TxId: {PH}. Your payment of {N} RWF to {W+} has been completed at {TS}. Your new balance: {N} RWF. Fee was {N} RWF.', 'mtn');
    const idOnly = runGate(clone(merchant, {timestamp: undefined}));
    assert.equal(idOnly.ok, true, JSON.stringify(idOnly.checks.filter(c => !c.ok)));

    const noAnchor = goodDraft('Sent {N} RWF to {W+}. Balance {N} RWF', 'mtn');
    assert.equal(check(runGate(noAnchor), 'required-captures').ok, false);
});

test('check 3: a balance capture is required because the app would otherwise store a balance of 0', () => {
    const draft = goodDraft();
    const captureMap = {...draft.captureMap};
    delete captureMap.balance;
    const result = check(runGate(clone(draft, {captureMap})), 'required-captures');
    assert.equal(result.ok, false);
    assert.match(result.detail, /balance capture is required/);

    const noBalance = goodDraft('You have received {N} RWF from {W+} ({PH}) at {TS}. Fee was: {N} RWF', 'mtn');
    assert.equal(noBalance.captureMap.balance, undefined);
    assert.equal(noBalance.gate.ok, false);
    assert.equal(check(noBalance.gate, 'required-captures').ok, false);
});

/* ---------- 4. type / id ---------- */

test('check 4: type must be one of the five, id must be a sane identifier', () => {
    const draft = goodDraft();
    for (const type of ['transfer', 'receive', 'payment', 'withdraw', 'deposit']) {
        assert.equal(check(runGate(clone(draft, {type})), 'valid-type').ok, true, type);
    }
    for (const type of ['refund', '', undefined, null, 5, 'Transfer']) {
        assert.equal(check(runGate(clone(draft, {type})), 'valid-type').ok, false, String(type));
    }
    for (const id of ['', 'a', 'has space', 'semi;colon', '-leading', 'x'.repeat(65), undefined, 5, '<b>']) {
        assert.equal(check(runGate(clone(draft, {id})), 'valid-type').ok, false, String(id));
    }
    assert.equal(check(runGate(clone(draft, {id: 'auto-mtn.transfer_1-x'})), 'valid-type').ok, true);
});

/* ---------- 5. redos ---------- */

test('findNestedUnboundedQuantifier flags (x*)* style nesting only', () => {
    const bad = ['(a+)+', '(a*)*', '(?:a+)*', '(?:a|b+)+', '((a+)b)*', '(a{1,})+', '(?<n>x+)*', '(a+)+?', '(.*?)+', '(\\d+\\s)*', '(?:(?:a+))+'];
    const good = [
        '(a+)',
        '(a+)?',
        '(a{1,3})+',
        '(?:a|b)*',
        '(?:RWF|Rwf)\\s+(\\d+)',
        '[(a+)+]',
        '\\(a+\\)+',
        '(a)+',
        '(a+)(b+)',
        '(?:a+b)?',
        '(?<=a+)b',
        '(\\d+)\\s*(.*?)',
        '(?:\\s?\\d{1,3})+',
    ];
    for (const src of bad) assert.equal(findNestedUnboundedQuantifier(src), true, src);
    for (const src of good) assert.equal(findNestedUnboundedQuantifier(src), false, src);
});

test('check 5: nested unbounded quantifiers, long sources and too many groups are rejected statically', () => {
    const draft = goodDraft();
    const nested = runGate(clone(draft, {pattern: `${draft.pattern}|(a+)+$`}));
    assert.equal(check(nested, 'redos-guard').ok, false);
    assert.match(check(nested, 'redos-guard').detail, /nested unbounded/);
    assert.match(check(nested, 'redos-guard').detail, /dynamic probe skipped/);

    const long = runGate(clone(draft, {pattern: `${draft.pattern}|${'x'.repeat(MAX_SOURCE_LENGTH)}`}));
    assert.equal(check(long, 'redos-guard').ok, false);
    assert.match(check(long, 'redos-guard').detail, new RegExp(`max ${MAX_SOURCE_LENGTH}`));

    const manyGroups = runGate(clone(draft, {pattern: `${draft.pattern}|${'(x)'.repeat(25)}`}));
    assert.equal(check(manyGroups, 'redos-guard').ok, false);
    assert.match(check(manyGroups, 'redos-guard').detail, /capture groups \(max 20\)/);

    const exactly20 = clone(draft, {pattern: `${draft.pattern}|${'(x)'.repeat(20 - (new RegExp(`${draft.pattern}|`).exec('').length - 1))}`});
    assert.equal(check(runGate(exactly20), 'redos-guard').ok, true);
});

test('check 5: a polynomial-time blowup is interrupted for real and fails the guard quickly', () => {
    const draft = goodDraft();
    const pattern = `${draft.pattern}|(.*?)(.*?)(.*?)(.*?)(.*?)(.*?)(.*?)Z`;
    const started = Date.now();
    const result = runGate(clone(draft, {pattern}));
    const took = Date.now() - started;
    assert.equal(check(result, 'redos-guard').ok, false);
    assert.match(check(result, 'redos-guard').detail, /interrupted|took/);
    assert.ok(took < 15000, `gate took ${took} ms`);
    for (const name of ['self-match', 'negative-corpus', 'no-shadow']) {
        assert.equal(check(result, name).ok, false);
        assert.match(check(result, name).detail, /skipped: ReDoS guard failed/);
    }
});

test('check 5: benign bounded repeats pass, quartic lazy wildcards do not', () => {
    const draft = goodDraft();
    const benign = runGate(clone(draft, {pattern: `${draft.pattern}|(?:RWF\\s){1,4}Z`}));
    assert.equal(check(benign, 'redos-guard').ok, true, check(benign, 'redos-guard').detail);
    const quartic = runGate(clone(draft, {pattern: `${draft.pattern}|(?:.*?a){1,4}b`}));
    assert.equal(check(quartic, 'redos-guard').ok, false);
});

/* ---------- 6. self-match ---------- */

test('check 6: synthesized messages must match and every capture must have the right shape', () => {
    const draft = goodDraft();
    const good = check(runGate(draft), 'self-match');
    assert.equal(good.ok, true);
    assert.match(good.detail, /planted values/);

    const broken = runGate(clone(draft, {pattern: draft.pattern.replace('RWF', 'XYZ')}));
    assert.equal(check(broken, 'self-match').ok, false);
    assert.match(check(broken, 'self-match').detail, /does not match/);

    const nameAsAmount = runGate(clone(draft, {captureMap: {...draft.captureMap, amount: draft.captureMap.secondParty, secondParty: draft.captureMap.amount}}));
    assert.equal(check(nameAsAmount, 'self-match').ok, false);
    assert.match(check(nameAsAmount, 'self-match').detail, /wrong shape/);

    const groups = new RegExp(`${draft.pattern}|`).exec('').length - 1;
    const tsOnEmptyGroup = runGate(clone(draft, {pattern: `${draft.pattern}(\\s*)`, timestamp: {group: groups + 1, parser: 'iso8601'}}));
    assert.equal(check(tsOnEmptyGroup, 'self-match').ok, false);
    assert.match(check(tsOnEmptyGroup, 'self-match').detail, /timestamp .* does not parse/);
});

test('check 6: needs the source skeleton; a bad one fails cleanly', () => {
    const draft = goodDraft();
    assert.equal(check(runGate(clone(draft, {sourceShape: undefined})), 'self-match').ok, false);
    assert.match(check(runGate(clone(draft, {sourceShape: undefined})), 'self-match').detail, /no sourceShape\.skeleton/);
    assert.equal(check(runGate(clone(draft, {sourceShape: {skeleton: 'has 12 digits'}})), 'self-match').ok, false);
    assert.match(check(runGate(clone(draft, {sourceShape: {skeleton: 'has 12 digits'}})), 'self-match').detail, /not a valid skeleton/);
});

test('check 6: when an admin edits the regex the check falls back to shape validation', () => {
    const draft = goodDraft();
    const edited = clone(draft, {pattern: `${draft.pattern}(?:)`});
    const unchanged = runGate(edited);
    assert.equal(check(unchanged, 'self-match').ok, true);

    const extraGroup = clone(draft, {pattern: `${draft.pattern}(\\s*)`});
    const result = runGate(extraGroup);
    assert.equal(check(result, 'self-match').ok, true, check(result, 'self-match').detail);
    assert.match(check(result, 'self-match').detail, /by shape/);
});

test('check 6: self-match covers both plain and comma-separated numbers, plus T-separated timestamps', () => {
    const draft = goodDraft('TransactionId: {PH} Your payment of {N} RWF to {W+} with token and ET Id: {PH} SUCCESSFUL at {TS}.Fee: {N} RWF. Balance {N} RWF', 'mtn');
    assert.equal(runGate(draft, {existingPatterns: EXISTING}).ok, true);
    const strictDigits = clone(draft, {pattern: draft.pattern.split(NUMBER_REGEX).join('(\\d+)')});
    const result = runGate(strictDigits);
    assert.equal(check(result, 'self-match').ok, false, 'a pattern that only accepts plain digits fails the comma variant');
    assert.match(check(result, 'self-match').detail, /variant 1/);

    const spaceOnlyTs = clone(draft, {pattern: draft.pattern.replace('[ T]', ' ')});
    assert.equal(check(runGate(spaceOnlyTs), 'self-match').ok, false);
});

/* ---------- 7. negative corpus ---------- */

test('negative corpus: at least 40 synthetic messages covering both carriers, both locales and every noise category', () => {
    const corpus = loadNegativeCorpus();
    assert.ok(corpus.length >= 40, `corpus has ${corpus.length}`);
    const raw = corpusFile.messages;
    assert.equal(raw.length, corpus.length);
    assert.equal(new Set(raw.map(m => m.id)).size, raw.length, 'unique ids');
    assert.equal(corpusFile.synthetic, true);
    const has = (key, value) => raw.some(m => m[key] === value);
    for (const carrier of ['mtn', 'airtel']) assert.ok(has('carrier', carrier), carrier);
    for (const locale of ['en-RW', 'rw-RW']) assert.ok(has('locale', locale), locale);
    for (const category of ['failed-transaction', 'insufficient-balance', 'wrong-pin', 'otp', 'promo', 'maintenance']) {
        assert.ok(has('category', category), category);
    }
    for (const carrier of ['mtn', 'airtel']) {
        for (const locale of ['en-RW', 'rw-RW']) {
            assert.ok(raw.some(m => m.carrier === carrier && m.locale === locale), `${carrier}/${locale}`);
        }
    }
    for (const m of raw) {
        assert.equal(typeof m.body, 'string');
        assert.ok(m.body.length > 10 && m.body.length < 400, m.id);
        const longRuns = m.body.match(/\d{9,}/g) || [];
        for (const run of longRuns) assert.equal(run, '0780000001', `${m.id}: only the one fake phone number may appear`);
        assert.equal(/UGX|USD|KES/.test(m.body), false, `${m.id}: RWF only`);
    }
});

test('negative corpus: no base served pattern matches any message', () => {
    const regexes = EXISTING.map(p => [p.id, new RegExp(p.pattern, p.flags)]);
    for (const m of corpusFile.messages) {
        for (const [id, re] of regexes) assert.equal(re.test(m.body), false, `${id} matches ${m.id}`);
    }
});

test('negative corpus: the built-in classifier does not turn any of them into a transaction', {skip: HAVE_APP ? false : 'APP repo not available'}, () => {
    const {loadClassify} = require(path.join(APP, 'tools/sms-pattern-tool/lib/loadClassify.js'));
    const {classify} = loadClassify(APP);
    classify.setPatternOverrides([]);
    const {transactions} = classify.classifyTransactions(corpusFile.messages.map(m => ({body: m.body})));
    assert.equal(transactions.length, 0);
});

test('check 7: a draft built from a non-transaction message is rejected, naming the corpus entry', () => {
    const balanceInquiry = goodDraft('Your account balance is {N} RWF as of {TS}.', 'mtn');
    const result = runGate(balanceInquiry);
    assert.equal(check(result, 'negative-corpus').ok, false);
    assert.match(check(result, 'negative-corpus').detail, /neg-015/);

    const failedKr = goodDraft('*{N}* TID {TID}*F* Kohereza Rwf {N} kuri {W+} {PH} ntibyakunze. Fee Rwf{N}. Ubu mufite Rwf {N}. *KR#', 'airtel');
    assert.equal(check(runGate(failedKr), 'negative-corpus').ok, false);
    assert.match(check(runGate(failedKr), 'negative-corpus').detail, /neg-044/);

    const failedEn = goodDraft('*{N}*TXN ID ({TID})*F*Payment of RWF {N} to {W+} - failed.Your NEW BALANCE is RWF {N}. *EN#', 'airtel');
    assert.equal(check(runGate(failedEn), 'negative-corpus').ok, false);
    assert.match(check(runGate(failedEn), 'negative-corpus').detail, /neg-028/);
});

test('check 7: the success counterpart of a failure notice is accepted', () => {
    const success = goodDraft('*{N}*TXN ID ({TID})*S*Payment of RWF {N} to {W+} - successful.Your NEW BALANCE is RWF {N}. *EN#', 'airtel');
    assert.equal(check(runGate(success), 'negative-corpus').ok, true);
    const successKr = goodDraft('*{N}* TID {TID}*S* Kohereza Rwf {N} kuri {W+} {PH} byakunze. Fee Rwf{N}. Ubu mufite Rwf {N}. *KR#', 'airtel');
    assert.equal(check(runGate(successKr), 'negative-corpus').ok, true);
});

/* ---------- 8. shadow ---------- */

test('existing patterns: every base served pattern yields a self-matching sample', () => {
    for (const p of EXISTING) {
        const samples = samplesFor(p);
        assert.ok(samples.length >= 1, `no sample for ${p.id}`);
        for (const s of samples) assert.equal(new RegExp(p.pattern, p.flags).test(s), true, p.id);
        const raw = sampleFromRegex(p.pattern);
        assert.equal(typeof raw, 'string');
    }
});

test('existing patterns: samples from an auto pattern use its source skeleton', () => {
    const auto = {...clone(goodDraft()), status: 'active'};
    const samples = samplesFor(auto);
    assert.equal(samples.length, 2);
    for (const s of samples) assert.equal(new RegExp(auto.pattern, auto.flags).test(s), true);
});

test('check 8: matching a sample of an existing pattern with a different type is a conflict', () => {
    const draft = goodDraft();
    const existing = {
        id: 'existing-sent',
        type: 'receive',
        status: 'active',
        flags: 'i',
        pattern: '.*?You sent (\\d+) RWF to (.*?) \\((\\d+)\\) on ([\\d\\- :]+)\\. Charge: (\\d+) RWF\\. Balance: (\\d+) RWF\\.',
    };
    const result = runGate(draft, {existingPatterns: [existing]});
    assert.equal(check(result, 'no-shadow').ok, false);
    assert.match(check(result, 'no-shadow').detail, /existing-sent \(receive\)/);
    assert.deepEqual(failedNames(result), ['no-shadow']);

    assert.equal(runGate(draft, {existingPatterns: [{...existing, type: 'transfer'}]}).ok, true, 'same type is fine');
    assert.equal(runGate(draft, {existingPatterns: [{...existing, type: undefined}]}).ok, false, 'a missing type means payment, like the client default');
    assert.equal(runGate(draft, {existingPatterns: [{...existing, status: 'disabled'}]}).ok, true, 'inactive patterns are ignored');
    assert.equal(runGate(draft, {existingPatterns: [{...existing, disabled: true}]}).ok, true);
    assert.equal(runGate(draft, {existingPatterns: [{...existing, id: draft.id}]}).ok, true, 'the pattern being replaced is ignored');
    assert.equal(runGate(draft, {existingPatterns: [{...existing, pattern: 'unrelated text (\\d+)'}]}).ok, true);
    assert.match(check(runGate(draft, {existingPatterns: []}), 'no-shadow').detail, /no existing active patterns/);
});

test('check 8: an auto pattern built from the same skeleton but typed differently conflicts', () => {
    const draft = goodDraft();
    const rival = {...clone(goodDraft(SKELETON, 'mtn', {type: 'payment', id: 'auto-rival'})), status: 'active'};
    const result = runGate(draft, {existingPatterns: [rival]});
    assert.equal(check(result, 'no-shadow').ok, false);
    assert.match(check(result, 'no-shadow').detail, /auto-rival \(payment\)/);
});

test('check 8: retyping a draft of a built-in format conflicts with the served built-in pattern', () => {
    const skeleton = '{N} RWF transferred to {W+}({PH}) at {TS} Fee was: {N} RWF New balance: {N} RWF';
    const asTransfer = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {existingPatterns: EXISTING});
    assert.equal(check(asTransfer.gate, 'no-shadow').ok, true);
    const asPayment = draftFromShape({skeleton, carrier: 'mtn'}, {type: 'payment'}, {existingPatterns: EXISTING});
    assert.equal(check(asPayment.gate, 'no-shadow').ok, false);
    assert.match(check(asPayment.gate, 'no-shadow').detail, /mtn-transfer-v\d/);
});

test('check 8: Airtel and Kinyarwanda built-ins are covered too', () => {
    const skeleton = '*{N}*TID {TID}*S*Mwakiriye RWF {N} avuye kuri {W+} {PH}.Kuri konti ubu mufite RWF {N}.*KR#';
    const asReceive = draftFromShape({skeleton, carrier: 'airtel'}, undefined, {existingPatterns: EXISTING});
    assert.equal(asReceive.type, 'receive');
    assert.equal(check(asReceive.gate, 'no-shadow').ok, true);
    const asTransfer = draftFromShape({skeleton, carrier: 'airtel'}, {type: 'transfer'}, {existingPatterns: EXISTING});
    assert.equal(check(asTransfer.gate, 'no-shadow').ok, false);
    assert.match(check(asTransfer.gate, 'no-shadow').detail, /airtel-receive-aa-rw/);
});

/* ---------- testPattern ---------- */

test('testPattern: returns captures, parsed fields and timing for a matching message', () => {
    const draft = goodDraft();
    const message = 'You sent 5,000 RWF to Alice Sample (0780000001) on 2026-04-11 14:30:00. Charge: 100 RWF. Balance: 123450 RWF.';
    const res = testPattern(draft, message);
    assert.equal(res.matched, true);
    assert.equal(res.timedOut, false);
    assert.equal(typeof res.elapsedMs, 'number');
    assert.equal(res.captures[0], message);
    assert.equal(res.captures[draft.captureMap.amount], '5,000');
    assert.deepEqual(
        {...res.fields, timestampMs: undefined, timestampIso: undefined},
        {
            type: 'transfer',
            direction: 'out',
            amount: 5000,
            balance: 123450,
            fee: 100,
            secondParty: 'Alice Sample',
            accountNumber: '0780000001',
            timestampRaw: '2026-04-11 14:30:00',
            timestampMs: undefined,
            timestampIso: undefined,
        },
    );
    assert.equal(res.fields.timestampMs, new Date('2026-04-11 14:30:00').getTime());
    assert.deepEqual(res.warnings, []);
});

test('testPattern: no match, receive direction, string group numbers, g/y flags', () => {
    const draft = goodDraft('Received {N} RWF from {W+} ({PH}) on {TS}. Balance: {N} RWF.');
    const no = testPattern(draft, 'nothing to see');
    assert.equal(no.matched, false);
    assert.equal(no.captures, null);
    assert.equal(no.fields, null);
    const res = testPattern(
        {pattern: draft.pattern, flags: 'gi', type: 'receive', captureMap: {amount: String(draft.captureMap.amount)}, timestamp: {group: String(draft.timestamp.group), parser: 'iso8601'}},
        'received 900 RWF from Bob Example (0730000002) on 2026-04-11T14:30:00. Balance: 1000 RWF.',
    );
    assert.equal(res.matched, true);
    assert.equal(res.fields.direction, 'in');
    assert.equal(res.fields.amount, 900);
    assert.equal(Number.isFinite(res.fields.timestampMs), true);
    assert.equal(testPattern({pattern: draft.pattern, flags: 'gi'}, 'received 900 RWF from Bob Example (0730000002) on 2026-04-11T14:30:00. Balance: 1000 RWF.').matched, true);
    assert.equal(testPattern({pattern: draft.pattern, flags: 'gi'}, 'received 900 RWF from Bob Example (0730000002) on 2026-04-11T14:30:00. Balance: 1000 RWF.').matched, true, 'no lastIndex state leaks between calls');
});

test('testPattern: an Airtel timestamp is read from the full code, and a group without the two-letter prefix is flagged', () => {
    const draft = goodDraft(AIRTEL_SKELETON, 'airtel');
    assert.equal(draft.timestamp.group, draft.captureMap.transactionId, 'one group is both the transaction id and the timestamp');
    const res = testPattern(draft, '*165*TID PP260411.1430.A12345*S* Sent Rwf 5000 to Alice Sample 0780000001. Fee Rwf 100. BAL Rwf 123450. *EN#');
    assert.equal(res.matched, true);
    assert.equal(res.fields.timestampRaw, 'PP260411.1430.A12345');
    assert.equal(res.fields.timestampMs, new Date(2026, 3, 11, 14, 30, 0).getTime());
    assert.equal(res.fields.transactionId, 'PP260411.1430.A12345');
    assert.deepEqual(res.warnings, [], 'the full code is read the same by every build of the app');

    const prefixLess = testPattern(
        {...draft, pattern: '(\\d+\\.\\d+)\\.\\D\\d+', captureMap: {amount: 1}, timestamp: {group: 1, parser: 'airtel-shortcode'}},
        'PP260411.1430.A12345',
    );
    assert.equal(prefixLess.matched, true);
    assert.equal(prefixLess.fields.timestampRaw, '260411.1430');
    assert.equal(prefixLess.fields.timestampMs, new Date(2026, 3, 11, 14, 30, 0).getTime(), 'the current app reads a bare YYMMDD.HHMM');
    assert.equal(prefixLess.warnings.length, 1);
    assert.match(prefixLess.warnings[0], /no two-letter prefix/, 'released builds would read it as an invalid date');
});

test('testPattern: invalid input returns an error instead of throwing', () => {
    assert.match(testPattern(null, 'x').error, /definition missing/);
    assert.match(testPattern({pattern: ''}, 'x').error, /non-empty/);
    assert.match(testPattern({pattern: '(['}, 'x').error, /invalid regex/);
    assert.match(testPattern({pattern: 'a', flags: 'x'}, 'x').error, /flags/);
    assert.match(testPattern({pattern: 'a'}, 5).error, /message must be a string/);
    assert.match(testPattern({pattern: 'a'}, 'x'.repeat(5001)).error, /longer than/);
    assert.match(testPattern({pattern: 'a'.repeat(3001)}, 'x').error, /longer than/);
    const res = testPattern({pattern: '(['}, 'x');
    assert.equal(res.matched, false);
    assert.equal(res.timedOut, false);
});

test('testPattern: a catastrophic admin-typed regex is interrupted for real, and the next call still works', () => {
    const evil = {pattern: '(a+)+$', flags: ''};
    const input = `${'a'.repeat(45)}b`;
    const started = Date.now();
    const res = testPattern(evil, input, {timeoutMs: 40});
    const took = Date.now() - started;
    assert.equal(res.timedOut, true);
    assert.equal(res.matched, false);
    assert.match(res.error, /exceeded 40 ms/);
    assert.ok(took < 10000, `took ${took} ms`);
    assert.ok(res.elapsedMs >= 30 && res.elapsedMs < 10000, `elapsed ${res.elapsedMs}`);
    const ok = testPattern({pattern: '(\\d+)', captureMap: {amount: 1}}, 'abc 42');
    assert.equal(ok.matched, true);
    assert.equal(ok.fields.amount, 42);
});

test('testPattern: other classic blowups are interrupted too and a bad timeout falls back to the default', () => {
    const cases = [
        [{pattern: '(x+x+)+y'}, `${'x'.repeat(60)}`],
        [{pattern: '^(([a-z])+.)+[A-Z]([a-z])+$'}, `${'a'.repeat(45)}!`],
        [{pattern: '^(\\w+\\s?)*$'}, `${'word '.repeat(40)}!`],
        [{pattern: '(a|aa)+$'}, `${'a'.repeat(60)}b`],
    ];
    for (const [def, input] of cases) {
        const started = Date.now();
        const res = testPattern(def, input, {timeoutMs: 30});
        assert.equal(res.timedOut, true, def.pattern);
        assert.ok(Date.now() - started < 10000, def.pattern);
    }
    const tiny = testPattern({pattern: 'a'}, 'a', {timeoutMs: -5});
    assert.equal(tiny.matched, true);
});

test('testPattern cannot be used to reach globals or code generation', () => {
    const res = testPattern({pattern: '(?:)'}, 'x');
    assert.equal(res.matched, true);
    assert.equal(res.fields.amount, 0);
    for (const pattern of ['\\u{110000}', '(?<a>x)(?<a>y)', '[z-a]', 'a**', '(?=a)*+']) {
        assert.doesNotThrow(() => testPattern({pattern}, 'x'), pattern);
    }
});

/* ---------- carrier signals: MTN uses *S* too ---------- */

const MTN_MERCHANT_ZERO_BALANCE = 'txid:{PH}*s*your payment of {N} rwf to {W+} {N} was completed at {TS}. balance: {N}. fee {N} rwf. *en#';

test('carrier-signals: the MTN merchant shape with a bare balance (dataset messages 15 and 50) passes the whole gate under mtn', () => {
    for (const skeleton of [MTN_MERCHANT_ZERO_BALANCE, 'TxId:{PH}*S*Your payment of {N} RWF to {W+} {N} was completed at {TS}. Balance: {N}. Fee {N} RWF. *EN#']) {
        const result = runGate(goodDraft(skeleton, 'mtn'), {existingPatterns: EXISTING});
        assert.equal(check(result, 'carrier-signals').ok, true, check(result, 'carrier-signals').detail);
        assert.deepEqual(failedNames(result), [], skeleton);
        assert.equal(result.ok, true);
    }
});

test('carrier-signals: MTN *S* forms (*NNN*S*, TxId:..*S*, *NNN*TxId:..*S*) never conflict with carrier mtn', () => {
    for (const skeleton of [
        '*{N}*S*{N} RWF transferred to {W+} ({PH}) at {TS} .Fee: {N}RWF.Balance: {N}RWF.Dial *{N}*{N}*{N}# and send money abroad *EN#',
        '*{N}*TxId:{PH}*S*Your payment of {N} RWF to {W+} with token and ET Id: {PH} was completed at {TS}. Fee {N} RWF. Balance: {N} RWF . Message: - -. *EN#',
        "*{N}*S*Y'ello, you have received {N} RWF from {W+} ({PH}) at {TS}. Balance: {N} RWF. *EN#",
    ]) {
        const result = runGate(goodDraft(skeleton, 'mtn'), {existingPatterns: EXISTING});
        assert.equal(check(result, 'carrier-signals').ok, true, skeleton + ': ' + check(result, 'carrier-signals').detail);
    }
});

test('carrier-signals: genuine Airtel markers still fail under mtn and pass under airtel', () => {
    const airtelShapes = [
        AIRTEL_SKELETON,
        '*{N}*Txn ID {TID}*R* Received Rwf {N} from {W+} {PH}. NEW BALANCE Rwf {N}. *EN#',
        '*{N}*TID:{TID}*S* Airtime of Rwf {N} done to {PH}. Balance: Rwf {N} *EN#',
        '*{N}*Txn ID {PH}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#',
        '*{N}*R* Received Rwf {N} from {W+} {PH}. NEW BALANCE Rwf {N}. *EN#',
        '*{N}*S* Mwakiriye RWF {N} avuye kuri {W+} {PH}. Asigaye ni RWF {N}. *KR#',
        '*{N}*S* Kugura Inite ya Rwf {N} byagenze neza. Ubu kuri konti mufite Rwf {N}. *KR#',
    ];
    for (const skeleton of airtelShapes) {
        const asMtn = check(runGate(goodDraft(skeleton, 'mtn')), 'carrier-signals');
        assert.equal(asMtn.ok, false, 'should fail under mtn: ' + skeleton);
        assert.match(asMtn.detail, /filed under MTN/);
        assert.equal(check(runGate(goodDraft(skeleton, 'airtel')), 'carrier-signals').ok, true, 'should pass under airtel: ' + skeleton);
    }
});
