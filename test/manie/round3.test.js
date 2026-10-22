'use strict';

// Regression tests for the third audit round. Every test name starts with the id of the finding it
// pins; each fails when its fix is taken out (see the mutation list in the review notes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync, execFileSync} = require('node:child_process');

const {startServer, submission, TOKEN, MemoryStore, loadBaseConfig} = require('./helpers');
const {anonymize, canonicalSkeleton, shapeId: rawShapeId} = require('../../lib/manie/anonymize');
const {draftFromShape: rawDraftFromShape} = require('../../lib/manie/draft');
const {runGate: rawRunGate} = require('../../lib/manie/gate');
const {isNoiseSkeleton} = require('../../lib/manie/noise');
const {buildVocabulary, literalWordsOfRegexSource} = require('../../lib/manie/vocab');
const {guessTypeOfSkeleton, layoutOf, NUMBER_REGEX} = require('../../lib/manie/_fields');
const {NEGATION_SOURCE, NEGATION_LOOKAHEAD, NEGATION_PHRASES, FAILURE_GROUPS, CONDITIONAL_FAILURE_WORDS} = require('../../lib/manie/_negation');
const {samplesFor} = require('../../lib/manie/gate');
const {K, LIMITS, RATE_LIMITS, COVERAGE_STATS} = require('../../routes/manie');
const seed = require('../../assets/manie/vocab-seed.json');
const base = require('../../assets/manie/sms-formats.json');

globalThis.__DEV__ = false;

const SALT = 'round3-salt-0123456789abcdef';
const PROXY_ENV = {MANIE_ADMIN_TOKEN: TOKEN, MANIE_TRUST_PROXY: '1', MANIE_HASH_SALT: SALT};
const ip = n => ({'X-Forwarded-For': `203.0.113.${n}`});
const wideIp = n => ({'X-Forwarded-For': `198.51.${100 + Math.floor(n / 250)}.${(n % 250) + 1}`});
const shapeId = (skeleton, carrier = 'mtn') => rawShapeId(canonicalSkeleton(skeleton), carrier);

const vocab = (extra = []) => new Set(buildVocabulary({seed: [...seed, ...extra], patterns: base.patterns, adminWords: []}));
const draftOf = (skeleton, carrier = 'mtn', overrides, extra) =>
    rawDraftFromShape({skeleton, carrier, count: 3, ...extra}, overrides, {existingPatterns: base.patterns});
const gateOf = (draft, patch = {}) => rawRunGate({...draft, ...patch}, {existingPatterns: base.patterns});
const named = (result, name) => result.checks.find(c => c.name === name);
const matches = (draft, body) => new RegExp(draft.pattern, draft.flags).test(body);
const slotGroup = (skeleton, slotNo) => layoutOf(skeleton).slots.find(s => s.slotNo === slotNo).group;

async function withServer(options, fn) {
    const server = await startServer(options);
    try {
        await fn(server);
    } finally {
        await server.close();
    }
}

async function quiet(fn) {
    const original = {error: console.error, warn: console.warn};
    console.error = () => {};
    console.warn = () => {};
    try {
        return await fn();
    } finally {
        console.error = original.error;
        console.warn = original.warn;
    }
}

// A store whose next call matching `match` fails (before it runs, or after it ran).
function failingOnce(match, {after = false} = {}) {
    const inner = new MemoryStore();
    const state = {armed: false, fired: 0};
    const store = new Proxy(inner, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            return async (...args) => {
                if (state.armed && match(prop, args)) {
                    state.armed = false;
                    state.fired += 1;
                    if (after) await value.apply(target, args);
                    throw new Error('injected storage failure');
                }
                return value.apply(target, args);
            };
        },
    });
    return {store, state};
}

const NOVEL = 'Dear customer {N} RWF has been moved to {W+} ({PH}) on {TS}. Fee: {N} RWF. Balance: {N} RWF.';
const NOVEL_AT = 'Dear customer {N} RWF has been moved to {W+} ({PH}) at {TS}. Fee: {N} RWF. Balance: {N} RWF.';
const seedMoved = s => s.admin('POST', '/vocab', {add: ['moved']});

async function submitAndRedraft(s, skeleton, carrier, ipN, overrides = {type: 'transfer'}) {
    const res = await s.submit(submission([{skeleton, carrier}]), ip(ipN));
    assert.equal(res.status, 202, res.text);
    const id = shapeId(skeleton, carrier);
    const redraft = await s.admin('POST', `/shape/${id}/redraft`, overrides);
    assert.equal(redraft.status, 200, redraft.text);
    return {id, draft: redraft.json.draft, gate: redraft.json.gate};
}

const servedAutoIds = async s => (await s.request('GET', '/manie/sms-formats')).json.patterns.filter(p => p.id.startsWith('auto-')).map(p => p.id);

/* ---------------------------------- F1 ---------------------------------- */

const ICU_SKELETONS = [
    ['mtn', 'You have transferred {N} RWF to {W+} ({PH}) on {TS}. Fee was {N} RWF. Your new balance: {N} RWF.', {type: 'transfer'}],
    ['mtn', 'Dear customer {N} RWF has been paid to {W+} at {W+} for {W+} on {TS}. Fee was {N} RWF. Your new balance: {N} RWF.', {type: 'payment'}],
    ['mtn', 'You have received {N} RWF from {W+}', {type: 'receive'}],
    ['airtel', '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#', {type: 'transfer'}],
    ['airtel', '*{N}*TXN ID {TID}*S* Mwakiriye RWF {N} avuye kuri {W+} {PH}. Asigaye ni RWF {N}. *KR#', {type: 'receive'}],
];

const swiftAvailable = process.platform === 'darwin' && spawnSync('swift', ['--version'], {stdio: 'ignore'}).status === 0;

