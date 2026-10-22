'use strict';

// The server reference anonymizer (lib/manie/anonymize.js) against the on-device port (the
// app's src/lib/utils/anonymize.ts, compiled here with the app's own TypeScript).
//
// What must hold, always: the reference is AT LEAST AS STRICT as the device port. A literal
// word that the reference keeps and the device port hides would be a privacy divergence, and
// there is none. And, as hard assertions, the device port reproduces every conformance vector,
// carries the reference's lists and is no more lenient than the reference: a port that lags
// the reference fails this file (the differential alone only sees the first direction, so a
// port that keeps more than the reference would otherwise pass for good).
//
// scripts/manie-anonymize-fuzz.js runs the same comparison at 200,000+ messages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reference = require('../../lib/manie/anonymize');
const names = require('../../lib/manie/_names');
const {runMessageFuzz, runCharFuzz, compileDevicePort, makeGen, servedVocabulary, FUZZ_TLDS} = require('./_anonFuzz');

const anonymizeVectors = require('./vectors/anonymize-vectors.json');
const sanitizeVectors = require('./vectors/sanitize-vectors.json');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'manie-anon-parity-'));
process.on('exit', () => {
    try {
        fs.rmSync(work, {recursive: true, force: true});
    } catch (error) {
        // a temp directory left behind is harmless
    }
});

const compiled = process.env.MANIE_SKIP_PARITY === '1' ? {file: null, reason: 'MANIE_SKIP_PARITY=1'} : compileDevicePort(path.join(work, 'port'));
const skip = compiled.file ? false : `the device port could not be built: ${compiled.reason}`;
const device = compiled.file ? require(compiled.file) : null;

const view = result => JSON.stringify(result.ok ? {...result} : {ok: false, reason: result.reason});

test('the reference never keeps a literal word that the device port hides (messages, three vocabularies)', {skip}, t => {
    const result = runMessageFuzz({api: reference, dev: device, names, n: 6000, seed: 20261022});
    for (const [what, tally] of [['anonymize', result.anonymize], ['sanitizeSkeleton', result.sanitize]]) {
        assert.equal(tally.privacy, 0, `${what}: ${JSON.stringify(tally.examplesPrivacy.slice(0, 2))}`);
        assert.equal(tally.mixed, 0, `${what} mixed divergences: ${JSON.stringify(tally.examplesOther.slice(0, 2))}`);
        assert.equal(tally.other, 0, `${what} unclassified divergences: ${JSON.stringify(tally.examplesOther.slice(0, 2))}`);
        t.diagnostic(`${what}: ${tally.cases} cases, ${tally.identical} identical, ${tally.apiStricter} where the reference hides more than the device port`);
    }
});

test('the reference never keeps a literal word that the device port hides (hostile random strings)', {skip}, t => {
    const result = runCharFuzz({api: reference, dev: device, names, n: 12000, seed: 77});
    for (const [what, tally] of [['anonymize', result.anonymize], ['sanitizeSkeleton', result.sanitize]]) {
        assert.equal(tally.privacy, 0, `${what}: ${JSON.stringify(tally.examplesPrivacy.slice(0, 2))}`);
        assert.equal(tally.mixed + tally.other, 0, `${what}: ${JSON.stringify(tally.examplesOther.slice(0, 2))}`);
        t.diagnostic(`${what}: ${tally.cases} cases, ${tally.identical} identical, ${tally.apiStricter} where the reference hides more`);
    }
});

test('the fuzz is not vacuous: a reference with one name rule switched off is caught', {skip}, () => {
    const dir = path.join(work, 'weakened');
    fs.mkdirSync(dir, {recursive: true});
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'manie', 'anonymize.js'), 'utf8');
    const rule = '                if (!absorb && nameLike) absorb = inNamePosition(items, i);\n';
    assert.ok(source.includes(rule), 'the rule this test switches off has moved: update the test');
    fs.writeFileSync(path.join(dir, 'anonymize.js'), source.replace(rule, ''));
    fs.copyFileSync(path.join(__dirname, '..', '..', 'lib', 'manie', '_names.js'), path.join(dir, '_names.js'));
    const weakened = require(path.join(dir, 'anonymize.js'));
    const result = runMessageFuzz({api: weakened, dev: device, names, n: 3000, seed: 5});
    assert.ok(result.anonymize.privacy > 0, 'the differential saw no divergence in anonymize()');
    assert.ok(result.sanitize.privacy > 0, 'the differential saw no divergence in sanitizeSkeleton()');
});

