'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {draftFromShape, describeDraft, describeLayout} = require('../../lib/manie/draft');
const {layoutOf, NUMBER_REGEX, WORD_REGEX, SEPARATOR_CLASS, SEPARATOR_REGEX, TID_REGEX} = require('../../lib/manie/_fields');
const {synthesize, roleValue, TID_VALUES} = require('../../lib/manie/_synth');
const {testPattern: rawTestPattern, runGate, CHECK_NAMES} = require('../../lib/manie/gate');
const H = require('./_clientHarness');

const testPattern = (def, message) => rawTestPattern(def, message, {timeoutMs: 3000});
const base = require('../../assets/manie/sms-formats.json');

globalThis.__DEV__ = false;

const APP = process.env.MANIE_APP_REPO || '/Users/ivainqueur/Documents/Code/React/mobile/Manie';
const HAVE_APP =
    fs.existsSync(path.join(APP, 'tools/sms-pattern-tool/lib/loadClassify.js')) &&
    fs.existsSync(path.join(APP, 'node_modules/typescript')) &&
    fs.existsSync(path.join(APP, 'src/lib/utils/classify.ts'));
const skipClient = HAVE_APP ? false : 'APP repo (classify.ts + typescript) not available';
const RELEASED = skipClient ? null : H.extractReleasedClient();
const skipReleased = skipClient || (RELEASED ? false : 'the released client sources (git show of the app repo) are not available');

const MARKER = 'draft-under-test';
const EXISTING = base.patterns;
const localMs = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0).getTime();
const EXPECTED_TS = localMs(2026, 4, 11, 14, 30);

const NOVEL = [
    {
        name: 'mtn sent (new wording)',
        carrier: 'mtn',
        skeleton: 'You sent {N} RWF to {W+} ({PH}) on {TS}. Charge: {N} RWF. Balance: {N} RWF.',
        type: 'transfer',
        roles: {0: 'amount', 1: 'secondParty', 2: 'accountNumber', 4: 'fee', 5: 'balance'},
    },
    {
        name: 'mtn received (new wording)',
        carrier: 'mtn',
        skeleton: 'Received {N} RWF from {W+} ({PH}) on {TS}. Balance: {N} RWF.',
        type: 'receive',
        roles: {0: 'amount', 1: 'secondParty', 2: 'accountNumber', 4: 'balance'},
    },
    {
        name: 'mtn payment (new wording)',
        carrier: 'mtn',
        skeleton: 'Payment of {N} RWF to {W+} done on {TS}. Fee {N} RWF. Balance {N} RWF.',
        type: 'payment',
        roles: {0: 'amount', 1: 'secondParty', 3: 'fee', 4: 'balance'},
    },
    {
        name: 'mtn token payment (served-only format, ISO timestamp)',
        carrier: 'mtn',
        skeleton: 'TransactionId: {PH} Your payment of {N} RWF to {W+} with token and ET Id: {PH} SUCCESSFUL at {TS}.Fee: {N} RWF. Balance {N} RWF',
        type: 'payment',
        roles: {0: 'transactionId', 1: 'amount', 2: 'secondParty', 5: 'fee', 6: 'balance'},
    },
    {
        name: 'mtn withdraw (new wording)',
        carrier: 'mtn',
        skeleton: 'Agent {W+}({PH}) withdrawn {N} RWF on {TS}. Fee: {N} RWF. Balance: {N} RWF.',
        type: 'withdraw',
        roles: {0: 'agentName', 1: 'agentNumber', 2: 'amount', 4: 'fee', 5: 'balance'},
    },
    {
        name: 'mtn deposit (new wording)',
        carrier: 'mtn',
        skeleton: 'Deposit of {N} RWF received in your account on {TS}. Balance: {N} RWF.',
        type: 'deposit',
        roles: {0: 'amount', 2: 'balance'},
    },
    {
        name: 'airtel en sent (new wording)',
        carrier: 'airtel',
        skeleton: '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#',
        type: 'transfer',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'fee', 6: 'balance'},
        tid: true,
    },
    {
        name: 'airtel en received (new wording)',
        carrier: 'airtel',
        skeleton: '*{N}*Txn ID {TID}*R* Received Rwf {N} from {W+} {PH}. NEW BALANCE Rwf {N}. *EN#',
        type: 'receive',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'balance'},
        tid: true,
    },
    {
        name: 'airtel en merchant payment (new wording)',
        carrier: 'airtel',
        skeleton: '*{N}*TXN ID ({TID})*S*Paid RWF {N} to {W+} OK. NEW BALANCE RWF {N}. *EN#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'balance'},
        tid: true,
    },
    {
        name: 'airtel en airtime (new wording)',
        carrier: 'airtel',
        skeleton: '*{N}*TID:{TID}*S* Airtime of Rwf {N} done to {PH}. Balance: Rwf {N} *EN#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'amount', 3: 'accountNumber', 4: 'balance'},
        tid: true,
    },
    {
        name: 'airtel kinyarwanda transfer (new wording)',
        carrier: 'airtel',
        skeleton: '*{N}*TID {TID}*S* Kohereza Rwf {N} kuri {W+} {PH} neza. Fee Rwf{N}. Ubu mufite Rwf {N}. *KR#',
        type: 'transfer',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'fee', 6: 'balance'},
        tid: true,
        locale: 'rw-RW',
    },
    {
        name: 'airtel kinyarwanda receive (new wording)',
        carrier: 'airtel',
        skeleton: '*{N}*TXN ID {TID}*S* Mwakiriye RWF {N} avuye kuri {W+} {PH}. Asigaye ni RWF {N}. *KR#',
        type: 'receive',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'balance'},
        tid: true,
        locale: 'rw-RW',
    },
    {
        name: 'airtel kinyarwanda bundle (new wording)',
        carrier: 'airtel',
        skeleton: '*{N}* TXN ID {TID}*S*Ubu mufite Rwf {N}. Kugura Inite ya Rwf {N} byagenze neza. *KR#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'balance', 3: 'amount'},
        tid: true,
        locale: 'rw-RW',
    },
];

NOVEL.push({
    name: 'mtn bank deposit (literal digits in the tail become slots)',
    carrier: 'mtn',
    skeleton: 'A bank deposit of {N} RWF has been added to your mobile money account at {TS}. Your NEW BALANCE :{N} RWF. Cash Deposit::FUNDS::::{N}::{N}',
    type: 'deposit',
    roles: {0: 'amount', 2: 'balance'},
});