function icuCompileFailures(items) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manie-icu-'));
    try {
        const file = path.join(dir, 'patterns.json');
        fs.writeFileSync(file, JSON.stringify(items));
        const out = execFileSync('swift', [path.join(__dirname, '_icuCompile.swift'), file], {encoding: 'utf8', timeout: 180000});
        return JSON.parse(out.trim().split('\n').pop());
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

test('F1: a drafted pattern never spells "any character" with an empty character class', () => {
    for (const [carrier, skeleton, overrides] of ICU_SKELETONS) {
        const {pattern} = draftOf(skeleton, carrier, overrides);
        assert.doesNotMatch(pattern, /\[\^?\]/, `${skeleton}: an empty class does not compile in ICU, so iOS would drop the pattern`);
        if (skeleton.includes('{W+}')) assert.ok(pattern.includes('[\\s\\S]'), 'the free-text slot says "any character" in a form every engine reads');
    }
    assert.doesNotMatch(NEGATION_SOURCE, /\[\^?\]/);
});

test('F1: every drafted pattern and every built-in pattern compiles in the engine behind iOS NSRegularExpression', {skip: swiftAvailable ? false : 'macOS with swift only'}, () => {
    const items = [{pattern: 'a[^]b', flags: 'i'}];
    for (const [carrier, skeleton, overrides] of ICU_SKELETONS) items.push({pattern: draftOf(skeleton, carrier, overrides).pattern, flags: 'i'});
    for (const p of base.patterns) items.push({pattern: p.pattern, flags: p.flags});
    assert.deepEqual(icuCompileFailures(items), [0], 'only the control (an empty negated class) fails to compile');
});

/* ---------------------------------- NEGATION-LEXICON-GAP ---------------------------------- */

const REVIEWER_FAILURE_WORDS = [
    'timed out', 'blocked', 'stopped', 'returned', 'voided', 'aborted', 'refunded', 'withheld', 'halted', 'suspended', 'unavailable',
    'incomplete', 'awaiting approval', 'exceeds limit', 'on hold', 'ntibishobotse', 'byahagaritswe', 'ntahagije', 'siyo', 'was reversed',
    'has been reversed', 'not completed', 'bounced', 'disputed', 'frozen', 'terminated', 'interrupted',
];

const SUCCESS_BODIES = [
    ['mtn', 'payment', 'ACME SHOP', 'Your payment of 5,000 RWF to ACME SHOP. Your new balance: 12,000 RWF. 2026-04-11 14:30:05'],
    ['mtn', 'transfer', 'Alice Mukamana', 'You have transferred 5,000 RWF to Alice Mukamana (250780000001) on 2026-04-11 14:30:05. Fee was 0 RWF. Your new balance: 12,000 RWF.'],
    ['mtn', 'payment', 'ACME SHOP', 'Payment of 5,000 RWF to ACME SHOP on 2026-04-11 14:30:05. Fee was 0 RWF. Your new balance: 12,000 RWF.'],
];

test('NEGATION-LEXICON-GAP: a drafted name slot refuses every failure wording the noise filter knows, and more', () => {
    for (const [carrier, type, name, body] of SUCCESS_BODIES) {
        const {skeleton} = anonymize(body, vocab());
        const draft = draftOf(skeleton, carrier, {type});
        assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
        assert.equal(matches(draft, body), true, 'the guard does not stop the real success notice');
        const words = [...NEGATION_PHRASES, ...REVIEWER_FAILURE_WORDS];
        for (const word of words) {
            const failed = body.replace(name, `${name} ${word}`);
            assert.equal(matches(draft, failed), false, `read as a success: ${failed}`);
        }
    }
});

test('NEGATION-LEXICON-GAP: the noise filter and the name-slot guard are built from one list', () => {
    for (const group of FAILURE_GROUPS) {
        for (const phrase of [...group.stems, ...group.words]) {
            assert.equal(isNoiseSkeleton(`Payment of {N} RWF to {W+} ${phrase}. Balance {N} RWF`).noise, true, `noise filter misses "${phrase}"`);
            assert.ok(new RegExp(NEGATION_SOURCE, 'i').test(` ${phrase} `), `the guard misses "${phrase}"`);
            assert.ok(NEGATION_PHRASES.includes(phrase), `the gate does not inject "${phrase}"`);
        }
    }
    for (const word of CONDITIONAL_FAILURE_WORDS) {
        assert.equal(isNoiseSkeleton(`Payment of {N} RWF to {W+} ${word}. Balance {N} RWF`).noise, true);
        assert.equal(isNoiseSkeleton(`Payment of {N} RWF to {W+} completed, nothing ${word}. Balance {N} RWF`).noise, false, `"${word}" next to "completed" is not enough to drop a notice`);
        assert.ok(new RegExp(NEGATION_SOURCE, 'i').test(` ${word} `));
    }
    for (const phrase of NEGATION_PHRASES) assert.ok(new RegExp(NEGATION_SOURCE, 'i').test(` ${phrase} `), `the guard misses injected phrase "${phrase}"`);
});

test('NEGATION-LEXICON-GAP: the gate injects every phrase of the list, not a hand-picked few', () => {
    const OLD_GUARD = "\\b(?:not|never|cannot|unable|fail(?:ed|ure)?|unsuccessful|cancell?ed|declined|reversed|pending|rejected|denied|refused|insufficient|invalid|expired|error|ntibyakunze|ntibyagenze|ntabwo|byanze)\\b|[n]['\\u2019][t]";
    const OLD_PHRASES = ['failed', "couldn't", 'couldn’t', 'was not', 'cannot', 'never', 'cancelled', 'declined', 'unsuccessful', 'pending', 'reversed', 'ntibyakunze', 'byanze'];
    const {skeleton} = anonymize(SUCCESS_BODIES[0][3], vocab());
    const draft = draftOf(skeleton, 'mtn', {type: 'payment'});
    assert.ok(draft.pattern.includes(NEGATION_LOOKAHEAD));
    const oldStyle = gateOf(draft, {pattern: draft.pattern.split(NEGATION_LOOKAHEAD).join(`(?!${OLD_GUARD})`)});
    const check = named(oldStyle, 'negation-slots');
    assert.equal(check.ok, false, 'a guard that only knows the old list is caught');
    const phrase = /when "([^"]+)" follows/.exec(check.detail)[1];
    assert.equal(OLD_PHRASES.includes(phrase), false, `the phrase that exposed it ("${phrase}") was not on the old list`);
    assert.match(named(draft.gate, 'negation-slots').detail, new RegExp(`${NEGATION_PHRASES.length} failure phrases`));

    NEGATION_PHRASES.push('zzsentinelphrase');
    try {
        const sentinel = named(gateOf(draft), 'negation-slots');
        assert.equal(sentinel.ok, false, 'the last entry of the list is injected too');
        assert.match(sentinel.detail, /when "zzsentinelphrase" follows/);
    } finally {
        NEGATION_PHRASES.pop();
    }
});

/* ---------------------------------- HINT-STEERS-GATE ---------------------------------- */

const REF_SKELETON = 'You have transferred {N} RWF to {W+} ({PH}) on {TS}. Ref {N}. Fee: {N} RWF. Your new balance: {N} RWF.';
const GREETING_SKELETON = 'Dear {W+}, you have received {N} RWF from {W+} ({PH}) on {TS}. Fee: {N} RWF. Your new balance: {N} RWF.';

test('HINT-STEERS-GATE: one device vote cannot move the amount onto the reference number', () => {
    const draft = draftOf(REF_SKELETON, 'mtn', {type: 'transfer'}, {hintVotes: {4: {amount: 1}}});
    assert.equal(draft.captureMap.amount, slotGroup(REF_SKELETON, 1));
    assert.ok(!draft.notes.some(n => /device hint/.test(n) && !n.startsWith('conflict:')), 'the lone vote was not applied');
    assert.equal(named(draft.gate, 'role-keywords').ok, true);
});

test('HINT-STEERS-GATE: even two devices cannot override a number the text points at as the amount', () => {
    const draft = draftOf(REF_SKELETON, 'mtn', {type: 'transfer'}, {hintVotes: {4: {amount: 2}}});
    assert.equal(draft.captureMap.amount, slotGroup(REF_SKELETON, 1), 'the currency-adjacent number keeps the amount');
    assert.ok(draft.notes.some(n => n.startsWith('conflict:') && /slot 4/.test(n)), draft.notes.join(' | '));
});

test('HINT-STEERS-GATE: device votes never name the counterparty or confirm the name mapping', () => {
    const second = slotGroup(GREETING_SKELETON, 3);
    for (const votes of [1, 2, 6]) {
        const draft = draftOf(GREETING_SKELETON, 'mtn', undefined, {hintVotes: {1: {secondParty: votes}}});
        assert.equal(draft.captureMap.secondParty, second, `${votes} vote(s) for the greeting slot do not beat "from {W+}"`);
        assert.equal(draft.sourceShape.nameConfirmed, undefined, 'a vote is not a confirmation');
    }
    const ambiguous = 'balance for {W+} is {N} rwf, sent {N} rwf {W+} on {TS}';
    const hinted = draftOf(ambiguous, 'mtn', undefined, {hintVotes: {3: {secondParty: 5}}});
    assert.equal(hinted.sourceShape.nameConfirmed, undefined);
    assert.equal(named(hinted.gate, 'name-slot').ok, false, 'only the admin confirms a guess among several free-text slots');
});