const listsOf = port => ({
    nameStoplist: port.NAME_STOPLIST,
    nameCueWords: port.NAME_CUE_WORDS,
    nameEdgePunct: port.NAME_EDGE_PUNCT,
    nameGreetingWords: port.NAME_GREETING_WORDS,
    nameCollisionWords: port.NAME_COLLISION_WORDS,
    nameSoleCueWords: port.NAME_SOLE_CUE_WORDS,
    nameSoleTerminators: port.NAME_SOLE_TERMINATORS,
});

function failingVectors(port) {
    const failingAnonymize = anonymizeVectors.filter(v => {
        const got = port.anonymize(v.input, new Set(v.vocab));
        const kinds = got.slots.map(s => `${s.kind}:${s.index}`);
        const spans = got.slots.map(s => v.input.slice(s.start, s.end));
        return got.skeleton !== v.expected || JSON.stringify(kinds) !== JSON.stringify(v.slots) || JSON.stringify(spans) !== JSON.stringify(v.spans);
    });
    const failingSanitize = sanitizeVectors.vectors.filter(v => {
        const got = port.sanitizeSkeleton(v.skeleton, new Set(v.vocab));
        const expected = v.expected.ok ? v.expected : {ok: false, reason: v.expected.reason};
        return view(got) !== JSON.stringify(expected);
    });
    const lists = listsOf(port);
    const staleLists = Object.keys(lists).filter(key => JSON.stringify(lists[key]) !== JSON.stringify(sanitizeVectors[key]));
    return {failingAnonymize, failingSanitize, staleLists};
}

test('the device port reproduces every conformance vector and carries the reference lists', {skip}, () => {
    const {failingAnonymize, failingSanitize, staleLists} = failingVectors(device);
    assert.deepEqual(failingAnonymize.map(v => v.name), []);
    assert.deepEqual(failingSanitize.map(v => v.name), []);
    assert.deepEqual(staleLists, []);
});

test('a device port that keeps more literals than the reference is a leak on the wire', {skip}, () => {
    const messages = runMessageFuzz({api: reference, dev: device, names, n: 6000, seed: 20261022});
    const chars = runCharFuzz({api: reference, dev: device, names, n: 12000, seed: 77});
    const lenient = [
        ['anonymize (messages)', messages.anonymize],
        ['sanitizeSkeleton (messages)', messages.sanitize],
        ['anonymize (hostile strings)', chars.anonymize],
        ['sanitizeSkeleton (hostile strings)', chars.sanitize],
    ].map(([what, tally]) => ({what, cases: tally.cases, keepsMore: tally.apiStricter}));
    assert.deepEqual(lenient.filter(row => row.keepsMore > 0), [], 'the device port hides everything the reference hides');
});

// The reference keeps its TLD list in a local constant (it only ever reaches the URL regex), so it
// is read from the source; the device port exports the list it builds its regex from.
function referenceTlds() {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'manie', 'anonymize.js'), 'utf8');
    const block = source.match(/const TLDS = \[([\s\S]*?)\]\s*\.map\(ci\)/);
    assert.ok(block, 'the TLDS list of lib/manie/anonymize.js has moved: update the test');
    return [...block[1].matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);
}

test('the URL rule recognises exactly the same TLDs, in the same order, in the reference and the device port', {skip}, () => {
    const listed = referenceTlds();
    assert.ok(listed.length >= 30, `only ${listed.length} reference TLDs were read`);
    assert.equal(new Set(listed).size, listed.length, 'the reference lists a TLD twice');
    assert.ok(Array.isArray(device.URL_TLDS), 'the device port no longer exports URL_TLDS: update the test');
    assert.deepEqual([...device.URL_TLDS], listed);
});

