'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    buildVocabulary,
    literalWordsOfRegexSource,
    normalizeVocabWord,
    normalizeAdminWord,
} = require('../../lib/manie/vocab');
const {NOISE_WORDS} = require('../../lib/manie/noise');
const seed = require('../../assets/manie/vocab-seed.json');
const base = require('../../assets/manie/sms-formats.json');

const APP_REPO = process.env.MANIE_APP_REPO || '/Users/ivainqueur/Documents/Code/React/mobile/Manie';

test('literalWordsOfRegexSource: escapes, classes and quantifiers are not words', () => {
    assert.deepEqual(literalWordsOfRegexSource('Fee\\swas:\\s(.*?)\\sRWF'), ['fee', 'was', 'rwf']);
    assert.deepEqual(literalWordsOfRegexSource('\\*?165\\*\\s*TID\\s+(\\D{2}\\d+\\.\\d+\\.\\D\\d+)\\*S\\*'), ['tid', 's']);
    assert.deepEqual(literalWordsOfRegexSource('([\\d\\-\\s:]+)abc[xyz]def'), ['abc', 'def']);
    assert.deepEqual(literalWordsOfRegexSource('\\d+\\.\\w+\\b\\n\\t'), []);
    assert.deepEqual(literalWordsOfRegexSource('\\u0041bc\\x41de\\cJfg'), ['bc', 'de', 'fg']);
});

test('literalWordsOfRegexSource: alternation, groups, lookarounds', () => {
    assert.deepEqual(literalWordsOfRegexSource('(?:RWF|Rwf)(\\d+)'), ['rwf']);
    assert.deepEqual(literalWordsOfRegexSource('(?:has|have)\\svia'), ['has', 'have', 'via']);
    assert.deepEqual(literalWordsOfRegexSource('in\\s+(?!MTN\\s+RWANDA)(.*?)\\.'), ['in', 'mtn', 'rwanda']);
    assert.deepEqual(literalWordsOfRegexSource('(?<=foo)bar(?<name>baz)qux(?=quux)'), ['foo', 'bar', 'baz', 'qux', 'quux']);
    assert.deepEqual(literalWordsOfRegexSource('a|b|cd'), ['a', 'b', 'cd']);
});

test('literalWordsOfRegexSource: optional letters and optional literal groups yield both spellings', () => {
    assert.deepEqual(literalWordsOfRegexSource('colou?r'), ['color', 'colour']);
    assert.deepEqual(literalWordsOfRegexSource('Bal(?:ance)?'), ['bal', 'balance']);
    assert.deepEqual(literalWordsOfRegexSource('x{0,2}y'), ['y', 'xy']);
    assert.deepEqual(literalWordsOfRegexSource('NEW\\s+BALANCE\\s+is\\sRWF'), ['new', 'balance', 'is', 'rwf']);
});

test('literalWordsOfRegexSource: apostrophes, case, de-duplication and garbage', () => {
    assert.deepEqual(literalWordsOfRegexSource("Nimero y'igikorwa ni Nimero"), ['nimero', "y'igikorwa", 'ni']);
    assert.deepEqual(literalWordsOfRegexSource("'abc"), ['abc']);
    assert.deepEqual(literalWordsOfRegexSource('{2}abc'), ['abc']);
    assert.deepEqual(literalWordsOfRegexSource(''), []);
    assert.deepEqual(literalWordsOfRegexSource(undefined), []);
    assert.deepEqual(literalWordsOfRegexSource(null), []);
    assert.deepEqual(literalWordsOfRegexSource(42), []);
    assert.deepEqual(literalWordsOfRegexSource('(((('), []);
    assert.deepEqual(literalWordsOfRegexSource('[abc'), []);
    assert.deepEqual(literalWordsOfRegexSource('\\'), []);
    assert.deepEqual(literalWordsOfRegexSource('a'.repeat(31)), []);
});

test('literalWordsOfRegexSource: terminates on hostile sources', () => {
    const started = Date.now();
    for (const src of ['('.repeat(5000), '['.repeat(5000), '\\'.repeat(5001), 'a?'.repeat(5000), '(?:a|b)?'.repeat(2000), '{'.repeat(5000), 'x{0,2}'.repeat(3000)]) {
        const words = literalWordsOfRegexSource(src);
        assert.ok(Array.isArray(words));
    }
    assert.ok(Date.now() - started < 2000);
});

test('normalizeVocabWord / normalizeAdminWord', () => {
    assert.equal(normalizeVocabWord(' Rwf '), 'rwf');
    assert.equal(normalizeVocabWord("Y'IGIKORWA"), "y'igikorwa");
    assert.equal(normalizeVocabWord("'abc"), 'abc');
    assert.equal(normalizeVocabWord('a'), 'a');
    for (const bad of ['', 'abc1', '1abc', 'ab cd', 'é', 'a-b', "'", 'x'.repeat(31), null, undefined, 5, {}]) {
        assert.equal(normalizeVocabWord(bad), null, String(bad));
    }
    assert.equal(normalizeAdminWord(' Kuri '), 'kuri');
    for (const bad of ['a', "y'i", 'ab1', 'x'.repeat(31), 'é', 'a b', '', null, 7]) {
        assert.equal(normalizeAdminWord(bad), null, String(bad));
    }
    assert.equal(normalizeAdminWord('x'.repeat(30)), 'x'.repeat(30));
});