const DERIVED = [
    {
        name: 'mtn transfer v1',
        carrier: 'mtn',
        skeleton: '{N} RWF transferred to {W+}({PH}) at {TS} Fee was: {N} RWF New balance: {N} RWF',
        type: 'transfer',
        roles: {0: 'amount', 1: 'secondParty', 2: 'accountNumber', 4: 'fee', 5: 'balance'},
    },
    {
        name: 'mtn transfer v4',
        carrier: 'mtn',
        skeleton: '{N} RWF transferred to {W+}({PH}) at {TS}.Fee: {N}RWF.Balance: {N}RWF',
        type: 'transfer',
        roles: {0: 'amount', 1: 'secondParty', 2: 'accountNumber', 4: 'fee', 5: 'balance'},
    },
    {
        name: 'mtn receive v1',
        carrier: 'mtn',
        skeleton: 'You have received {N} RWF from {W+} ({PH}) on your mobile money account at {TS} Your new balance:{N} RWF',
        type: 'receive',
        roles: {0: 'amount', 1: 'secondParty', 2: 'accountNumber', 4: 'balance'},
    },
    {
        name: 'mtn payment token v1',
        carrier: 'mtn',
        skeleton: 'Your payment of {N} RWF to {W+} with token has been completed at {TS}. Fee was {N} RWF. Your new balance: {N} RWF',
        type: 'payment',
        roles: {0: 'amount', 1: 'secondParty', 3: 'fee', 4: 'balance'},
    },
    {
        name: 'mtn payment merchant',
        carrier: 'mtn',
        skeleton: 'TxId: {PH}. Your payment of {N} RWF to {W+} has been completed at {TS}. Your new balance: {N} RWF. Fee was {N} RWF.',
        type: 'payment',
        roles: {0: 'transactionId', 1: 'amount', 2: 'secondParty', 4: 'balance', 5: 'fee'},
    },
    {
        name: 'mtn withdraw',
        carrier: 'mtn',
        skeleton: 'Cash has via agent: {W+}({PH}) withdrawn {N} RWF from your account at {TS} Your new balance: {N} RWF Fee paid: {N} RWF',
        type: 'withdraw',
        roles: {0: 'agentName', 1: 'agentNumber', 2: 'amount', 4: 'balance', 5: 'fee'},
    },
    {
        name: 'airtel to airtel transfer en',
        carrier: 'airtel',
        skeleton: '*{N}* TID {TID}*S* Money successfully sent to {W+} {PH} Amt {N}Fee RWF {N}. BAL is RWF {N}. *EN#',
        type: 'transfer',
        roles: {1: 'transactionId', 2: 'secondParty', 3: 'accountNumber', 4: 'amount', 5: 'fee', 6: 'balance'},
        codes: {0: '165'},
        tid: true,
    },
    {
        name: 'airtel to mtn transfer en',
        carrier: 'airtel',
        skeleton: '*{N}* TID {TID}*S* Money successfully sent to {W+} in MTN. Amt RWF {N}. Fee RWF {N}. BAL RWF {N}. *EN#',
        type: 'transfer',
        roles: {1: 'transactionId', 2: 'secondParty', 3: 'amount', 4: 'fee', 5: 'balance'},
        codes: {0: '165'},
        tid: true,
    },
    {
        name: 'airtel merchant payment en',
        carrier: 'airtel',
        skeleton: '*{N}*TXN ID ({TID})*S*Payment of RWF {N} to {W+} - successful.Your NEW BALANCE is RWF {N}. *EN#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'balance'},
        codes: {0: '161'},
        tid: true,
    },
    {
        name: 'airtel receive from airtel en',
        carrier: 'airtel',
        skeleton: '*{N}*Txn ID {TID}*R* You received Rwf{N} from {W+} {PH}.Your NEW BALANCE is Rwf {N}. *EN#',
        type: 'receive',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'balance'},
        codes: {0: '165'},
        tid: true,
    },
    {
        name: 'airtel receive from mtn en',
        carrier: 'airtel',
        skeleton: '*{N}*Txn ID {TID}*R* You have received RWF {N} from {W+} {PH} in MTN RWANDA.Your NEW BALANCE isRWF {N}. *EN#',
        type: 'receive',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'balance'},
        codes: {0: '151'},
        tid: true,
    },
    {
        name: 'airtel transfer kinyarwanda',
        carrier: 'airtel',
        skeleton: '*{N}* TID {TID}*S* Kohereza Rwf {N} kuri {W+} {PH} byakunze. Fee Rwf{N}. Ubu mufite Rwf {N}. *KR#',
        type: 'transfer',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'fee', 6: 'balance'},
        codes: {0: '165'},
        tid: true,
        locale: 'rw-RW',
    },
    {
        name: 'airtel merchant payment kinyarwanda',
        carrier: 'airtel',
        skeleton: '*{N}*TXN ID ({TID})*S*Kwishyura RWF {N} kuri {W+} Kode byagenze neza.Ubu mufite RWF {N}. *KR#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'balance'},
        codes: {0: '161'},
        tid: true,
        locale: 'rw-RW',
    },
    {
        name: 'airtel receive v2 kinyarwanda',
        carrier: 'airtel',
        skeleton: '*{N}*TID {TID}*S*Mwakiriye RWF {N} avuye kuri {W+} {PH}.Kuri konti ubu mufite RWF {N}.*KR#',
        type: 'receive',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'balance'},
        codes: {0: '165'},
        tid: true,
        locale: 'rw-RW',
    },
    {
        name: 'airtel data purchase kinyarwanda',
        carrier: 'airtel',
        skeleton: '*{N}*TID:{TID}*S* Kugura Inite ya Rwf {N} Byemeye kuri {PH}.Ubu kuri konti mufite Rwf {N} *KR#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'amount', 3: 'accountNumber', 4: 'balance'},
        codes: {0: '149'},
        tid: true,
        locale: 'rw-RW',
    },
    {
        name: 'airtel bundle purchase en',
        carrier: 'airtel',
        skeleton: '*{N}* TXN ID {TID}*S Your NEW BALANCE is Rwf {N}. Purchase of Bundle of Rwf {N} successful. *EN#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'balance', 3: 'amount'},
        codes: {0: '150'},
        tid: true,
    },
    {
        name: 'airtel bundle purchase kinyarwanda',
        carrier: 'airtel',
        skeleton: '*{N}* TXN ID {TID}*S*Ubu kuri konti yanyu mufite Rwf {N}. Kugura Pack ya Rwf {N} byagenze neza. *KR#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'balance', 3: 'amount'},
        codes: {0: '150'},
        tid: true,
        locale: 'rw-RW',
    },
    {
        name: 'airtel cashpower kinyarwanda',
        carrier: 'airtel',
        skeleton: '*{N}*Txn ID {TID}*S* Ibyo Kugura Cashpower ya RWF {N} byagenze neza.Musigaranye RWF {N}. *KR#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'amount', 3: 'balance'},
        codes: {0: '161'},
        tid: true,
        locale: 'rw-RW',
        unmatchedKeys: ['secondParty'],
    },
    {
        name: 'airtel receive from any institution en',
        carrier: 'airtel',
        skeleton: '*{N}*Txn ID {TID}*R* You have received RWF {N} from {W+} {PH} in {W+}.Your NEW BALANCE isRWF {N}. *EN#',
        type: 'receive',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 6: 'balance'},
        codes: {0: '151'},
        tid: true,
    },
    {
        name: 'airtel merchant payment v2 en (merchant code after the name)',
        carrier: 'airtel',
        skeleton: '*{N}*TXN ID ({TID})*S*Payment of RWF {N} to {W+} - {N} successful.Your NEW BALANCE is RWF {N}. *EN#',
        type: 'payment',
        roles: {1: 'transactionId', 2: 'amount', 3: 'secondParty', 4: 'accountNumber', 5: 'balance'},
        codes: {0: '161'},
        tid: true,
    },
    {
        name: 'airtel merchant receive en (merchant code before the name)',
        carrier: 'airtel',
        skeleton: '*{N}*TID {TID}*R* You have received Rwf{N} from {N} {W+}.CHARGES Rwf{N}.BAL is Rwf {N}. *EN#',
        type: 'receive',
        roles: {1: 'transactionId', 2: 'amount', 3: 'accountNumber', 4: 'secondParty', 5: 'fee', 6: 'balance'},
        codes: {0: '161'},
        tid: true,
    },
    {
        name: 'mtn payment token v2.5',
        carrier: 'mtn',
        skeleton: 'A transaction of {N} RWF by {W+} was completed at {TS}. Balance:{N} RWF. Fee {N} RWF.',
        type: 'payment',
        roles: {0: 'amount', 1: 'secondParty', 3: 'balance', 4: 'fee'},
    },
];

function slotFor(skeleton, ordinal) {
    return layoutOf(skeleton).slots.find(s => s.ordinal === Number(ordinal));
}

function roleOrdinalMap(skeleton, draft) {
    const layout = layoutOf(skeleton);
    const out = new Map();
    for (const [role, group] of Object.entries(draft.captureMap)) {
        const slot = layout.slots.find(s => s.group === group);
        if (slot) out.set(slot.ordinal, role);
    }
    return out;
}

function buildMessage(shape, draft) {
    const overrideByOrdinal = new Map(Object.entries(shape.codes || {}).map(([k, v]) => [Number(k), v]));
    return synthesize(shape.skeleton, {roleByOrdinal: roleOrdinalMap(shape.skeleton, draft), overrideByOrdinal}).message;
}

function expectedFields(shape) {
    const out = {};
    for (const [ordinal, role] of Object.entries(shape.roles)) {
        const slot = slotFor(shape.skeleton, ordinal);
        if (role === 'transactionId' && slot.kind === 'TID') out.transactionId = TID_VALUES[0];
        else if (role === 'amount' || role === 'fee' || role === 'balance') out[role] = Number(roleValue(role, slot.kind, 0).replace(/,/g, ''));
        else out[role] = roleValue(role, slot.kind, 0);
    }
    return out;
}

function projectDraft(draft) {
    return {
        id: draft.id,
        carrier: draft.carrier,
        locale: draft.locale,
        type: draft.type,
        pattern: draft.pattern,
        flags: draft.flags,
        captureMap: draft.captureMap,
        ...(draft.timestamp ? {timestamp: draft.timestamp} : {}),
        tags: [...draft.tags, MARKER],
        status: 'active',
    };
}

let configCounter = 0;

async function applyDrafts(client, drafts) {
    configCounter += 1;
    const config = {
        version: `regex-test-${configCounter}`,
        defaultLocale: 'en-RW',
        fetchedAt: `2026-10-21T00:00:${String(configCounter % 60).padStart(2, '0')}Z`,
        patterns: drafts.map(projectDraft),
    };
    const realFetch = global.fetch;
    global.fetch = async () => ({ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(config))});
    try {
        return await client.rrc.syncRegexConfig({forceRefresh: true});
    } finally {
        global.fetch = realFetch;
    }
}

function classifyOne(client, body) {
    const {transactions, unmatched} = client.classify.classifyTransactions([{body}]);
    return {tx: transactions[0] || null, unmatched: unmatched.length};
}

function loadRealClient() {
    const {loadClassify} = require(path.join(APP, 'tools/sms-pattern-tool/lib/loadClassify.js'));
    const {classify, remoteRegexConfig} = loadClassify(APP);
    return {classify, rrc: remoteRegexConfig};
}

const PATCH_DROP_BUILTINS = ['return [...PATTERNS, ...remotePatterns];', 'return [...remotePatterns];'];
const PATCH_AIRTEL_TOLERANT = ['const shortDate = tid.slice(2);', "const shortDate = /^[A-Za-z]{2}/.test(tid) ? tid.slice(2) : tid;"];

function loadPatchedClient({dropBuiltins, fixAirtel}) {
    const ts = require(path.join(APP, 'node_modules/typescript'));
    const cache = new Map();
    const classifyPath = path.join(APP, 'src/lib/utils/classify.ts');
    const rrcPath = path.join(APP, 'src/lib/utils/remoteRegexConfig.ts');

    const patch = source => {
        let out = source;
        if (dropBuiltins) {
            assert.ok(out.includes(PATCH_DROP_BUILTINS[0]), 'classify.ts changed: update the drop-builtins test patch');
            out = out.replace(PATCH_DROP_BUILTINS[0], PATCH_DROP_BUILTINS[1]);
        }
        if (fixAirtel && out.includes(PATCH_AIRTEL_TOLERANT[0])) out = out.replace(PATCH_AIRTEL_TOLERANT[0], PATCH_AIRTEL_TOLERANT[1]);
        return out;
    };

    const load = abs => {
        if (cache.has(abs)) return cache.get(abs).exports;
        let source = fs.readFileSync(abs, 'utf8');
        if (abs === classifyPath) source = patch(source);
        const {outputText} = ts.transpileModule(source, {
            compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true},
            fileName: abs,
        });
        const mod = {exports: {}};
        cache.set(abs, mod);
        const dir = path.dirname(abs);
        const req = spec => {
            if (spec.endsWith('reprocessUnmatched')) return {reprocessUnmatchedMessages: async () => {}};
            if (spec === 'react-native') return {NativeModules: {}, Platform: {OS: 'android'}};
            if (spec === '@react-native-async-storage/async-storage') {
                return {default: {getItem: async () => null, setItem: async () => {}, removeItem: async () => {}}};
            }
            if (spec.startsWith('.')) {
                let resolved = path.resolve(dir, spec);
                if (fs.existsSync(`${resolved}.ts`)) resolved += '.ts';
                else if (fs.existsSync(`${resolved}.tsx`)) resolved += '.tsx';
                return load(resolved);
            }
            return require(spec);
        };
        const wrapper = vm.compileFunction(outputText, ['module', 'exports', 'require', '__filename', '__dirname'], {filename: abs});
        wrapper(mod, mod.exports, req, abs, dir);
        return mod.exports;
    };
    return {classify: load(classifyPath), rrc: load(rrcPath)};
}

