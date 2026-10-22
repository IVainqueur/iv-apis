'use strict';

// Reference implementation of the on-device anonymizer (SPEC section 1). The
// app's TypeScript port must reproduce anonymize() byte-for-byte; the
// conformance suite is test/manie/vectors/anonymize-vectors.json.
//
// Pipeline: tokenize (one regex, first alternative wins) -> collapse
// whitespace -> merge spaced/hyphenated digit groups into {PH} -> keep only
// vocabulary words -> collapse unknown-word runs into {W+} -> trim.
// Digits never survive; non-ASCII and alphanumeric words are always unknown;
// characters outside the allowed set become a space.

const crypto = require('crypto');
const {
    isNameLike,
    isCollisionWord,
    NAME_CUE_SET,
    NAME_EDGE_SET,
    NAME_GREETING_SET,
    NAME_SOLE_CUE_SET,
    NAME_SOLE_TERMINATOR_SET,
} = require('./_names');

const MAX_SKELETON_LENGTH = 400;
const MAX_INPUT_CHARS = 2000;
const PLACEHOLDER_KINDS = ['N', 'PH', 'TS', 'TID', 'URL', 'EMAIL', 'W', 'W+'];
const HINTABLE_KINDS = new Set(['N', 'PH', 'W', 'W+']);
const PH_MIN_DIGITS = 9;
const MAX_PHONE_GROUPS = 8;
const KEPT_PUNCT = new Set(['.', ',', ':', ';', '(', ')', '-', "'", '/', '!', '?', '%', '@', '#', '&', '*', '_', '=', '[', ']', '"', '+']);

const ci = word =>
    word
        .split('')
        .map(ch => '[' + ch.toLowerCase() + ch.toUpperCase() + ']')
        .join('');

const TLDS = [
    'com', 'net', 'org', 'info', 'biz', 'edu', 'gov', 'int', 'rw', 'ug', 'ke', 'tz', 'bi', 'cd',
    'co', 'io', 'me', 'ly', 'app', 'dev', 'xyz', 'link', 'site', 'online', 'top', 'club', 'shop',
    'store', 'page', 'ai', 'tv', 'cc', 'mobi', 'africa',
]
    .map(ci)
    .join('|');
const URL_TAIL = '[^\\s]*[^\\s.,;:!?)\\]"\'>]';
const SRC_EMAIL = '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)+';
const SRC_URL =
    '(?:(?:' + ci('http') + '[Ss]?|' + ci('ftp') + ')://|' + ci('www') + '\\.)' + URL_TAIL +
    '|(?:[A-Za-z0-9\\-]+\\.)+(?:' + TLDS + ')(?![A-Za-z0-9\\-])(?:[/?#]' + URL_TAIL + ')?';
const SRC_TS = '\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:Z|[+\\-]\\d{2}:?\\d{2})?';
const SRC_TID = '[A-Za-z]{2}\\d+\\.\\d+\\.[A-Za-z]\\d+';
const SRC_RWF_GLUE = ci('rwf') + '(?=\\d)';
const SRC_NUM = '\\d+(?:[.,]\\d+)*';
const SRC_WORD = "(?:[A-Za-z]|[^\\s\\x00-\\x7F])(?:[A-Za-z0-9']|[^\\s\\x00-\\x7F])*";

const TOKEN_KINDS = ['email', 'url', 'ts', 'tid', 'word', 'num', 'word', 'space', 'other'];
const TOKEN_RE = new RegExp(
    [SRC_EMAIL, SRC_URL, SRC_TS, SRC_TID, SRC_RWF_GLUE, SRC_NUM, SRC_WORD, '\\s+', '[\\s\\S]']
        .map(src => '(' + src + ')')
        .join('|'),
    'g',
);

const vocabCache = new WeakMap();

function toVocabSet(vocab) {
    if (vocab instanceof Set) return vocab;
    if (Array.isArray(vocab)) {
        let set = vocabCache.get(vocab);
        if (!set) {
            set = new Set(vocab.filter(w => typeof w === 'string').map(w => w.toLowerCase()));
            vocabCache.set(vocab, set);
        }
        return set;
    }
    return new Set();
}

