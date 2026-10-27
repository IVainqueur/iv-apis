'use strict';

// Client contract: what the REAL Manie app code (remoteRegexConfig.ts, classify.ts,
// balanceProcessing.ts) does with the config this API serves.
//
// Each contract has up to three tests:
//   today              characterises the real client as it is now (passes)
//   after fix / real   the behaviour the pipeline needs, run on the real client;
//                      marked todo while the client lacks it (failure is expected)
//   after fix / patch  the same expectation on the real client + reference patch
//                      (test/manie/_clientHarness.js PATCHES = the CLIENT CHANGE LIST)
//
// When the app is fixed the patch anchors disappear (patched tests skip with a
// reason) and the "after fix / real" todos start passing; delete the "today" tests.
// Synthetic data only. Needs the Manie app checkout (MANIE_APP_REPO) with node_modules.

const {describe, test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./_clientHarness');

const HOUR = 3600 * 1000;
const T0 = 1_800_000_000_000;
const SMS_DATE = Date.UTC(2026, 3, 11, 9, 7);
const STATIC_BASE_PATH = path.join(__dirname, '..', '..', 'assets', 'manie', 'sms-formats.json');
const {mtnPattern, airtelPattern, mtnBody, airtelBody} = H.SYNTH;

const SKIP_REAL = H.unavailableReason() || false;
const patchStatus = SKIP_REAL ? {ok: false, reason: SKIP_REAL} : H.patchSetStatus();
const SKIP_PATCHED = patchStatus.ok ? false : patchStatus.reason;

const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const clone = value => JSON.parse(JSON.stringify(value));
const without = (object, key) => {
    const copy = {...object};
    delete copy[key];
    return copy;
};

function boot({fix = 'none', platform = 'android', storage, clock, server} = {}) {
    const env = H.makeEnv({
        platform,
        storage,
        clock,
        fetchImpl: async () => H.jsonResponse(server.config, {headers: server.headers || {}}),
    });
    return {env, client: H.loadClient(env, {fix})};
}

const classifyAll = (client, ...items) =>
    client.classify.classifyTransactions(items.map(item => (typeof item === 'string' ? {body: item} : item)));

const nanSafe = value => (typeof value === 'number' && Number.isNaN(value) ? 'NaN' : value);

async function skipIfAlreadyFixed(t, today, after) {
    try {
        await today();
    } catch (error) {
        let fixed = true;
        try {
            await after('none');
        } catch (afterError) {
            fixed = false;
        }
        if (!fixed) throw error;
        t.skip('the app already has this fix: delete this characterisation test');
    }
}

function contract(id, title, {changes, today, after, patchedFix = 'all'}) {
    describe(`${id} ${title}`, () => {
        if (today) test('today: real client behaviour', {skip: SKIP_REAL}, t => skipIfAlreadyFixed(t, today, after));
        test(`after fix: real client meets the expectation (${changes})`, {skip: SKIP_REAL, todo: `needs client change ${changes}`}, () => after('none'));
        test(`after fix: reference patch meets the expectation (${changes})`, {skip: SKIP_PATCHED}, () => after(patchedFix));
    });
}

describe('fixtures are sound', () => {
    test('synthetic bodies are matched by no built-in pattern', {skip: SKIP_REAL}, () => {
        const {client} = boot({server: {config: H.servedConfig({patterns: [airtelPattern]})}});
        const result = classifyAll(client, mtnBody, airtelBody);
        assert.equal(result.transactions.length, 0);
        assert.equal(result.unmatched.length, 2);
    });

    test('SPEC section 3 AIRTEL TID RULE numbering: outer group = full TID, inner group = YYMMDD.HHMM', () => {
        const match = airtelBody.match(new RegExp(airtelPattern.pattern, airtelPattern.flags));
        assert.equal(match[1], 'PP260411.1430.A12345');
        assert.equal(match[2], '260411.1430');
        assert.equal(airtelPattern.captureMap.transactionId, 1);
        assert.equal(airtelPattern.timestamp.group, 2);
    });
});

describe('A. content change detection', () => {
    async function observe(fix, {withHash}) {
        const storage = new Map();
        const clock = {now: T0};
        const stamp = {version: 'regex-v20261021-aaaaaaaa', fetchedAt: '2026-10-21T08:00:00Z'};
        const one = {config: H.servedConfig({...stamp, patterns: [airtelPattern], contentHash: withHash ? 'hash-1' : undefined})};
        const two = {config: H.servedConfig({...stamp, patterns: [airtelPattern, mtnPattern], contentHash: withHash ? 'hash-2' : undefined})};
        const first = boot({fix, platform: 'ios', storage, clock, server: one});
        await first.client.rrc.syncRegexConfig();
        clock.now += 7 * HOUR;
        const upgraded = boot({fix, platform: 'ios', storage, clock, server: two});
        await upgraded.client.rrc.syncRegexConfig();
        await settle();
        const fresh = boot({fix, platform: 'ios', server: two});
        await fresh.client.rrc.syncRegexConfig();
        return {
            upgradedDeviceMatches: classifyAll(upgraded.client, mtnBody).transactions.length === 1,
            freshInstallMatches: classifyAll(fresh.client, mtnBody).transactions.length === 1,
        };
    }

    contract('A1', 'same version + fetchedAt with different content must still be applied', {
        changes: 'P3',
        today: async () => {
            assert.deepEqual(await observe('none', {withHash: true}), {upgradedDeviceMatches: false, freshInstallMatches: true});
            assert.deepEqual(await observe('none', {withHash: false}), {upgradedDeviceMatches: false, freshInstallMatches: true});
        },
        after: async fix => {
            assert.deepEqual(await observe(fix, {withHash: true}), {upgradedDeviceMatches: true, freshInstallMatches: true});
            assert.deepEqual(await observe(fix, {withHash: false}), {upgradedDeviceMatches: true, freshInstallMatches: true});
        },
    });

    test('A2 content-derived version (the new server scheme) is applied by today\'s client', {skip: SKIP_REAL}, async () => {
        const storage = new Map();
        const clock = {now: T0};
        const v1 = {config: H.servedConfig({version: 'regex-v20261021-aaaaaaaa', patterns: [airtelPattern], contentHash: 'h1'})};
        const v2 = {config: H.servedConfig({version: 'regex-v20261022-bbbbbbbb', fetchedAt: '2026-10-22T09:00:00Z', patterns: [airtelPattern, mtnPattern], contentHash: 'h2'})};
        const first = boot({platform: 'ios', storage, clock, server: v1});
        await first.client.rrc.syncRegexConfig();
        clock.now += 7 * HOUR;
        const second = boot({platform: 'ios', storage, clock, server: v2});
        await second.client.rrc.syncRegexConfig();
        assert.equal(second.client.rrc.getRegexConfigVersion(), 'regex-v20261022-bbbbbbbb');
        assert.equal(classifyAll(second.client, mtnBody).transactions.length, 1);
    });
});

describe('B. status filtering', () => {
    async function observe(fix) {
        const run = async patterns => {
            const {client} = boot({fix, server: {config: H.servedConfig({patterns})}});
            await client.rrc.syncRegexConfig();
            return client;
        };
        const pending = await run([{...mtnPattern, status: 'pending_review'}]);
        const disabled = await run([{...airtelPattern, status: 'disabled'}]);
        const noStatus = await run([without(mtnPattern, 'status')]);
        const active = await run([mtnPattern]);
        return {
            pendingReviewApplied: classifyAll(pending, mtnBody).transactions.length === 1,
            disabledApplied: classifyAll(disabled, airtelBody).transactions.length === 1,
            missingStatusApplied: classifyAll(noStatus, mtnBody).transactions.length === 1,
            activeApplied: classifyAll(active, mtnBody).transactions.length === 1,
        };
    }

    contract('B1', 'patterns whose status is not "active" must not be applied', {
        changes: 'P1 (+ I1 on iOS native)',
        today: async () => {
            assert.deepEqual(await observe('none'), {pendingReviewApplied: true, disabledApplied: true, missingStatusApplied: true, activeApplied: true});
        },
        after: async fix => {
            assert.deepEqual(await observe(fix), {pendingReviewApplied: false, disabledApplied: false, missingStatusApplied: true, activeApplied: true});
        },
    });
});

// NOTE: section C characterises the client against the superseded nested-group fixture
// (SYNTH.airtelPattern: outer group = transaction id, inner group = YYMMDD.HHMM). The draft
// generator now follows option B (one full-TID group for both, see airtel-option-b.test.js);
// C7 below is the form it emits, and it already worked on every released JS client.
describe('C. Airtel shortcode timestamps (AIRTEL TID RULE)', () => {
    const probePattern = {
        id: 'probe-shortcode',
        type: 'payment',
        pattern: 'ZZ\\s(\\S+)\\sAMT\\s(\\d+)\\sBAL\\s(\\d+)',
        flags: 'i',
        captureMap: {amount: 2, balance: 3},
        timestamp: {group: 1, parser: 'airtel-shortcode'},
        tags: ['payment', 'airtel'],
        status: 'active',
    };

    async function timestampFor(fix, captured) {
        const clock = {now: T0};
        const {client} = boot({fix, clock, server: {config: H.servedConfig({patterns: [probePattern]})}});
        await client.rrc.syncRegexConfig();
        const {transactions} = classifyAll(client, {body: `ZZ ${captured} AMT 500 BAL 1000`, date: SMS_DATE});
        return {timestamp: transactions[0].timestamp, clock: clock.now};
    }

    const expected = {y: 2026, mo: 4, d: 11, h: 14, mi: 30};

    contract('C1', 'SPEC nested-group Airtel pattern end to end (transactionId + inner timestamp)', {
        changes: 'P4',
        today: async () => {
            const {client} = boot({server: {config: H.servedConfig({patterns: [airtelPattern]})}});
            await client.rrc.syncRegexConfig();
            const [tx] = classifyAll(client, airtelBody).transactions;
            assert.equal(tx.transactionId, 'PP260411.1430.A12345');
            assert.equal(tx.amount, 2000);
            assert.equal(tx.balance, 7000);
            assert.equal(tx.agentName, 'ACME SHOP');
            assert.ok(Number.isNaN(tx.timestamp), 'inner prefix-less group parses to NaN in the JS handler');
        },
        after: async fix => {
            const {client} = boot({fix, server: {config: H.servedConfig({patterns: [airtelPattern]})}});
            await client.rrc.syncRegexConfig();
            const [tx] = classifyAll(client, airtelBody).transactions;
            assert.equal(tx.transactionId, 'PP260411.1430.A12345');
            assert.deepEqual(H.localParts(tx.timestamp), expected);
        },
    });

    contract('C2', 'airtel-shortcode parser accepts both "PP260411.1430.A12345" and "260411.1430", rejects garbage', {
        changes: 'P4',
        today: async () => {
            const full = await timestampFor('none', 'PP260411.1430.A12345');
            assert.deepEqual(H.localParts(full.timestamp), expected);
            const inner = await timestampFor('none', '260411.1430');
            assert.ok(Number.isNaN(inner.timestamp), `expected NaN, got ${inner.timestamp}`);
            const {client} = boot({server: {config: H.servedConfig({patterns: [probePattern]})}});
            assert.ok(Number.isNaN(client.classify.__parseAirtelTimestamp('260411.1430')));
            assert.deepEqual(H.localParts(client.classify.__parseAirtelTimestamp('PP260411.1430.A12345')), expected);
        },
        after: async fix => {
            for (const captured of ['PP260411.1430.A12345', '260411.1430', 'MP260411.1430.C9']) {
                const {timestamp} = await timestampFor(fix, captured);
                assert.deepEqual(H.localParts(timestamp), expected, captured);
            }
            for (const captured of ['PP261311.1430.A1', '260431.2561', 'garbage']) {
                const result = await timestampFor(fix, captured);
                assert.equal(result.timestamp, SMS_DATE, `${captured} must fall back to the SMS date`);
            }
        },
    });

    test('C3 iOS native parseAirtelShort (Swift port): prefix-less inner group parses, full TID does not', () => {
        assert.deepEqual(H.localParts(H.swiftParseAirtelShort('260411.1430')), expected);
        assert.equal(H.swiftParseAirtelShort('PP260411.1430.A12345'), null);
    });

    test('C4 the inner prefix-less group is the only form valid on both platforms once the JS parser is tolerant', {skip: SKIP_PATCHED}, async () => {
        const match = airtelBody.match(new RegExp(airtelPattern.pattern, airtelPattern.flags));
        const viaSwift = H.swiftParseAirtelShort(match[2]);
        const viaJs = (await timestampFor('all', match[2])).timestamp;
        assert.equal(viaJs, viaSwift);
    });

    test('C6 rollout matrix: which timestamp-group form works on which client (decides the AIRTEL TID RULE)', {skip: SKIP_PATCHED}, async () => {
        const forms = {full: 'PP260411.1430.A12345', inner: '260411.1430'};
        const isExpected = ts_ => Number.isFinite(ts_) && JSON.stringify(H.localParts(ts_)) === JSON.stringify(expected);
        const js = async fix => ({
            full: isExpected((await timestampFor(fix, forms.full)).timestamp),
            inner: isExpected((await timestampFor(fix, forms.inner)).timestamp),
        });
        const swift = parse => ({full: parse(forms.full) !== null, inner: parse(forms.inner) !== null});
        assert.deepEqual(
            {
                jsToday: await js('none'),
                jsPatched: await js('all'),
                swiftToday: swift(H.swiftParseAirtelShort),
                swiftTolerant: swift(H.swiftParseAirtelShortTolerant),
            },
            {
                jsToday: {full: true, inner: false},
                jsPatched: {full: true, inner: true},
                swiftToday: {full: false, inner: true},
                swiftTolerant: {full: true, inner: true},
            },
        );
    });

    test('C7 option B (timestamp.group = the outer full-TID group) already works on today\'s JS client', {skip: SKIP_REAL}, async () => {
        const optionB = {...airtelPattern, id: 'airtel-auto-cashout-en-b', timestamp: {group: 1, parser: 'airtel-shortcode'}};
        const {client} = boot({server: {config: H.servedConfig({patterns: [optionB]})}});
        await client.rrc.syncRegexConfig();
        const [tx] = classifyAll(client, airtelBody).transactions;
        assert.equal(tx.transactionId, 'PP260411.1430.A12345');
        assert.deepEqual(H.localParts(tx.timestamp), expected);
    });

    test('C5 static base Airtel patterns (prefix-less group 1) get a valid timestamp from handler 0 after the parser fix', {skip: SKIP_PATCHED || !fs.existsSync(STATIC_BASE_PATH)}, () => {
        const base = JSON.parse(fs.readFileSync(STATIC_BASE_PATH, 'utf8'));
        const pattern = base.patterns.find(p => p.id === 'airtel-transfer-aa-en');
        const body = '*165* TID PP260411.1430.C12345*S* Money successfully sent to TEST PERSON 0780000000 Amt 1000Fee RWF 100. BAL is RWF 5000. *EN#';
        const match = body.match(new RegExp(pattern.pattern, pattern.flags));
        const {client: before} = boot({});
        const {client: patched} = boot({fix: 'all'});
        assert.ok(Number.isNaN(before.classify.__handlers[0](match, {body}, pattern).timestamp));
        assert.deepEqual(H.localParts(patched.classify.__handlers[0](match, {body}, pattern).timestamp), expected);
    });
});

describe('D. re-apply storm on relaunch / foreground', () => {
    async function observe(fix) {
        const storage = new Map();
        const clock = {now: T0};
        const same = {config: H.servedConfig({patterns: [airtelPattern, mtnPattern], contentHash: 'hash-1'})};
        const changed = {config: H.servedConfig({version: 'regex-v20261022-aaaaaaaa', patterns: [airtelPattern], contentHash: 'hash-2'})};
        const counts = env => [env.calls.fetch, env.calls.reprocess, env.calls.bridgeApply];
        const steps = {};

        let session = boot({fix, platform: 'ios', storage, clock, server: same});
        await session.client.rrc.syncRegexConfig();
        await settle();
        steps.freshInstall = counts(session.env);

        clock.now += 1 * HOUR;
        session = boot({fix, platform: 'ios', storage, clock, server: same});
        await session.client.rrc.syncRegexConfig();
        await settle();
        steps.relaunchPlus1h = counts(session.env);

        await session.client.rrc.syncRegexConfig();
        await session.client.rrc.syncRegexConfig();
        await settle();
        steps.twoForegroundSyncsSameProcess = counts(session.env);

        clock.now += 8 * HOUR;
        session = boot({fix, platform: 'ios', storage, clock, server: same});
        await session.client.rrc.syncRegexConfig();
        await settle();
        steps.relaunchPlus9hRemoteUnchanged = counts(session.env);

        clock.now += 8 * HOUR;
        session = boot({fix, platform: 'ios', storage, clock, server: changed});
        await session.client.rrc.syncRegexConfig();
        await settle();
        steps.relaunchPlus17hRemoteChanged = counts(session.env);
        return steps;
    }

    contract('D1', 'unchanged cached config must not re-run native apply or unmatched reprocess ([fetch, reprocess, iosBridgeApply])', {
        changes: 'P3',
        today: async () => {
            assert.deepEqual(await observe('none'), {
                freshInstall: [1, 1, 1],
                relaunchPlus1h: [0, 1, 1],
                twoForegroundSyncsSameProcess: [0, 3, 3],
                relaunchPlus9hRemoteUnchanged: [1, 1, 1],
                relaunchPlus17hRemoteChanged: [1, 2, 2],
            });
        },
        after: async fix => {
            assert.deepEqual(await observe(fix), {
                freshInstall: [1, 1, 1],
                relaunchPlus1h: [0, 0, 0],
                twoForegroundSyncsSameProcess: [0, 0, 0],
                relaunchPlus9hRemoteUnchanged: [1, 0, 0],
                relaunchPlus17hRemoteChanged: [1, 1, 1],
            });
        },
    });

    test('D2 reference patch: a launch that was killed before reprocess finished retries it, without re-forwarding to iOS native', {skip: SKIP_PATCHED}, async () => {
        const config = H.servedConfig({patterns: [airtelPattern], contentHash: 'hash-1'});
        const storage = new Map([
            ['remote_regex_config_v1', JSON.stringify({config, storedAt: T0})],
            ['remote_regex_applied_state_v1', JSON.stringify({bridged: 'hash-1'})],
        ]);
        const clock = {now: T0 + HOUR};
        const session = boot({fix: 'all', platform: 'ios', storage, clock, server: {config}});
        await session.client.rrc.syncRegexConfig();
        await settle();
        assert.equal(session.env.calls.fetch, 0);
        assert.equal(session.env.calls.reprocess, 1);
        assert.equal(session.env.calls.bridgeApply, 0);
        assert.deepEqual(JSON.parse(storage.get('remote_regex_applied_state_v1')), {bridged: 'hash-1', reprocessed: 'hash-1'});
    });
});

describe('E. malformed tags / captureMap', () => {
    const tagsString = {...mtnPattern, id: 'bad-tags-string', tags: 'airtel'};
    const tagsMixed = {...mtnPattern, id: 'bad-tags-mixed', tags: ['payment', 5]};
    const mapGarbage = {...mtnPattern, id: 'bad-map', captureMap: {amount: '1', balance: '4', transactionId: 6, bogus: 99, secondParty: {}}};
    const balanceState = () => ({latestCheck: 0, balance: {mtn: 0, airtel: 0}, carriersUsed: {mtn: false, airtel: false}});

    async function observe(fix, pattern) {
        const {client} = boot({fix, server: {config: H.servedConfig({patterns: [pattern]})}});
        const config = await client.rrc.syncRegexConfig();
        const attempt = fn => {
            try {
                fn();
                return 'ok';
            } catch (error) {
                return error.constructor.name;
            }
        };
        const [tx] = classifyAll(client, mtnBody).transactions;
        return {
            config,
            isAirtelOnPlainText: attempt(() => client.classify.isAirtelMessage('any text no built-in matches')),
            balanceOnPlainMessage: attempt(() => client.balance.processTransactionBalance({message: 'any text', timestamp: T0, balance: 100}, balanceState())),
            txTags: tx ? tx.tags : undefined,
        };
    }

    contract('E1', 'non-array / non-string tags must not make isAirtelMessage (and the balance path) throw', {
        changes: 'P1',
        today: async () => {
            for (const pattern of [tagsString, tagsMixed]) {
                const seen = await observe('none', pattern);
                assert.equal(seen.isAirtelOnPlainText, 'TypeError');
                assert.equal(seen.balanceOnPlainMessage, 'TypeError', 'one bad remote pattern breaks the balance update for every non-Airtel message');
            }
            assert.equal((await observe('none', tagsString)).txTags, 'airtel');
        },
        after: async fix => {
            for (const pattern of [tagsString, tagsMixed]) {
                const seen = await observe(fix, pattern);
                assert.equal(seen.isAirtelOnPlainText, 'ok');
                assert.equal(seen.balanceOnPlainMessage, 'ok');
            }
            assert.deepEqual((await observe(fix, tagsString)).txTags, []);
            assert.deepEqual((await observe(fix, tagsMixed)).txTags, ['payment']);
        },
    });

    contract('E2', 'captureMap is normalised to known keys with positive integer groups', {
        changes: 'P1',
        today: async () => {
            const {config} = await observe('none', mapGarbage);
            assert.deepEqual(config.patterns[0].captureMap, mapGarbage.captureMap, 'garbage is passed through untouched (no crash, but silent mis-captures)');
        },
        after: async fix => {
            const {config} = await observe(fix, mapGarbage);
            assert.deepEqual(config.patterns[0].captureMap, {amount: 1, balance: 4, transactionId: 6});
        },
    });
});

describe('E3. tags default is preserved', () => {
    test('E3 reference patch: a pattern without tags still yields the built-in default tag ["remote"]', {skip: SKIP_PATCHED}, async () => {
        for (const fix of ['none', 'all']) {
            const {client} = boot({fix, server: {config: H.servedConfig({patterns: [without(mtnPattern, 'tags')]})}});
            await client.rrc.syncRegexConfig();
            assert.deepEqual(classifyAll(client, mtnBody).transactions[0].tags, ['remote'], fix);
        }
    });
});

describe('F. amount capture', () => {
    const optionalAmountBody = mtnBody.replace('RWF 2000 kuri', 'RWF  kuri');
    const dotAmountBody = mtnBody.replace('RWF 2000 kuri', 'RWF . kuri');
    const emptyAmountPattern = {...mtnPattern, id: 'empty-amount', pattern: mtnPattern.pattern.replace('RWF\\s([\\d,.]+)\\skuri', 'RWF\\s([\\d,.]*)\\skuri')};

    async function amountsFor(fix, pattern, body) {
        const {client} = boot({fix, server: {config: H.servedConfig({patterns: [pattern]})}});
        const config = await client.rrc.syncRegexConfig();
        const result = classifyAll(client, body);
        return {kept: config ? config.patterns.length : 0, amounts: result.transactions.map(t => nanSafe(t.amount)), unmatched: result.unmatched.length};
    }

    contract('F1', 'a pattern without a usable amount capture must never save a transaction', {
        changes: 'P1 + P5',
        today: async () => {
            assert.deepEqual(await amountsFor('none', {...mtnPattern, id: 'no-amount', captureMap: {balance: 4, transactionId: 6}}, mtnBody), {kept: 1, amounts: [0], unmatched: 0});
            assert.deepEqual(await amountsFor('none', {...mtnPattern, id: 'oob-amount', captureMap: {amount: 99, balance: 4, transactionId: 6}}, mtnBody), {kept: 1, amounts: [0], unmatched: 0});
            assert.deepEqual(await amountsFor('none', mtnPattern, dotAmountBody), {kept: 1, amounts: ['NaN'], unmatched: 0});
            assert.deepEqual(await amountsFor('none', emptyAmountPattern, optionalAmountBody), {kept: 1, amounts: [0], unmatched: 0});
        },
        after: async fix => {
            assert.deepEqual(await amountsFor(fix, {...mtnPattern, id: 'no-amount', captureMap: {balance: 4, transactionId: 6}}, mtnBody), {kept: 0, amounts: [], unmatched: 1});
            assert.deepEqual(await amountsFor(fix, {...mtnPattern, id: 'oob-amount', captureMap: {amount: 99, balance: 4, transactionId: 6}}, mtnBody), {kept: 0, amounts: [], unmatched: 1});
            assert.deepEqual(await amountsFor(fix, mtnPattern, dotAmountBody), {kept: 1, amounts: [], unmatched: 1});
            assert.deepEqual(await amountsFor(fix, emptyAmountPattern, optionalAmountBody), {kept: 1, amounts: [], unmatched: 1});
            assert.deepEqual(await amountsFor(fix, mtnPattern, mtnBody), {kept: 1, amounts: [2000], unmatched: 0});
        },
    });
});

describe('G. timestamp fallback', () => {
    const noTimestamp = without({...mtnPattern, id: 'no-timestamp'}, 'timestamp');
    const garbageTimestamp = {...mtnPattern, id: 'garbage-timestamp', pattern: mtnPattern.pattern.replace('(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2})', '(\\w+)')};
    const garbageBody = mtnBody.replace('2026-04-11 14:30:05', 'yesterday');

    async function observe(fix) {
        const clock = {now: T0};
        const make = async pattern => {
            const {client} = boot({fix, clock, server: {config: H.servedConfig({patterns: [pattern]})}});
            await client.rrc.syncRegexConfig();
            return client;
        };
        const timestampOf = (client, item) => nanSafe(classifyAll(client, item).transactions[0].timestamp);
        const client = await make(noTimestamp);
        const withDate = [timestampOf(client, {body: mtnBody, date: SMS_DATE})];
        clock.now += 60_000;
        withDate.push(timestampOf(client, {body: mtnBody, date: SMS_DATE}));
        const withoutDate = [timestampOf(client, {body: mtnBody})];
        clock.now += 60_000;
        withoutDate.push(timestampOf(client, {body: mtnBody}));
        const garbageClient = await make(garbageTimestamp);
        return {withDate, withoutDate, garbage: timestampOf(garbageClient, {body: garbageBody, date: SMS_DATE}), clock: clock.now};
    }

    contract('G1', 'missing or unparseable timestamp falls back to the SMS date, then to now', {
        changes: 'P4 + P5',
        today: async () => {
            const seen = await observe('none');
            assert.deepEqual(seen.withDate, [T0, T0 + 60_000], 'SMS date is ignored; every pass gets a new timestamp (breaks timestamp+direction+amount dedup)');
            assert.equal(seen.garbage, 'NaN');
        },
        after: async fix => {
            const seen = await observe(fix);
            assert.deepEqual(seen.withDate, [SMS_DATE, SMS_DATE]);
            assert.deepEqual(seen.withoutDate, [T0 + 60_000, T0 + 120_000]);
            assert.equal(seen.garbage, SMS_DATE);
        },
    });
});

describe('H. balance capture', () => {
    const noBalance = {...mtnPattern, id: 'no-balance', captureMap: {amount: 1, transactionId: 6}};

    async function observe(fix) {
        const {client} = boot({fix, server: {config: H.servedConfig({patterns: [noBalance]})}});
        await client.rrc.syncRegexConfig();
        const [tx] = classifyAll(client, mtnBody).transactions;
        const current = {latestCheck: 0, balance: {mtn: 5000, airtel: 0}, carriersUsed: {mtn: true, airtel: false}};
        return {tx, mtnBalanceAfter: tx ? client.balance.processTransactionBalance(tx, current).balance.mtn : null};
    }

    contract('H1', 'a balance-less pattern must not overwrite the displayed carrier balance with 0', {
        changes: 'P1 + P5 (and server gate: require captureMap.balance)',
        today: async () => {
            const seen = await observe('none');
            assert.equal(seen.tx.balance, 0);
            assert.equal(seen.mtnBalanceAfter, 0);
        },
        after: async fix => {
            const seen = await observe(fix);
            assert.equal(seen.tx, undefined);
        },
    });
});

describe('I. carrier detection convention (isAirtelMessage)', () => {
    async function isAirtel(pattern) {
        const {client} = boot({server: {config: H.servedConfig({patterns: [pattern]})}});
        await client.rrc.syncRegexConfig();
        return client.classify.isAirtelMessage(airtelBody);
    }

    test('I1 an approved Airtel pattern is recognised as Airtel only if its tags or id contain "airtel"', {skip: SKIP_REAL}, async () => {
        assert.equal(await isAirtel(airtelPattern), true);
        assert.equal(await isAirtel({...airtelPattern, id: 'auto-cashout-en', tags: ['withdraw', 'airtel']}), true);
        assert.equal(await isAirtel({...airtelPattern, id: 'airtel-auto-cashout-en', tags: ['withdraw']}), true);
        assert.equal(await isAirtel({...airtelPattern, id: 'auto-cashout-en', tags: ['withdraw']}), false);
    });
});

describe('J. precedence', () => {
    test('J1 remote patterns can never shadow a built-in; they only see what no built-in matches', {skip: SKIP_REAL}, async () => {
        const builtinBody = '*165*S*1000 RWF transferred to TEST PERSON (250780000000) at 2026-04-11 14:30:05 . Fee was: 100 RWF. New balance: 9000 RWF .';
        const catchAll = {
            id: 'auto-catch-all',
            type: 'receive',
            pattern: '.*?([\\d,]+)\\sRWF.*?at\\s(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}).*?balance:\\s([\\d,]+)\\sRWF',
            flags: 'i',
            captureMap: {amount: 1, balance: 3},
            timestamp: {group: 2, parser: 'iso8601'},
            tags: ['receive'],
            status: 'active',
        };
        const {client} = boot({server: {config: H.servedConfig({patterns: [catchAll]})}});
        await client.rrc.syncRegexConfig();
        const [tx] = classifyAll(client, builtinBody).transactions;
        assert.equal(tx.type, 'transfer');
        assert.deepEqual(tx.tags, ['transfer']);
    });
});

describe('K. kill switch and degraded responses', () => {
    test('K1 disabling a pattern server-side (removing it from the served set) stops it on the next sync', {skip: SKIP_REAL}, async () => {
        const storage = new Map();
        const clock = {now: T0};
        const both = {config: H.servedConfig({patterns: [airtelPattern, mtnPattern], contentHash: 'h1'})};
        const disabled = {config: H.servedConfig({version: 'regex-v20261022-cccccccc', patterns: [airtelPattern], contentHash: 'h2'})};
        const first = boot({storage, clock, server: both});
        await first.client.rrc.syncRegexConfig();
        assert.equal(classifyAll(first.client, mtnBody).transactions.length, 1);
        clock.now += 7 * HOUR;
        const second = boot({storage, clock, server: disabled});
        await second.client.rrc.syncRegexConfig();
        assert.equal(classifyAll(second.client, mtnBody).transactions.length, 0);
        assert.equal(classifyAll(second.client, airtelBody).transactions.length, 1);
    });

    async function observeLatency(fix) {
        const storage = new Map();
        const clock = {now: T0};
        const both = {config: H.servedConfig({patterns: [airtelPattern, mtnPattern], contentHash: 'h1'})};
        const disabled = {config: H.servedConfig({version: 'regex-v20261022-cccccccc', patterns: [airtelPattern], contentHash: 'h2'})};
        const first = boot({fix, storage, clock, server: both});
        await first.client.rrc.syncRegexConfig();
        clock.now += 90 * 60 * 1000;
        const second = boot({fix, storage, clock, server: disabled});
        await second.client.rrc.syncRegexConfig();
        return {fetches: second.env.calls.fetch, stillMatches: classifyAll(second.client, mtnBody).transactions.length === 1};
    }

    contract('K2', 'OPTIONAL: kill switch reaches a device within about an hour (refresh interval 6h -> 1h)', {
        changes: 'P7 (optional)',
        patchedFix: 'all+optional',
        today: async () => {
            assert.deepEqual(await observeLatency('none'), {fetches: 0, stillMatches: true});
        },
        after: async fix => {
            assert.deepEqual(await observeLatency(fix), {fetches: 1, stillMatches: false});
        },
    });

    async function observeDegraded(fix) {
        const storage = new Map();
        const clock = {now: T0};
        const healthy = {config: H.servedConfig({patterns: [airtelPattern, mtnPattern], contentHash: 'h1'})};
        const degraded = {
            config: H.servedConfig({version: 'regex-v20261021-dddddddd', patterns: [airtelPattern], contentHash: 'h-degraded'}),
            headers: {'X-Manie-Degraded': 'kv'},
        };
        const first = boot({fix, storage, clock, server: healthy});
        await first.client.rrc.syncRegexConfig();
        clock.now += 7 * HOUR;
        const during = boot({fix, storage, clock, server: degraded});
        await during.client.rrc.syncRegexConfig();
        const duringOutage = classifyAll(during.client, mtnBody).transactions.length === 1;
        clock.now += 7 * HOUR;
        const recovered = boot({fix, storage, clock, server: healthy});
        await recovered.client.rrc.syncRegexConfig();
        return {duringOutage, afterRecovery: classifyAll(recovered.client, mtnBody).transactions.length === 1};
    }

    contract('K3', 'a degraded (X-Manie-Degraded: kv, base-only) response must not drop approved patterns on devices', {
        changes: 'P6',
        today: async () => {
            assert.deepEqual(await observeDegraded('none'), {duringOutage: false, afterRecovery: true});
        },
        after: async fix => {
            assert.deepEqual(await observeDegraded(fix), {duringOutage: true, afterRecovery: true});
        },
    });
});

describe('L. extra fields', () => {
    async function observe(fix) {
        const config = H.servedConfig({
            patterns: [airtelPattern],
            contentHash: 'hash-x',
            vocabulary: ['kohereza', "don't", 'rwf', 'Bad', 'with1digit', 'x'.repeat(41), 7],
        });
        const {client, env} = boot({fix, platform: 'ios', server: {config}});
        const parsed = await client.rrc.syncRegexConfig();
        await settle();
        return {parsed, forwarded: env.bridgePayloads.map(payload => JSON.parse(payload))};
    }

    contract('L1', 'contentHash and a sanitised vocabulary survive parseConfig; vocabulary is not forwarded to iOS native', {
        changes: 'P2 + P3',
        today: async () => {
            const {parsed} = await observe('none');
            assert.equal(parsed.contentHash, undefined);
            assert.equal(parsed.vocabulary, undefined);
        },
        after: async fix => {
            const {parsed, forwarded} = await observe(fix);
            assert.equal(parsed.contentHash, 'hash-x');
            assert.deepEqual(parsed.vocabulary, ['kohereza', "don't", 'rwf']);
            assert.equal(forwarded.length, 1);
            assert.equal('vocabulary' in forwarded[0], false);
            assert.equal(forwarded[0].patterns.length, 1);
        },
    });
});

describe('M. no regression on the static base config', () => {
    const haveBase = fs.existsSync(STATIC_BASE_PATH);

    test('M1 today: every static base pattern survives parseConfig and compiles', {skip: SKIP_REAL || !haveBase}, () => {
        const base = JSON.parse(fs.readFileSync(STATIC_BASE_PATH, 'utf8'));
        const {client} = boot({});
        const parsed = client.rrc.__parseConfig(base);
        assert.equal(parsed.patterns.length, base.patterns.length);
        assert.equal(client.rrc.__compileOverrides(parsed).length, base.patterns.length);
    });

    test('M2 reference patch: stricter parseConfig keeps every static base pattern byte-identical in the fields that matter', {skip: SKIP_PATCHED || !haveBase}, () => {
        const base = JSON.parse(fs.readFileSync(STATIC_BASE_PATH, 'utf8'));
        const {client} = boot({fix: 'all'});
        const parsed = client.rrc.__parseConfig(base);
        assert.equal(parsed.patterns.length, base.patterns.length);
        for (const [index, source] of base.patterns.entries()) {
            const kept = parsed.patterns[index];
            assert.equal(kept.id, source.id);
            assert.equal(kept.pattern, source.pattern);
            assert.deepEqual(kept.captureMap, source.captureMap);
            assert.deepEqual(kept.timestamp, source.timestamp);
            assert.deepEqual(kept.tags, source.tags);
        }
    });

    test('M3 reference patch: built-in classification is unchanged for the same inputs', {skip: SKIP_PATCHED}, () => {
        const bodies = [
            '*165*S*1000 RWF transferred to TEST PERSON (250780000000) at 2026-04-11 14:30:05 . Fee was: 100 RWF. New balance: 9000 RWF .',
            '*165* TID PP260411.1430.C12345*S* Money successfully sent to TEST PERSON 0780000000 Amt 1000Fee RWF 100. BAL is RWF 5000. *EN#',
            'unrelated text with no transaction',
        ];
        const {client: before} = boot({});
        const {client: after} = boot({fix: 'all'});
        assert.deepEqual(classifyAll(after, ...bodies), classifyAll(before, ...bodies));
    });
});

describe('N. config built by lib/manie/formats.js consumed by the real client', () => {
    let formats = null;
    try {
        formats = require('../../lib/manie/formats');
    } catch (error) {
        formats = null;
    }
    const SKIP_SERVER = formats ? false : 'lib/manie/formats.js not available';
    const base = fs.existsSync(STATIC_BASE_PATH) ? JSON.parse(fs.readFileSync(STATIC_BASE_PATH, 'utf8')) : null;
    const build = ({approved, disabledIds = [], now = '2026-10-21T12:00:00Z'}) =>
        formats.buildServedConfig({base, approved: clone(approved), disabledIds, vocabulary: ['rwf', 'fee', 'balance'], now});
    const approvedPair = () => [
        {...airtelPattern, createdAt: '2026-10-21T09:00:00Z', updatedAt: '2026-10-21T09:00:00Z'},
        {...mtnPattern, createdAt: '2026-10-21T09:05:00Z', updatedAt: '2026-10-21T09:05:00Z'},
    ];

    async function endToEnd(fix, approved) {
        const {config} = build({approved});
        const {client} = boot({fix, platform: 'ios', server: {config}});
        const parsed = await client.rrc.syncRegexConfig();
        const {transactions} = classifyAll(client, airtelBody, mtnBody);
        return {config, parsed, transactions};
    }

    test('N1 every served pattern (static + approved) is accepted by today\'s client', {skip: SKIP_SERVER || SKIP_REAL || !base}, async () => {
        const {config, parsed} = await endToEnd('none', approvedPair());
        assert.equal(parsed.patterns.length, config.patterns.length);
        assert.equal(typeof config.contentHash, 'string');
        assert.match(config.version, /^regex-v\d{8}-[0-9a-f]{8}$/);
    });

    contract('N2', 'approved nested-group Airtel + MTN patterns classify with finite timestamps through the whole served path', {
        changes: 'P4',
        after: async fix => {
            if (SKIP_SERVER || !base) return;
            const {transactions} = await endToEnd(fix, approvedPair());
            assert.equal(transactions.length, 2);
            for (const tx of transactions) assert.ok(Number.isFinite(tx.timestamp), `${tx.transactionId} timestamp`);
            assert.deepEqual(transactions.map(tx => tx.transactionId), ['PP260411.1430.A12345', '55512345']);
        },
    });

    test('N3 server drops non-active approved patterns, so the client never sees them', {skip: SKIP_SERVER || !base}, () => {
        const {config, dropped} = build({approved: [{...mtnPattern, status: 'pending_review'}]});
        assert.equal(config.patterns.some(p => p.id === mtnPattern.id), false);
        assert.deepEqual(dropped.map(d => d.reason), ['inactive']);
    });

    test('N4 kill switch: disabling an approved pattern changes version and contentHash and the client stops matching it', {skip: SKIP_SERVER || SKIP_REAL || !base}, async () => {
        const live = build({approved: approvedPair()});
        const off = build({approved: approvedPair(), disabledIds: [mtnPattern.id], now: '2026-10-21T13:00:00Z'});
        assert.notEqual(live.config.version, off.config.version);
        assert.notEqual(live.contentHash, off.contentHash);
        const storage = new Map();
        const clock = {now: T0};
        const first = boot({platform: 'ios', storage, clock, server: {config: live.config}});
        await first.client.rrc.syncRegexConfig();
        assert.equal(classifyAll(first.client, mtnBody).transactions.length, 1);
        clock.now += 7 * HOUR;
        const second = boot({platform: 'ios', storage, clock, server: {config: off.config}});
        await second.client.rrc.syncRegexConfig();
        assert.equal(classifyAll(second.client, mtnBody).transactions.length, 0);
    });

    test('N5 REQUEST formats.js: an approved Airtel pattern must carry an airtel tag (client isAirtelMessage depends on it)', {skip: SKIP_SERVER, todo: 'formats.js normalizePattern should add the carrier tag'}, () => {
        const res = formats.normalizePattern({...airtelPattern, id: 'auto-cashout-en', tags: ['withdraw']});
        assert.ok(res.ok);
        assert.ok(res.pattern.tags.some(tag => /airtel/i.test(tag)) || /airtel/i.test(res.pattern.id));
    });

    test('N6 REQUEST formats.js: an approved pattern without a balance capture must be rejected (client would show balance 0)', {skip: SKIP_SERVER, todo: 'formats.js normalizePattern should require captureMap.balance'}, () => {
        const res = formats.normalizePattern({...mtnPattern, id: 'no-balance', captureMap: {amount: 1, transactionId: 6}});
        assert.equal(res.ok, false);
    });
});

describe('R. on-device reporter reference model (pure functions the app implements)', () => {
    let anonymizeModule = null;
    try {
        anonymizeModule = require('../../lib/manie/anonymize');
    } catch (error) {
        anonymizeModule = null;
    }
    const SKIP_ANON = anonymizeModule ? false : 'lib/manie/anonymize.js not available';
    const vocab = new Set(['muraho', 'wakoresheje', 'rwf', 'kuri', 'ku', 'wa', 'amafaranga', 'asigaye', 'fee', 'txid', 'cash', 'out', 'of', 'at', 'agent', 'successful', 'bal', 'is', 'tid', 'en']);

    const PENDING_WINDOW_MS = 5 * 60 * 1000;
    const carrierOf = address => ({'M-Money': 'mtn', AirtelMoney: 'airtel'})[address] || null;
    const digitsOnly = text => text.replace(/\D/g, '');
    const normalisePhone = text => {
        const digits = digitsOnly(text);
        if (digits.length === 10 && digits.startsWith('0')) return `250${digits.slice(1)}`;
        return digits;
    };

    // Mirrors the on-device design: hints come from slot offsets + a single matching pending
    // transaction; only {slot, role} leave the phone, never values.
    function deriveHints({body, address, date}, anonymized, pendings) {
        const carrier = carrierOf(address);
        const candidates = pendings.filter(p => p.from === carrier && p.timestamp < date && date - p.timestamp <= PENDING_WINDOW_MS);
        if (candidates.length !== 1) return [];
        const [pending] = candidates;
        const hints = [];
        const amountSlots = anonymized.slots.filter(s => s.kind === 'N' && parseInt(body.slice(s.start, s.end).replace(/,/g, ''), 10) === pending.amount);
        if (amountSlots.length === 1) hints.push({slot: amountSlots[0].index, role: 'amount'});
        const phoneSlots = pending.recipientNumber
            ? anonymized.slots.filter(s => s.kind === 'PH' && normalisePhone(body.slice(s.start, s.end)) === normalisePhone(pending.recipientNumber))
            : [];
        if (phoneSlots.length === 1) hints.push({slot: phoneSlots[0].index, role: 'accountNumber'});
        return hints;
    }

    const MAX_ITEMS_PER_REQUEST = 20;
    const MAX_ITEMS_PER_RUN = 40;
    const MAX_BODY_BYTES = 16 * 1024;
    function planBatches(items) {
        const batches = [];
        for (const item of items.slice(0, MAX_ITEMS_PER_RUN)) {
            const last = batches[batches.length - 1];
            const candidate = last && last.length < MAX_ITEMS_PER_REQUEST ? [...last, item] : null;
            const fits = candidate && Buffer.byteLength(JSON.stringify({v: 1, items: candidate, app: {version: '0.0.99', platform: 'android'}})) <= MAX_BODY_BYTES;
            if (fits) batches[batches.length - 1] = candidate;
            else batches.push([item]);
        }
        return batches;
    }

    const nextBackoffMs = (failures, random = 0.5) => {
        const base = Math.min(24 * HOUR, 30 * 60 * 1000 * 2 ** Math.max(0, failures - 1));
        return Math.round(base * (0.8 + 0.4 * random));
    };

    test('R1 hints are derived locally from slot offsets and never contain a value', {skip: SKIP_ANON}, () => {
        const body = 'Muraho! Wakoresheje RWF 2000 kuri 0780000000 ku wa 2026-04-11 14:30:05. Amafaranga asigaye RWF 8000. Fee RWF 100.';
        const anonymized = anonymizeModule.anonymize(body, vocab);
        const pendings = [{recipientNumber: '0780000000', amount: 2000, timestamp: SMS_DATE - 60_000, from: 'mtn'}];
        const hints = deriveHints({body, address: 'M-Money', date: SMS_DATE}, anonymized, pendings);
        assert.deepEqual(hints, [{slot: 1, role: 'amount'}, {slot: 2, role: 'accountNumber'}]);
        assert.equal(/\d{3,}/.test(JSON.stringify({skeleton: anonymized.skeleton, hints})), false);
        assert.equal(anonymized.skeleton, 'Muraho! Wakoresheje RWF {N} kuri {PH} ku wa {TS}. Amafaranga asigaye RWF {N}. Fee RWF {N}.');
    });

    test('R2 no hints when zero or several pending transactions fit the window, or the carrier differs', {skip: SKIP_ANON}, () => {
        const body = 'Wakoresheje RWF 2000 kuri 0780000000.';
        const anonymized = anonymizeModule.anonymize(body, vocab);
        const pending = {recipientNumber: '0780000000', amount: 2000, timestamp: SMS_DATE - 60_000, from: 'mtn'};
        assert.deepEqual(deriveHints({body, address: 'M-Money', date: SMS_DATE}, anonymized, []), []);
        assert.deepEqual(deriveHints({body, address: 'M-Money', date: SMS_DATE}, anonymized, [pending, {...pending, timestamp: SMS_DATE - 120_000}]), []);
        assert.deepEqual(deriveHints({body, address: 'AirtelMoney', date: SMS_DATE}, anonymized, [pending]), []);
        assert.deepEqual(deriveHints({body, address: 'M-Money', date: SMS_DATE + 10 * 60 * 1000}, anonymized, [pending]), []);
    });

    test('R3 every locally produced skeleton passes the server PII guard (and so does a batch of 20 at maximum length)', {skip: SKIP_ANON}, () => {
        const bodies = [
            mtnBody,
            airtelBody,
            'Dear JOHN DOE, you paid 5,000 RWF to ACME LTD ref 123456789012 on 2026-04-11 14:30:05 call 0780000000 or mail a@b.rw',
        ];
        for (const body of bodies) {
            const {skeleton} = anonymizeModule.anonymize(body, vocab);
            const check = anonymizeModule.sanitizeSkeleton(skeleton, vocab);
            assert.equal(check.ok, true, skeleton);
            assert.equal(check.skeleton, skeleton, 'device output is a fixed point of the server sanitiser');
        }
        const long = Array.from({length: 20}, (_, i) => ({skeleton: `Muraho ${'{N} '.repeat(95).trim()}`, carrier: i % 2 ? 'mtn' : 'airtel', count: 3, hints: [{slot: 1, role: 'amount'}]}));
        assert.ok(long[0].skeleton.length <= anonymizeModule.MAX_SKELETON_LENGTH);
        assert.equal(planBatches(long).length, 1);
        assert.ok(Buffer.byteLength(JSON.stringify({v: 1, items: long, app: {version: '0.0.99', platform: 'android'}})) <= MAX_BODY_BYTES);
    });

    test('R4 batching: at most 20 items per request and 40 per run, remainder waits for the next run', () => {
        const items = Array.from({length: 55}, (_, i) => ({skeleton: `Muraho {N} ${i}`, carrier: 'mtn'}));
        const batches = planBatches(items);
        assert.deepEqual(batches.map(b => b.length), [20, 20]);
    });

    test('R5 backoff: 30m, 1h, 2h ... capped at 24h, with +-20% jitter', () => {
        assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => nextBackoffMs(n)), [30, 60, 120, 240, 480, 960, 1440, 1440, 1440].map(m => m * 60 * 1000));
        assert.equal(nextBackoffMs(1, 0), Math.round(30 * 60 * 1000 * 0.8));
        assert.equal(nextBackoffMs(1, 1), Math.round(30 * 60 * 1000 * 1.2));
    });
});