function swiftParseAirtelShort(value) {
    if (value.length < 11) return null;
    const toInt = s => (/^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null);
    const [y, mo, d, h, mi] = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6), value.slice(7, 9), value.slice(9, 11)].map(toInt);
    if ([y, mo, d, h, mi].some(v => v === null)) return null;
    return new Date(2000 + y, mo - 1, d, h, mi, 0).getTime();
}

function makeDraft(shape, overrides, opts) {
    return draftFromShape({skeleton: shape.skeleton, carrier: shape.carrier, count: 4}, overrides, {existingPatterns: EXISTING, ...opts});
}

function assertRolesMatch(shape, draft) {
    const layout = layoutOf(shape.skeleton);
    const expectedRoles = {};
    for (const [ordinal, role] of Object.entries(shape.roles)) {
        const slot = layout.slots.find(s => s.ordinal === Number(ordinal));
        expectedRoles[role] = slot.group;
    }
    assert.deepEqual(draft.captureMap, expectedRoles, `${shape.name}: captureMap`);
}

/* ------------------------------ draft structure ------------------------------ */

test('draft has exactly the shape remoteRegexConfig.ts expects, plus review metadata', () => {
    const draft = makeDraft(NOVEL[0]);
    assert.deepEqual(
        Object.keys(draft).sort(),
        ['captureMap', 'carrier', 'confidence', 'flags', 'gate', 'id', 'locale', 'notes', 'pattern', 'sourceShape', 'status', 'tags', 'timestamp', 'type'],
    );
    assert.equal(draft.flags, 'i');
    assert.equal(draft.status, 'pending_review');
    assert.equal(draft.carrier, 'mtn');
    assert.equal(draft.locale, 'en-RW');
    assert.ok(Array.isArray(draft.notes) && draft.notes.length > 0);
    assert.ok(draft.confidence > 0 && draft.confidence <= 1);
    assert.deepEqual(draft.tags, ['transfer']);
    assert.match(draft.id, /^auto-mtn-transfer-[0-9a-f]{8}$/);
    assert.equal(draft.sourceShape.skeleton, NOVEL[0].skeleton);
    assert.equal(draft.sourceShape.count, 4);
    assert.match(draft.sourceShape.shapeId, /^[0-9a-f]{16}$/);
    assert.equal(draft.sourceShape.shapeId, crypto.createHash('sha256').update(NOVEL[0].skeleton).digest('hex').slice(0, 16));
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(draft)));
});

test('shapeId matches anonymize.js when that module is present', t => {
    let anonymize;
    try {
        anonymize = require('../../lib/manie/anonymize');
    } catch (_) {
        return t.skip('anonymize.js not present yet');
    }
    if (typeof anonymize.shapeId !== 'function') return t.skip('anonymize.shapeId missing');
    const draft = makeDraft(NOVEL[0], undefined, {gate: false});
    assert.equal(draft.sourceShape.shapeId, anonymize.shapeId(NOVEL[0].skeleton));
});

test('gate can be skipped and the draft stays serialisable without it', () => {
    const draft = makeDraft(NOVEL[1], undefined, {gate: false});
    assert.equal('gate' in draft, false);
});

test('pattern building rules: escaping, spaces, prefix, trailing word slot', () => {
    const lead = draftFromShape({skeleton: '{N} RWF (sent) to {W+} at {TS}', carrier: 'mtn'}, undefined, {gate: false});
    assert.ok(lead.pattern.startsWith(`${NUMBER_REGEX}${SEPARATOR_REGEX}RWF`), 'no .*? prefix when the shape starts with a slot');
    assert.ok(lead.pattern.includes('\\(sent\\)'), 'literal parentheses escaped');
    assert.ok(lead.pattern.includes(`to${SEPARATOR_CLASS}(`) && lead.pattern.includes(`)${SEPARATOR_CLASS}at${SEPARATOR_REGEX}`), 'one separator next to a free-text slot (the rest of a run belongs to the text), runs everywhere else');

    const literalFirst = draftFromShape({skeleton: 'Sent {N} RWF to {W+}', carrier: 'mtn'}, undefined, {gate: false});
    assert.ok(literalFirst.pattern.startsWith(`.*?Sent${SEPARATOR_REGEX}`));
    assert.ok(literalFirst.pattern.includes(`to${SEPARATOR_CLASS}(`) && literalFirst.pattern.endsWith('[\\s\\S])+)'), 'final word slot is greedy so it never captures an empty string');

    const meta = draftFromShape({skeleton: 'A.b*c+d? ({N}) [x] {y} RWF {N}', carrier: 'mtn'}, undefined, {gate: false});
    assert.doesNotThrow(() => new RegExp(meta.pattern, 'i'));
    assert.ok(new RegExp(meta.pattern, 'i').test('A.b*c+d? (12) [x] {y} RWF 34'));
    assert.equal(new RegExp(meta.pattern, 'i').test('AxbbcCd (12) [x] {y} RWF 34'), false);

    const urlEmail = draftFromShape({skeleton: 'Pay {N} RWF at {URL} or {EMAIL} on {TS}', carrier: 'mtn'}, undefined, {gate: false});
    assert.ok(urlEmail.pattern.includes('\\S+'));
    assert.equal((new RegExp(`${urlEmail.pattern}|`).exec('').length - 1), 2, 'URL/EMAIL are not captured');
});

test('whitespace in real messages may vary: runs of spaces still match', () => {
    const shape = NOVEL[0];
    const draft = makeDraft(shape);
    const spaced = buildMessage(shape, draft).replace(/ /g, '   ').replace('2026-04-11   14:30:00', '2026-04-11 14:30:00');
    const res = testPattern(draft, spaced);
    assert.equal(res.matched, true);
    assert.equal(res.fields.amount, 5000);
});

test('timestamp placeholder also accepts fractional seconds and zone offsets', () => {
    const draft = makeDraft(NOVEL[3]);
    const message = synthesize(NOVEL[3].skeleton, {roleByOrdinal: roleOrdinalMap(NOVEL[3].skeleton, draft)}).message.replace('2026-04-11 14:30:00', '2026-04-11T14:30:00.123+02:00');
    const res = testPattern(draft, message);
    assert.equal(res.matched, true);
    assert.equal(res.captures[draft.timestamp.group], '2026-04-11T14:30:00.123+02:00');
    assert.equal(res.fields.fee, 100);
});

test('invalid input is rejected with a coded error', () => {
    const bad = [
        [{skeleton: 'Sent 5000 RWF to {W+}', carrier: 'mtn'}, 'invalid_skeleton'],
        [{skeleton: 'Sent {N} RWF to Zoë {W+}', carrier: 'mtn'}, 'invalid_skeleton'],
        [{skeleton: `${'a '.repeat(250)}{N}`, carrier: 'mtn'}, 'invalid_skeleton'],
        [{skeleton: '', carrier: 'mtn'}, 'invalid_skeleton'],
        [{skeleton: 'Sent {N} RWF to {W+}', carrier: 'tigo'}, 'invalid_carrier'],
        [{skeleton: 'Sent {N} RWF to {W+}'}, 'invalid_carrier'],
        [null, 'invalid_shape'],
    ];
    for (const [shape, code] of bad) {
        assert.throws(() => draftFromShape(shape), err => err.code === code, `${JSON.stringify(shape)} -> ${code}`);
    }
});

test('carrier is case-insensitive and locale falls back sensibly', () => {
    assert.equal(draftFromShape({skeleton: 'Sent {N} RWF to {W+} at {TS}', carrier: 'MTN'}, undefined, {gate: false}).carrier, 'mtn');
    assert.equal(draftFromShape({skeleton: 'Sent {N} RWF to {W+} at {TS}', carrier: 'mtn', locale: 'rw'}, undefined, {gate: false}).locale, 'rw-RW');
    assert.equal(draftFromShape({skeleton: 'Sent {N} RWF to {W+} at {TS}', carrier: 'mtn', locale: 'garbage!'}, undefined, {gate: false}).locale, 'en-RW');
    assert.equal(draftFromShape({skeleton: 'Kohereza {N} RWF kuri {W+} at {TS}', carrier: 'airtel'}, undefined, {gate: false}).locale, 'rw-RW');
});

test('airtel drafts carry the airtel tag, mtn drafts do not', () => {
    assert.deepEqual(makeDraft(NOVEL[6], undefined, {gate: false}).tags, ['transfer', 'airtel']);
    assert.deepEqual(makeDraft(NOVEL[0], undefined, {gate: false}).tags, ['transfer']);
});

/* ------------------------------ role guessing ------------------------------ */

for (const shape of [...NOVEL, ...DERIVED]) {
    test(`roles and type: ${shape.name}`, () => {
        const draft = makeDraft(shape);
        assert.equal(draft.type, shape.type);
        assertRolesMatch(shape, draft);
        if (shape.locale) assert.equal(draft.locale, shape.locale);
        assert.equal(draft.gate.ok, true, `${shape.name}: ${JSON.stringify(draft.gate.checks.filter(c => !c.ok))}`);
        if (shape.tid) {
            assert.deepEqual(draft.timestamp.parser, 'airtel-shortcode');
        } else {
            assert.deepEqual(draft.timestamp.parser, 'iso8601');
        }
    });
}

