'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256Hex } = require('./_shared');

const FALLBACK = 'v1';
const SOURCES = [
    ['_fields.js', 'lib'],
    ['_synth.js', 'lib'],
    ['_names.js', 'lib'],
    ['_negation.js', 'lib'],
    ['draft.js', 'lib'],
    ['gate.js', 'lib'],
    ['noise.js', 'lib'],
    ['negative-corpus.json', 'assets'],
];

// Cached drafts and gate results are only valid for the code that produced them,
// so their cache key includes a hash of that code (and of the negative corpus).
function computeVersion() {
    try {
        const parts = SOURCES.map(([file, kind]) => {
            const dir = kind === 'assets' ? path.join(__dirname, '..', '..', 'assets', 'manie') : __dirname;
            return fs.readFileSync(path.join(dir, file));
        });
        return sha256Hex(Buffer.concat(parts)).slice(0, 8);
    } catch (err) {
        return FALLBACK;
    }
}

const DRAFT_CODE_VERSION = computeVersion();

module.exports = { DRAFT_CODE_VERSION };
