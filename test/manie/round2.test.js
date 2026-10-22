'use strict';

// Regression tests for the second audit round. Every test name starts with the id of
// the finding it pins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const {startServer, submission, TOKEN, MemoryStore} = require('./helpers');
const {anonymize, sanitizeSkeleton, canonicalSkeleton, shapeId: rawShapeId} = require('../../lib/manie/anonymize');
const {draftFromShape: rawDraftFromShape} = require('../../lib/manie/draft');
const {runGate: rawRunGate, iosCanParseTimestamp, CHECK_NAMES} = require('../../lib/manie/gate');
const {isNoiseSkeleton} = require('../../lib/manie/noise');
const {buildVocabulary} = require('../../lib/manie/vocab');
const {ambiguousSlotChains, guessTypeOfSkeleton, layoutOf, PHONE_REGEX, SEPARATOR_CLASS, SEPARATOR_REGEX} = require('../../lib/manie/_fields');
const {NEGATION_SOURCE, NEGATION_PHRASES} = require('../../lib/manie/_negation');
const {TS_VALUES} = require('../../lib/manie/_synth');
const seed = require('../../assets/manie/vocab-seed.json');
const base = require('../../assets/manie/sms-formats.json');

globalThis.__DEV__ = false;

const SALT = 'round2-salt-0123456789abcdef';
const PROXY_ENV = {MANIE_ADMIN_TOKEN: TOKEN, MANIE_TRUST_PROXY: '1', MANIE_HASH_SALT: SALT};
const ip = n => ({'X-Forwarded-For': `203.0.113.${n}`});
const shapeId = (skeleton, carrier = 'mtn') => rawShapeId(canonicalSkeleton(skeleton), carrier);

const vocab = (extra = []) => new Set(buildVocabulary({seed: [...seed, ...extra], patterns: base.patterns, adminWords: []}));
const draftOf = (skeleton, carrier = 'mtn', overrides, extra) =>
    rawDraftFromShape({skeleton, carrier, count: 3, ...extra}, overrides, {existingPatterns: base.patterns});
const gateOf = (draft, patch = {}) => rawRunGate({...draft, ...patch}, {existingPatterns: base.patterns});
const named = (result, name) => result.checks.find(c => c.name === name);
const failedChecks = result => result.checks.filter(c => !c.ok).map(c => c.name);
const matches = (draft, body) => new RegExp(draft.pattern, draft.flags).test(body);

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

const NOVEL = 'Dear customer {N} RWF has been moved to {W+} ({PH}) on {TS}. Fee: {N} RWF. Balance: {N} RWF.';
const seedMoved = s => s.admin('POST', '/vocab', {add: ['moved']});

async function submitAndRedraft(s, skeleton, carrier, ipN, overrides = {type: 'transfer'}) {
    const res = await s.submit(submission([{skeleton, carrier}]), ip(ipN));
    assert.equal(res.status, 202, res.text);
    const id = shapeId(skeleton, carrier);
    const redraft = await s.admin('POST', `/shape/${id}/redraft`, overrides);
    assert.equal(redraft.status, 200, redraft.text);
    return {id, draft: redraft.json.draft, gate: redraft.json.gate};
}

function failingOnce(match) {
    const inner = new MemoryStore();
    const state = {armed: false, fired: 0};
    const store = new Proxy(inner, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            return (...args) => {
                if (state.armed && match(prop, args)) {
                    state.armed = false;
                    state.fired += 1;
                    return Promise.reject(new Error('injected storage failure'));
                }
                return value.apply(target, args);
            };
        },
    });
    return {store, state};
}

/* ---------------------------------- R2-ATK-1 ---------------------------------- */

const REDOS_SKELETONS = [
    ['six dot-separated numbers', 'mtn', 'you have received {N} RWF from {W+} on {TS} Balance {N} RWF ref {N}.{N}.{N}.{N}.{N}.{N} thank you'],
    ['five dot-separated numbers', 'mtn', 'you have received {N} RWF from {W+} on {TS} Balance {N} RWF ref {N}.{N}.{N}.{N}.{N} thank you'],
    ['six dot-separated numbers with a transaction id', 'airtel', '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. BAL Rwf {N}. ref {N}.{N}.{N}.{N}.{N}.{N} *EN#'],
    ['five colon-separated free-text slots', 'mtn', 'you have received {N} RWF from {W+}:{W+}:{W+}:{W+}:{W+} on {TS} Balance {N} RWF thank you'],
    ['adjacent numbers', 'mtn', 'you have received {N} RWF from {W+} on {TS} Balance {N}{N} RWF'],
    ['number glued to a phone', 'mtn', 'you have received {N} RWF from {W+} on {TS} Balance {N}{PH} RWF'],
];

test('R2-ATK-1: skeletons that chain variable slots through characters both can match fail the redos guard', () => {
    for (const [label, carrier, skeleton] of REDOS_SKELETONS) {
        const draft = draftOf(skeleton, carrier, {type: 'receive'});
        const check = named(draft.gate, 'redos-guard');
        assert.equal(check.ok, false, `${label}: ${check.detail}`);
        assert.match(check.detail, /touch/, label);
        assert.equal(draft.gate.ok, false, label);
    }
});

test('R2-ATK-1: more than three free-text slots are refused, three are fine', () => {
    const four = draftOf('you have received {N} RWF from {W+} and {W+} and {W+} and {W+} on {TS} Balance {N} RWF', 'mtn', {type: 'receive'});
    const check = named(four.gate, 'redos-guard');
    assert.equal(check.ok, false);
    assert.match(check.detail, /4 free-text slots/);
    const three = draftOf('you have received {N} RWF from {W+} and {W+} and {W+} on {TS} Balance {N} RWF', 'mtn', {type: 'receive'});
    assert.equal(named(three.gate, 'redos-guard').ok, true, named(three.gate, 'redos-guard').detail);
});