function tokenize(body) {
    const tokens = [];
    for (const m of body.matchAll(TOKEN_RE)) {
        let kind = null;
        for (let g = 0; g < TOKEN_KINDS.length; g++) {
            if (m[g + 1] !== undefined) {
                kind = TOKEN_KINDS[g];
                break;
            }
        }
        const text = m[0];
        if (kind === 'other') kind = KEPT_PUNCT.has(text) ? 'punct' : 'space';
        tokens.push({kind, text, start: m.index, end: m.index + text.length});
    }
    return tokens;
}

function collapseSpaces(tokens) {
    const out = [];
    for (const t of tokens) {
        const last = out[out.length - 1];
        if (t.kind === 'space') {
            if (last && last.kind === 'space') last.end = t.end;
            else out.push({kind: 'space', text: ' ', start: t.start, end: t.end});
        } else {
            out.push(t);
        }
    }
    return out;
}

function digitCount(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] >= '0' && text[i] <= '9') n++;
    }
    return n;
}

const isPlainGroup = t => t && t.kind === 'num' && /^\d{1,7}$/.test(t.text);
const isSeparator = t => t && (t.kind === 'space' || (t.kind === 'punct' && t.text === '-'));

function mergePhoneRuns(tokens) {
    const out = [];
    let i = 0;
    while (i < tokens.length) {
        const t = tokens[i];
        if (isPlainGroup(t)) {
            let j = i;
            let groups = 1;
            let total = t.text.length;
            let sep = null;
            while (groups < MAX_PHONE_GROUPS) {
                const s = tokens[j + 1];
                const next = tokens[j + 2];
                if (!isSeparator(s) || !isPlainGroup(next)) break;
                if (sep !== null && sep !== s.text) break;
                sep = s.text;
                total += next.text.length;
                groups++;
                j += 2;
            }
            if (groups >= 2 && total >= PH_MIN_DIGITS) {
                out.push({kind: 'ph', text: '', start: t.start, end: tokens[j].end});
                i = j + 1;
                continue;
            }
        }
        out.push(t);
        i++;
    }
    return out;
}