test('hints: keywords always win, hints only fill unlabelled slots, conflicts are reported, bad hints are ignored', () => {
    const skeleton = 'Sent {N} RWF to {W+} on {TS}. Fee {N} RWF. Bal {N} RWF.';
    const plain = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {gate: false});
    const g = n => layoutOf(skeleton).slots.find(s => s.slotNo === n).group;
    assert.equal(plain.captureMap.amount, g(1));
    assert.equal(plain.captureMap.fee, g(3));

    const swapped = draftFromShape({skeleton, carrier: 'mtn', hintVotes: {3: {amount: 5}, 1: {fee: 4}}}, undefined, {gate: false});
    assert.equal(swapped.captureMap.amount, g(1), 'a hint never overrides the keyword');
    assert.equal(swapped.captureMap.fee, g(3));
    assert.equal(swapped.notes.filter(n => n.startsWith('conflict:')).length, 2);
    assert.ok(swapped.confidence < plain.confidence, 'a conflict lowers the confidence');
    assert.ok(!swapped.notes.some(n => /device hint/.test(n) && !n.startsWith('conflict:')), 'no hint was applied');

    const weakIgnored = draftFromShape({skeleton, carrier: 'mtn', hintVotes: {3: {amount: 1}}}, undefined, {gate: false});
    assert.equal(weakIgnored.captureMap.fee, g(3), 'a single vote does not beat a keyword');

    const split = draftFromShape({skeleton, carrier: 'mtn', hintVotes: {3: {amount: 2, fee: 2}}}, undefined, {gate: false});
    assert.equal(split.captureMap.fee, g(3), 'split votes are not strong');

    const incompatible = draftFromShape({skeleton, carrier: 'mtn', hintVotes: {2: {amount: 9}, 99: {fee: 9}, x: {fee: 9}, 1: {bogus: 9}}}, undefined, {gate: false});
    assert.equal(incompatible.captureMap.amount, g(1));
    assert.equal(incompatible.captureMap.secondParty, g(2));

    const lone = draftFromShape({skeleton: 'Sent {N} {N} {N} to {W+} on {TS}.', carrier: 'mtn', hintVotes: {2: {fee: 1}}}, undefined, {gate: false});
    assert.equal(lone.captureMap.fee, undefined, 'a lone vote is one device and decides nothing');
    const fills = draftFromShape({skeleton: 'Sent {N} {N} {N} to {W+} on {TS}.', carrier: 'mtn', hintVotes: {2: {fee: 2}}}, undefined, {gate: false});
    assert.ok(fills.captureMap.fee, 'two devices can fill an otherwise unlabelled slot');
    const strong = draftFromShape({skeleton: 'Sent {N} {N} {N} to {W+} on {TS}.', carrier: 'mtn', hintVotes: {3: {balance: 4}}}, undefined, {gate: false});
    assert.equal(strong.captureMap.balance, layoutOf('Sent {N} {N} {N} to {W+} on {TS}.').slots.find(s => s.slotNo === 3).group);
    assert.ok(strong.confidence < 0.95, 'hints never raise a role to 0.95');
});

test('hints for a withdrawal map the other party to the agent', () => {
    const skeleton = 'Cash {W+}({PH}) {N} RWF at {TS}. Balance {N} RWF';
    const draft = draftFromShape({skeleton, carrier: 'mtn', hintVotes: {1: {secondParty: 3}, 2: {accountNumber: 3}}}, {type: 'withdraw'}, {gate: false});
    const layout = layoutOf(skeleton);
    assert.equal(draft.captureMap.agentName, layout.slots[0].group);
    assert.equal(draft.captureMap.agentNumber, layout.slots[1].group);
    assert.equal(draft.captureMap.secondParty, undefined);
});

test('hint slots count only numeric and word placeholders, not timestamps or TIDs', () => {
    const skeleton = '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} at {TS}. Charge {N}. Bal {N}.';
    const layout = layoutOf(skeleton);
    assert.deepEqual(layout.slots.map(s => s.slotNo), [1, null, 2, 3, null, 4, 5]);
    const unlabelled = '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} at {TS}. {N}. {N}.';
    const unlabelledLayout = layoutOf(unlabelled);
    const draft = draftFromShape({skeleton: unlabelled, carrier: 'airtel', hintVotes: {5: {fee: 3}, 4: {balance: 3}}}, undefined, {gate: false});
    assert.equal(draft.captureMap.fee, unlabelledLayout.slots.find(s => s.slotNo === 5).group);
    assert.equal(draft.captureMap.balance, unlabelledLayout.slots.find(s => s.slotNo === 4).group);
});

test('amount is not guessed from a USSD service code or a code-like number', () => {
    const draft = draftFromShape({skeleton: '*{N}*TID {TID}*S* Done Rwf {N} Kode {N} OK. Ubu mufite Rwf {N}. *KR#', carrier: 'airtel'}, undefined, {gate: false});
    const layout = layoutOf('*{N}*TID {TID}*S* Done Rwf {N} Kode {N} OK. Ubu mufite Rwf {N}. *KR#');
    assert.equal(draft.captureMap.amount, layout.slots[2].group);
    assert.equal(draft.captureMap.balance, layout.slots[4].group);
    assert.equal(Object.keys(draft.captureMap).includes('accountNumber'), false);
});

test('an identifier-like phone-length number is not mistaken for an account number', () => {
    const skeleton = 'Paid {N} RWF to {W+} on {TS}. Ref Id: {PH}. Balance {N} RWF.';
    const draft = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {gate: false});
    assert.equal(draft.captureMap.accountNumber, undefined);
});

test('type guess: earliest keyword wins; weak keyword and *R* marker fallbacks; default is payment with a note', () => {
    const t = s => draftFromShape({skeleton: s, carrier: 'airtel'}, undefined, {gate: false});
    assert.equal(t('You received Rwf {N} from {W+} after you sent it on {TS}').type, 'receive');
    assert.equal(t('Cash withdrawn {N} RWF at {TS}').type, 'withdraw');
    assert.equal(t('Bank deposit {N} RWF at {TS}').type, 'deposit');
    assert.equal(t('Kugura {W+} ya Rwf {N} at {TS}').type, 'payment');
    assert.equal(t('A transaction of {N} RWF by {W+} at {TS}').type, 'payment');
    assert.equal(t('*{N}*TID {TID}*R* Rwf {N} OK').type, 'receive');
    const dflt = t('Rwf {N} OK at {TS}');
    assert.equal(dflt.type, 'payment');
    assert.ok(dflt.notes.some(n => /defaulted to payment/.test(n)));
    assert.ok(dflt.confidence < t('Payment of Rwf {N} OK at {TS}').confidence);
});

test('shapes without amount, timestamp or id are flagged in notes and fail the gate', () => {
    const noAmount = draftFromShape({skeleton: 'Hello {W+} your code is {W} at {TS}', carrier: 'mtn'});
    assert.equal(noAmount.gate.ok, false);
    assert.ok(noAmount.notes.some(n => /no amount slot/.test(n)));
    assert.ok(noAmount.confidence <= 0.2);
    const noAnchor = draftFromShape({skeleton: 'Sent {N} RWF to {W+}. Balance {N} RWF', carrier: 'mtn'});
    assert.equal(noAnchor.gate.ok, false);
    assert.ok(noAnchor.notes.some(n => /no timestamp or transaction id/.test(n)));
});

/* ------------------------------ airtel TID rule ------------------------------ */

test('AIRTEL TID RULE (option B): one capture group holds the full TID and is both the transaction id and the timestamp', () => {
    const shape = DERIVED.find(s => s.name === 'airtel to airtel transfer en');
    const draft = makeDraft(shape);
    assert.ok(draft.pattern.includes(TID_REGEX), 'the full TID is one capture group');
    assert.equal(draft.pattern.includes('(\\d+\\.\\d+)'), false, 'no nested group inside the TID');
    assert.deepEqual(draft.captureMap, {transactionId: 2, secondParty: 3, accountNumber: 4, amount: 5, fee: 6, balance: 7});
    assert.deepEqual(draft.timestamp, {group: 2, parser: 'airtel-shortcode'});
    assert.equal(draft.timestamp.group, draft.captureMap.transactionId);
    assert.equal(new RegExp(`${draft.pattern}|`, 'i').exec('').length - 1, 7);
    const message = buildMessage(shape, draft);
    const res = testPattern(draft, message);
    assert.equal(res.matched, true);
    assert.equal(res.captures[2], 'PP260411.1430.A12345');
    assert.equal(res.captures[5], '5000');
    assert.equal(res.fields.transactionId, 'PP260411.1430.A12345');
    assert.equal(res.fields.timestampRaw, 'PP260411.1430.A12345');
    assert.equal(res.fields.timestampMs, EXPECTED_TS);
    assert.deepEqual(res.warnings, [], 'every build of the app reads the full TID the same way');
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
    assert.ok(draft.notes.some(n => /Airtel TID rule: group 2 is the full TID/.test(n)));
});

test('AIRTEL TID RULE (option B): the full TID parses under the iOS parseAirtelShort contract', () => {
    const shape = NOVEL[6];
    const draft = makeDraft(shape);
    const res = testPattern(draft, buildMessage(shape, draft));
    const captured = res.captures[draft.timestamp.group];
    assert.equal(captured, TID_VALUES[0]);
    assert.equal(H.swiftParseAirtelShortTolerant(captured), EXPECTED_TS, 'tolerant of the two-letter prefix');
    assert.equal(swiftParseAirtelShort(captured), null, 'the iOS parser before the prefix change cannot read it, so those builds store the processing time');
});