test('R2-ATK-1: the slot chain analysis flags only chains a device cannot produce', () => {
    const chains = skeleton => ambiguousSlotChains(skeleton).map(c => c.kinds.join(c.separator || '^'));
    assert.deepEqual(chains('ref {N}.{N}.{N}'), ['N.N', 'N.N']);
    assert.deepEqual(chains('{W+}:{W+}'), ['W+:W+']);
    assert.deepEqual(chains('Balance {N}{PH}'), ['N^PH']);
    for (const fine of [
        'You sent {N} RWF to {W+} ({PH}) on {TS}. Charge: {N} RWF. Balance: {N} RWF.',
        '{N} RWF transferred to {W+}({PH}) at {TS}.Fee: {N}RWF.Balance: {N}RWF',
        'Date {N}-{N}-{N} {N}:{N}',
        'to {W}-{W+}-{W} done',
        '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#',
        'ref {N} {N} {N} done',
    ]) {
        assert.deepEqual(chains(fine), [], fine);
    }
});

test('R2-ATK-1: the stress probes catch an ambiguous pattern the skeleton does not show', () => {
    const skeleton = 'you have received {N} RWF ref {N} {N} {N} {N} {N} {N} balance {N} RWF';
    const draft = draftOf(skeleton, 'mtn', {type: 'receive'});
    assert.equal(named(draft.gate, 'redos-guard').ok, true, 'the generated pattern is fine');
    const hostile = '.*?ref ([\\d,.]+)\\.([\\d,.]+)\\.([\\d,.]+)\\.([\\d,.]+)\\.([\\d,.]+)\\.([\\d,.]+) balance ([\\d,.]+) RWF';
    const result = gateOf(draft, {pattern: hostile, captureMap: {amount: 1, balance: 7}, timestamp: undefined});
    const check = named(result, 'redos-guard');
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, /interrupted|took|super-linear/);
});

test('R2-ATK-1: an approved chain shape never reaches the served config', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        const skeleton = 'you have received {N} RWF from {W+} on {TS} Balance {N} RWF ref {N}.{N}.{N}.{N}.{N}.{N} thank you';
        const submitted = await s.submit(submission([{skeleton, carrier: 'mtn'}]), ip(10));
        assert.equal(submitted.status, 202, submitted.text);
        const listed = (await s.admin('GET', '/pending?limit=10')).json.shapes;
        assert.equal(listed.length, 1);
        assert.equal(listed[0].gate.ok, false);
        const approve = await s.admin('POST', `/shape/${listed[0].shapeId}/approve`, {draft: listed[0].draft});
        assert.equal(approve.status, 422, approve.text);
        assert.equal(approve.json.error, 'gate_failed');
        const served = (await s.request('GET', '/manie/sms-formats')).json;
        assert.ok(!served.patterns.some(p => p.id.startsWith('auto-')));
    });
});

/* -------------------------------- R2-TYPE-ORDER -------------------------------- */

const TYPE_MESSAGES = [
    ['has sent you', 'mtn', 'Jane Doe has sent you 5000 RWF on 2026-05-01 10:15:20. Your new balance: 20000 RWF. TxId: 12345678901'],
    ['transfer ... has been received', 'mtn', 'A transfer of 5000 RWF from Jane Doe (250788111222) has been received on 2026-05-01 10:15:20. New balance: 20000 RWF. Ref: 12345678901'],
    ['have been paid', 'mtn', 'You have been paid 5000 RWF by Jane Doe on 2026-05-01 10:15:20. Your new balance: 20000 RWF. TxId: 12345678901'],
    ['Airtel *R* with transfer received', 'airtel', '*165*TXN ID PP260411.1430.A12345*R* Transfer received: Rwf 5000 from Jane Doe 250788111222. Your NEW BALANCE is Rwf 20000. *EN#'],
];

test('R2-TYPE-ORDER: received money is never approved as outgoing without the admin choosing the type', () => {
    for (const [label, carrier, body] of TYPE_MESSAGES) {
        const {skeleton} = anonymize(body, vocab());
        const draft = draftOf(skeleton, carrier);
        assert.equal(draft.type, 'receive', `${label}: ${skeleton}`);
        const check = named(draft.gate, 'valid-type');
        assert.equal(check.ok, false, `${label}: ${check.detail}`);
        assert.match(check.detail, /only a default/, label);
        const confirmed = draftOf(skeleton, carrier, {type: 'receive'});
        assert.equal(named(confirmed.gate, 'valid-type').ok, true, label);
        const wrong = draftOf(skeleton, carrier, {type: 'transfer'});
        assert.equal(wrong.type, 'transfer', 'an explicit choice always wins');
    }
});

test('R2-TYPE-ORDER: keywords of opposite directions are defaulted and the verb beats the noun; keywords of one direction resolve to the more specific type', () => {
    const guess = skeleton => guessTypeOfSkeleton(skeleton);
    const cases = [
        ['transfer from agent: cash deposited {N} rwf by agent {W+} ({PH}) on {TS}. balance {N} rwf', 'deposit', true],
        ['transfer to agent: you have withdrawn {N} rwf from {W+} on {TS}. balance {N} rwf', 'withdraw', false],
        ['payment received: {N} rwf from {W+} on {TS}. balance {N} rwf', 'receive', true],
        ['{W+} has sent you {N} rwf on {TS}', 'receive', true],
        ['*{N}*Txn ID {TID}*R* You sent Rwf {N}', 'receive', true],
        ['*{N}*Txn ID {TID}*R* Airtime Rwf {N}', 'receive', true],
    ];
    for (const [skeleton, type, defaulted] of cases) {
        const g = guess(skeleton);
        assert.equal(g.type, type, skeleton);
        assert.equal(g.defaulted, defaulted, skeleton);
    }
});

test('R2-TYPE-ORDER: agreeing text keeps its type without confirmation', () => {
    const agreeing = [
        ['deposit of {N} rwf received in your account on {TS}. balance {N} rwf', 'deposit'],
        ['You have received {N} RWF from {W+} on {TS}. Balance {N} RWF', 'receive'],
        ['Sent {N} RWF to {W+} on {TS}. Fee {N} RWF. Balance {N} RWF', 'transfer'],
        ['Payment of {N} RWF to {W+} done on {TS}. Balance {N} RWF', 'payment'],
        ['*{N}*TXN ID {TID}*R* Received Rwf {N} from {W+} {PH}. NEW BALANCE Rwf {N}. *EN#', 'receive'],
        ['*{N}*TXN ID {TID}*R* NEW BALANCE Rwf {N}. *EN#', 'receive'],
    ];
    for (const [skeleton, type] of agreeing) {
        const g = guessTypeOfSkeleton(skeleton);
        assert.equal(g.type, type, skeleton);
        assert.equal(g.defaulted, false, `${skeleton}: ${g.reason}`);
    }
});

