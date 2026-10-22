#!/usr/bin/env node
'use strict';

// Differential fuzz of the server reference anonymizer (lib/manie/anonymize.js) against the
// on-device port (the app's src/lib/utils/anonymize.ts), over synthetic messages only.
//
//   node scripts/manie-anonymize-fuzz.js [--n 210000] [--chars 150000] [--seed 20261022]
//                                        [--out /tmp/anon-port] [--dev <compiled.js>] [--api <dir>] [--examples]
//
//   --out   where the app's TypeScript compiles the port to (the app checkout is read-only)
//   --dev   an already compiled port to measure instead of compiling the app's anonymize.ts
//   --api   a directory holding another copy of anonymize.js + _names.js, to measure it instead
//           of the one in lib/manie (before/after comparisons)
//
// A PRIVACY divergence is a literal word that the reference keeps where the device port hid
// it. The run exits 1 if there is any. Cases where the reference hides MORE than the device
// are counted, not failed: it means the device port lags the reference.

const fs = require('node:fs');
const path = require('node:path');
const {runMessageFuzz, runCharFuzz, compileDevicePort} = require('../test/manie/_anonFuzz');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? dflt : args[i + 1];
};

const n = Number(opt('n', 210000));
const chars = Number(opt('chars', 150000));
const seed = Number(opt('seed', 20261022));
const out = opt('out', '/tmp/anon-port');
const apiDir = path.resolve(opt('api', path.join(__dirname, '..', 'lib', 'manie')));
const withExamples = args.includes('--examples');

let compiled;
if (opt('dev', null)) {
    compiled = {file: path.resolve(opt('dev', null))};
} else {
    fs.mkdirSync(out, {recursive: true});
    compiled = compileDevicePort(out);
}
if (!compiled.file) {
    console.error(`cannot build the device port: ${compiled.reason}`);
    process.exit(2);
}

const api = require(path.join(apiDir, 'anonymize.js'));
const names = require(path.join(apiDir, '_names.js'));
const dev = require(compiled.file);

const started = Date.now();
const messages = runMessageFuzz({api, dev, names, n, seed});
const strings = runCharFuzz({api, dev, names, n: chars, seed: seed + 1});

const summary = tally => {
    const {examplesPrivacy, examplesApiStricter, examplesOther, ...counts} = tally;
    return withExamples ? {...counts, examplesPrivacy, examplesApiStricter, examplesOther} : {...counts, examplesPrivacy};
};

const report = {
    reference: apiDir,
    devicePort: compiled.file,
    seed,
    ms: Date.now() - started,
    messages: {count: messages.messages, anonymize: summary(messages.anonymize), sanitizeSkeleton: summary(messages.sanitize)},
    strings: {count: strings.strings, anonymize: summary(strings.anonymize), sanitizeSkeleton: summary(strings.sanitize)},
};
console.log(JSON.stringify(report, null, 2));

const privacy = messages.anonymize.privacy + messages.sanitize.privacy + strings.anonymize.privacy + strings.sanitize.privacy;
if (privacy > 0) {
    console.error(`${privacy} PRIVACY divergence(s): the reference keeps a literal word that the device port replaces`);
    process.exit(1);
}