test('HINT-STEERS-GATE: a vote-backed amount the text does not point at is not accepted until the admin sets it', () => {
    const skeleton = 'Sent {N} {N} {N} to {W+} on {TS}.';
    const voted = draftOf(skeleton, 'mtn', {type: 'transfer'}, {hintVotes: {2: {amount: 4}}});
    assert.equal(voted.captureMap.amount, slotGroup(skeleton, 2), 'the vote filled the slot the text left open');
    const check = named(voted.gate, 'role-keywords');
    assert.equal(check.ok, false);
    assert.match(check.detail, /no amount keyword before it and no currency word next to it/);

    const lone = draftOf(skeleton, 'mtn', {type: 'transfer'}, {hintVotes: {2: {amount: 1}, 3: {fee: 1}}});
    assert.equal(lone.captureMap.amount, slotGroup(skeleton, 1), 'a lone vote does not decide where the amount is');
    assert.equal(lone.captureMap.fee, undefined, 'nor does it fill a slot');

    const confirmed = draftOf(skeleton, 'mtn', {type: 'transfer', captureMap: {amount: slotGroup(skeleton, 2)}}, {hintVotes: {2: {amount: 4}}});
    assert.equal(confirmed.sourceShape.amountConfirmed, true);
    assert.equal(named(confirmed.gate, 'role-keywords').ok, true, 'the admin setting it is the confirmation');
    const unlabelled = draftOf(skeleton, 'mtn', {type: 'transfer'});
    assert.equal(named(unlabelled.gate, 'role-keywords').ok, false, 'the first unlabelled number is a guess too');
});

/* ---------------------------------- TYPE-DIRECTION-SILENT ---------------------------------- */

const INCOMING_WORDINGS = [
    'You have been sent {N} RWF by {W+} on {TS}. Your new balance: {N} RWF.',
    'Transfer of {N} RWF from {W+} to your account completed on {TS}. Your new balance: {N} RWF.',
    '{N} RWF has been transferred to your account by {W+} on {TS}. Your new balance: {N} RWF.',
    'Dear customer, {N} RWF was sent to you by {W+}. Your new balance: {N} RWF. {TS}',
    'You have been transferred {N} RWF by {W+} on {TS}. Your new balance: {N} RWF.',
    'Money transfer from {W+}: {N} RWF credited on {TS}. Your new balance: {N} RWF.',
    'Payment from {W+} of {N} RWF credited to your account on {TS}. New balance: {N} RWF.',
    'Kohereza {N} RWF yavuye kuri {W+} {TS}. Ubu mufite {N} RWF.',
];

test('TYPE-DIRECTION-SILENT: incoming-money wordings outside the old cue list are never drafted as outgoing without the admin', () => {
    for (const skeleton of INCOMING_WORDINGS) {
        const guess = guessTypeOfSkeleton(skeleton);
        assert.equal(guess.defaulted, true, `trusted: ${skeleton}`);
        assert.equal(guess.type, 'receive', `the offered default is the direction the text names: ${skeleton}`);
        const draft = draftOf(skeleton, 'mtn');
        const check = named(draft.gate, 'valid-type');
        assert.equal(check.ok, false, `${skeleton}: ${check.detail}`);
        assert.equal(draft.gate.ok, false);
        const picked = draftOf(skeleton, 'mtn', {type: 'receive'});
        assert.equal(named(picked.gate, 'valid-type').ok, true, 'the admin choosing the type clears it');
    }
});

test('TYPE-DIRECTION-SILENT: "credited" alone is enough to say the money came in', () => {
    for (const skeleton of ['Dear customer, {N} RWF credited on {TS}. New balance {N} RWF.', 'Your account has been credited with {N} RWF on {TS}. Balance {N} RWF.']) {
        const guess = guessTypeOfSkeleton(skeleton);
        assert.deepEqual([guess.type, guess.defaulted], ['receive', true], skeleton);
    }
});

test('TYPE-DIRECTION-SILENT: outgoing wordings and the built-in formats are not flagged by the new cues', () => {
    for (const skeleton of [
        'You have transferred {N} RWF to {W+} ({PH}) on {TS}. Fee was {N} RWF. Your new balance: {N} RWF.',
        'Your payment of {N} RWF has been sent to {W+} ({PH}) on {TS}. Balance {N} RWF.',
        '{N} RWF was transferred from your account to {W+} on {TS}. Balance {N} RWF.',
        'Cash withdrawal of {N} RWF from agent {W+} on {TS}. Balance {N} RWF.',
        'You have withdrawn {N} RWF from {W+} ({PH}) on {TS}. Balance {N} RWF.',
    ]) {
        const guess = guessTypeOfSkeleton(skeleton);
        assert.equal(guess.defaulted, false, `${skeleton}: ${guess.reason}`);
    }
    const v = vocab();
    const direction = {transfer: 'out', receive: 'in', payment: 'out', withdraw: 'out', deposit: 'in'};
    let compared = 0;
    for (const p of base.patterns) {
        const [sample] = samplesFor(p);
        if (!sample) continue;
        const guess = guessTypeOfSkeleton(anonymize(sample, v).skeleton);
        compared += 1;
        assert.equal(guess.defaulted, false, `${p.id} is flagged: ${guess.reason}`);
        assert.equal(direction[guess.type], direction[p.type], `${p.id}: the built-in's direction survives the guess`);
    }
    assert.ok(compared >= 35);
});

test('TYPE-DIRECTION-SILENT: approving the pre-filled draft of an incoming wording is refused end to end', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        for (const [i, skeleton] of INCOMING_WORDINGS.slice(0, 3).entries()) {
            const res = await s.submit(submission([{skeleton, carrier: 'mtn'}]), ip(10 + i));
            assert.equal(res.status, 202, res.text);
            const id = shapeId(skeleton);
            const shape = (await s.admin('GET', `/shape/${id}`)).json.shape;
            assert.equal(shape.gate.ok, false);
            const approve = await s.admin('POST', `/shape/${id}/approve`, {draft: shape.draft});
            assert.equal(approve.status, 422, approve.text);
            assert.equal(approve.json.error, 'gate_failed');
        }
        assert.deepEqual(await servedAutoIds(s), []);
    });
});

/* ---------------------------------- APPROVE-RESUME-OVERWRITE-AND-ORPHAN ---------------------------------- */

test('APPROVE-RESUME-OVERWRITE-AND-ORPHAN: a retried approval never overwrites a pattern that another shape owns', async () => {
    const {store, state} = failingOnce((prop, args) => prop === 'hsetnx' && args[0] === K.approved);
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const a = await submitAndRedraft(s, NOVEL, 'mtn', 9, {type: 'transfer', id: 'auto-shared-id'});
            const b = await submitAndRedraft(s, NOVEL_AT, 'mtn', 10, {type: 'transfer', id: 'auto-shared-id'});
            state.armed = true;
            assert.equal((await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft})).status, 503, 'A fails before its pattern is written');
            assert.equal(state.fired, 1);
            assert.equal((await s.admin('POST', `/shape/${b.id}/approve`, {draft: b.draft})).status, 200, 'B takes the id');
            const live = (await s.request('GET', '/manie/sms-formats')).json.patterns.find(p => p.id === 'auto-shared-id');

            const retry = await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft});
            assert.equal(retry.status, 409, retry.text);
            assert.equal(retry.json.error, 'id_conflict');
            const after = (await s.request('GET', '/manie/sms-formats')).json.patterns.find(p => p.id === 'auto-shared-id');
            assert.equal(after.pattern, live.pattern, 'the served pattern is still B\'s');
            assert.equal((await s.admin('GET', `/shape/${b.id}`)).json.shape.approvedId, 'auto-shared-id');
            assert.notEqual((await s.admin('GET', `/shape/${a.id}`)).json.shape.status, 'approved');
        })
    );
});