/* -------------------------------- R2-NAME-SLOT -------------------------------- */

test('R2-NAME-SLOT: the counterparty is the slot after a preposition, not the greeting', () => {
    const skeleton = 'dear {W+}, you have received {N} rwf from {W+} ({PH}) on {TS}. new balance: {N} rwf. ref: {PH}';
    const layout = layoutOf(skeleton);
    const [greeting, counterparty] = layout.slots.filter(s => s.kind === 'W+');
    const draft = draftOf(skeleton, 'mtn');
    assert.equal(draft.captureMap.secondParty, counterparty.group);
    assert.notEqual(draft.captureMap.secondParty, greeting.group);
    assert.equal(draft.captureMap.accountNumber, layout.slots.find(s => s.kind === 'PH').group);
    assert.equal(named(draft.gate, 'name-slot').ok, true, named(draft.gate, 'name-slot').detail);
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));

    const greetingOnly = draftOf('Dear {W+}, you have received {N} rwf on {TS}. new balance: {N} rwf. ref: {PH}', 'mtn');
    assert.equal(greetingOnly.captureMap.secondParty, undefined, 'a lone name after a greeting is the customer');
});

test('R2-NAME-SLOT: a mapping onto the greeting, or an unguided guess among several slots, needs the admin', () => {
    const skeleton = 'dear {W+}, you have received {N} rwf from {W+} ({PH}) on {TS}. new balance: {N} rwf. ref: {PH}';
    const draft = draftOf(skeleton, 'mtn');
    const greeting = layoutOf(skeleton).slots.find(s => s.kind === 'W+');
    const wrong = gateOf(draft, {captureMap: {...draft.captureMap, secondParty: greeting.group}});
    const check = named(wrong, 'name-slot');
    assert.equal(check.ok, false);
    assert.match(check.detail, /greeting|preposition/);

    const guessed = 'balance for {W+} is {N} rwf, sent {N} rwf {W+} on {TS}';
    const guess = draftOf(guessed, 'mtn', undefined, {});
    assert.ok(guess.captureMap.secondParty, 'a guess is still offered');
    assert.equal(named(guess.gate, 'name-slot').ok, false, 'but it is not approvable unconfirmed');
    const confirmed = draftOf(guessed, 'mtn', {captureMap: {secondParty: guess.captureMap.secondParty}});
    assert.equal(named(confirmed.gate, 'name-slot').ok, true, 'setting the mapping explicitly confirms it');
    assert.equal(confirmed.sourceShape.nameConfirmed, true);
});

test('R2-NAME-SLOT: device hints can pick among ambiguous name slots but never confirm the mapping', () => {
    const skeleton = 'balance for {W+} is {N} rwf, sent {N} rwf {W+} on {TS}';
    const second = layoutOf(skeleton).slots.filter(s => s.kind === 'W+')[1];
    const hinted = rawDraftFromShape({skeleton, carrier: 'mtn', hintVotes: {[second.slotNo]: {secondParty: 3}}});
    assert.equal(hinted.captureMap.secondParty, second.group);
    assert.equal(hinted.sourceShape.nameConfirmed, undefined);
    assert.equal(named(hinted.gate, 'name-slot').ok, false, 'only the admin confirms a name mapping the text does not settle');
});

/* ------------------------------ PRIV2-2 (gate side) ------------------------------ */

test('PRIV2-2: a literal word where a name or phone number is expected cannot be approved as regex text', () => {
    const cases = [
        ['You have transferred {N} RWF to Money ({PH}) on {TS}. Fee was {N} RWF. Balance {N} RWF.', /"Money"/],
        ['You have transferred {N} RWF to {W+} ({PH}) on {TS}. Dear Alice. Balance {N} RWF.', /"Alice"/],
        ['You have transferred {N} RWF to can {W+} ({PH}) on {TS}. Fee was {N} RWF. Balance {N} RWF.', /"can"/],
    ];
    for (const [skeleton, pattern] of cases) {
        const draft = draftOf(skeleton, 'mtn', {type: 'transfer'});
        const check = named(draft.gate, 'name-slot');
        assert.equal(check.ok, false, skeleton);
        assert.match(check.detail, pattern, skeleton);
    }
    const ok = draftOf('You have transferred {N} RWF to agent {W+} ({PH}) on {TS}. Fee was {N} RWF. Balance {N} RWF.', 'mtn', {type: 'transfer'});
    assert.equal(named(ok.gate, 'name-slot').ok, true, named(ok.gate, 'name-slot').detail);
    const customer = draftOf('Dear customer, you have transferred {N} RWF to {W+} ({PH}) on {TS}. Fee was {N} RWF. Balance {N} RWF.', 'mtn', {type: 'transfer'});
    assert.equal(named(customer.gate, 'name-slot').ok, true, named(customer.gate, 'name-slot').detail);
});

/* --------------------------------- R2-PH-GROUP --------------------------------- */

test('R2-PH-GROUP: a phone-shaped slot accepts every form the anonymizer folds into {PH}', () => {
    const token = 'Payment of 5000 RWF to EUCL ELECTRICITY completed on 2026-05-01 10:15:20. Token: 1234-5678-9012-3456. Fee 0 RWF. Balance: 20000 RWF. TxId 123456';
    const {skeleton} = anonymize(token, vocab());
    assert.equal(skeleton, 'Payment of {N} RWF to {W+} completed on {TS}. Token: {PH}. Fee {N} RWF. Balance: {N} RWF. TxId {N}');
    const draft = draftOf(skeleton, 'mtn', {type: 'payment'});
    for (const body of [token, token.replace('1234-5678-9012-3456', '1234567890123456'), token.replace('1234-5678-9012-3456', '1234 5678 9012 3456')]) {
        assert.equal(matches(draft, body), true, body);
    }

    const send = 'You have transferred 5000 RWF to Jane Doe ({PH}) on 2026-05-01 10:15:20. Fee was 100 RWF. Your new balance: 20000 RWF.';
    const shape = anonymize(send.replace('{PH}', '0788 111 222'), vocab()).skeleton;
    assert.match(shape, /\(\{PH\}\)/);
    const phoneDraft = draftOf(shape, 'mtn', {type: 'transfer'});
    for (const phone of ['0788 111 222', '250-788-111-222', '+250 788 111 222', '+250788111222', '0788111222', '(0788) 111 222']) {
        const body = send.replace('{PH}', phone);
        const folded = anonymize(body, vocab()).skeleton;
        assert.equal(matches(draftOf(folded, 'mtn', {type: 'transfer'}, {}), body), true, `${phone} -> ${folded}`);
        if (/\(\{PH\}\)/.test(folded)) assert.equal(matches(phoneDraft, body), true, phone);
    }
});