test('AIRTEL TID RULE (option B): a second TID placeholder occupies one group of its own, only the first one is mapped', () => {
    const skeleton = '*{N}*TID {TID}*S* Sent Rwf {N} to {W+} ref {TID}. Bal Rwf {N}. *EN#';
    const draft = draftFromShape({skeleton, carrier: 'airtel'}, undefined, {gate: false});
    const layout = layoutOf(skeleton);
    const tids = layout.slots.filter(s => s.kind === 'TID');
    assert.equal(draft.captureMap.transactionId, tids[0].group);
    assert.equal(draft.timestamp.group, tids[0].group);
    assert.deepEqual(tids.map(t => t.group), [2, 5]);
    assert.equal(draft.captureMap.amount, 3);
    assert.equal(draft.captureMap.balance, 6);
    assert.equal(new RegExp(`${draft.pattern}|`).exec('').length - 1, layout.groupCount);
});

test('AIRTEL TID RULE (option B): the TID group is tight enough that every match is a real date, under every reader', () => {
    const re = new RegExp(`^${TID_REGEX}$`, 'i');
    for (const good of ['PP260411.1430.A12345', 'MP261002.0905.C77', 'rc260502.1015.h75073', 'CI261231.2359.Z9', 'NP260101.0000.A1']) {
        assert.equal(re.test(good), true, good);
    }
    for (const bad of ['PP261301.1430.A1', 'PP260011.1430.A1', 'PP260400.1430.A1', 'PP260432.1430.A1', 'PP260411.2430.A1', 'PP260411.1460.A1', 'PP2604111.1430.A1', 'PP26041.1430.A1', 'PP260411.143.A1', 'PP260411.14300.A1', '260411.1430', 'PP260411.1430.', 'PP260411.1430.12', 'P260411.1430.A1']) {
        assert.equal(re.test(bad), false, bad);
    }
});

test('a shape with both an ISO timestamp and a TID keeps the ISO timestamp and the full TID', () => {
    const skeleton = 'Sent Rwf {N} to {W+} id {TID} at {TS}. Bal Rwf {N}.';
    const draft = draftFromShape({skeleton, carrier: 'airtel'}, undefined, {existingPatterns: EXISTING});
    assert.equal(draft.timestamp.parser, 'iso8601');
    assert.equal(draft.timestamp.group, layoutOf(skeleton).slots.find(s => s.kind === 'TS').group);
    assert.ok(draft.captureMap.transactionId);
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
});

/* ------------------------------ overrides ------------------------------ */

test('override: type and id', () => {
    const shape = NOVEL[2];
    const draft = makeDraft(shape, {type: 'transfer', id: 'my-custom-id'});
    assert.equal(draft.type, 'transfer');
    assert.equal(draft.id, 'my-custom-id');
    assert.ok(draft.notes.some(n => /type set to "transfer" by admin/.test(n)));
    assert.equal(makeDraft(shape, {type: 'transfer'}).id.startsWith('auto-mtn-transfer-'), true);
    const invalidType = makeDraft(shape, {type: 'refund'});
    assert.equal(invalidType.gate.ok, false);
    assert.equal(invalidType.gate.checks.find(c => c.name === 'valid-type').ok, false);
});

test('override: type withdraw re-assigns agent roles', () => {
    const draft = draftFromShape({skeleton: 'Cash {W+}({PH}) {N} RWF at {TS}. Balance {N} RWF', carrier: 'mtn'}, {type: 'withdraw'}, {gate: false});
    assert.ok(draft.captureMap.agentName && draft.captureMap.agentNumber);
    assert.equal(draft.captureMap.secondParty, undefined);
});

test('override: captureMap edits use pattern group numbers and swap cleanly', () => {
    const shape = NOVEL[0];
    const draft = makeDraft(shape);
    const {amount, fee} = draft.captureMap;
    const swapped = makeDraft(shape, {captureMap: {amount: fee, fee: amount}});
    assert.equal(swapped.captureMap.amount, fee);
    assert.equal(swapped.captureMap.fee, amount);
    assert.equal(swapped.pattern, draft.pattern, 'regex is unchanged by role edits');
    const clash = makeDraft(shape, {captureMap: {amount, fee: amount}});
    assert.equal(clash.gate.ok, false, 'two roles on one group is rejected by the gate');

    const stolen = makeDraft(shape, {captureMap: {fee: draft.captureMap.balance}});
    assert.equal(stolen.captureMap.fee, draft.captureMap.balance);
    assert.equal(stolen.captureMap.balance, undefined, 'the previous owner of a claimed group is dropped');
    assert.ok(stolen.notes.some(n => /balance capture dropped/.test(n)));

    const removed = makeDraft(shape, {captureMap: {fee: null}});
    assert.equal(removed.captureMap.fee, undefined);

    const unknown = makeDraft(shape, {captureMap: {nonsense: 3}});
    assert.ok(unknown.notes.some(n => /unknown captureMap role "nonsense"/.test(n)));

    const outOfRange = makeDraft(shape, {captureMap: {fee: 99}});
    assert.equal(outOfRange.gate.ok, false, 'bad group numbers are surfaced by the gate, not silently fixed');

    const asString = makeDraft(shape, {captureMap: {fee: String(draft.captureMap.fee)}});
    assert.equal(asString.captureMap.fee, draft.captureMap.fee);
});

test('override: edited captureMap round-trips unchanged', () => {
    for (const shape of [NOVEL[0], NOVEL[6], DERIVED[6]]) {
        const draft = makeDraft(shape);
        const again = makeDraft(shape, {captureMap: draft.captureMap, timestamp: draft.timestamp, type: draft.type, id: draft.id});
        assert.deepEqual(again.captureMap, draft.captureMap);
        assert.deepEqual(again.timestamp, draft.timestamp);
        assert.equal(again.pattern, draft.pattern);
    }
});

test('override: timestamp parser/group edits and removal', () => {
    const shape = NOVEL[0];
    const draft = makeDraft(shape);
    assert.equal(makeDraft(shape, {timestamp: {parser: 'airtel-shortcode'}}).timestamp.parser, 'airtel-shortcode');
    assert.equal(makeDraft(shape, {timestamp: {parser: 'iso8601', group: 1}}).timestamp.group, 1);
    const none = makeDraft(shape, {timestamp: null});
    assert.equal(none.timestamp, undefined);
    assert.equal(none.gate.ok, false, 'no timestamp and no transaction id is rejected');
    assert.equal(makeDraft(shape, {timestamp: {parser: 'weird'}}).gate.ok, false);
    assert.equal(draft.timestamp.parser, 'iso8601');
});

test('override: wordsAsLiteral turns word slots into literal text and the gate synthesizes from the literal skeleton', () => {
    const skeleton = '{N} RWF transferred to {W+}({PH}) at {TS}. {W} {N} RWF. Balance: {N} RWF';
    const baseDraft = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {gate: false});
    const plainGroups = new RegExp(`${baseDraft.pattern}|`).exec('').length - 1;
    const draft = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['Charges']}, {existingPatterns: EXISTING});
    assert.equal(new RegExp(`${draft.pattern}|`).exec('').length - 1, plainGroups - 1);
    assert.ok(/Charges\\s\+?/.test(draft.pattern) || draft.pattern.includes('Charges'));
    assert.equal(draft.sourceShape.skeleton, skeleton, 'original skeleton kept for traceability');
    assert.equal(draft.sourceShape.synthSkeleton, '{N} RWF transferred to {W+}({PH}) at {TS}. Charges {N} RWF. Balance: {N} RWF');
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
    const layout = layoutOf(draft.sourceShape.synthSkeleton);
    assert.equal(draft.captureMap.fee, layout.slots.filter(sl => sl.kind === 'N')[1].group, 'the literal word "Charges" now labels the fee slot');
});

test('override: wordsAsLiteral targeting and misuse', () => {
    const skeleton = 'Sent {N} RWF to {W+} then {W} via {W} on {TS}. Balance {N} RWF';
    const targeted = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['3:Bank']}, {gate: false});
    assert.equal(targeted.sourceShape.synthSkeleton, 'Sent {N} RWF to {W+} then {W} via Bank on {TS}. Balance {N} RWF');
    const sequential = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['Then', 'Via']}, {gate: false});
    assert.equal(sequential.sourceShape.synthSkeleton, 'Sent {N} RWF to {W+} then Then via Via on {TS}. Balance {N} RWF');
    const multi = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['1:Alice Sample']}, {gate: false});
    assert.equal(multi.sourceShape.synthSkeleton, 'Sent {N} RWF to Alice Sample then {W} via {W} on {TS}. Balance {N} RWF');
    const wrongArity = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['2:two words'], }, {gate: false});
    assert.equal(wrongArity.sourceShape.synthSkeleton, undefined);
    assert.ok(wrongArity.notes.some(n => /does not fit/.test(n)));
    const junk = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['(.*)', 12, '', 'a;b']}, {gate: false});
    assert.equal(junk.sourceShape.synthSkeleton, undefined);
    assert.equal(junk.notes.filter(n => /invalid wordsAsLiteral/.test(n)).length >= 2, true);
    assert.equal(new RegExp(junk.pattern, 'i').test('Sent 5 RWF to X then Y via Z on 2026-04-11 14:30:00. Balance 3 RWF'), true);
});

test('describeDraft maps every placeholder to its group and role for the admin page', () => {
    const shape = DERIVED.find(s => s.name === 'airtel to airtel transfer en');
    const draft = makeDraft(shape);
    const view = describeDraft(draft);
    assert.equal(view.groupCount, 7);
    assert.deepEqual(
        view.slots.map(s => [s.kind, s.group, s.role, s.roles]),
        [
            ['N', 1, null, []],
            ['TID', 2, 'transactionId', ['transactionId', 'timestamp']],
            ['W+', 3, 'secondParty', ['secondParty']],
            ['PH', 4, 'accountNumber', ['accountNumber']],
            ['N', 5, 'amount', ['amount']],
            ['N', 6, 'fee', ['fee']],
            ['N', 7, 'balance', ['balance']],
        ],
    );
    assert.deepEqual(describeLayout(shape.skeleton).slots.map(s => s.slotNo), [1, null, 2, 3, 4, 5, 6]);
    assert.equal(describeLayout('bad 5 skeleton'), null);
    assert.equal(describeDraft({}), null);
    const literal = draftFromShape({skeleton: 'Sent {N} RWF to {W} on {TS}', carrier: 'mtn'}, {wordsAsLiteral: ['Bob']}, {gate: false});
    assert.equal(describeDraft(literal).slots.length, 2, 'uses the literal skeleton when words were turned into text');
});

