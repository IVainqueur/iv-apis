'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {isNoiseSkeleton, NOISE_RULES, NOISE_WORDS} = require('../../lib/manie/noise');
const {anonymize} = require('../../lib/manie/anonymize');
const vectors = require('./vectors/anonymize-vectors.json');
const seed = require('../../assets/manie/vocab-seed.json');

const VOCAB = new Set(seed);
const skeletonOf = body => anonymize(body, VOCAB).skeleton;

// Synthetic only: invented names/numbers, structurally modeled on carrier traffic.
const NOISE = [
    ['otp', '<#> Dear Customer, your MTN MoMo application one-time password is :1234.MTN MoMo does not recommend that you share or expose your one-time password with anyone.'],
    ['otp', 'Your verification code is 482913. Do not share it.'],
    ['otp', 'Use OTP 5821 to confirm.'],
    ['account-security', 'You have entered an incorrect PIN. If you enter the wrong PIN 5 times, your account will be blocked.'],
    ['account-security', 'Your PIN has been reset. Your security question is now set.'],
    ['service-notice-en', 'Dear customer, MTN MoMo will be unavailable on 01/01/2026 from 01:00 to 04:00 due to scheduled maintenance.'],
    ['service-notice-en', 'Airtel Money will be down tonight for maintenance.'],
    ['service-notice-rw', 'Kubera imirimo yo kwagura serivisi iteganyijwe iri joro 01/01/2026, serivisi za Airtel Money ziraba zidakora guhera 01:00 kugeza 04:00 z igitondo. Tubiseguyeho'],
    ['service-notice-rw', 'Turabamenyesha ko serivisi zadakora uyu munsi.'],
    ['promo', 'Kanda *182*1*2# wohereze kuri AirtelMoney cg MTN MoMo. Utifuza ubu butumwa, kanda *389#'],
    ['promo', 'Download MoMoApp and get cashback on every payment!'],
    ['pending-ack', 'Your transaction of 5000 RWF is being processed. You will receive a confirmation message shortly.'],
    ['account-notice', 'You have changed your user profile successfully.'],
    ['failed-transaction', "*143*R*Y'ello, the transaction with amount 500 RWF for TEST MERCHANT LTD with message: test failed at 2026-01-01 09:00:00 .Please Contact MobileMoney HelpLine for Assistance.Thank you for using MTN MobileMoney.*EN#"],
    ['failed-transaction', 'Transfer of 5000 RWF to Alice Fakename 250780000001 was not successful. Balance: 20000 RWF'],
    ['failed-transaction', 'Your payment of 5000 RWF could not be completed due to insufficient funds. Balance: 100 RWF'],
    ['failed-transaction', 'Payment of 3000 RWF to Fake Mart was declined.'],
    ['failed-transaction', 'Transaction of 3000 RWF was cancelled.'],
    ['failed-transaction', 'Transaction of 3000 RWF timed out.'],
    ['failed-transaction', 'Transaction failed. 3000 RWF not sent.'],
    ['failed-transaction', '*165* TID PP260411.1430.A1*S* Kohereza Rwf 5000 kuri Aline Fakeperson 250780000008 ntibyakunze. Amafaranga adahagije. Ubu mufite Rwf 20. *KR#'],
    ['failed-transaction', 'Kwishyura Rwf 3000 byanze. Ntibyagenze neza.'],
    ['no-amount-mentioned', 'Hello Alice, welcome to MoMo.'],
    ['no-amount-mentioned', 'Your balance is being checked.'],
];

test('noise filter flags every synthetic non-transaction skeleton with the expected reason', () => {
    for (const [reason, body] of NOISE) {
        const skeleton = skeletonOf(body);
        const r = isNoiseSkeleton(skeleton);
        assert.equal(r.noise, true, 'expected noise for: ' + body + '\n  skeleton: ' + skeleton);
        if (reason !== 'no-amount-mentioned') {
            assert.equal(r.reason, reason, 'wrong reason for: ' + body + '\n  skeleton: ' + skeleton);
        }
    }
});