test('R2-PH-GROUP: the self-match covers a grouped phone and the approved shape is not lost as covered', async () => {
    const skeleton = 'You have transferred {N} RWF to {W+} ({PH}) on {TS}. Fee was {N} RWF. Your new balance: {N} RWF. Token: {PH}';
    const draft = draftOf(skeleton, 'mtn', {type: 'transfer'});
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
    const strictPhone = gateOf(draft, {pattern: draft.pattern.split(PHONE_REGEX).join('(\\+?\\d+)')});
    assert.equal(named(strictPhone, 'self-match').ok, false, 'a pattern that only reads contiguous digits fails the grouped variant');
});

/* -------------------------------- R2-SEPARATORS -------------------------------- */

test('R2-SEPARATORS: a space in the skeleton stands for any run of whitespace and of separator characters', () => {
    const body = 'Payment of 5000 RWF to SHOPPY completed on 2026-05-01 10:15:20. Fee 0 RWF. Balance: 20000 RWF. TxId 123456';
    const {skeleton} = anonymize(body, vocab());
    assert.match(skeleton, /to \{W\} completed/);
    const draft = draftOf(skeleton, 'mtn', {type: 'payment'});
    const variants = [
        body,
        body.replace('to SHOPPY', 'to  SHOPPY'),
        body.replace('SHOPPY completed', 'SHOPPY  completed'),
        body.replace('SHOPPY completed', 'SHOPPY\tcompleted'),
        body.replace('SHOPPY completed', 'SHOPPY\ncompleted'),
        body.replace(/ /g, '   ').replace('2026-05-01   10:15:20', '2026-05-01 10:15:20'),
    ];
    for (const v of variants) {
        assert.equal(anonymize(v, vocab()).skeleton, skeleton, `same skeleton for ${JSON.stringify(v)}`);
        assert.equal(matches(draft, v), true, JSON.stringify(v));
    }
    for (const sep of [' | ', ' ~ ', ' > ', ' $ ', ' ^ ', ' \\ ', ' ` ', ' { ', ' } ']) {
        const noisy = body.replace(/\. /g, `.${sep}`);
        assert.equal(anonymize(noisy, vocab()).skeleton, skeleton, `same skeleton for separator ${JSON.stringify(sep)}`);
        assert.equal(matches(draft, noisy), true, `separator ${JSON.stringify(sep)}`);
    }
});

test('R2-SEPARATORS: a run of separators next to a name slot costs linear time, and the gate sees the cubic alternative', () => {
    const skeleton = 'You sent {N} RWF to {W+} ({PH}) on {TS}. Charge: {N} RWF. Balance: {N} RWF.';
    const draft = draftOf(skeleton, 'mtn', {type: 'transfer'});
    const time = (pattern, text) => {
        const re = new RegExp(pattern, 'i');
        const start = process.hrtime.bigint();
        re.test(text);
        return Number(process.hrtime.bigint() - start) / 1e6;
    };
    for (const unit of [' ', ' | ', 'a ', '| ']) {
        const attack = n => `You sent 5000 RWF to${unit.repeat(Math.ceil(n / unit.length))}`;
        const small = Math.min(time(draft.pattern, attack(800)), time(draft.pattern, attack(800)));
        const large = Math.min(time(draft.pattern, attack(3200)), time(draft.pattern, attack(3200)));
        assert.ok(large < 250, `3200 characters took ${large.toFixed(1)} ms for run ${JSON.stringify(unit)}`);
        assert.ok(large < Math.max(small, 0.5) * 12, `${small.toFixed(2)} ms at 800 characters, ${large.toFixed(2)} ms at 3200 for ${JSON.stringify(unit)}`);
    }
    const cubic = draft.pattern.split(SEPARATOR_CLASS).join(SEPARATOR_REGEX).split(`${SEPARATOR_REGEX}+`).join(SEPARATOR_REGEX);
    assert.notEqual(cubic, draft.pattern);
    const result = gateOf(draft, {pattern: cubic});
    assert.equal(named(result, 'redos-guard').ok, false, named(result, 'redos-guard').detail);
});

test('R2-SEPARATORS: a name may span a line break', () => {
    const body = 'Payment of 5000 RWF to EUCL\nELECTRICITY completed on 2026-05-01 10:15:20. Fee 0 RWF. Balance: 20000 RWF. TxId 123456';
    const {skeleton} = anonymize(body, vocab());
    assert.match(skeleton, /to \{W\+\} completed/);
    assert.equal(matches(draftOf(skeleton, 'mtn', {type: 'payment'}), body), true);
});