test('APPROVE-RESUME-OVERWRITE-AND-ORPHAN: a retry that finds no pattern claims the id atomically, so another shape taking it in between wins', async () => {
    const inner = new MemoryStore();
    const hooks = {failNextClaim: false, plantOnMissingGet: null, failed: 0};
    const store = new Proxy(inner, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            return async (...args) => {
                if (hooks.failNextClaim && prop === 'hsetnx' && args[0] === K.approved) {
                    hooks.failNextClaim = false;
                    hooks.failed += 1;
                    throw new Error('injected storage failure');
                }
                const out = await value.apply(target, args);
                if (hooks.plantOnMissingGet && prop === 'hget' && args[0] === K.approved && out === null) {
                    const planted = hooks.plantOnMissingGet;
                    hooks.plantOnMissingGet = null;
                    await target.hset(K.approved, {[planted.id]: planted});
                }
                return out;
            };
        },
    });
    const planted = {
        id: 'auto-raced-id', carrier: 'mtn', locale: 'en-RW', type: 'transfer', pattern: '(\\d+) RWF planted (\\d+)', flags: 'i',
        captureMap: {amount: 1, balance: 2}, tags: ['transfer'], status: 'active',
        createdAt: '2026-10-22T08:00:00.000Z', updatedAt: '2026-10-22T08:00:00.000Z', sourceShapeId: 'ffffffffffffffff',
    };
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const a = await submitAndRedraft(s, NOVEL, 'mtn', 9, {type: 'transfer', id: 'auto-raced-id'});
            hooks.failNextClaim = true;
            assert.equal((await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft})).status, 503);
            assert.equal(hooks.failed, 1);
            hooks.plantOnMissingGet = planted;
            const retry = await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft});
            assert.equal(hooks.plantOnMissingGet, null, 'the other shape\'s pattern appeared between the check and the write');
            assert.equal(retry.status, 409, retry.text);
            assert.equal(retry.json.error, 'id_conflict');
            const stored = await s.store.hget(K.approved, 'auto-raced-id');
            assert.equal(stored.sourceShapeId, 'ffffffffffffffff', 'the other shape still owns the id');
            assert.equal(stored.pattern, planted.pattern, 'and its pattern was not replaced');
        })
    );
});

test('APPROVE-RESUME-OVERWRITE-AND-ORPHAN: a shape may still finish its own interrupted approval under the same id', async () => {
    const {store, state} = failingOnce((prop, args) => prop === 'hset' && String(args[0]).startsWith('manie:shape:') && args[1] && args[1].status === 'approved');
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const a = await submitAndRedraft(s, NOVEL, 'mtn', 9);
            state.armed = true;
            assert.equal((await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft})).status, 503, 'the pattern is live, the shape does not know yet');
            assert.equal((await servedAutoIds(s)).length, 1);
            const retry = await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft});
            assert.equal(retry.status, 200, retry.text);
            assert.equal((await s.admin('GET', `/shape/${a.id}`)).json.shape.status, 'approved');
            assert.equal((await servedAutoIds(s)).length, 1);
        })
    );
});

test('APPROVE-RESUME-OVERWRITE-AND-ORPHAN: approving an interrupted shape under another id switches the first pattern off and keeps track of it', async () => {
    const {store, state} = failingOnce((prop, args) => prop === 'hset' && String(args[0]).startsWith('manie:shape:') && args[1] && args[1].status === 'approved');
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const a = await submitAndRedraft(s, NOVEL, 'mtn', 9);
            state.armed = true;
            assert.equal((await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft})).status, 503);
            const [firstId] = await servedAutoIds(s);
            assert.ok(firstId, 'the first pattern went live before the failure');

            const second = await s.admin('POST', `/shape/${a.id}/approve`, {draft: {...a.draft, id: 'auto-custom-two'}});
            assert.equal(second.status, 200, second.text);
            assert.deepEqual(await servedAutoIds(s), ['auto-custom-two'], 'the first pattern is no longer served');
            const shape = (await s.admin('GET', `/shape/${a.id}`)).json.shape;
            assert.equal(shape.approvedId, 'auto-custom-two');
            assert.deepEqual(shape.previousApprovedIds, [firstId], 'the shape still knows about the first pattern');
            const listed = (await s.admin('GET', '/approved')).json.approved.find(p => p.id === firstId);
            assert.equal(listed.enabled, false);
        })
    );
});

/* ---------------------------------- REJECT-APPROVE-RACE ---------------------------------- */

function slowStore(shouldSlow, ms) {
    const inner = new MemoryStore();
    const state = {armed: false};
    const store = new Proxy(inner, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            return async (...args) => {
                const slow = state.armed && shouldSlow(prop, args);
                if (slow) state.armed = false;
                const out = await value.apply(target, args);
                if (slow) await new Promise(resolve => setTimeout(resolve, ms));
                return out;
            };
        },
    });
    return {store, state};
}

test('REJECT-APPROVE-RACE: a reject that is slow to read cannot overwrite an approval that finishes meanwhile', async () => {
    const {store, state} = slowStore((prop, args) => prop === 'hgetall' && String(args[0]).startsWith('manie:shape:'), 600);
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const {id, draft} = await submitAndRedraft(s, NOVEL, 'mtn', 9);
            state.armed = true;
            const reject = s.admin('POST', `/shape/${id}/reject`, {reason: 'double click'});
            await new Promise(resolve => setTimeout(resolve, 100));
            const approve = await s.admin('POST', `/shape/${id}/approve`, {draft});
            const rejected = await reject;
            assert.equal(approve.status, 409, approve.text);
            assert.equal(approve.json.error, 'approve_in_progress');
            assert.equal(rejected.status, 200);
            const shape = (await s.admin('GET', `/shape/${id}`)).json.shape;
            assert.equal(shape.status, 'rejected');
            assert.deepEqual(await servedAutoIds(s), [], 'a rejected shape has no live pattern');
        })
    );
});

test('REJECT-APPROVE-RACE: a reject that arrives while an approval is running is told to retry, and the approval stands', async () => {
    const {store, state} = slowStore((prop, args) => prop === 'hsetnx' && args[0] === K.approved, 500);
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const {id, draft} = await submitAndRedraft(s, NOVEL, 'mtn', 9);
            state.armed = true;
            const approve = s.admin('POST', `/shape/${id}/approve`, {draft});
            await new Promise(resolve => setTimeout(resolve, 150));
            const reject = await s.admin('POST', `/shape/${id}/reject`, {reason: 'two admins'});
            assert.equal(reject.status, 409, reject.text);
            assert.equal(reject.json.error, 'shape_busy');
            assert.equal((await approve).status, 200);
            const shape = (await s.admin('GET', `/shape/${id}`)).json.shape;
            assert.equal(shape.status, 'approved');
            assert.equal((await servedAutoIds(s)).length, 1);
            assert.equal((await s.admin('GET', '/stats')).json.rejected, 0);
        })
    );
});

test('REJECT-APPROVE-RACE: reopening a shape takes the same lock, so it cannot interleave with an approval', async () => {
    const {store, state} = slowStore((prop, args) => prop === 'hsetnx' && args[0] === K.approved, 500);
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const {id, draft} = await submitAndRedraft(s, NOVEL, 'mtn', 9);
            state.armed = true;
            const approve = s.admin('POST', `/shape/${id}/approve`, {draft});
            await new Promise(resolve => setTimeout(resolve, 150));
            const reopen = await s.admin('POST', `/shape/${id}/reopen`);
            assert.equal(reopen.status, 409, reopen.text);
            assert.equal(reopen.json.error, 'shape_busy');
            assert.equal((await approve).status, 200);
        })
    );
});

/* ---------------------------------- REOPEN-NOT-IDEMPOTENT ---------------------------------- */

function faulty() {
    const inner = new MemoryStore();
    const state = {armed: false, mode: 'before', count: 0, target: -1, fired: false};
    const store = new Proxy(inner, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function' || ['flush', 'snapshot'].includes(String(prop))) return value;
            return async (...args) => {
                if (!state.armed) return value.apply(target, args);
                const n = state.count++;
                if (n === state.target && !state.fired) {
                    state.fired = true;
                    if (state.mode === 'before') throw new Error('injected');
                    await value.apply(target, args);
                    throw new Error('injected-after');
                }
                return value.apply(target, args);
            };
        },
    });
    return {store, state};
}

const REOPEN_LEFTOVERS = ['approvedId', 'approvedAt', 'approvingId', 'rejectedAt', 'rejectReason', 'draft', 'gate', 'gateHash', 'draftEdited'];

async function assertReopened(s, id, label) {
    const stored = await s.store.hgetall(K.shape(id));
    assert.equal(stored.status, 'pending', `${label}: status`);
    assert.notEqual(await s.store.zscore(K.pending, id), null, `${label}: queued`);
    assert.equal((await s.store.smembers(K.approvedShapes)).includes(id), false, `${label}: still counted as approved`);
    assert.equal((await s.store.smembers(K.rejectedShapes)).includes(id), false, `${label}: still counted as rejected`);
    for (const field of REOPEN_LEFTOVERS) assert.equal(stored[field], undefined, `${label}: ${field} left over`);
}