test('the fuzz draws the TLDs that no fixed URL uses, and the reference reads each one as a URL', () => {
    const listed = new Set(referenceTlds());
    assert.deepEqual(FUZZ_TLDS.filter(tld => !listed.has(tld)), [], 'the fuzz draws a TLD that the reference does not list');
    const vocab = servedVocabulary();
    const gen = makeGen(20261022, [...vocab]);
    const seen = new Set();
    for (let i = 0; i < 6000; i++) {
        const message = gen.message();
        for (const slot of reference.anonymize(message, vocab).slots) {
            if (slot.kind !== 'URL') continue;
            const span = message.slice(slot.start, slot.end);
            for (const tld of FUZZ_TLDS) if (new RegExp(`\\.${tld}(?![a-z0-9-])`, 'i').test(span)) seen.add(tld);
        }
    }
    assert.deepEqual(FUZZ_TLDS.filter(tld => !seen.has(tld)), [], 'these TLDs were never read as a URL by the message fuzz');
});

// A list entry that no vector exercises can be dropped from a port without any test noticing, and
// the lists decide what is hidden from a person's name. Each entry is removed from the live list
// of the reference in turn: the vectors must then disagree with the reference somewhere. "dear" is
// the one entry that two lists carry, so only removing it from both is visible.
test('every entry of every name list is exercised by a conformance vector', () => {
    const lists = {
        nameStoplist: {set: names.NAME_STOPSET, entries: names.NAME_STOPLIST},
        nameCueWords: {set: names.NAME_CUE_SET, entries: names.NAME_CUE_WORDS},
        nameEdgePunct: {set: names.NAME_EDGE_SET, entries: names.NAME_EDGE_PUNCT.split('')},
        nameGreetingWords: {set: names.NAME_GREETING_SET, entries: names.NAME_GREETING_WORDS},
        nameCollisionWords: {set: names.NAME_COLLISION_SET, entries: names.NAME_COLLISION_WORDS},
        nameSoleCueWords: {set: names.NAME_SOLE_CUE_SET, entries: names.NAME_SOLE_CUE_WORDS},
        nameSoleTerminators: {set: names.NAME_SOLE_TERMINATOR_SET, entries: names.NAME_SOLE_TERMINATORS.split('')},
    };
    const outputs = () =>
        anonymizeVectors.map(v => reference.anonymize(v.input, new Set(v.vocab)).skeleton)
            .concat(sanitizeVectors.vectors.map(v => JSON.stringify(reference.sanitizeSkeletonDetailed(v.skeleton, new Set(v.vocab)))));
    const expected = outputs();
    const alsoIn = {nameCueWords: {dear: [names.NAME_GREETING_SET]}};
    const unexercised = [];
    let entries = 0;
    for (const [key, list] of Object.entries(lists)) {
        for (const entry of list.entries) {
            entries += 1;
            const sets = [list.set, ...((alsoIn[key] && alsoIn[key][entry]) || [])];
            sets.forEach(set => set.delete(entry));
            try {
                if (outputs().every((out, i) => out === expected[i])) unexercised.push(`${key}:${entry}`);
            } finally {
                sets.forEach(set => set.add(entry));
            }
        }
    }
    assert.ok(entries >= 100, `only ${entries} entries were checked`);
    assert.deepEqual(unexercised, [], 'add a vector (scripts/gen-manie-vectors.js fills in the expected values) for each of these entries');
    assert.deepEqual(outputs(), expected, 'the lists were restored');
});

// The two changes of the reviewed port that every vector used to let through: the near-unknown
// distance one step short, and (in the device port only) the worklist radius. The first exists in
// the reference too, so the vectors are held to catching it there.
test('the vectors catch a reference whose near-unknown distance is one step short', () => {
    const dir = path.join(work, 'short-distance');
    fs.mkdirSync(dir, {recursive: true});
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'manie', 'anonymize.js'), 'utf8');
    const rule = 'while (isGap(items[j]) && steps < 3) {';
    assert.ok(source.includes(rule), 'the line this test shortens has moved: update the test');
    fs.writeFileSync(path.join(dir, 'anonymize.js'), source.replace(rule, 'while (isGap(items[j]) && steps < 2) {'));
    fs.copyFileSync(path.join(__dirname, '..', '..', 'lib', 'manie', '_names.js'), path.join(dir, '_names.js'));
    const mutant = require(path.join(dir, 'anonymize.js'));
    const caught = failingVectors(mutant);
    assert.ok(caught.failingAnonymize.some(v => v.name === 'priv02-near-unknown-two-steps-away'), 'the vector for this distance is the one that sees it');
});