function mulberry(seedValue) {
    let a = seedValue >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('R2-SEPARATORS / R2-PH-GROUP: for random messages the drafted pattern matches the message it came from', () => {
    const rnd = mulberry(20261022);
    const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = list => list[int(0, list.length - 1)];
    const syllables = ['ka', 'mu', 'ta', 'bi', 'ne', 'ro', 'zu', 'li', 'sho', 'qua', 'vex', 'ply', 'dro', 'gri', 'mon', 'jak', 'fel', 'wur', 'nix', 'bro'];
    const word = () => Array.from({length: int(2, 3)}, () => pick(syllables)).join('');
    const name = () => Array.from({length: int(1, 3)}, () => pick([word(), word().toUpperCase(), `${word()}-${word()}`, `O'${word()}`])).join(pick([' ', ' ', '  ']));
    const digits = n => Array.from({length: n}, () => int(0, 9)).join('');
    const phone = () => pick([`250${digits(9)}`, `0${digits(9)}`, `+250${digits(9)}`, `0${digits(3)} ${digits(3)} ${digits(3)}`, `+250 ${digits(3)} ${digits(3)} ${digits(3)}`, `250-${digits(3)}-${digits(3)}-${digits(3)}`]);
    const amount = () => pick([digits(int(1, 6)), '12,500', '1,234,567', '5000.50']).replace(/^0+(?=\d)/, '1');
    const ts = () => `2026-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')} ${String(int(0, 23)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}`;
    const sep = () => pick([' ', ' ', ' ', '  ', ' | ', ' ~ ', '\t', ' $ ']);
    const templates = [
        v => `${v.a} RWF transferred to ${v.n}(${v.p}) at ${v.t}.Fee was: ${v.f} RWF. New balance: ${v.b} RWF`,
        v => `You have received ${v.a} RWF from ${v.n} (${v.p}) on your mobile money account at ${v.t} Your new balance:${v.b} RWF`,
        v => `*165*Txn ID RC260502.1015.H75073*R* You received Rwf${v.a} from ${v.n} ${v.p}.Your NEW BALANCE is Rwf ${v.b}. *EN#`,
        v => `*165* TID PP260411.1430.A12345*S* Kohereza Rwf ${v.a} kuri ${v.n} ${v.p} byakunze. Fee Rwf${v.f}. Ubu mufite Rwf ${v.b}. *KR#`,
        v => `Payment of ${v.a} RWF to ${v.n} completed on ${v.t}. Token: ${v.p}. Fee ${v.f} RWF. Balance: ${v.b} RWF. TxId ${v.f}`,
        v => `You have via agent: ${v.n}(${v.p}) withdrawn ${v.a} RWF from at ${v.t} Your new balance: ${v.b} RWF Fee paid: ${v.f} RWF`,
    ];
    const v = vocab();
    let checked = 0;
    for (let i = 0; i < 600; i++) {
        const values = {a: amount(), b: amount(), f: amount(), n: name(), p: phone(), t: ts()};
        let body = pick(templates)(values);
        if (rnd() < 0.5) body = body.replace(/ /g, sep);
        const {skeleton} = anonymize(body, v);
        if (!skeleton || skeleton.length > 400) continue;
        const carrier = /TID|Txn ID/.test(skeleton) ? 'airtel' : 'mtn';
        const draft = rawDraftFromShape({skeleton, carrier, count: 1}, undefined, {gate: false});
        const body1 = body;
        assert.equal(new RegExp(draft.pattern, 'i').test(body1), true, `no match for ${JSON.stringify(body1)}\n  skeleton ${skeleton}\n  pattern ${draft.pattern}`);
        checked += 1;
    }
    assert.ok(checked > 500, `only ${checked} messages were checked`);
});

/* ---------------------------------- R2-NEGATION ---------------------------------- */

const SUCCESS_BODY = 'Your payment of 1,200 RWF to SHOPPY LTD completed on 2026-05-01 10:15:20. Fee: 0 RWF. Balance: 26,300 RWF. TxId: 55512345678';

test('R2-NEGATION: failure notices written with contractions or plain negations are dropped as noise', () => {
    const v = vocab();
    const failures = [
        "Your payment of 1,200 RWF to SHOPPY LTD couldn't be completed. Fee: 0 RWF. Balance: 26,300 RWF. TxId: 55512345678",
        "Your payment of 1,200 RWF to SHOPPY LTD wasn't completed. Fee: 0 RWF. Balance: 26,300 RWF. TxId: 55512345678",
        "Your payment of 1,200 RWF to SHOPPY LTD didn't complete. Fee: 0 RWF. Balance: 26,300 RWF. TxId: 55512345678",
        'Your payment of 1,200 RWF to SHOPPY LTD never completed. Fee: 0 RWF. Balance: 26,300 RWF. TxId: 55512345678',
        'Sorry, you cannot send 5000 RWF to Jane Doe. Balance: 26,300 RWF.',
        'Your voucher of 5000 RWF is no longer valid. Balance: 26,300 RWF.',
        'Transfer of 5000 RWF to Jane Doe is not allowed. Balance: 26,300 RWF.',
    ];
    for (const body of failures) {
        const {skeleton} = anonymize(body, v);
        assert.equal(isNoiseSkeleton(skeleton).noise, true, `${body} -> ${skeleton}`);
    }
    const success = anonymize(SUCCESS_BODY, v).skeleton;
    assert.equal(isNoiseSkeleton(success).noise, false, success);
    assert.match(anonymize(failures[0], v).skeleton, /to \{W\+\} couldn't be completed/, 'the contraction stays visible instead of joining the name');
});

test('R2-NEGATION: a name slot refuses to swallow a failure phrase, with straight or curly apostrophes', () => {
    const {skeleton} = anonymize(SUCCESS_BODY, vocab());
    const draft = draftOf(skeleton, 'mtn', {type: 'payment'});
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
    assert.equal(matches(draft, SUCCESS_BODY), true);
    const phrases = [...NEGATION_PHRASES, "wasn't", 'wasn’t', 'did not', 'has failed', 'FAILED', 'Cancelled'];
    for (const phrase of phrases) {
        const failed = SUCCESS_BODY.replace('SHOPPY LTD', `SHOPPY LTD ${phrase}`);
        assert.equal(matches(draft, failed), false, `read as a success: ${failed}`);
    }
    assert.equal(matches(draft, SUCCESS_BODY.replace('SHOPPY LTD', 'NOTATION STORES')), true, 'a merchant whose name merely contains "not" is still read');
    assert.equal(matches(draft, SUCCESS_BODY.replace('SHOPPY LTD', 'Ntirenganya Jean')), true, 'Kinyarwanda names that start like a negation are still read');
});

test('R2-NEGATION: the gate injects failure phrases after every name slot and blocks a pattern that still matches', () => {
    const {skeleton} = anonymize(SUCCESS_BODY, vocab());
    const draft = draftOf(skeleton, 'mtn', {type: 'payment'});
    assert.equal(named(draft.gate, 'negation-slots').ok, true, named(draft.gate, 'negation-slots').detail);
    const plain = draft.pattern.split(`((?:(?!${NEGATION_SOURCE})[\\s\\S])*?)`).join('(.*?)');
    assert.notEqual(plain, draft.pattern);
    const loose = gateOf(draft, {pattern: plain});
    const check = named(loose, 'negation-slots');
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, /still matches/);
    assert.equal(loose.ok, false);
});

/* ---------------------------------- R2-IOS-TS ---------------------------------- */

test('R2-IOS-TS: the iOS parser replica reads exactly the forms the Swift DateFormatter code reads', () => {
    // measured with the verbatim RegexPattern.parseStandardDate code under TZ=Africa/Kigali
    const readable = ['2026-05-01 10:15:20', '2026-05-01T10:15:20Z', '2026-05-01T10:15:20+02:00', '2026-05-01T10:15:20.5Z', '2026-05-01T10:15:20.123+0200', '2026-05-01T10:15:20.123456Z'];
    const unreadable = ['2026-05-01T10:15:20', '2026-05-01 10:15:20.123', '2026-05-01 10:15:20+02:00', '2026-05-01 10:15:20Z', '2026-05-01T10:15:20.5', ''];
    for (const form of readable) assert.equal(iosCanParseTimestamp(form), true, form);
    for (const form of unreadable) assert.equal(iosCanParseTimestamp(form), false, form);
});

test('R2-IOS-TS: the gate no longer blesses a timestamp form iOS cannot read', () => {
    for (const form of TS_VALUES) assert.equal(iosCanParseTimestamp(form), true, `synthesized form ${form}`);
    const skeleton = 'Payment of {N} RWF to {W+} completed on {TS}. Fee: {N} RWF. Balance: {N} RWF. TxId: {PH}';
    const draft = draftOf(skeleton, 'mtn', {type: 'payment'});
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
    const check = named(draft.gate, 'ios-timestamp');
    assert.equal(check.ok, true);
    assert.equal(check.warn, true, 'the wide {TS} regex is reported, not hidden');
    assert.match(check.detail, /iOS app cannot read/);

    const wideTs = '(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:[Z]|[+\\-]\\d{2}:?\\d{2})?)';
    assert.ok(draft.pattern.includes(wideTs));
    const zoneless = gateOf(draft, {pattern: draft.pattern.replace(wideTs, '(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2})(?:\\.\\d{1,6})?(?:[Z]|[+\\-]\\d{2}:?\\d{2})?')});
    assert.equal(named(zoneless, 'self-match').ok, false, 'a pattern that captures a zoneless T timestamp is rejected');
    assert.match(named(zoneless, 'self-match').detail, /iOS app cannot read/);

    const narrowed = gateOf(draft, {pattern: draft.pattern.replace(wideTs, '(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})')});
    assert.equal(named(narrowed, 'ios-timestamp').ok, true);
    assert.equal(named(narrowed, 'ios-timestamp').warn, undefined, 'a pattern that reads only plain timestamps has nothing to report');
});

/* --------------------------------- R2-ATK-3 / carrier --------------------------------- */

test('R2-ATK-3: the carrier is part of a shape, so a forged carrier cannot fix the carrier of the real devices', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await seedMoved(s);
        const skeleton = NOVEL;
        assert.equal((await s.submit(submission([{skeleton, carrier: 'mtn'}]), ip(21))).status, 202);
        assert.equal((await s.submit(submission([{skeleton, carrier: 'airtel'}]), ip(22))).status, 202);
        assert.equal((await s.submit(submission([{skeleton, carrier: 'airtel'}]), ip(23))).status, 202);
        const listed = (await s.admin('GET', '/pending?limit=10')).json;
        assert.equal(listed.total, 2);
        const byCarrier = Object.fromEntries(listed.shapes.map(sh => [sh.carrier, sh]));
        assert.equal(byCarrier.mtn.count, 1);
        assert.equal(byCarrier.airtel.count, 2, 'the Airtel votes are recorded on an Airtel shape');
        assert.equal(byCarrier.mtn.shapeId, shapeId(skeleton, 'mtn'));
        assert.equal(byCarrier.airtel.shapeId, shapeId(skeleton, 'airtel'));
        assert.notEqual(byCarrier.mtn.shapeId, byCarrier.airtel.shapeId);
        assert.ok(byCarrier.airtel.draft.id.startsWith('auto-airtel-'));
        assert.equal(byCarrier.mtn.draft.sourceShape.shapeId, byCarrier.mtn.shapeId, 'the draft carries the real shape id');
    });
    assert.equal(rawShapeId('Fee {N}'), rawShapeId('Fee {N}', ''), 'without a carrier the id is the plain skeleton hash');
    assert.notEqual(rawShapeId('Fee {N}', 'mtn'), rawShapeId('Fee {N}', 'airtel'));
});