for (const [scenario, prepare] of [
    ['a rejected shape', async (s, id) => {
        assert.equal((await s.admin('POST', `/shape/${id}/reject`, {})).status, 200);
    }],
    ['an approved and disabled shape', async (s, id, draft) => {
        const approved = await s.admin('POST', `/shape/${id}/approve`, {draft});
        assert.equal(approved.status, 200, approved.text);
        assert.equal((await s.admin('POST', `/approved/${approved.json.id}/disable`)).status, 200);
    }],
]) {
    test(`REOPEN-NOT-IDEMPOTENT: reopening ${scenario} that fails at any step is completed by a retry`, async () => {
        for (const mode of ['before', 'after']) {
            for (let k = 0; k < 14; k++) {
                const {store, state} = faulty();
                await quiet(() =>
                    withServer({env: PROXY_ENV, store}, async s => {
                        await seedMoved(s);
                        const {id, draft} = await submitAndRedraft(s, NOVEL, 'mtn', 9);
                        await prepare(s, id, draft);
                        Object.assign(state, {armed: true, mode, count: 0, target: k, fired: false});
                        const first = await s.admin('POST', `/shape/${id}/reopen`);
                        state.armed = false;
                        if (!state.fired) {
                            assert.equal(first.status, 200);
                            await assertReopened(s, id, `${scenario} ${mode} k=${k} (no fault reached)`);
                            return;
                        }
                        await s.store.del(K.approveLock(id));
                        const retry = await s.admin('POST', `/shape/${id}/reopen`);
                        assert.ok([200, 409].includes(retry.status), `${mode} k=${k}: retry answered ${retry.status} ${retry.text}`);
                        await assertReopened(s, id, `${scenario} ${mode} k=${k}`);
                    })
                );
            }
        }
    });
}

test('REOPEN-NOT-IDEMPOTENT: a retry that finishes an interrupted reopen says so, a double click still gets "already pending"', async () => {
    const {store, state} = failingOnce((prop, args) => prop === 'hdel' && String(args[0]).startsWith('manie:shape:') && args.includes('approvedId'));
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const {id} = await submitAndRedraft(s, NOVEL, 'mtn', 9);
            await s.admin('POST', `/shape/${id}/reject`, {reason: 'later'});
            state.armed = true;
            assert.equal((await s.admin('POST', `/shape/${id}/reopen`)).status, 503);
            assert.equal(state.fired, 1);
            await s.store.del(K.approveLock(id));
            const retry = await s.admin('POST', `/shape/${id}/reopen`);
            assert.equal(retry.status, 200, retry.text);
            assert.equal(retry.json.recovered, true);
            await assertReopened(s, id, 'recovered');
            const again = await s.admin('POST', `/shape/${id}/reopen`);
            assert.equal(again.status, 409);
            assert.equal(again.json.error, 'already_pending');
        })
    );
});

/* ---------------------------------- QUEUE-SYBIL-LOCK ---------------------------------- */

async function withLimits(patch, fn) {
    const saved = {};
    for (const key of Object.keys(patch)) saved[key] = LIMITS[key];
    Object.assign(LIMITS, patch);
    try {
        await fn();
    } finally {
        Object.assign(LIMITS, saved);
    }
}

const fakeId = n => n.toString(16).padStart(16, '0');
// five voters, created a few days ago (older i is older): the shape of a queue that junk has filled
const junkScore = i => 5 + (Date.now() - (60 - i) * 86400000) / 1e14;

test('QUEUE-SYBIL-LOCK: a queue full of shapes with enough voters still takes a genuine new format and evicts the lowest ranked', async () => {
    await withLimits({maxPending: 40}, async () => {
        await withServer({env: PROXY_ENV}, async s => {
            await seedMoved(s);
            const junk = Array.from({length: 40}, (_, i) => fakeId(i + 1));
            for (const [i, id] of junk.entries()) await s.store.zadd(K.pending, junkScore(i), id);
            assert.equal(await s.store.zcard(K.pending), 40);

            const res = await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]), ip(9));
            assert.deepEqual(res.json, {accepted: 1, deduped: 0, discarded: 0}, 'the genuine format is queued, not discarded');
            assert.equal(await s.store.zcard(K.pending), 40);
            assert.notEqual(await s.store.zscore(K.pending, shapeId(NOVEL)), null);
            assert.equal(await s.store.zscore(K.pending, junk[0]), null, 'the lowest ranked junk shape made room');
            const shield = Math.floor(40 * LIMITS.protectedShare);
            for (const id of junk.slice(-shield)) assert.notEqual(await s.store.zscore(K.pending, id), null, 'the best-voted quarter is shielded');
            const stats = (await s.admin('GET', '/stats')).json;
            assert.equal(stats.evicted, 1);
            assert.equal(stats.evicted24h, 1);
        });
    });
});

test('QUEUE-SYBIL-LOCK: the shield is a ranking, so it holds only the best-voted quarter however many shapes reach the threshold', async () => {
    await withLimits({maxPending: 40}, async () => {
        await withServer({env: PROXY_ENV}, async s => {
            await seedMoved(s);
            for (let i = 0; i < 40; i++) await s.store.zadd(K.pending, junkScore(i), fakeId(i + 1));
            const submitNew = async n => {
                const skeleton = `${NOVEL}${'!'.repeat(n)}`;
                const res = await s.submit(submission([{skeleton, carrier: 'mtn'}]), ip(20 + n));
                assert.equal(res.json.accepted, 1, `new shape ${n} was refused`);
            };
            for (let n = 1; n <= 12; n++) await submitNew(n);
            const survivors = (await s.store.zrange(K.pending, 0, -1)).filter(id => /^0{10}/.test(id));
            assert.equal(survivors.length, 40 - 12, 'every new shape displaced one junk shape');
            for (let n = 1; n <= 12; n++) assert.notEqual(await s.store.zscore(K.pending, shapeId(`${NOVEL}${'!'.repeat(n)}`)), null, `new shape ${n} was pushed out by a later newcomer`);
            for (let i = 40 - 10; i < 40; i++) assert.notEqual(await s.store.zscore(K.pending, fakeId(i + 1)), null, 'the shielded top ten never moved');
        });
    });
});

test('QUEUE-SYBIL-LOCK: a bulk reject clears the lowest-ranked shapes in bounded batches', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await seedMoved(s);
        const skeletons = Array.from({length: 6}, (_, i) => `${NOVEL}${'!'.repeat(i + 1)}`);
        for (const [i, skeleton] of skeletons.entries()) assert.equal((await s.submit(submission([{skeleton, carrier: 'mtn'}]), ip(30 + i))).status, 202);
        for (const n of [40, 41]) await s.submit(submission([{skeleton: skeletons[0], carrier: 'mtn'}]), ip(n));
        assert.equal((await s.admin('GET', '/stats')).json.pending, 6);

        const dry = await s.admin('POST', '/pending/reject', {maxVoters: 1, olderThanHours: 24});
        assert.equal(dry.status, 200, dry.text);
        assert.equal(dry.json.rejected, 0, 'nothing is old enough yet');

        const res = await s.admin('POST', '/pending/reject', {maxVoters: 1, limit: 3, reason: 'junk'});
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.rejected, 3, 'a batch is bounded by limit');
        assert.equal(res.json.remaining, 3);
        const rest = await s.admin('POST', '/pending/reject', {maxVoters: 1});
        assert.equal(rest.json.rejected, 2, 'the shape that three devices reported is not low-vote');
        assert.equal(rest.json.remaining, 1);
        assert.notEqual(await s.store.zscore(K.pending, shapeId(skeletons[0])), null);
        const stats = (await s.admin('GET', '/stats')).json;
        assert.equal(stats.rejected, 5);
        const rejected = (await s.admin('GET', `/shape/${shapeId(skeletons[1])}`)).json.shape;
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.rejectReason, 'junk');
        for (const bad of [{}, {maxVoters: 0}, {maxVoters: 1, limit: 101}, {maxVoters: 1, extra: 1}, {maxVoters: 'x'}]) {
            assert.equal((await s.admin('POST', '/pending/reject', bad)).status, 400, JSON.stringify(bad));
        }
        assert.equal((await s.request('POST', '/manie/admin/api/pending/reject', {body: {maxVoters: 1}})).status, 401);
    });
});