test('redraft is deterministic apart from gate timings', () => {
    const shape = NOVEL[7];
    const strip = d => {
        const {gate, ...rest} = d;
        return {...rest, checks: gate.checks.map(c => [c.name, c.ok])};
    };
    assert.deepEqual(strip(makeDraft(shape)), strip(makeDraft(shape)));
});

/* ------------------------------ gate integration ------------------------------ */

test('drafts of every shape pass the gate against the real served patterns', () => {
    for (const shape of [...NOVEL, ...DERIVED]) {
        const draft = makeDraft(shape);
        assert.deepEqual(draft.gate.checks.map(c => c.ok), Array(CHECK_NAMES.length).fill(true), `${shape.name}: ${JSON.stringify(draft.gate.checks.filter(c => !c.ok))}`);
        const again = runGate(draft, {existingPatterns: EXISTING});
        assert.equal(again.ok, true);
    }
});

/* ------------------------------ generated shapes ------------------------------ */

function lcg(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

const FUZZ_WORDS = ['sent', 'to', 'from', 'fee', 'balance', 'rwf', 'RWF', 'at', 'on', 'your', 'payment', 'completed', 'transaction', 'successful', 'new', 'of', 'you', 'have', 'received', 'bal', 'amt', 'txn', 'id', 'TID', 'kuri', 'ubu', 'mufite', 'byagenze', 'neza', 'Kohereza', 'Mwakiriye', 'Kwishyura', 'withdrawn', 'agent', 'deposit', 'charge', 'token', 'cash', 'is', 'was', 'by', 'has', 'been'];
const FUZZ_PUNCT = ['.', ':', ';', '-', '/', '*', '#', '(', ')', '!', '?', '%', '@', '&', '=', '_', ','];
const FUZZ_SLOTS = ['{N}', '{N}', '{N}', '{PH}', '{W+}', '{W}', '{TS}', '{TID}', '{URL}', '{EMAIL}'];

function randomSkeleton(rand) {
    const pick = list => list[Math.floor(rand() * list.length)];
    const isWord = t => t === '{W}' || t === '{W+}';
    const isNum = t => t === '{N}' || t === '{PH}';
    const isSlot = t => t.startsWith('{');
    const count = 3 + Math.floor(rand() * 13);
    let out = '';
    let last = null;
    for (let i = 0; i < count; i++) {
        const r = rand();
        let item = r < 0.5 ? pick(FUZZ_WORDS) : r < 0.9 ? pick(FUZZ_SLOTS) : pick(FUZZ_PUNCT);
        if (last && isWord(last) && (isWord(item) || item === '{URL}' || item === '{EMAIL}')) item = pick(FUZZ_WORDS);
        if (last && (last === '{URL}' || last === '{EMAIL}') && isWord(item)) item = pick(FUZZ_WORDS);
        let sep = rand() < 0.8 ? ' ' : '';
        if (last && isSlot(last) && isSlot(item)) sep = ' ';
        if (last && isNum(last) && /^[.,]/.test(item) && item !== '.') sep = ' ';
        if (last && isNum(item) && /[.,]$/.test(last)) sep = ' ';
        if (last && !isSlot(last) && !isSlot(item) && /^[A-Za-z]/.test(last) && /^[A-Za-z]/.test(item)) sep = ' ';
        if (i > 0) out += sep;
        out += item;
        last = item;
    }
    return out.replace(/ +/g, ' ').trim();
}

test('generated shapes: drafts always compile, layouts agree, and a draft that clears the structural checks always matches its own skeleton', () => {
    const rand = lcg(20261021);
    let cleared = 0;
    let total = 0;
    for (let i = 0; i < 300; i++) {
        const skeleton = randomSkeleton(rand);
        if (!skeleton || skeleton.length > 400) continue;
        total += 1;
        const carrier = rand() < 0.5 ? 'mtn' : 'airtel';
        const draft = draftFromShape({skeleton, carrier, count: 1});
        const groups = new RegExp(`${draft.pattern}|`, 'i').exec('').length - 1;
        assert.equal(groups, layoutOf(skeleton).groupCount, skeleton);
        const values = Object.values(draft.captureMap);
        assert.equal(new Set(values).size, values.length, skeleton);
        for (const v of values) assert.ok(Number.isInteger(v) && v >= 1 && v <= groups, skeleton);
        if (draft.timestamp) assert.ok(draft.timestamp.group >= 1 && draft.timestamp.group <= groups, skeleton);
        assert.deepEqual(draft.gate.checks.map(c => c.name).length, CHECK_NAMES.length);
        const byName = Object.fromEntries(draft.gate.checks.map(c => [c.name, c]));
        const structural = ['regex-compiles', 'capture-map', 'valid-type'].every(n => byName[n].ok);
        if (structural && byName['redos-guard'].ok) {
            assert.equal(byName['self-match'].ok, true, `${skeleton} -> ${byName['self-match'].detail}`);
            cleared += 1;
        }
    }
    assert.ok(total >= 250);
    assert.ok(cleared >= 50, `only ${cleared} generated shapes cleared the structural and ReDoS checks`);
});

test('hostile skeleton strings either produce a draft or a coded error, never anything else', () => {
    const rand = lcg(77);
    const pool = ['{N}', '{PH}', '{W+}', '{W}', '{TS}', '{TID}', '{URL}', '{EMAIL}', '{x}', '{', '}', '5', '0', 'a', 'Z', ' ', '  ', '\n', '\t', '.', '*', '(', ')', '[', ']', '\\', '|', '$', '^', '+', '?', 'é', '\u202e', '\u0000', '<', '>', '"', "'"];
    const mostlyValid = ['{N}', '{PH}', '{W+}', '{TS}', '{TID}', ' ', ' ', '.', '*', '(', ')', 'a', 'RWF', 'Fee'];
    let produced = 0;
    for (let i = 0; i < 400; i++) {
        const len = 1 + Math.floor(rand() * 40);
        const source = i % 2 === 0 ? mostlyValid : pool;
        let skeleton = '';
        for (let j = 0; j < len; j++) skeleton += source[Math.floor(rand() * source.length)];
        try {
            const draft = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {gate: false});
            produced += 1;
            assert.doesNotThrow(() => new RegExp(draft.pattern, 'i'));
            assert.equal(new RegExp(`${draft.pattern}|`, 'i').exec('').length - 1, layoutOf(skeleton).groupCount);
        } catch (error) {
            assert.equal(error.code, 'invalid_skeleton', `${JSON.stringify(skeleton)}: ${error.message}`);
        }
    }
    assert.ok(produced > 50, 'many of the generated strings were valid skeletons');
});

/* ------------------------------ anonymizer contract ------------------------------ */

function loadAnonymizer() {
    try {
        const anonymize = require('../../lib/manie/anonymize');
        const vocab = require('../../lib/manie/vocab');
        const seed = require('../../assets/manie/vocab-seed.json');
        return {anonymize, vocab, seed};
    } catch (_) {
        return null;
    }
}

const ANON = loadAnonymizer();

function vocabFor(skeleton) {
    const words = new Set(ANON.vocab.buildVocabulary({seed: ANON.seed, patterns: base.patterns, adminWords: []}));
    const parsed = require('../../lib/manie/_fields').tokenizeSkeleton(skeleton);
    for (const t of parsed.tokens) if (t.type === 'word') words.add(t.text.toLowerCase());
    return words;
}

for (const shape of [...NOVEL, ...DERIVED]) {
    test(`anonymizer output feeds the draft generator unchanged: ${shape.name}`, {skip: ANON ? false : 'anonymize.js / vocab.js not present'}, () => {
        const draft = makeDraft(shape);
        const message = buildMessage(shape, draft);
        const {skeleton} = ANON.anonymize.anonymize(message, vocabFor(shape.skeleton));
        assert.equal(skeleton, shape.skeleton, 'a message built from the skeleton anonymizes back to the same skeleton');
        const again = makeDraft({...shape, skeleton});
        assert.equal(again.pattern, draft.pattern);
        assert.deepEqual(again.captureMap, draft.captureMap);
        assert.equal(again.sourceShape.shapeId, ANON.anonymize.shapeId(skeleton));
        assert.equal(again.gate.ok, true);
    });
}

test('an unknown word that anonymizes to {W} can be restored with wordsAsLiteral, which recovers the fee', {skip: ANON ? false : 'anonymize.js / vocab.js not present'}, () => {
    const message = 'You sent 5000 RWF to Alice Sample (0780000001) on 2026-04-11 14:30:00. Charge: 100 RWF. Balance: 123450 RWF.';
    const fullVocab = new Set(ANON.vocab.buildVocabulary({seed: ANON.seed, patterns: base.patterns, adminWords: []}));
    assert.ok(fullVocab.has('charge'), 'the served vocabulary already carries every fee keyword');
    const vocab = new Set([...fullVocab].filter(w => w !== 'charge'));
    const {skeleton} = ANON.anonymize.anonymize(message, vocab);
    assert.equal(skeleton, 'You sent {N} RWF to {W+} ({PH}) on {TS}. {W}: {N} RWF. Balance: {N} RWF.');
    const unresolved = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {existingPatterns: EXISTING});
    assert.equal(unresolved.gate.checks.find(c => c.name === 'word-slots').ok, false, 'a single unknown word blocks approval');
    const before = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {existingPatterns: EXISTING});
    assert.equal(before.captureMap.fee, undefined);
    const after = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['Charge']}, {existingPatterns: EXISTING});
    assert.ok(after.captureMap.fee);
    assert.equal(after.gate.ok, true, JSON.stringify(after.gate.checks.filter(c => !c.ok)));
    const res = testPattern(after, message);
    assert.equal(res.matched, true);
    assert.equal(res.fields.fee, 100);
    assert.equal(res.fields.amount, 5000);

    const withAdminWord = ANON.anonymize.anonymize(message, fullVocab);
    assert.equal(withAdminWord.skeleton, 'You sent {N} RWF to {W+} ({PH}) on {TS}. Charge: {N} RWF. Balance: {N} RWF.');
    assert.equal(draftFromShape({skeleton: withAdminWord.skeleton, carrier: 'mtn'}).captureMap.fee, after.captureMap.fee);
});