test('R2-ATK-3: a draft filed under MTN that carries Airtel markers is blocked by the gate', () => {
    const airtel = '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#';
    const asMtn = draftOf(airtel, 'mtn', {type: 'transfer'});
    const check = named(asMtn.gate, 'carrier-signals');
    assert.equal(check.ok, false);
    assert.match(check.detail, /filed under MTN/);
    assert.equal(named(draftOf(airtel, 'airtel', {type: 'transfer'}).gate, 'carrier-signals').ok, true);
    assert.equal(named(draftOf('Sent {N} RWF to {W+} on {TS}. Balance {N} RWF', 'mtn').gate, 'carrier-signals').ok, true);
    assert.equal(CHECK_NAMES[CHECK_NAMES.length - 1], 'carrier-signals');
});

/* ------------------------------- R2-CARRIER-KILL ------------------------------- */

test('R2-CARRIER-KILL: switching off an Airtel pattern warns that stored transactions change carrier', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await seedMoved(s);
        const airtelShape = '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#';
        const a = await submitAndRedraft(s, airtelShape, 'airtel', 31);
        const approvedAirtel = await s.admin('POST', `/shape/${a.id}/approve`, {draft: a.draft});
        assert.equal(approvedAirtel.status, 200, approvedAirtel.text);
        const m = await submitAndRedraft(s, NOVEL, 'mtn', 32, {type: 'transfer'});
        const approvedMtn = await s.admin('POST', `/shape/${m.id}/approve`, {draft: m.draft});
        assert.equal(approvedMtn.status, 200, approvedMtn.text);

        const off = await s.admin('POST', `/approved/${approvedAirtel.json.id}/disable`);
        assert.equal(off.status, 200, off.text);
        assert.equal(off.json.warnings.length, 1);
        assert.match(off.json.warnings[0], /Airtel/);
        assert.match(off.json.warnings[0], /MTN/);
        const on = await s.admin('POST', `/approved/${approvedAirtel.json.id}/enable`);
        assert.equal(on.json.warnings, undefined);
        const mtnOff = await s.admin('POST', `/approved/${approvedMtn.json.id}/disable`);
        assert.equal(mtnOff.status, 200);
        assert.equal(mtnOff.json.warnings, undefined);
    });
});