/* ---------------------------------- COVERAGE-SANDBOX-CLIFF ---------------------------------- */

function baseWithExtraPatterns(count, tag) {
    const config = loadBaseConfig();
    const extras = Array.from({length: count}, (_, i) => ({
        id: `cov-${tag}-${String(i).padStart(3, '0')}`,
        carrier: 'mtn',
        locale: 'en-RW',
        type: 'payment',
        pattern: `.*?zz${tag}x${i}y\\s+([\\d,.]+)\\s+balance\\s+([\\d,.]+)`,
        flags: 'i',
        captureMap: {amount: 1, balance: 2},
        tags: ['payment'],
        status: 'active',
    }));
    return {...config, patterns: [...config.patterns, ...extras]};
}

test('COVERAGE-SANDBOX-CLIFF: with more served patterns than the old cache cap, later requests reuse the sandboxes', async () => {
    await withLimits({coverageBudgetMs: 60000}, async () => {
        const served = baseWithExtraPatterns(200, 'cliff');
        await withServer({env: PROXY_ENV, base: served, servedTtlMs: 60000}, async s => {
            const batch = n => Array.from({length: 20}, (_, i) => ({skeleton: `you got news {N} RWF today balance {N} RWF ${'!'.repeat(n * 20 + i + 1)}`, carrier: 'mtn'}));
            const created = [COVERAGE_STATS.created];
            for (let n = 0; n < 4; n++) {
                assert.equal((await s.submit(submission(batch(n)), wideIp(n + 1))).status, 202);
                created.push(COVERAGE_STATS.created);
            }
            assert.ok(created[1] - created[0] >= 200, 'the first request builds the sandboxes');
            assert.ok(created[1] - created[0] <= served.patterns.length, 'and builds each of them once');
            assert.equal(created[2] - created[1], 0, 'the second request builds none');
            assert.equal(created[4] - created[3], 0, 'nor does the fourth');
        });
    });
});

test('COVERAGE-SANDBOX-CLIFF: the time budget and the repeated-timeout skip of the coverage check are in force', async () => {
    const covered = '{N} RWF transferred to {W+}({PH}) at {TS}. Fee was: {N} RWF. New balance: {N} RWF';
    await withServer({env: PROXY_ENV}, async s => {
        const before = COVERAGE_STATS.budgetStops;
        await withLimits({coverageBudgetMs: -1}, async () => {
            const res = await s.submit(submission([{skeleton: covered, carrier: 'mtn'}]), ip(60));
            assert.deepEqual(res.json, {accepted: 1, deduped: 0, discarded: 0}, 'with no budget left the check gives up and the shape is queued');
        });
        assert.ok(COVERAGE_STATS.budgetStops > before);
        const res = await s.submit(submission([{skeleton: `${covered}!`, carrier: 'mtn'}]), ip(61));
        assert.deepEqual(res.json, {accepted: 0, deduped: 0, discarded: 1}, 'with its budget the same check finds the covering pattern');
    });

    const evil = loadBaseConfig();
    evil.patterns = [
        {id: 'evil-slow', carrier: 'mtn', locale: 'en-RW', type: 'payment', pattern: '^(?:\\d+\\s?)+!', flags: 'i', captureMap: {amount: 1, balance: 1}, tags: ['payment'], status: 'active'},
        ...evil.patterns,
    ];
    await withServer({env: PROXY_ENV, base: evil, servedTtlMs: 60000}, async s => {
        const skippedBefore = COVERAGE_STATS.skipped;
        const items = Array.from({length: 12}, (_, i) => ({skeleton: `${'{N} '.repeat(60 + i)}RWF`, carrier: 'mtn'}));
        const started = Date.now();
        const res = await s.submit(submission(items), ip(62));
        assert.equal(res.status, 202, res.text);
        assert.ok(COVERAGE_STATS.skipped - skippedBefore >= 6, 'after three timeouts the slow pattern is skipped instead of being timed on every item');
        assert.ok(Date.now() - started < 3000, 'and the request stays short');
    });
});

/* ---------------------------------- STORAGE-DEGRADED-200 ---------------------------------- */

test('STORAGE-DEGRADED-200: production without a persistent store refuses the config instead of serving the base file as current', async () => {
    const production = {VERCEL: '1', NODE_ENV: 'production', MANIE_ADMIN_TOKEN: TOKEN, MANIE_HASH_SALT: 'prod-salt-0123456789abcdef'};
    await quiet(() =>
        withServer({env: production}, async s => {
            const res = await s.request('GET', '/manie/sms-formats');
            assert.equal(res.status, 503);
            assert.equal(res.headers.get('x-manie-degraded'), 'storage');
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.ok(Number(res.headers.get('retry-after')) > 0);
            assert.equal(res.json.patterns, undefined);
        })
    );
    await withServer({env: {MANIE_ADMIN_TOKEN: TOKEN}}, async s => {
        const res = await s.request('GET', '/manie/sms-formats');
        assert.equal(res.status, 200, 'development keeps serving the base file');
        assert.equal(res.json.patterns.length, base.patterns.length);
    });
});

/* ---------------------------------- F2 ---------------------------------- */

const H = require('./_clientHarness');
const COHORT_REF = '4bd236f^';
const skipClient = H.unavailableReason() || false;
const COHORT = skipClient ? null : H.extractReleasedClient(COHORT_REF);

test('F2: the one-group Airtel rule reads as an invalid date on app builds from before 2026-02-19, and the gate says so', {skip: skipClient || (COHORT ? false : `the app at ${COHORT_REF} is not available`)}, () => {
    const old = H.loadClient(H.makeEnv(), {root: COHORT});
    const full = old.classify.__parseAirtelTimestamp('PP260411.1430.A12345');
    assert.ok(Number.isNaN(full), 'those builds (Android before 0.0.32) read the two letters as part of the date');
    assert.ok(Number.isFinite(old.classify.__parseAirtelTimestamp('260411.1430')), 'they only read the bare form');

    const draft = draftOf('*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#', 'airtel', {type: 'transfer'});
    assert.equal(draft.gate.ok, true, 'a known limit of the owner decision, not a failure');
    const warning = named(draft.gate, 'ios-timestamp');
    assert.equal(warning.warn, true);
    assert.match(warning.detail, /Android builds before 0\.0\.32/);
});

/* ---------------------------------- F3 ---------------------------------- */

const AIRTEL_SKELETON = '*{N}*TID:{TID}*S* Airtime of Rwf {N} done to {PH}. Balance: Rwf {N} *EN#';
const {TID_REGEX} = require('../../lib/manie/_fields');