/* ------------------------------ real client verification ------------------------------ */

for (const shape of NOVEL) {
    test(`real client (loadClassify + syncRegexConfig): ${shape.name}`, {skip: skipClient}, async t => {
        const client = loadRealClient();
        const draft = makeDraft(shape);
        const message = buildMessage(shape, draft);
        const synced = await applyDrafts(client, [draft]);
        assert.ok(synced.patterns.some(p => p.id === draft.id), 'client parseConfig accepted the pattern');
        const {tx, unmatched} = classifyOne(client, message);
        assert.equal(unmatched, 0, 'message matched');
        assert.ok(tx.tags.includes(MARKER), 'classified by the remote draft, not by a built-in');
        assert.equal(client.classify.isAirtelMessage(message), shape.carrier === 'airtel', 'carrier detection through the airtel tag');
        const expected = expectedFields(shape);
        assert.equal(tx.type, shape.type);
        assert.equal(tx.direction, shape.type === 'receive' || shape.type === 'deposit' ? 'in' : 'out');
        for (const [key, value] of Object.entries(expected)) assert.equal(tx[key], value, `${shape.name}: ${key}`);
        if (!shape.roles || !Object.values(shape.roles).includes('fee')) assert.equal(tx.fee, undefined);

        const raw = testPattern(draft, message);
        assert.equal(raw.matched, true);
        if (shape.tid) {
            assert.equal(raw.captures[draft.captureMap.transactionId], TID_VALUES[0]);
            assert.equal(raw.captures[draft.timestamp.group], TID_VALUES[0], 'the timestamp group is the full TID');
            assert.equal(draft.timestamp.group, draft.captureMap.transactionId);
        }
        assert.equal(tx.timestamp, EXPECTED_TS, 'the timestamp is the one the message says');
    });
}

async function applyViaHarness(drafts, {released, dropBuiltins = true}) {
    configCounter += 1;
    const config = {
        version: `regex-test-${configCounter}`,
        defaultLocale: 'en-RW',
        fetchedAt: `2026-10-21T00:01:${String(configCounter % 60).padStart(2, '0')}Z`,
        patterns: drafts.map(projectDraft),
    };
    const env = H.makeEnv({fetchImpl: async () => H.jsonResponse(config)});
    const client = H.loadClient(env, {root: released ? RELEASED : undefined, dropBuiltins});
    const synced = await client.rrc.syncRegexConfig({forceRefresh: true});
    assert.ok(synced && synced.patterns.some(p => p.id === drafts[0].id), 'the client accepted the pattern');
    return client;
}

for (const shape of [...NOVEL, ...DERIVED]) {
    test(`client without built-ins, RELEASED client (shipped parseAirtelTimestamp): ${shape.name}`, {skip: skipReleased}, async () => {
        const draft = makeDraft(shape);
        const client = await applyViaHarness([draft], {released: true});
        const {tx, unmatched} = classifyOne(client, buildMessage(shape, draft));
        assert.equal(unmatched, 0);
        assert.ok(tx.tags.includes(MARKER));
        const expected = expectedFields(shape);
        for (const [key, value] of Object.entries(expected)) assert.equal(tx[key], value, `${shape.name}: ${key}`);
        assert.equal(tx.type, shape.type);
        assert.equal(tx.timestamp, EXPECTED_TS, 'the shipped parser reads the full TID correctly');
        assert.ok(Number.isFinite(tx.timestamp));
    });

    test(`client without built-ins, CURRENT client (tolerant parseAirtelShortcode): ${shape.name}`, {skip: skipClient}, async () => {
        const draft = makeDraft(shape);
        const client = await applyViaHarness([draft], {released: false});
        const {tx} = classifyOne(client, buildMessage(shape, draft));
        assert.ok(tx && tx.tags.includes(MARKER));
        assert.equal(tx.timestamp, EXPECTED_TS);
        const expected = expectedFields(shape);
        for (const [key, value] of Object.entries(expected)) assert.equal(tx[key], value, `${shape.name}: ${key}`);
        assert.ok(Number.isFinite(tx.timestamp));
    });
}

for (const shape of DERIVED) {
    test(`differential vs built-in classifier: ${shape.name}`, {skip: skipClient}, async t => {
        const draft = makeDraft(shape);
        const message = buildMessage(shape, draft);

        const real = loadRealClient();
        real.classify.setPatternOverrides([]);
        const oracle = classifyOne(real, message);
        assert.equal(oracle.unmatched, 0, `${shape.name}: the synthetic message is a real built-in format`);
        assert.equal(oracle.tx.tags.includes(MARKER), false);

        const patched = loadPatchedClient({dropBuiltins: true, fixAirtel: true});
        await applyDrafts(patched, [draft]);
        const {tx} = classifyOne(patched, message);
        assert.ok(tx.tags.includes(MARKER));

        const builtinIdIsDigitsOnly = oracle.tx.transactionId !== undefined && !/^[A-Za-z]{2}\d/.test(oracle.tx.transactionId);
        if (builtinIdIsDigitsOnly) {
            t.diagnostic(`built-in handler stores a prefix-less transactionId and an invalid timestamp for this format (${oracle.tx.transactionId}); the draft keeps the full TID`);
        }
        for (const key of ['type', 'direction', 'amount', 'balance', 'fee', 'secondParty', 'accountNumber', 'transactionId', 'agentName', 'agentNumber', 'timestamp']) {
            if (oracle.tx[key] === undefined || (shape.unmatchedKeys || []).includes(key)) continue;
            if (builtinIdIsDigitsOnly && (key === 'transactionId' || key === 'timestamp')) continue;
            assert.equal(tx[key], oracle.tx[key], `${shape.name}: ${key} differs from the built-in classifier`);
        }
        if (shape.tid && !builtinIdIsDigitsOnly) assert.equal(tx.transactionId, oracle.tx.transactionId, 'dedup key is identical to the built-in one');
        if (shape.tid) assert.equal(tx.transactionId, TID_VALUES[0]);
    });
}

test('real client accepts several drafts at once and routes each message to its own draft', {skip: skipClient}, async () => {
    const client = loadPatchedClient({dropBuiltins: true, fixAirtel: true});
    const shapes = [NOVEL[0], NOVEL[1], NOVEL[2], NOVEL[6], NOVEL[7], NOVEL[11]];
    const drafts = shapes.map(s => makeDraft(s));
    assert.equal(new Set(drafts.map(d => d.id)).size, drafts.length);
    await applyDrafts(client, drafts);
    shapes.forEach((shape, i) => {
        const {tx} = classifyOne(client, buildMessage(shape, drafts[i]));
        assert.ok(tx, shape.name);
        assert.equal(tx.type, shape.type, shape.name);
        assert.equal(tx.amount, 5000, shape.name);
    });
});

test('negative corpus is not classified by any drafted pattern in the real client', {skip: skipClient}, async () => {
    const client = loadPatchedClient({dropBuiltins: true, fixAirtel: true});
    const drafts = [...NOVEL, ...DERIVED].map(s => makeDraft(s));
    await applyDrafts(client, drafts);
    const corpus = require('../../assets/manie/negative-corpus.json').messages;
    const {transactions} = client.classify.classifyTransactions(corpus.map(m => ({body: m.body})));
    assert.equal(transactions.length, 0);
});

/* ------------------------------ audit regressions ------------------------------ */

const servedVocab = () => new Set(ANON.vocab.buildVocabulary({seed: ANON.seed, patterns: base.patterns, adminWords: []}));
const slotGroup = (skeleton, slotNo) => layoutOf(skeleton).slots.find(s => s.slotNo === slotNo).group;
const gateCheck = (draft, name) => draft.gate.checks.find(c => c.name === name);

test('R1-SERVED-5: a single unknown word is never given a person role unless it follows a preposition', () => {
    const made = 'A cash deposit of {N} RWF has been {W} to your account on {TS}. Your new balance: {N} RWF. TxId: {N}';
    const d1 = draftFromShape({skeleton: made, carrier: 'mtn'}, undefined, {gate: false});
    assert.equal(d1.captureMap.secondParty, undefined, 'the word after "has been" is a status, not a counterparty');
    assert.ok(d1.notes.some(n => /needs a literal/.test(n)));

    const purchase = 'Your airtime purchase of {N} RWF {W} {PH} was completed on {TS}. Your new balance: {N} RWF.';
    assert.equal(draftFromShape({skeleton: purchase, carrier: 'mtn'}, undefined, {gate: false}).captureMap.secondParty, undefined);

    const kinyarwanda = '*{N}*TID {TID}*S* {W} RWF {N} kuri konti yawe neza. Ubu mufite RWF {N}. *KR#';
    const d2 = draftFromShape({skeleton: kinyarwanda, carrier: 'airtel'}, undefined, {gate: false});
    assert.equal(d2.captureMap.secondParty, undefined, '"Kubikuza" as a lone unknown word is not a name');
    assert.equal(d2.captureMap.agentName, undefined);

    const afterPreposition = 'Sent {N} RWF to {W} ({PH}) on {TS}. Balance: {N} RWF.';
    const d3 = draftFromShape({skeleton: afterPreposition, carrier: 'mtn'}, undefined, {gate: false});
    assert.equal(d3.captureMap.secondParty, slotGroup(afterPreposition, 2), 'a one-word name right after "to" is fine');
});