/* ---------------------------------- R2-REL-01 ---------------------------------- */

test('R2-REL-01: a storage error while a shape is created leaves nothing behind that blocks the format', async () => {
    const {store, state} = failingOnce((method, args) => method === 'hset' && args[1] && args[1].status === 'pending' && args[1].carrier === 'mtn');
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            const id = shapeId(NOVEL);
            state.armed = true;
            const first = await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]), ip(41));
            assert.equal(first.status, 503);
            assert.equal(state.fired, 1);
            const half = await s.store.hgetall(`manie:shape:${id}`);
            assert.equal(typeof half.skeleton, 'string');
            assert.equal(half.status, undefined, 'the commit marker is missing, so the record is known to be unfinished');

            const second = await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]), ip(42));
            assert.equal(second.status, 202, second.text);
            const listed = (await s.admin('GET', '/pending?limit=10')).json;
            assert.equal(listed.total, 1);
            assert.equal(listed.shapes.length, 1);
            assert.equal(listed.shapes[0].status, 'pending');
            assert.equal(listed.shapes[0].count, 1, 'only the request that succeeded counted');
            assert.ok((await s.store.zscore('manie:shapes:pending', id)) >= 1);
        })
    );
});

test('R2-REL-01: a listing that meets an unfinished record neither shows nor drops it', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        const id = shapeId(NOVEL);
        await s.store.hsetnx(`manie:shape:${id}`, 'skeleton', canonicalSkeleton(NOVEL));
        await s.store.zadd('manie:shapes:pending', 1, id);
        const listed = (await s.admin('GET', '/pending?limit=10')).json;
        assert.equal(listed.shapes.length, 0);
        assert.equal(await s.store.zscore('manie:shapes:pending', id), 1, 'still queued for the repair');
    });
});

test('R2-REL-01: reopening queues the shape before it flips back to pending', async () => {
    const {store, state} = failingOnce((method, args) => method === 'hset' && args[1] && args[1].status === 'pending' && args[1].revision === 2);
    await quiet(() =>
        withServer({env: PROXY_ENV, store}, async s => {
            await seedMoved(s);
            await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]), ip(43));
            const id = shapeId(NOVEL);
            assert.equal((await s.admin('POST', `/shape/${id}/reject`, {reason: 'test'})).status, 200);
            state.armed = true;
            assert.equal((await s.admin('POST', `/shape/${id}/reopen`)).status, 503);
            assert.equal((await s.store.hgetall(`manie:shape:${id}`)).status, 'rejected', 'the status was not changed');
            const retry = await s.admin('POST', `/shape/${id}/reopen`);
            assert.equal(retry.status, 200, retry.text);
            assert.equal((await s.admin('GET', '/pending?limit=10')).json.shapes.length, 1);
        })
    );
});

test('R2-REL-01: reopening a pending shape that fell out of the queue puts it back', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        await seedMoved(s);
        await s.submit(submission([{skeleton: NOVEL, carrier: 'mtn'}]), ip(44));
        const id = shapeId(NOVEL);
        assert.equal((await s.admin('POST', `/shape/${id}/reopen`)).status, 409, 'queued: nothing to do');
        await s.store.zrem('manie:shapes:pending', id);
        assert.equal((await s.admin('GET', '/pending?limit=10')).json.shapes.length, 0);
        const repaired = await s.admin('POST', `/shape/${id}/reopen`);
        assert.equal(repaired.status, 200, repaired.text);
        assert.equal(repaired.json.requeued, true);
        assert.equal((await s.admin('GET', '/pending?limit=10')).json.shapes.length, 1);
    });
});

/* ---------------------------------- R2-REL-02 ---------------------------------- */

function routerWithBrokenFile(suffix, content) {
    const original = fs.readFileSync;
    fs.readFileSync = function patched(file, ...rest) {
        if (String(file).endsWith(suffix)) {
            if (content === undefined) throw Object.assign(new Error('ENOENT: no such file or directory'), {code: 'ENOENT'});
            return content;
        }
        return original.call(this, file, ...rest);
    };
    const id = require.resolve('../../routes/manie');
    delete require.cache[id];
    try {
        const mod = require('../../routes/manie');
        return mod.createManieRouter({store: new MemoryStore(), env: PROXY_ENV});
    } finally {
        fs.readFileSync = original;
        delete require.cache[id];
    }
}

async function serve(router, fn) {
    const app = express();
    app.use('/manie', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(resolve => {
            server.close(() => resolve());
            if (server.closeAllConnections) server.closeAllConnections();
        });
    }
}