test('buildVocabulary merges seed, pattern literals and admin words', () => {
    const vocab = buildVocabulary({
        seed: ['Rwf', 'fee', 'kuri', 'bad1', 5, null],
        patterns: [{pattern: 'Mwakiriye\\s+(\\d+)\\s+avuye'}, {pattern: 7}, null, {}],
        adminWords: ['Kucyiguzi', 'x', 'ab1', "no'pe", 'musigaranye'],
    });
    assert.ok(vocab instanceof Set);
    assert.deepEqual([...vocab].sort(), ['avuye', 'fee', 'kucyiguzi', 'kuri', 'musigaranye', 'mwakiriye', 'rwf']);
});

test('buildVocabulary is total', () => {
    assert.equal(buildVocabulary().size, 0);
    assert.equal(buildVocabulary({}).size, 0);
    assert.equal(buildVocabulary({seed: 'abc', patterns: 'x', adminWords: {}}).size, 0);
    assert.equal(buildVocabulary({seed: ['a', 'a', 'A']}).size, 1);
});

test('seed file: sorted, unique, lowercase words only', () => {
    assert.ok(Array.isArray(seed));
    assert.ok(seed.length > 100);
    assert.deepEqual(seed, [...new Set(seed)].sort());
    for (const w of seed) {
        assert.equal(normalizeVocabWord(w), w, 'invalid seed word: ' + w);
        assert.doesNotMatch(w, /\d/);
    }
});

test('seed file: single-letter words are limited to the Airtel markers (R, S, F) and the article', () => {
    const singles = seed.filter(w => w.length === 1);
    assert.deepEqual(singles, ['a', 'f', 'r', 's']);
});

test('seed file contains the carrier boilerplate the shapes depend on', () => {
    const must = ['rwf', 'fee', 'balance', 'transferred', 'received', 'payment', 'tid', 'txn', 'txid', 'transactionid', 'kohereza', 'kuri', 'mwakiriye', 'avuye', 'ubu', 'mufite', 'byakunze', 'byagenze', 'neza', 'kwishyura', 'kugura', 'en', 'kr', 'mtn', 'airtel', 'successful', 'successfully', 'completed', 'token', 'et', 'id'];
    for (const w of must) assert.ok(seed.includes(w), 'seed missing ' + w);
});

test('seed file covers the literal words of every served base pattern', () => {
    const vocab = new Set(seed);
    for (const p of base.patterns) {
        for (const w of literalWordsOfRegexSource(p.pattern)) {
            assert.ok(vocab.has(w), 'seed missing "' + w + '" from pattern ' + p.id);
        }
    }
});

test('seed file contains every noise keyword so the skeleton noise filter can see them', () => {
    const vocab = new Set(seed);
    for (const w of NOISE_WORDS) assert.ok(vocab.has(w), 'seed missing noise word ' + w);
});

test('seed file is up to date with the app built-in patterns (skipped when the app repo is absent)', t => {
    const loader = path.join(APP_REPO, 'tools', 'sms-pattern-tool', 'lib', 'loadClassify.js');
    if (!fs.existsSync(loader)) {
        t.skip('app repo not found at ' + APP_REPO);
        return;
    }
    const {buildSeed} = require('../../scripts/gen-manie-vocab-seed');
    assert.deepEqual(buildSeed(APP_REPO), seed, 'run: node scripts/gen-manie-vocab-seed.js');
});

// R1-SERVED-4 and R1-SERVED-5: every keyword the draft generator reasons about must be literal in the
// served vocabulary, otherwise it collapses into {W} and the keyword never fires.
test('seed contains every keyword list of the draft generator and the function-word lexicon', () => {
    const {KEYWORD_WORDS} = require('../../lib/manie/_fields');
    const {EXTRA_VOCAB_WORDS} = require('../../lib/manie/_lexicon');
    const vocab = new Set(seed);
    assert.ok(KEYWORD_WORDS.length > 40);
    for (const w of KEYWORD_WORDS) assert.ok(vocab.has(w), `keyword "${w}" is missing from the seed`);
    for (const w of EXTRA_VOCAB_WORDS) assert.ok(vocab.has(w), `lexicon word "${w}" is missing from the seed`);
    for (const w of ['deposited', 'withdrawal', 'kubitsa', 'kubikuza', 'yakiriye', 'mwakoresheje', 'transfer', 'receive', 'withdraw', 'pay', 'fees', 'charge', 'icyiciro', 'amount', 'txnid', 'for', 'the', 'an', 'are', 'made', 'done', 'approved']) {
        assert.ok(vocab.has(w), `${w} must be literal`);
    }
});

test('seed contains the failure, reversal and limit lexicon used by the noise filter', () => {
    const vocab = new Set(seed);
    for (const w of ['error', 'expired', 'denied', 'refused', 'reversed', 'reversal', 'aborted', 'invalid', 'exceeded', 'exceeds', 'limit', 'pending', 'not', 'siyo', 'ntibishobotse', 'byahagaritswe', 'ntahagije', 'f']) {
        assert.ok(vocab.has(w), `${w} must be literal`);
    }
});

test('seed no longer carries words that exist only for a rule that stopped needing them', () => {
    assert.equal(seed.includes('will'), false, 'will is a given name and no served pattern or noise rule needs it');
});

test('merchant-name words are deliberately not in the lexicon', () => {
    const vocab = new Set(seed);
    for (const w of ['shop', 'store', 'service', 'services']) assert.equal(vocab.has(w), false, w);
});