function isWordLiteral(text, vocab) {
    return /^[A-Za-z][A-Za-z']*$/.test(text) && vocab.has(text.toLowerCase());
}

function toItems(tokens, vocab) {
    const items = [];
    for (const t of tokens) {
        switch (t.kind) {
            case 'space':
                items.push({k: 'sp'});
                break;
            case 'punct':
                items.push({k: 'lit', text: t.text, start: t.start, end: t.end});
                break;
            case 'word':
                if (isWordLiteral(t.text, vocab)) items.push({k: 'lit', text: t.text, start: t.start, end: t.end});
                else items.push({k: 'unk', start: t.start, end: t.end});
                break;
            case 'num':
                items.push({k: 'ph', kind: digitCount(t.text) >= PH_MIN_DIGITS ? 'PH' : 'N', start: t.start, end: t.end});
                break;
            case 'ph':
                items.push({k: 'ph', kind: 'PH', start: t.start, end: t.end});
                break;
            case 'ts':
                items.push({k: 'ph', kind: 'TS', start: t.start, end: t.end});
                break;
            case 'tid':
                items.push({k: 'ph', kind: 'TID', start: t.start, end: t.end});
                break;
            case 'url':
                items.push({k: 'ph', kind: 'URL', start: t.start, end: t.end});
                break;
            case 'email':
                items.push({k: 'ph', kind: 'EMAIL', start: t.start, end: t.end});
                break;
            default:
                items.push({k: 'sp'});
        }
    }
    return items;
}

function consumeLeadingPlus(items) {
    for (let i = 1; i < items.length; i++) {
        const it = items[i];
        const prev = items[i - 1];
        if (it.k === 'ph' && it.kind === 'PH' && prev.k === 'lit' && prev.text === '+' && prev.end === it.start) {
            it.start = prev.start;
            prev.k = 'gone';
        }
    }
    return items.filter(it => it.k !== 'gone');
}

const isWordText = text => /^[A-Za-z][A-Za-z']*$/.test(text);
const isGap = it => !!it && (it.k === 'sp' || (it.k === 'lit' && (it.text === '.' || it.text === '-')));

function nearUnknown(items, index, dir) {
    let j = index + dir;
    let steps = 0;
    while (isGap(items[j]) && steps < 3) {
        j += dir;
        steps++;
    }
    return !!items[j] && items[j].k === 'unk';
}

// "a" is the article far more often than an initial, so it only joins a name next to an
// unknown word.
const isInitial = text => text.length === 1 && text.toLowerCase() !== 'a';

function isNameWord(it) {
    return !!it && it.k === 'lit' && isWordText(it.text) && (isNameLike(it.text) || isInitial(it.text));
}

function adjacentNameLike(items, index) {
    for (const dir of [-1, 1]) {
        const gap = items[index + dir];
        if (gap && gap.k === 'sp' && isNameWord(items[index + 2 * dir])) return true;
    }
    return false;
}

const nextIndex = (items, index) => (items[index + 1] && items[index + 1].k === 'sp' ? index + 2 : index + 1);
const prevIndex = (items, index) => (items[index - 1] && items[index - 1].k === 'sp' ? index - 2 : index - 1);

// A placeholder, or a delimiter that frames a name, right after (dir 1: also before
// a placeholder) or right before (dir -1) the word.
function nameEdgeNext(items, index, dir) {
    let j = index + dir;
    if (items[j] && items[j].k === 'sp') j += dir;
    const other = items[j];
    return !!other && ((dir > 0 && other.k === 'ph') || (other.k === 'lit' && NAME_EDGE_SET.has(other.text)));
}

function followsWordIn(items, index, set) {
    const gap = items[index - 1];
    const cue = items[index - 2];
    return !!gap && gap.k === 'sp' && !!cue && cue.k === 'lit' && isWordText(cue.text) && set.has(cue.text.toLowerCase());
}

// "kanda *182*8*1#" tells the reader to dial a USSD code, it does not name anyone. A
// masked number ("Neza *****123") is not a code: a code is stars and digits closed by #.
function beforeShortcode(items, index) {
    let j = index + 1;
    if (items[j] && items[j].k === 'sp') j++;
    for (;;) {
        const star = items[j];
        const digits = items[j + 1];
        if (!star || star.k !== 'lit' || star.text !== '*' || !digits || digits.k !== 'ph' || (digits.kind !== 'N' && digits.kind !== 'PH')) return false;
        const after = items[j + 2];
        if (after && after.k === 'lit' && after.text === '#') return true;
        j += 2;
    }
}

function inNamePosition(items, index) {
    return (
        followsWordIn(items, index, NAME_CUE_SET) ||
        followsWordIn(items, index, NAME_GREETING_SET) ||
        (!beforeShortcode(items, index) && (nameEdgeNext(items, index, -1) || nameEdgeNext(items, index, 1)))
    );
}

// The word is directly followed by a phone number, with or without a parenthesis.
function beforePhone(items, index) {
    let j = nextIndex(items, index);
    if (items[j] && items[j].k === 'lit' && items[j].text === '(') {
        j++;
        if (items[j] && items[j].k === 'sp') j++;
    }
    return !!items[j] && items[j].k === 'ph' && items[j].kind === 'PH';
}

// The word starts a name that ends at a phone number: only spaces, unknown words,
// full stops and hyphens lie between them ("Merchant Uwase(0788...)").
function beforeNameAndPhone(items, index) {
    let j = index + 1;
    while (items[j] && (items[j].k === 'sp' || items[j].k === 'unk' || (items[j].k === 'lit' && (items[j].text === '.' || items[j].text === '-')))) j++;
    if (items[j] && items[j].k === 'lit' && items[j].text === '(') {
        j++;
        if (items[j] && items[j].k === 'sp') j++;
    }
    return !!items[j] && items[j].k === 'ph' && items[j].kind === 'PH';
}

function previousWord(items, index) {
    const prev = items[prevIndex(items, index)];
    return prev && prev.k === 'lit' && isWordText(prev.text) ? prev.text.toLowerCase() : null;
}

// Words that are real template text elsewhere ("kuri MoMo advance", "Fake Merchant
// Ltd") stop being literal only where a name sits: at the start of a name that ends at
// a phone number, right after a greeting, or as the only word between a preposition and
// the end of the clause.
function collisionInNamePosition(items, index) {
    if (beforeNameAndPhone(items, index)) return true;
    const prev = previousWord(items, index);
    if (prev === null) return false;
    if (NAME_GREETING_SET.has(prev)) return true;
    if (NAME_SOLE_CUE_SET.has(prev)) {
        const next = items[nextIndex(items, index)];
        return !next || (next.k === 'lit' && NAME_SOLE_TERMINATOR_SET.has(next.text));
    }
    return false;
}

// An initial stands where a name is: before a phone number, or between a preposition
// or greeting and the end of the clause ("Dear S,", "to A. R.").
function initialInNamePosition(items, index) {
    if (beforePhone(items, index)) return true;
    const prev = previousWord(items, index);
    if (prev === null || !(NAME_CUE_SET.has(prev) || NAME_GREETING_SET.has(prev))) return false;
    if (items[index].text.toLowerCase() === 'a') return false;
    const next = items[nextIndex(items, index)];
    return !next || (next.k === 'lit' && (next.text === '.' || NAME_EDGE_SET.has(next.text)));
}

// A vocabulary word that doubles as a given name (see _names.js), or a single letter
// (an initial), stops being literal as soon as it sits next to an unknown word or next
// to another such word: "to Will Uwase" must not keep "Will". A stoplist word also stops
// being literal after a cue word ("to", "from", ...) or greeting, before a placeholder
// ("Neza {PH}") and beside any punctuation but "." and "-", unless it introduces a dial
// code ("kanda *182#") and no cue word precedes it; after a placeholder it is template
// text ("{PH} neza."). Collision words and initials follow the positional rules above.
// Every condition only gets easier to meet when a neighbour is absorbed, so repeating
// the pass reaches one fixpoint (the app port reaches it with a worklist).
function absorbNameLike(items) {
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.k !== 'lit' || !isWordText(it.text)) continue;
            const single = it.text.length === 1;
            const nameLike = isNameLike(it.text);
            const collision = !single && !nameLike && isCollisionWord(it.text);
            if (!single && !nameLike && !collision) continue;
            let absorb;
            if (collision) {
                absorb = collisionInNamePosition(items, i);
            } else {
                absorb = nearUnknown(items, i, -1) || nearUnknown(items, i, 1);
                if (!absorb && (nameLike || isInitial(it.text))) absorb = adjacentNameLike(items, i);
                if (!absorb && single) absorb = initialInNamePosition(items, i);
                if (!absorb && nameLike) absorb = inNamePosition(items, i);
            }
            if (absorb) {
                items[i] = {k: 'unk', kind: 'W', start: it.start, end: it.end, orig: null};
                changed = true;
            }
        }
    }
    return items;
}