test('R1-SERVED-5: a {W+} slot wins over an earlier single word, and a marker letter never takes the name', () => {
    const skeleton = 'Sent {N} RWF {W} to {W+} on {TS}. Balance: {N} RWF';
    const d1 = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {gate: false});
    assert.equal(d1.captureMap.secondParty, slotGroup(skeleton, 3));

    const marker = '*{N}*TID {TID}*{W}* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#';
    const d2 = draftFromShape({skeleton: marker, carrier: 'airtel'}, undefined, {gate: false});
    assert.equal(d2.captureMap.secondParty, layoutOf(marker).slots.find(s => s.kind === 'W+').group);
    assert.equal(d2.captureMap.accountNumber, layoutOf(marker).slots.find(s => s.kind === 'PH').group);

    const both = 'Sent {N} RWF to {W} and {W+} on {TS}. Balance: {N} RWF';
    const d3 = draftFromShape({skeleton: both, carrier: 'mtn'}, undefined, {gate: false});
    assert.equal(d3.captureMap.secondParty, slotGroup(both, 2), 'the slot that follows a preposition is the other person, whatever the width of the slots around it');
});

test('R1-SERVED-1: an unresolved single word blocks the gate until the admin turns it into a literal, and then "reversed" no longer matches', () => {
    const skeleton = 'Your payment of {N} RWF to {W+} has been {W}. Fee was {N} RWF. Your new balance: {N} RWF. {TS}';
    const draft = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {existingPatterns: EXISTING});
    const check = gateCheck(draft, 'word-slots');
    assert.equal(check.ok, false);
    assert.match(check.detail, /word slot 2/);
    assert.match(check.detail, /wordsAsLiteral/);
    assert.equal(draft.gate.ok, false);
    assert.ok(draft.pattern.includes(`been${SEPARATOR_REGEX}${WORD_REGEX}\\.`), `a single unknown word never swallows more than one token: ${draft.pattern}`);

    const fixed = draftFromShape({skeleton, carrier: 'mtn'}, {wordsAsLiteral: ['2: authorised']}, {existingPatterns: EXISTING});
    assert.equal(gateCheck(fixed, 'word-slots').ok, true);
    assert.equal(fixed.gate.ok, true, JSON.stringify(fixed.gate.checks.filter(c => !c.ok)));
    const ok = 'Your payment of 5,000 RWF to ACME SHOP has been authorised. Fee was 0 RWF. Your new balance: 12,000 RWF. 2026-04-11 14:30:05';
    const failed = ok.replace('authorised', 'reversed').replace('5,000', '7,000');
    assert.equal(testPattern(fixed, ok).matched, true);
    assert.equal(testPattern(fixed, failed).matched, false, 'the reversed notice must stay unmatched');
});

test('R1-SERVED-1: a single {W} compiles to a one-token capture, never to a wildcard', () => {
    const d = draftFromShape({skeleton: 'Sent {N} RWF to {W} at {TS}. Balance {N} RWF', carrier: 'mtn'}, undefined, {gate: false});
    assert.ok(d.pattern.includes(`to${SEPARATOR_REGEX}${WORD_REGEX}${SEPARATOR_REGEX}at`), d.pattern);
    const trailing = draftFromShape({skeleton: 'Sent {N} RWF to {W}', carrier: 'mtn'}, undefined, {gate: false});
    assert.ok(trailing.pattern.endsWith(`to${SEPARATOR_REGEX}${WORD_REGEX}`), trailing.pattern);
});

test('R1-SERVED-2: Airtel drafts pass the gate with no switch, because the full TID reads the same on released and current builds', () => {
    const shape = NOVEL.find(s => s.name === 'airtel en sent (new wording)');
    const draft = draftFromShape({skeleton: shape.skeleton, carrier: 'airtel'}, undefined, {existingPatterns: EXISTING});
    assert.equal(draft.gate.ok, true, JSON.stringify(draft.gate.checks.filter(c => !c.ok)));
    const self = gateCheck(draft, 'self-match');
    assert.equal(self.ok, true);
    assert.match(self.detail, /malformed Airtel codes rejected/);
    assert.doesNotMatch(JSON.stringify(draft.gate), /MANIE_AIRTEL_SHORTCODE_OK|patched app builds/);
    assert.equal(runGate(draft, {existingPatterns: EXISTING, clientTimestampCompat: 'shipped'}).ok, true, 'the old compat option is ignored');
    const ios = gateCheck(draft, 'ios-timestamp');
    assert.equal(ios.ok, true);
    assert.equal(ios.warn, true, 'old iOS builds fall back to the processing time: a warning, not a failure');
    assert.match(ios.detail, /iOS builds before the tolerant parseAirtelShort/);
});

test('R1-SERVED-4: type keywords that used to collapse into {W} now reach the draft generator', () => {
    const vocab = servedVocab();
    const cases = [
        ['mtn', 'You have deposited 5,000 RWF to your account via agent Alice Mukamana (250780000001) on 2026-04-11 14:30:05. Your new balance: 12,000 RWF. TxId: 55512345', 'deposit'],
        ['airtel', '*165*TID PP260411.1430.A12345*S* Kubitsa RWF 5000 kuri konti yawe neza. Ubu mufite RWF 12000. *KR#', 'deposit'],
        ['mtn', 'Withdrawal of 5,000 RWF at agent Alice Mukamana (250780000001) on 2026-04-11 14:30:05. Fee was 250 RWF. Your new balance: 12,000 RWF. TxId: 55512346', 'withdraw'],
        ['airtel', '*165*TID PP260411.1430.A12345*S* Kubikuza RWF 5000 kuri agent Alice Mukamana 0780000001. Fee RWF 250. Ubu mufite RWF 12000. *KR#', 'withdraw'],
    ];
    for (const [carrier, body, type] of cases) {
        const {skeleton} = ANON.anonymize.anonymize(body, vocab);
        const draft = draftFromShape({skeleton, carrier}, undefined, {gate: false});
        assert.equal(draft.type, type, `${skeleton}`);
        assert.ok(!draft.notes.some(n => /defaulted/.test(n)), draft.notes.join(' | '));
        if (type === 'withdraw') assert.ok(draft.captureMap.agentName || draft.captureMap.agentNumber, 'agent roles are filled for a withdrawal');
    }
});

test('R1-SERVED-4: a type that was only defaulted blocks the gate until the admin picks it explicitly', () => {
    const skeleton = 'Dear customer {N} RWF has been moved to {W+} ({PH}) on {TS}. Fee: {N} RWF. Balance: {N} RWF.';
    const defaulted = draftFromShape({skeleton, carrier: 'mtn'}, undefined, {existingPatterns: EXISTING});
    assert.equal(defaulted.type, 'payment');
    const check = gateCheck(defaulted, 'valid-type');
    assert.equal(check.ok, false);
    assert.match(check.detail, /only a default/);

    const confirmed = draftFromShape({skeleton, carrier: 'mtn'}, {type: 'payment'}, {existingPatterns: EXISTING});
    assert.equal(gateCheck(confirmed, 'valid-type').ok, true, 'choosing the default explicitly is allowed');
    const other = draftFromShape({skeleton, carrier: 'mtn'}, {type: 'receive'}, {existingPatterns: EXISTING});
    assert.equal(gateCheck(other, 'valid-type').ok, true);
    assert.equal(confirmed.sourceShape.typeConfirmed, true);

    const keyword = draftFromShape({skeleton: 'Sent {N} RWF to {W+} on {TS}. Fee: {N} RWF. Balance: {N} RWF.', carrier: 'mtn'}, undefined, {existingPatterns: EXISTING});
    assert.equal(gateCheck(keyword, 'valid-type').ok, true, 'a keyword-derived type needs no confirmation');
});

test('R1-02 / R1-SERVED-6: hints cannot swap amount and balance, and an edit that does is caught by the gate', () => {
    const skeleton = 'You have transferred {N} RWF to {W+} ({PH}) on {TS}. Fee was {N} RWF. Your new balance: {N} RWF.';
    const attacked = draftFromShape(
        {skeleton, carrier: 'mtn', hintVotes: {1: {balance: 5}, 5: {amount: 5}}},
        {type: 'transfer'},
        {existingPatterns: EXISTING},
    );
    assert.equal(attacked.captureMap.amount, slotGroup(skeleton, 1));
    assert.equal(attacked.captureMap.balance, slotGroup(skeleton, 5));
    assert.equal(attacked.captureMap.fee, slotGroup(skeleton, 4));
    assert.equal(attacked.notes.filter(n => n.startsWith('conflict:')).length, 2);
    assert.ok(attacked.confidence < 0.9);
    assert.equal(gateCheck(attacked, 'role-keywords').ok, true);

    const swapped = draftFromShape(
        {skeleton, carrier: 'mtn'},
        {type: 'transfer', captureMap: {amount: slotGroup(skeleton, 5), balance: slotGroup(skeleton, 1)}},
        {existingPatterns: EXISTING},
    );
    const check = gateCheck(swapped, 'role-keywords');
    assert.equal(check.ok, false);
    assert.match(check.detail, /slot 1 is mapped to balance but the words before it say amount|slot 5 is mapped to amount but the words before it say balance/);
    assert.equal(swapped.gate.ok, false, 'self-match alone cannot see a consistent swap, the keyword check can');
});

test('hint confidence never reaches the 0.95 that used to let three submissions outvote the text', () => {
    const skeleton = 'Sent {N} {N} {N} to {W+} on {TS}.';
    const d = draftFromShape({skeleton, carrier: 'mtn', hintVotes: {1: {amount: 9}}}, undefined, {gate: false});
    assert.ok(d.captureMap.amount);
    assert.ok(!d.notes.some(n => /0\.95/.test(n)));
    assert.ok(d.confidence < 0.9);
});