test('R2-REL-02: an unreadable, invalid or empty base file or vocabulary seed is a 503, never an empty config', async () => {
    const cases = [
        ['sms-formats.json', undefined, 'missing base file'],
        ['sms-formats.json', '{ "patterns": [ oops', 'base file with a syntax error'],
        ['sms-formats.json', JSON.stringify({version: 'x', patterns: []}), 'base file without patterns'],
        ['sms-formats.json', JSON.stringify({version: 'x', patterns: [{id: 'a', pattern: 'x', status: 'retired'}]}), 'base file without an active pattern'],
        ['vocab-seed.json', undefined, 'missing vocabulary seed'],
        ['vocab-seed.json', '[]', 'empty vocabulary seed'],
    ];
    for (const [suffix, content, label] of cases) {
        const router = await quiet(() => routerWithBrokenFile(suffix, content));
        await serve(router, async url => {
            const res = await fetch(`${url}/manie/sms-formats`);
            assert.equal(res.status, 503, label);
            assert.equal((await res.json()).error, 'config_unavailable', label);
            assert.match(res.headers.get('cache-control'), /no-store/, label);
            assert.equal(res.headers.get('x-manie-degraded'), 'config', label);
            const submitted = await fetch(`${url}/manie/submissions`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(submission([{skeleton: NOVEL, carrier: 'mtn'}]))});
            assert.equal(submitted.status, 503, label);
        });
    }
    await withServer({env: PROXY_ENV}, async s => {
        assert.equal((await s.request('GET', '/manie/sms-formats')).status, 200, 'the real files still serve');
    });
});

/* ---------------------------------- R2-REL-03 ---------------------------------- */

function slowStore(ms) {
    const inner = new MemoryStore();
    return new Proxy(inner, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            return async (...args) => {
                await new Promise(resolve => setTimeout(resolve, ms));
                return value.apply(target, args);
            };
        },
    });
}

test('R2-REL-03: two shapes approved at once under the same id: one wins, the other is told and stays pending', async () => {
    await withServer({env: PROXY_ENV, store: slowStore(25)}, async s => {
        await seedMoved(s);
        const other = NOVEL.replace('Balance:', 'Bal:');
        const a = await submitAndRedraft(s, NOVEL, 'mtn', 51, {type: 'transfer', id: 'mtn-auto-unique-one'});
        const b = await submitAndRedraft(s, other, 'mtn', 52, {type: 'transfer', id: 'mtn-auto-unique-one'});
        assert.equal(a.gate.ok, true, JSON.stringify(a.gate.checks.filter(c => !c.ok)));
        assert.equal(b.gate.ok, true, JSON.stringify(b.gate.checks.filter(c => !c.ok)));
        const results = await Promise.all([
            s.admin('POST', `/shape/${a.id}/approve`, {draft: {...a.draft, id: 'mtn-auto-unique-one'}}),
            s.admin('POST', `/shape/${b.id}/approve`, {draft: {...b.draft, id: 'mtn-auto-unique-one'}}),
        ]);
        const statuses = results.map(r => r.status).sort();
        assert.deepEqual(statuses, [200, 409], results.map(r => r.text).join(' | '));
        const loser = results.find(r => r.status === 409);
        assert.equal(loser.json.error, 'id_conflict');
        const winnerDraft = results[0].status === 200 ? a : b;
        const loserShape = results[0].status === 200 ? b : a;
        assert.equal((await s.store.hgetall('manie:approved'))['mtn-auto-unique-one'].pattern, winnerDraft.draft.pattern, 'the stored pattern is the winner\'s');
        const loserRecord = await s.store.hgetall(`manie:shape:${loserShape.id}`);
        assert.equal(loserRecord.status, 'pending');
        assert.equal(loserRecord.approvingId, undefined);
        const served = (await s.request('GET', '/manie/sms-formats')).json;
        assert.equal(served.patterns.filter(p => p.id === 'mtn-auto-unique-one').length, 1);
    });
});

/* ---------------------------------- R2-REL-04 ---------------------------------- */

test('R2-REL-04: a hand-edited base fetchedAt that is not strict ISO keeps the served version stable', async () => {
    for (const fetchedAt of ['2026-10-22T10:00:00Z', '2026-10-22', '2026-10-22 10:00:00', '2026-10-22T10:00:00']) {
        await withServer({env: PROXY_ENV, base: {...base, fetchedAt}}, async s => {
            const first = (await s.request('GET', '/manie/sms-formats')).json;
            await new Promise(resolve => setTimeout(resolve, 15));
            const second = (await s.request('GET', '/manie/sms-formats')).json;
            assert.equal(first.fetchedAt, second.fetchedAt, fetchedAt);
            assert.equal(first.contentHash, second.contentHash, fetchedAt);
            assert.equal(first.version, second.version, fetchedAt);
            assert.match(first.version, /^regex-v20261022-/, fetchedAt);
            const etag = (await s.request('GET', '/manie/sms-formats')).headers.get('etag');
            assert.equal((await s.request('GET', '/manie/sms-formats', {headers: {'If-None-Match': etag}})).status, 304, fetchedAt);
        });
    }
});

/* ------------------------- R2-ATK-2 / PRIV2 on the real endpoint ------------------------- */

test('R2-ATK-2 / PRIV2-2: names that are vocabulary words are hidden before a skeleton is stored', async () => {
    await withServer({env: PROXY_ENV}, async s => {
        const skeletons = [
            'You have transferred {N} RWF to May {W} ({PH}). Balance {N} RWF',
            'you have sent {N} RWF to neza ({PH}) balance {N} RWF',
            'Your transfer of {N} RWF to Money ({PH}) was completed at {TS}. Fee was: {N} RWF. New balance: {N} RWF. TxId: {PH}',
            'Your transfer of {N} RWF to Bank ({PH}) was completed at {TS}. Fee was: {N} RWF. New balance: {N} RWF. TxId: {PH}',
            'Mwakiriye RWF {N} avuye kuri Kanda {PH}. Ubu mufite RWF {N}',
            'transferred {N} RWF to Momo ({PH}) at {TS}. Balance {N} RWF',
        ];
        let n = 60;
        for (const skeleton of skeletons) {
            const res = await s.submit(submission([{skeleton, carrier: 'mtn'}]), ip(n++));
            assert.equal(res.status, 202, res.text);
        }
        const stored = (await s.admin('GET', '/pending?limit=100')).json.shapes.map(sh => sh.skeleton).join('\n');
        for (const word of ['may', 'neza', 'money', 'bank', 'kanda', 'momo']) {
            assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(stored.replace(/\bmoney account\b/gi, '')), `"${word}" was stored:\n${stored}`);
        }
    });
    assert.equal(sanitizeSkeleton('Sent {N} RWF to Money ({PH})', vocab()).skeleton, 'Sent {N} RWF to {W} ({PH})');
});