test('noise filter never flags the real transaction shapes in the conformance vectors', () => {
    const txn = vectors.filter(v => /^(mtn|airtel)-/.test(v.name));
    assert.ok(txn.length >= 20);
    for (const v of txn) {
        const r = isNoiseSkeleton(v.expected);
        assert.deepEqual(r, {noise: false}, v.name + ' wrongly flagged as ' + JSON.stringify(r));
    }
});

test('noise vectors from the conformance suite are flagged', () => {
    const noise = vectors.filter(v => v.name.startsWith('noise-'));
    assert.ok(noise.length >= 5);
    for (const v of noise) {
        assert.equal(isNoiseSkeleton(v.expected).noise, true, v.name);
    }
});

test('a failed word next to success wording is not enough to drop the shape', () => {
    assert.deepEqual(isNoiseSkeleton('Payment of {N} RWF completed. Earlier attempt failed. Balance {N} RWF'), {noise: false});
    assert.equal(isNoiseSkeleton('Payment of {N} RWF failed. Balance {N} RWF').reason, 'failed-transaction');
});

test('explicit failure phrases win even beside success wording', () => {
    const r = isNoiseSkeleton('Your payment of {N} RWF was not successful. Balance {N} RWF');
    assert.deepEqual(r, {noise: true, reason: 'failed-transaction'});
});

test('skeletons need an RWF mention and a number placeholder', () => {
    assert.equal(isNoiseSkeleton('Money sent to {W+} Amt {N}').reason, 'no-amount-mentioned');
    assert.equal(isNoiseSkeleton('Money sent to {W+} Amt RWF').reason, 'no-amount-mentioned');
    assert.deepEqual(isNoiseSkeleton('Money sent to {W+} Amt RWF {N}'), {noise: false});
    assert.deepEqual(isNoiseSkeleton('Money sent to {W+} Amt rwf {PH}'), {noise: false});
});

test('non-string and empty skeletons are noise', () => {
    for (const bad of [undefined, null, 42, '', '   ', {}]) {
        assert.deepEqual(isNoiseSkeleton(bad), {noise: true, reason: 'empty'});
    }
});

test('noise matching is case-insensitive', () => {
    assert.equal(isNoiseSkeleton('YOUR PIN IS {N} RWF {N}').reason, 'account-security');
    assert.equal(isNoiseSkeleton('TRANSACTION FAILED RWF {N}').reason, 'failed-transaction');
});

test('rules only use vocabulary words and expose them for the seed generator', () => {
    const vocab = new Set(seed);
    assert.ok(NOISE_WORDS.length > 30);
    for (const w of NOISE_WORDS) {
        assert.ok(w.length >= 2 || w === 'f', 'stray fragment in noise words: ' + w);
        assert.ok(vocab.has(w), 'noise word missing from seed: ' + w);
    }
    assert.deepEqual(NOISE_WORDS, [...NOISE_WORDS].sort());
    const reasons = new Set(NOISE_RULES.map(r => r.reason));
    for (const reason of ['otp', 'account-security', 'service-notice-en', 'service-notice-rw', 'promo', 'pending-ack', 'account-notice', 'failed-transaction', 'reversed-or-refused', 'failed-marker']) {
        assert.ok(reasons.has(reason), reason);
    }
});

test('noise filter is linear on adversarial skeletons', () => {
    const started = Date.now();
    for (const s of ['{N} '.repeat(100), 'not '.repeat(100), 'one-time '.repeat(40), 'kanda '.repeat(60), 'failed '.repeat(60) + 'rwf {N}', ' '.repeat(400)]) {
        isNoiseSkeleton(s);
    }
    assert.ok(Date.now() - started < 500);
});