test('F3: a loosened transaction-code group is refused whatever it was loosened to, aligned with the skeleton or not', () => {
    const draft = draftOf(AIRTEL_SKELETON, 'airtel', {type: 'payment'});
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
    const loosened = [
        ['month and day any digits', '([A-Za-z]{2}\\d+\\.\\d+\\.[A-Za-z]\\d+)'],
        ['one or two prefix letters', '([A-Za-z]{1,2}\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\.(?:[01]\\d|2[0-3])[0-5]\\d\\.[A-Za-z]\\d+)'],
        ['two or three prefix letters', '([A-Za-z]{2,3}\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\.(?:[01]\\d|2[0-3])[0-5]\\d\\.[A-Za-z]\\d+)'],
        ['optional dot between date and time', '([A-Za-z]{2}\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\.?(?:[01]\\d|2[0-3])[0-5]\\d\\.[A-Za-z]\\d+)'],
        ['optional digits after the letter', '([A-Za-z]{2}\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\.(?:[01]\\d|2[0-3])[0-5]\\d\\.[A-Za-z]\\d*)'],
    ];
    for (const [label, group] of loosened) {
        const pattern = draft.pattern.replace(TID_REGEX, group);
        assert.notEqual(pattern, draft.pattern);
        const aligned = gateOf(draft, {pattern});
        assert.equal(named(aligned, 'self-match').ok, false, `${label}: ${named(aligned, 'self-match').detail}`);
        const unaligned = gateOf(draft, {pattern: `${pattern}(.*)`});
        assert.equal(named(unaligned, 'self-match').ok, false, `${label}, with an extra trailing group so that the layout no longer lines up: ${named(unaligned, 'self-match').detail}`);
        assert.equal(unaligned.ok, false);
    }
});

test('F3: the near-miss probe is every single-edit variant of a real code that is not a real code, not a hand-picked sample', () => {
    const {MALFORMED_AIRTEL_CODES, airtelReferenceDate} = require('../../lib/manie/gate');
    assert.ok(MALFORMED_AIRTEL_CODES.length > 100, `only ${MALFORMED_AIRTEL_CODES.length} codes`);
    for (const code of MALFORMED_AIRTEL_CODES) assert.equal(Number.isFinite(airtelReferenceDate(code)), false, `${code} is a real code`);
    for (const code of ['P260411.1430.A12345', 'APP260411.1430.A12345', 'PP2604111430.A12345', 'PP260411.1430A12345', 'PP260411.1430.12345', 'PP261301.1430.A12345']) {
        assert.ok(MALFORMED_AIRTEL_CODES.includes(code), `${JSON.stringify(code)} is not probed`);
    }
});

test('F3: the generated transaction-code group passes, and a hand-edited approve body with a loosened group is refused by the endpoint', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        const res = await s.submit(submission([{skeleton: AIRTEL_SKELETON, carrier: 'airtel'}]), ip(70));
        assert.equal(res.status, 202, res.text);
        const id = shapeId(AIRTEL_SKELETON, 'airtel');
        const shape = (await s.admin('GET', `/shape/${id}`)).json.shape;
        assert.equal(shape.gate.ok, true, JSON.stringify(shape.gate.checks.filter(c => !c.ok)));
        const loose = {...shape.draft, pattern: `${shape.draft.pattern.replace(TID_REGEX, '([A-Za-z]{2}\\d{6}\\.\\d{4}\\.[A-Za-z]\\d+)')}(.*)`};
        const refused = await s.admin('POST', `/shape/${id}/approve`, {draft: loose});
        assert.equal(refused.status, 422, refused.text);
        assert.equal(refused.json.error, 'gate_failed');
        assert.deepEqual(await servedAutoIds(s), []);
        assert.equal((await s.admin('POST', `/shape/${id}/approve`, {draft: shape.draft})).status, 200);
    });
});

/* ---------------------------------- F4 ---------------------------------- */

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'manie', 'admin.html'), 'utf8');

function runSyncEditor(edit) {
    const source = /function syncEditor\(D, full\) \{[\s\S]*?\n\}\n/.exec(ADMIN_HTML)[0];
    const marks = {};
    const element = key => ({
        value: '',
        disabled: false,
        className: '',
        textContent: '',
        classList: {toggle: (name, on) => { if (name === 'bad') marks[key] = Boolean(on); }},
    });
    const roleKeys = ['amount', 'fee', 'balance', 'transactionId'];
    const D = {
        refs: {type: element('type'), id: element('id'), idErr: element('idErr'), tsParser: element('tsParser'), tsGroup: element('tsGroup'), tsSwatch: element('tsSwatch'), groupN: 6, roles: {}},
        edit,
        groups: [1, 2, 3, 4, 5, 6],
        test: {result: null},
    };
    for (const key of roleKeys) D.refs.roles[key] = {sel: element(key), sw: element(`${key}-swatch`), samp: element(`${key}-samp`)};
    const context = vm.createContext({
        ROLES: roleKeys.map(key => ({key})),
        fillGroupOptions() {},
        gcls: n => `g${n}`,
        ID_RE: /^[a-z0-9-]{3,61}$/,
        document: {activeElement: null},
        D,
    });
    vm.runInContext(`${source}\nsyncEditor(D, false);`, context);
    return marks;
}

test('F4: the editor does not mark the shared Airtel code group as an error, and still marks real clashes', () => {
    const edit = (patch = {}) => ({type: 'payment', id: 'auto-airtel-1', tsParser: 'airtel-shortcode', tsGroup: 2, captureMap: {amount: 1, transactionId: 2, balance: 3}, ...patch});
    const shared = runSyncEditor(edit());
    assert.deepEqual(Object.entries(shared).filter(([, bad]) => bad), [], 'one group for the transaction id and the airtel-shortcode timestamp is how an Airtel draft is built');
    const clash = runSyncEditor(edit({captureMap: {amount: 1, transactionId: 2, balance: 3, fee: 2}}));
    assert.equal(clash.tsGroup, true);
    assert.equal(clash.fee, true, 'a third role on the same group is a real clash');
    const iso = runSyncEditor(edit({tsParser: 'iso8601', tsGroup: 1}));
    assert.equal(iso.tsGroup, true, 'an ISO timestamp cannot share the amount group');
    assert.equal(iso.amount, true);
});

/* ---------------------------------- PRIV-03 ---------------------------------- */

const SECOND_SKELETON = 'Payment of {N} RWF to {W+} ({PH}) at {TS} was {W}. Fee {N} RWF. Balance {N} RWF';

test('PRIV-03: approving an ordinary draft adds no word to the served vocabulary that was not already there as text of the pattern', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await seedMoved(s);
        const before = new Set((await s.request('GET', '/manie/sms-formats')).json.vocabulary);
        const {id, draft} = await submitAndRedraft(s, NOVEL, 'mtn', 9);
        assert.equal((await s.admin('POST', `/shape/${id}/approve`, {draft})).status, 200);
        const after = (await s.request('GET', '/manie/sms-formats')).json.vocabulary;
        const gained = after.filter(w => !before.has(w));
        assert.deepEqual(gained, [], `the guard and the timestamp expression leaked words into the vocabulary: ${gained.join(', ')}`);
        assert.equal(after.includes('z'), false);
    });
    for (const word of ['fail', 'failed', 'on hold', 'timed', 'out']) assert.deepEqual(literalWordsOfRegexSource(`(?:(?!${NEGATION_SOURCE})[\\s\\S])`), [], word);
    assert.deepEqual(literalWordsOfRegexSource('in\\s+(?!MTN\\s+RWANDA)(.*?)\\.'), ['in', 'mtn', 'rwanda'], 'other lookaheads still count as text');
});

test('PRIV-03: a word the vocabulary endpoint refuses cannot reach the served vocabulary through a draft either', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await s.admin('POST', '/vocab', {add: ['remitted']});
        const submitted = await s.submit(submission([{skeleton: SECOND_SKELETON, carrier: 'mtn'}]), ip(80));
        assert.equal(submitted.status, 202, submitted.text);
        const id = shapeId(SECOND_SKELETON);
        const refused = await s.admin('POST', `/shape/${id}/redraft`, {type: 'payment', wordsAsLiteral: ['Grace']});
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.json.error, 'restricted_word');
        assert.deepEqual(refused.json.words, ['grace']);
        assert.equal((await s.admin('POST', `/shape/${id}/redraft`, {type: 'payment', wordsAsLiteral: ['4:Grace']})).status, 409, 'the slot prefix does not hide it');

        const forced = await s.admin('POST', `/shape/${id}/redraft`, {type: 'payment', wordsAsLiteral: ['Grace'], force: true});
        assert.equal(forced.status, 200, forced.text);
        assert.equal(forced.json.gate.ok, true, JSON.stringify(forced.json.gate.checks.filter(c => !c.ok)));
        const approve = await s.admin('POST', `/shape/${id}/approve`, {draft: forced.json.draft});
        assert.equal(approve.status, 409, 'approval asks again, since the word would join the vocabulary');
        assert.equal(approve.json.error, 'restricted_word');
        assert.equal((await s.request('GET', '/manie/sms-formats')).json.vocabulary.includes('grace'), false);
        const done = await s.admin('POST', `/shape/${id}/approve`, {draft: forced.json.draft, force: true});
        assert.equal(done.status, 200, done.text);
        assert.equal((await s.request('GET', '/manie/sms-formats')).json.vocabulary.includes('grace'), true, 'an explicit force is the admin\'s decision');
        assert.equal((await s.admin('POST', `/shape/${id}/redraft`, {force: 'yes'})).status, 400);
    });
});