function anonymize(body, vocab) {
    const empty = {skeleton: '', slots: []};
    if (typeof body !== 'string' || body.length === 0 || body.length > MAX_INPUT_CHARS) return empty;
    const vocabSet = toVocabSet(vocab);

    const tokens = mergePhoneRuns(collapseSpaces(tokenize(body)));
    const items = absorbNameLike(consumeLeadingPlus(toItems(tokens, vocabSet)));

    while (items.length && items[0].k === 'sp') items.shift();
    while (items.length && items[items.length - 1].k === 'sp') items.pop();

    let skeleton = '';
    const slots = [];
    let hintIndex = 0;
    const emit = (kind, start, end) => {
        skeleton += '{' + kind + '}';
        const hintable = HINTABLE_KINDS.has(kind);
        if (hintable) hintIndex++;
        slots.push({kind, index: hintable ? hintIndex : 0, start, end});
    };

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.k === 'sp') skeleton += ' ';
        else if (it.k === 'lit') skeleton += it.text;
        else if (it.k === 'ph') emit(it.kind, it.start, it.end);
        else {
            let j = i;
            let count = 1;
            while (items[j + 1] && items[j + 1].k === 'sp' && items[j + 2] && items[j + 2].k === 'unk') {
                j += 2;
                count++;
            }
            emit(count > 1 ? 'W+' : 'W', it.start, items[j].end);
            i = j;
        }
    }
    return {skeleton, slots};
}