// R1-SERVED-1: reversed, denied, expired or limit-blocked notices anonymize to shapes that look like
// successful payments unless the failure vocabulary is known and filtered.
const FAILURE_NOTICES = [
    'Your payment of 7,000 RWF to ACME SHOP has been reversed. Fee was 0 RWF. Your new balance: 19,000 RWF. 2026-04-12 09:01:02',
    'Your transfer of 5,000 RWF to Alice Mukamana was not processed due to an error. Your new balance: 19,000 RWF.',
    'Your payment of 5,000 RWF to ACME SHOP has expired. Balance: 19,000 RWF',
    'Your transfer of 5,000 RWF exceeds your daily limit. Balance: 19,000 RWF',
    'Your request to transfer 5,000 RWF to Alice Mukamana (250780000001) was denied',
    'Your payment of 5,000 RWF to ACME SHOP has been refused. Balance: 19,000 RWF',
    'Your transfer of 5,000 RWF to Alice Mukamana did not go through. Balance: 19,000 RWF',
    'Your payment of 5,000 RWF to ACME SHOP was rolled back. Balance: 19,000 RWF',
    'Your payment of 5,000 RWF to ACME SHOP is awaiting approval. Balance: 19,000 RWF',
    'Use code 123456 to confirm payment of 5,000 RWF to ACME SHOP. Your new balance: 19,000 RWF',
    '*165*TID PP260411.1430.A12345*F* Sent Rwf 5000 to Alice Mukamana 0780000001. Fee Rwf 0. BAL Rwf 12000. *EN#',
    '*165*TID PP260411.1430.A12345*S* Kohereza Rwf 5000 kuri Alice Mukamana 0780000001 siyo. Ubu mufite Rwf 12000. *KR#',
    '*165*TID PP260411.1430.A12345*S* Kohereza Rwf 5000 kuri Alice Mukamana 0780000001 ntibishobotse. Ubu mufite Rwf 12000. *KR#',
    '*165*TID PP260411.1430.A12345*S* Kohereza Rwf 5000 kuri Alice Mukamana 0780000001 byahagaritswe. Ubu mufite Rwf 12000. *KR#',
    '*165*TID PP260411.1430.A12345*S* Kohereza Rwf 5000 kuri Alice Mukamana 0780000001. Amafaranga ntahagije. Ubu mufite Rwf 12000. *KR#',
];

test('reversal, denial, expiry, limit and Kinyarwanda failure notices are noise end to end', () => {
    for (const body of FAILURE_NOTICES) {
        const skeleton = skeletonOf(body);
        assert.equal(isNoiseSkeleton(skeleton).noise, true, `${body}\n  -> ${skeleton}`);
    }
});

test('the Airtel failure marker *F* is kept literal and dropped, the success marker *S* is not', () => {
    assert.equal(skeletonOf('*165*TID PP260411.1430.A12345*F* Sent Rwf 5000 to Alice Mukamana 0780000001. Fee Rwf 0. BAL Rwf 12000. *EN#').includes('*F*'), true);
    assert.equal(isNoiseSkeleton('*{N}*TID {TID}*F* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#').reason, 'failed-marker');
    assert.equal(isNoiseSkeleton('*{N}*TID {TID}*S* Sent Rwf {N} to {W+} {PH}. Fee Rwf {N}. BAL Rwf {N}. *EN#').noise, false);
});

test('successful payment, receipt and deposit shapes are not mistaken for the failure lexicon', () => {
    for (const body of [
        'Your payment of 5,000 RWF to ACME SHOP has been approved. Fee was 0 RWF. Your new balance: 12,000 RWF. 2026-04-11 14:30:05',
        'A cash deposit of 4,000 RWF has been made to your account on 2026-04-11 14:30:05. Your new balance: 12,000 RWF. TxId: 55512345',
        'You have deposited 5,000 RWF to your account via agent Alice Mukamana (250780000001) on 2026-04-11 14:30:05. Your new balance: 12,000 RWF.',
        'You have received 5,000 RWF from Alice Mukamana (250780000001) on 2026-04-11 14:30:05. Your new balance: 12,000 RWF.',
    ]) {
        const skeleton = skeletonOf(body);
        assert.equal(isNoiseSkeleton(skeleton).noise, false, skeleton);
    }
});

test('a service notice survives the name-like rule: "Services will be unavailable" is still noise', () => {
    const skeleton = skeletonOf('Mobile Money services will be unavailable tonight for maintenance, thank you for 5 RWF');
    assert.equal(isNoiseSkeleton(skeleton).noise, true, skeleton);
    assert.equal(isNoiseSkeleton('{W+} be unavailable {N} RWF').noise, true);
});

