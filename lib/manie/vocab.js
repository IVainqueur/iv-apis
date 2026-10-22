'use strict';

const {NEGATION_LOOKAHEAD} = require('./_negation');

const WORD_RE = /^[a-z][a-z']{0,29}$/;
const ADMIN_WORD_RE = /^[a-z]{2,30}$/;
const MAX_VARIANTS = 16;

function normalizeVocabWord(word) {
    if (typeof word !== 'string') return null;
    const w = word.trim().toLowerCase().replace(/^'+/, '');
    return WORD_RE.test(w) ? w : null;
}

function normalizeAdminWord(word) {
    if (typeof word !== 'string') return null;
    const w = word.trim().toLowerCase();
    return ADMIN_WORD_RE.test(w) ? w : null;
}

function literalWordsOfRegexSource(rawSrc) {
    const out = [];
    const seen = new Set();
    if (typeof rawSrc !== 'string') return out;
    // The generated name-slot guard lists words the message must NOT contain; they are not text
    // that the pattern reads, so they say nothing about the vocabulary.
    const src = rawSrc.split(NEGATION_LOOKAHEAD).join('');

    let variants = [''];
    const flush = () => {
        for (const v of variants) {
            const w = normalizeVocabWord(v);
            if (w && !seen.has(w)) {
                seen.add(w);
                out.push(w);
            }
        }
        variants = [''];
    };

    const quantifierIsOptional = idx => {
        const c = src[idx];
        if (c === '?' || c === '*') return true;
        if (c === '{') {
            const m = /^\{(\d+)(?:,\d*)?\}/.exec(src.slice(idx, idx + 16));
            return !!m && Number(m[1]) === 0;
        }
        return false;
    };

    const n = src.length;
    let i = 0;
    while (i < n) {
        const c = src[i];

        if (c === '\\') {
            const next = src[i + 1];
            flush();
            if (next === 'u') i += 6;
            else if (next === 'x') i += 4;
            else if (next === 'c') i += 3;
            else if ((next === 'p' || next === 'P') && src[i + 2] === '{') {
                const end = src.indexOf('}', i + 3);
                i = end === -1 ? n : end + 1;
            } else if (next === 'k' && src[i + 2] === '<') {
                const end = src.indexOf('>', i + 3);
                i = end === -1 ? n : end + 1;
            } else {
                i += 2;
            }
            continue;
        }

        if (c === '[') {
            flush();
            let j = i + 1;
            while (j < n && src[j] !== ']') {
                if (src[j] === '\\') j++;
                j++;
            }
            i = j + 1;
            continue;
        }

        if (c === '(' && src.startsWith('(?:', i)) {
            const end = src.indexOf(')', i + 3);
            const inner = end === -1 ? '' : src.slice(i + 3, end);
            if (/^[A-Za-z']+(?:\|[A-Za-z']+)*$/.test(inner)) {
                const alts = inner.split('|');
                const combos = [];
                for (const v of variants) for (const a of alts) combos.push(v + a);
                const next = quantifierIsOptional(end + 1) ? variants.concat(combos) : combos;
                if (next.length <= MAX_VARIANTS) {
                    variants = next;
                    i = end + 1;
                    continue;
                }
            }
        }

        if (c === '(') {
            flush();
            i += 1;
            if (src[i] === '?') {
                if (src[i + 1] === ':' || src[i + 1] === '=' || src[i + 1] === '!') i += 2;
                else if (src[i + 1] === '<' && (src[i + 2] === '=' || src[i + 2] === '!')) i += 3;
                else if (src[i + 1] === '<') {
                    const end = src.indexOf('>', i + 2);
                    i = end === -1 ? n : end + 1;
                } else i += 1;
            }
            continue;
        }

        if (/[A-Za-z']/.test(c)) {
            if (quantifierIsOptional(i + 1)) {
                if (variants.length * 2 <= MAX_VARIANTS) {
                    variants = variants.concat(variants.map(v => v + c));
                }
            } else {
                variants = variants.map(v => v + c);
            }
            i += 1;
            continue;
        }

        if (c === '*' || c === '+' || c === '?') {
            i += 1;
            continue;
        }

        if (c === '{' && /^\{\d+(?:,\d*)?\}/.test(src.slice(i, i + 16))) {
            i += src.slice(i).indexOf('}') + 1;
            continue;
        }

        flush();
        i += 1;
    }
    flush();
    return out;
}

function buildVocabulary({seed, patterns, adminWords} = {}) {
    const vocab = new Set();
    for (const w of Array.isArray(seed) ? seed : []) {
        const word = normalizeVocabWord(w);
        if (word) vocab.add(word);
    }
    for (const p of Array.isArray(patterns) ? patterns : []) {
        if (!p || typeof p.pattern !== 'string') continue;
        for (const w of literalWordsOfRegexSource(p.pattern)) vocab.add(w);
    }
    for (const w of Array.isArray(adminWords) ? adminWords : []) {
        const word = normalizeAdminWord(w);
        if (word) vocab.add(word);
    }
    return vocab;
}

module.exports = {
    WORD_RE,
    ADMIN_WORD_RE,
    buildVocabulary,
    literalWordsOfRegexSource,
    normalizeVocabWord,
    normalizeAdminWord,
};