const CHAR_GUARD_RE = /[^A-Za-z{}+ .,:;()\-'\/!?%@#&*_=\[\]"]/;
const SKELETON_TOKEN_RE = /\{(?:N|PH|TS|TID|URL|EMAIL|W\+|W)\}|[A-Za-z][A-Za-z']*|[\s\S]/g;
const PLACEHOLDER_RE = /^\{(?:N|PH|TS|TID|URL|EMAIL|W\+|W)\}$/;

function sanitizeSkeletonDetailed(skeleton, vocab) {
    if (typeof skeleton !== 'string') return {ok: false, reason: 'not_string'};
    if (skeleton.length === 0) return {ok: false, reason: 'empty'};
    if (skeleton.length > MAX_SKELETON_LENGTH) return {ok: false, reason: 'too_long'};
    if (/[0-9]/.test(skeleton)) return {ok: false, reason: 'digit'};
    if (CHAR_GUARD_RE.test(skeleton)) return {ok: false, reason: 'bad_char'};
    const vocabSet = toVocabSet(vocab);

    let items = [];
    let origCount = 0;
    for (const m of skeleton.matchAll(SKELETON_TOKEN_RE)) {
        const text = m[0];
        if (PLACEHOLDER_RE.test(text)) {
            const kind = text.slice(1, -1);
            const orig = HINTABLE_KINDS.has(kind) ? ++origCount : null;
            items.push(kind === 'W' || kind === 'W+' ? {k: 'unk', kind, orig} : {k: 'ph', kind, orig});
        } else if (text === '{' || text === '}') {
            return {ok: false, reason: 'bad_placeholder'};
        } else if (/^[A-Za-z]/.test(text)) {
            if (vocabSet.has(text.toLowerCase())) items.push({k: 'lit', text});
            else items.push({k: 'unk', kind: 'W', orig: null});
        } else if (text === ' ') {
            if (!items.length || items[items.length - 1].k !== 'sp') items.push({k: 'sp'});
        } else {
            items.push({k: 'lit', text});
        }
    }

    while (items.length && items[0].k === 'sp') items.shift();
    while (items.length && items[items.length - 1].k === 'sp') items.pop();
    items = absorbNameLike(items);

    let out = '';
    let slotCount = 0;
    let placeholderCount = 0;
    const slotMap = new Array(origCount).fill(null);
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.k === 'sp') out += ' ';
        else if (it.k === 'lit') out += it.text;
        else if (it.k === 'ph') {
            out += '{' + it.kind + '}';
            placeholderCount++;
            if (HINTABLE_KINDS.has(it.kind)) {
                slotCount++;
                if (it.orig) slotMap[it.orig - 1] = slotCount;
            }
        } else {
            let j = i;
            let count = 1;
            while (items[j + 1] && items[j + 1].k === 'sp' && items[j + 2] && items[j + 2].k === 'unk') {
                j += 2;
                count++;
            }
            const kind = count > 1 ? 'W+' : it.kind;
            out += '{' + kind + '}';
            placeholderCount++;
            slotCount++;
            if (count === 1 && it.orig && kind === it.kind) slotMap[it.orig - 1] = slotCount;
            i = j;
        }
    }

    if (out.length === 0) return {ok: false, reason: 'empty'};
    if (out.length > MAX_SKELETON_LENGTH) return {ok: false, reason: 'too_long'};
    return {ok: true, skeleton: out, slotCount, placeholderCount, slotMap};
}

function sanitizeSkeleton(skeleton, vocab) {
    const res = sanitizeSkeletonDetailed(skeleton, vocab);
    if (!res.ok) return res;
    return {ok: true, skeleton: res.skeleton, slotCount: res.slotCount, placeholderCount: res.placeholderCount};
}

// Case-folds literal words so that "RECEIVED Balance" and "received balance" are
// one shape. Placeholders keep their spelling.
function canonicalSkeleton(skeleton) {
    return skeleton.replace(/\{(?:N|PH|TS|TID|URL|EMAIL|W\+|W)\}|[A-Za-z][A-Za-z']*/g, m => (m[0] === '{' ? m : m.toLowerCase()));
}

// A shape is a skeleton as one carrier's devices send it: the same words from MTN and
// from Airtel are two shapes, so that whoever submits a skeleton first cannot decide
// the carrier of the people who really receive it. Without a carrier the id is the hash
// of the skeleton alone.
function shapeId(skeleton, carrier) {
    if (typeof skeleton !== 'string') throw new TypeError('skeleton must be a string');
    const material = typeof carrier === 'string' && carrier ? `${carrier}\n${skeleton}` : skeleton;
    return crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

module.exports = {
    anonymize,
    sanitizeSkeleton,
    sanitizeSkeletonDetailed,
    canonicalSkeleton,
    shapeId,
    MAX_SKELETON_LENGTH,
    MAX_INPUT_CHARS,
    PLACEHOLDER_KINDS,
    HINTABLE_KINDS,
};
