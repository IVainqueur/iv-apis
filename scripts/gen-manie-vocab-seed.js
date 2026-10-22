#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {literalWordsOfRegexSource, normalizeVocabWord} = require('../lib/manie/vocab');
const {NOISE_WORDS} = require('../lib/manie/noise');
const {KEYWORD_WORDS} = require('../lib/manie/_fields');
const {EXTRA_VOCAB_WORDS} = require('../lib/manie/_lexicon');

const DEFAULT_APP_REPO = '/Users/ivainqueur/Documents/Code/React/mobile/Manie';
const OUT_PATH = path.join(__dirname, '..', 'assets', 'manie', 'vocab-seed.json');
const BASE_PATH = path.join(__dirname, '..', 'assets', 'manie', 'sms-formats.json');

function parseArgs(argv) {
    const args = {check: false, app: process.env.MANIE_APP_REPO || DEFAULT_APP_REPO, out: OUT_PATH};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--check') args.check = true;
        else if (argv[i] === '--app') args.app = argv[++i];
        else if (argv[i] === '--out') args.out = argv[++i];
        else throw new Error('unknown argument: ' + argv[i]);
    }
    return args;
}

function builtinSources(appRepo) {
    const {loadClassify} = require(path.join(appRepo, 'tools', 'sms-pattern-tool', 'lib', 'loadClassify.js'));
    const {classify} = loadClassify(appRepo);
    return classify.getBuiltinPatternSources().map(p => p.source);
}

function servedSources() {
    const base = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8'));
    return base.patterns.map(p => p.pattern);
}

function buildSeed(appRepo) {
    const words = new Set();
    for (const src of [...builtinSources(appRepo), ...servedSources()]) {
        for (const w of literalWordsOfRegexSource(src)) words.add(w);
    }
    for (const w of [...NOISE_WORDS, ...KEYWORD_WORDS, ...EXTRA_VOCAB_WORDS]) {
        const word = normalizeVocabWord(w);
        if (word) words.add(word);
    }
    return Array.from(words).sort();
}

function main() {
    const args = parseArgs(process.argv);
    const seed = buildSeed(args.app);
    const text = JSON.stringify(seed, null, 1) + '\n';
    if (args.check) {
        const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, 'utf8') : '';
        if (current !== text) {
            console.error('vocab-seed.json is out of date; run: node scripts/gen-manie-vocab-seed.js');
            process.exit(1);
        }
        console.log('vocab-seed.json is up to date (' + seed.length + ' words)');
        return;
    }
    fs.writeFileSync(args.out, text);
    console.log('wrote ' + seed.length + ' words to ' + path.relative(process.cwd(), args.out));
}

if (require.main === module) main();

module.exports = {buildSeed};