// Dataset shapes: bundle activations are not transactions and the app reads MoMoAdvance itself.
// Numbers and ids are invented. The {W} skeletons are what a device with a vocabulary from before
// these words were added sends, so the rules must hold for both forms.
const DATASET_NOTICES = [
    ['bundle-activation', 'Yello!You have successfully activated 1000Frw=7GB/7Days worth 1,000 RWF'],
    ['bundle-activation', 'Yello!You have successfully activated  2000Frw=4000Mins/Iminsi 30 worth 2,000 RWF'],
    ['bundle-activation', 'Yello!You have successfully activated  2000Frw = 4000Mins/30Days worth 2,000 RWF'],
    ['momoadvance', 'You have used 2070 RWF on FRI:31907745/MM with access fee 67 RWF on 2026-09-02 13:11:25 from MoMoAdvance. Your available overdraft balance is 20930 RWF. Financial transaction id: 30439184340'],
    ['momoadvance', 'The amount 4202 RWF has been repaid from your account FRI:31907745/MM on 2026-09-02 15:31:52. Financial transaction id: 30441302961'],
];

const OLD_VOCABULARY_SKELETONS = [
    ['bundle-activation', '{W}!You have successfully {W} {N}{W}={N}{W}/{N}{W+} {N} RWF'],
    ['bundle-activation', '{W}!You have successfully {W} {N}{W}={N}{W}/{W} {N} {W} {N} RWF'],
    ['bundle-activation', '{W}!You have successfully {W} {N}{W} = {N}{W}/{N}{W+} {N} RWF'],
    ['momoadvance', 'You have {W} {N} RWF on {W}:{N}/{W} with {W} fee {N} RWF on {TS} from {W}. Your available {W} balance is {N} RWF. Financial transaction id: {PH}'],
    ['momoadvance', 'The amount {N} RWF has been {W} from your account {W}:{N}/{W} on {TS}. Financial transaction id: {PH}'],
];

test('dataset notices (bundle activation, MoMoAdvance) are dropped under the current vocabulary', () => {
    for (const [reason, body] of DATASET_NOTICES) {
        const skeleton = skeletonOf(body);
        assert.deepEqual(isNoiseSkeleton(skeleton), {noise: true, reason}, skeleton);
    }
});

test('dataset notices are still dropped when a device sends the {W} form of the new words', () => {
    for (const [reason, skeleton] of OLD_VOCABULARY_SKELETONS) {
        assert.deepEqual(isNoiseSkeleton(skeleton), {noise: true, reason}, skeleton);
    }
});

test('a preapproval cancellation is dropped', () => {
    const skeleton = skeletonOf("*143*S*Your preapproval with identity 30672204 was canceled.Thank you for using MTN MobileMoney. *EN#");
    assert.equal(isNoiseSkeleton(skeleton).noise, true, skeleton);
    assert.deepEqual(isNoiseSkeleton('*{N}*S*Your preapproval of {N} RWF was approved.'), {noise: true, reason: 'preapproval-notice'});
});

test('the new notice rules leave real MTN shapes alone', () => {
    for (const skeleton of [
        'TxId:{PH}*S*Your payment of {N} RWF to {W+} {N} was completed at {TS}. Balance: {N}. Fee {N} RWF. *EN#',
        'TransactionId: {PH} Your payment of {N} RWF to {W+} with token and ET Id: SUCCESSFUL at {TS}.Fee:{N} RWF. Balance {N} RWF.',
        'You have received {N} RWF from {W+} ({PH}) at {TS} . Balance:{N} RWF. FT Id: {PH}',
        '*165*S*{N} RWF transferred to {W+} ({PH}) at {TS} .Fee: {N}RWF.Balance: {N}RWF.Dial *182*1*3# and send money abroad *EN#',
    ]) {
        assert.deepEqual(isNoiseSkeleton(skeleton), {noise: false}, skeleton);
    }
});