/* ---------------------------------- UNPINNED-FIXES ---------------------------------- */

test('UNPINNED-FIXES (REL-09): a shape whose approval was interrupted cannot be reopened and orphan its live pattern', async () => {
    const {store, state} = failingOnce((prop, args) => prop === 'hset' && String(args[0]).startsWith('manie:shape:') && args[1] && args[1].status === 'approved');
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const {id, draft} = await submitAndRedraft(s, NOVEL, 'mtn', 9);
            state.armed = true;
            assert.equal((await s.admin('POST', `/shape/${id}/approve`, {draft})).status, 503);
            assert.equal((await servedAutoIds(s)).length, 1);
            const reopen = await s.admin('POST', `/shape/${id}/reopen`);
            assert.equal(reopen.status, 409, reopen.text);
            assert.equal(reopen.json.error, 'approval_in_progress');
            assert.equal((await s.admin('GET', `/shape/${id}`)).json.shape.revision, 1, 'the revision did not move');
        })
    );
});

test('UNPINNED-FIXES (REL-04): a shape stores at most maxVoters distinct voters, however many addresses report it', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await seedMoved(s);
        const total = LIMITS.maxVoters + 30;
        for (let n = 0; n < total; n++) assert.equal((await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]), wideIp(n))).status, 202);
        const stored = await s.store.hgetall(K.shape(shapeId(NOVEL)));
        const voters = Object.keys(stored).filter(field => field.startsWith('v:')).length;
        assert.equal(voters, LIMITS.maxVoters, 'the voter fields stop at the cap');
        assert.equal(Number(stored.count), LIMITS.maxVoters, 'and so does the count they back');
    });
});

test('UNPINNED-FIXES (REL-06): after a few failures the circuit opens and the next requests are answered at once', async () => {
    class HangingStore extends MemoryStore {
        async _run() {
            return new Promise(() => {});
        }
    }
    await quiet(() =>
        withServer({store: new HangingStore(), guard: {callTimeoutMs: 400, openMs: 60000}}, async s => {
            const first = Date.now();
            assert.equal((await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]))).status, 503);
            assert.ok(Date.now() - first >= 350, 'the first request really waited for the store');
            const started = Date.now();
            for (let i = 0; i < 4; i++) assert.equal((await s.request('GET', '/manie/sms-formats')).status, 503);
            assert.ok(Date.now() - started < 300, `four requests behind an open circuit took ${Date.now() - started} ms, so each waited for the store`);
        })
    );
});

test('UNPINNED-FIXES (REL-11): a cached gate result is recomputed when the served config changes, also for a single shape', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await seedMoved(s);
        await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]), ip(9));
        const id = shapeId(NOVEL);
        assert.equal((await s.admin('GET', `/shape/${id}`)).status, 200);
        const first = (await s.store.hgetall(K.shape(id))).gateHash;
        assert.ok(first, 'the gate result was cached with the config it was computed against');
        await s.admin('POST', '/vocab', {add: ['zebra']});
        assert.equal((await s.admin('GET', `/shape/${id}`)).status, 200);
        const second = (await s.store.hgetall(K.shape(id))).gateHash;
        assert.notEqual(second, first, 'the stale gate result was thrown away');
    });
});

test('UNPINNED-FIXES (R2-NAME-SLOT): a name mapped onto the greeting is refused when it is the only thing wrong with it', () => {
    const skeleton = 'Dear {W+}, you have paid {N} RWF. Balance {N} RWF. {TS}';
    const draft = draftOf(skeleton, 'mtn', {type: 'payment'});
    const greetingGroup = slotGroup(skeleton, 1);
    assert.equal(draft.captureMap.secondParty, undefined, 'the greeting slot is never picked for the other party');
    const patched = gateOf(draft, {captureMap: {...draft.captureMap, secondParty: greetingGroup}});
    const check = named(patched, 'name-slot');
    assert.equal(check.ok, false);
    assert.match(check.detail, /follows a greeting/);
});

test('UNPINNED-FIXES (R2-NUMBER): a number slot accepts digit groups with single separators, not any run of digits, dots and commas', () => {
    const re = new RegExp(`^${NUMBER_REGEX}$`);
    for (const good of ['5', '5000', '5,000', '1,234,567.89', '12.50']) assert.equal(re.test(good), true, good);
    for (const bad of ['...', ',,,', '1..2', '1,,2', '.5', '5.', '1,2,3,4,5,6,7,8,9,1,2,3,4,5,6,7,8']) assert.equal(re.test(bad), false, bad);
    assert.doesNotMatch(NUMBER_REGEX, /\[\\d,\.\]\+/);
});

test('UNPINNED-FIXES: the per-instance request pre-filter, the admin vocabulary cap and the gate timing limits keep their values', async () => {
    const gate = require('../../lib/manie/gate');
    assert.deepEqual([gate.EXEC_LIMIT_MS, gate.STRESS_LIMIT_MS, gate.GROWTH_FLOOR_MS, gate.GROWTH_RATIO], [25, 5, 2, 6]);
    assert.equal(RATE_LIMITS.localRequestsPer10Min, 120);
    await withServer({env: PROXY_ENV}, async s => {
        const item = [{skeleton: `${NOVEL}`, carrier: 'mtn'}];
        let refused = 0;
        for (let i = 0; i < RATE_LIMITS.localRequestsPer10Min + 1; i++) {
            const res = await s.submit(submission(item), ip(90));
            if (res.status === 429) refused += 1;
        }
        assert.equal(refused, 1, 'the 121st request of one address in ten minutes is refused before any counter is touched');
    });
    await withLimits({maxAdminVocab: 3}, async () => {
        await withServer({env: PROXY_ENV}, async s => {
            assert.equal((await s.admin('POST', '/vocab', {add: ['alpha', 'bravo', 'charlie']})).status, 200);
            const full = await s.admin('POST', '/vocab', {add: ['delta']});
            assert.equal(full.status, 409);
            assert.equal(full.json.error, 'vocab_full');
        });
    });
});

/* ---------------------------------- BUILTIN-MTN-TRANSFER-CUBIC ---------------------------------- */

// Not fixable here: the app runs its compiled-in patterns first and appends the served ones, so
// changing sms-formats.json would not change what a phone does. The numbers are tracked so that the
// fix in the app (src/lib/utils/classify.ts, and the same patterns in ios/RegexPatternProvider.swift)
// shows up as this todo turning into a pass.
test('BUILTIN-MTN-TRANSFER-CUBIC: the built-in transfer patterns hold the time limit the gate imposes on new patterns', {todo: 'mtn-transfer-v1/v3/v4 are cubic in the message length (about 165 ms at 1,900 characters on V8, a phone is slower); the app must bound the input or the gaps (see the review notes)'}, () => {
    const pattern = base.patterns.find(p => p.id === 'mtn-transfer-v4');
    const re = new RegExp(pattern.pattern, pattern.flags);
    const message = '1000 RWF '.repeat(211).slice(0, 1900);
    re.test(message);
    const started = process.hrtime.bigint();
    re.test(message);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs <= 25, `${elapsedMs.toFixed(1)} ms for ${message.length} characters (limit 25 ms)`);
});
