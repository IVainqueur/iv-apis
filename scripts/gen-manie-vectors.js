#!/usr/bin/env node
'use strict';

// Re-derives the expected values of the anonymizer conformance vectors from the reference
// implementation, keeping every vector's input and vocabulary. Run it after a deliberate
// change to lib/manie/anonymize.js or lib/manie/_names.js, review the diff, then copy both
// files byte for byte to the app (__tests__/fixtures/) so that its port is held to the
// same behaviour.
//
//   node scripts/gen-manie-vectors.js            rewrite the files
//   node scripts/gen-manie-vectors.js --check    fail if they are stale

const fs = require('fs');
const path = require('path');
const {anonymize, sanitizeSkeletonDetailed} = require('../lib/manie/anonymize');
const names = require('../lib/manie/_names');

const DIR = path.join(__dirname, '..', 'test', 'manie', 'vectors');
const ANON_FILE = path.join(DIR, 'anonymize-vectors.json');
const SAN_FILE = path.join(DIR, 'sanitize-vectors.json');

function anonymizeVector(v) {
    const got = anonymize(v.input, new Set(v.vocab));
    return {
        name: v.name,
        input: v.input,
        vocab: v.vocab,
        expected: got.skeleton,
        slots: got.slots.map(s => s.kind + ':' + s.index),
        spans: got.slots.map(s => v.input.slice(s.start, s.end)),
    };
}

function sanitizeVector(v) {
    return {name: v.name, skeleton: v.skeleton, vocab: v.vocab, expected: sanitizeSkeletonDetailed(v.skeleton, new Set(v.vocab))};
}

function render() {
    const anon = JSON.parse(fs.readFileSync(ANON_FILE, 'utf8')).map(anonymizeVector);
    const sanitize = JSON.parse(fs.readFileSync(SAN_FILE, 'utf8')).vectors.map(sanitizeVector);
    const lists = {
        nameStoplist: names.NAME_STOPLIST,
        nameCueWords: names.NAME_CUE_WORDS,
        nameEdgePunct: names.NAME_EDGE_PUNCT,
        nameGreetingWords: names.NAME_GREETING_WORDS,
        nameCollisionWords: names.NAME_COLLISION_WORDS,
        nameSoleCueWords: names.NAME_SOLE_CUE_WORDS,
        nameSoleTerminators: names.NAME_SOLE_TERMINATORS,
    };
    let sanitizeText = '{\n';
    for (const [key, value] of Object.entries(lists)) sanitizeText += ` ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`;
    sanitizeText += ' "vectors": [\n' + sanitize.map(v => '  ' + JSON.stringify(v)).join(',\n') + '\n ]\n}\n';
    return {
        [ANON_FILE]: '[\n' + anon.map(v => '  ' + JSON.stringify(v)).join(',\n') + '\n]\n',
        [SAN_FILE]: sanitizeText,
    };
}

function main() {
    const check = process.argv.includes('--check');
    const files = render();
    let stale = false;
    for (const [file, text] of Object.entries(files)) {
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (check) {
            if (current !== text) {
                stale = true;
                console.error(path.relative(process.cwd(), file) + ' is out of date; run: node scripts/gen-manie-vectors.js');
            }
        } else if (current !== text) {
            fs.writeFileSync(file, text);
            console.log('rewrote ' + path.relative(process.cwd(), file));
        }
    }
    if (check && stale) process.exit(1);
    if (check) console.log('conformance vectors are up to date');
}

if (require.main === module) main();

module.exports = {render};