describe('S. served base patterns for the MTN dataset formats (remote patterns only)', () => {
    const base = JSON.parse(fs.readFileSync(STATIC_BASE_PATH, 'utf8'));
    const bankBody = (txId, payee, amount, fee, balance, etId = '', gap = '') =>
        `TransactionId: ${txId} Your payment of ${amount} RWF to ${payee} with token and ET Id: ${etId} SUCCESSFUL at 2026-09-04T09:52:29.406+02:00.${gap}Fee:${fee} RWF. Balance ${balance} RWF.`;
    const feeGaps = [['', 'glued'], [' ', 'one space'], ['  ', 'two spaces'], ['\t', 'tab'], ['\n', 'newline'], ['\r\n', 'carriage return and newline']];
    const bank = [
        [bankBody('30000000001', 'ALICE EXAMPLE at EXAMPLE BANK', 120000, 20, 46138), 120000, 20, 46138, '30000000001', 'ALICE EXAMPLE'],
        [bankBody('30000000002', 'Bob SAMPLE at Airtel', 2500, 20, 33343), 2500, 20, 33343, '30000000002', 'Bob SAMPLE'],
        [bankBody('30000000003', 'SAMPLE ENERGY LTD at TESTBANK', 400, 0, 23643), 400, 0, 23643, '30000000003', 'SAMPLE ENERGY LTD'],
        [bankBody('30000000004', 'EXAMPLE CATERING Limited', 48000, 0, 17000), 48000, 0, 17000, '30000000004', 'EXAMPLE CATERING Limited'],
        [bankBody('30000000005', 'Carol TESTER', 1000, 20, 0), 1000, 20, 0, '30000000005', 'Carol TESTER'],
    ];
    const electricity = bankBody('30000000006', 'SAMPLE POWER', 5000, 0, 41138, '1234-5678-9012-3456');
    const merchantZero = [
        ['TxId:30000000007*S*Your payment of 2,000 RWF to EXAMPLE CAFE Ltd 077314 was completed at 2026-09-02 13:31:31.  Balance: 0. Fee 0 RWF. *EN#', 2000, 'EXAMPLE CAFE Ltd 077314', '30000000007'],
        ['TxId:30000000008*S*Your payment of 20,000 RWF to SAMPLE GROUP Ltd 0712245 was completed at 2026-09-07 09:41:49.  Balance: 0. Fee 0 RWF. *EN#', 20000, 'SAMPLE GROUP Ltd 0712245', '30000000008'],
    ];

    async function remoteOnlyClient(t) {
        const env = H.makeEnv({fetchImpl: async () => H.jsonResponse(H.servedConfig({patterns: base.patterns}))});
        let client;
        try {
            client = H.loadClient(env, {dropBuiltins: true});
        } catch (error) {
            if (error instanceof H.PatchDriftError) {
                t.skip(error.message);
                return null;
            }
            throw error;
        }
        await client.rrc.syncRegexConfig({forceRefresh: true});
        return client;
    }

    test('ids are unique and the bank pattern is served before the electricity pattern', () => {
        const ids = base.patterns.map(p => p.id);
        assert.equal(new Set(ids).size, ids.length);
        assert.ok(ids.indexOf('mtn-payment-bank-v1') < ids.indexOf('mtn-token-payment-v1'));
        assert.ok(ids.includes('mtn-payment-merchant-zero-balance-v1'));
    });

    test('empty ET Id payments parse as plain payments with the payee only', {skip: SKIP_REAL}, async t => {
        const client = await remoteOnlyClient(t);
        if (!client) return;
        for (const [body, amount, fee, balance, transactionId, secondParty] of bank) {
            const [tx] = classifyAll(client, body).transactions;
            assert.ok(tx, body);
            assert.deepEqual(
                {type: tx.type, direction: tx.direction, amount: tx.amount, fee: tx.fee, balance: tx.balance, transactionId: tx.transactionId, secondParty: tx.secondParty, tags: tx.tags},
                {type: 'payment', direction: 'out', amount, fee, balance, transactionId, secondParty, tags: ['payment']},
                body,
            );
            assert.equal(tx.timestamp, Date.UTC(2026, 8, 4, 7, 52, 29, 406));
        }
    });

    test('a non-empty ET Id still parses through the electricity pattern', {skip: SKIP_REAL}, async t => {
        const client = await remoteOnlyClient(t);
        if (!client) return;
        const [tx] = classifyAll(client, electricity).transactions;
        assert.ok(tx);
        assert.deepEqual(tx.tags, ['payment', 'token', 'electricity']);
        assert.deepEqual({amount: tx.amount, fee: tx.fee, balance: tx.balance, transactionId: tx.transactionId, secondParty: tx.secondParty}, {amount: 5000, fee: 0, balance: 41138, transactionId: '30000000006', secondParty: 'SAMPLE POWER'});
    });

    test('empty ET Id payments parse when whitespace separates the sentence period from Fee', {skip: SKIP_REAL}, async t => {
        const client = await remoteOnlyClient(t);
        if (!client) return;
        for (const [gap, label] of feeGaps) {
            const body = bankBody('30000000009', 'Dana SAMPLE at Airtel', 6500, 20, 0, '', gap);
            const [tx] = classifyAll(client, body).transactions;
            assert.ok(tx, label);
            assert.deepEqual(
                {type: tx.type, direction: tx.direction, amount: tx.amount, fee: tx.fee, balance: tx.balance, transactionId: tx.transactionId, secondParty: tx.secondParty, tags: tx.tags},
                {type: 'payment', direction: 'out', amount: 6500, fee: 20, balance: 0, transactionId: '30000000009', secondParty: 'Dana SAMPLE', tags: ['payment']},
                label,
            );
            assert.equal(tx.timestamp, Date.UTC(2026, 8, 4, 7, 52, 29, 406), label);
        }
    });

    test('a non-empty ET Id still parses through the electricity pattern when whitespace separates the sentence period from Fee', {skip: SKIP_REAL}, async t => {
        const client = await remoteOnlyClient(t);
        if (!client) return;
        for (const [gap, label] of feeGaps) {
            const body = bankBody('30000000006', 'SAMPLE POWER', 5000, 0, 41138, '1234-5678-9012-3456', gap);
            const [tx] = classifyAll(client, body).transactions;
            assert.ok(tx, label);
            assert.deepEqual(tx.tags, ['payment', 'token', 'electricity'], label);
            assert.deepEqual({amount: tx.amount, fee: tx.fee, balance: tx.balance, transactionId: tx.transactionId, secondParty: tx.secondParty}, {amount: 5000, fee: 0, balance: 41138, transactionId: '30000000006', secondParty: 'SAMPLE POWER'}, label);
        }
    });

    test('the bank and electricity patterns accept any whitespace before Fee and never match each other', () => {
        const compile = id => {
            const entry = base.patterns.find(p => p.id === id);
            return new RegExp(entry.pattern, entry.flags);
        };
        const bankRe = compile('mtn-payment-bank-v1');
        const tokenRe = compile('mtn-token-payment-v1');
        for (const [gap, label] of feeGaps) {
            const emptyBody = bankBody('30000000009', 'Dana SAMPLE at Airtel', 6500, 20, 0, '', gap);
            const elecBody = bankBody('30000000006', 'SAMPLE POWER', 5000, 0, 41138, '1234-5678-9012-3456', gap);
            assert.ok(bankRe.test(emptyBody), `bank matches empty ET Id: ${label}`);
            assert.ok(!tokenRe.test(emptyBody), `token ignores empty ET Id: ${label}`);
            assert.ok(tokenRe.test(elecBody), `token matches electricity: ${label}`);
            assert.ok(!bankRe.test(elecBody), `bank ignores electricity: ${label}`);
            const groups = bankRe.exec(emptyBody);
            assert.equal(groups?.[3], 'Dana SAMPLE', label);
            assert.equal(groups?.[4], '2026-09-04T09:52:29.406+02:00', label);
            assert.equal(groups?.[5], '20', label);
        }
    });

    test('merchant payments that print "Balance: 0." with no currency are recovered by the bridge pattern', {skip: SKIP_REAL}, async t => {
        const client = await remoteOnlyClient(t);
        if (!client) return;
        for (const [body, amount, secondParty, transactionId] of merchantZero) {
            const [tx] = classifyAll(client, body).transactions;
            assert.ok(tx, body);
            assert.deepEqual(
                {type: tx.type, amount: tx.amount, fee: tx.fee, balance: tx.balance, transactionId: tx.transactionId, secondParty: tx.secondParty, tags: tx.tags},
                {type: 'payment', amount, fee: 0, balance: 0, transactionId, secondParty, tags: ['payment', 'merchant']},
                body,
            );
        }
    });
});
