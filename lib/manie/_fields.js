'use strict';

const {VALID_TYPES, CAPTURE_ROLES, HINT_ROLES, sha256Hex} = require('./_shared');
const {NEGATION_SOURCE} = require('./_negation');

const MAX_SKELETON_LENGTH = 400;

const PLACEHOLDER_SRC = '\\{(?:N|PH|TS|TID|URL|EMAIL|W\\+|W)\\}';
const ALLOWED_RESIDUE = /^[A-Za-z{}+ .,:;()\-'/!?%@#&*_=[\]"]*$/;
const TOKEN_RE = /\{(N|PH|TS|TID|URL|EMAIL|W\+|W)\}|([A-Za-z][A-Za-z']*)| |([\s\S])/g;

const TS_REGEX = '(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?(?:[Z]|[+\\-]\\d{2}:?\\d{2})?)';
// One capture group for the whole transaction code: it is the transaction id and, for the
// airtel-shortcode parser, the timestamp as well. Every build of the app reads the date
// from fixed offsets of that text (two letters, then YYMMDD.HHMM), so the date part is
// pinned to exactly that shape and to real month/day/hour/minute ranges: a code that is
// not a date never matches, instead of being read as a wrong one.
const AIRTEL_DATE_TIME = '\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\.(?:[01]\\d|2[0-3])[0-5]\\d';
const TID_REGEX = `([A-Za-z]{2}${AIRTEL_DATE_TIME}\\.[A-Za-z]\\d+)`;

// Slot regexes accept every text the anonymizer folds into the placeholder and nothing
// that two neighbouring slots could also claim:
// - a number token is digits with single separators between digit groups (bounded, so
//   that no unbounded quantifier sits inside another);
// - a phone is a number of nine digits or more, or digit groups joined by a space (any
//   run of the separator characters below) or a hyphen (mergePhoneRuns), with an
//   optional leading plus;
// - a word is what the tokenizer calls a word (letters, digits, apostrophes, non-ASCII);
// - free text refuses the words that turn a success notice into a failure notice;
// - a space stands for any run of whitespace and of the characters the anonymizer
//   turns into spaces, except next to free text, where it is one such character and
//   the rest of the run belongs to the free text: a run of separators that two
//   quantifiers could both claim makes a failed match cubic in the length of the run.
const NUMBER_REGEX = '(\\d+(?:[.,]\\d+){0,15})';
const PHONE_REGEX = '(\\+?\\d+(?:(?:[.,\\-]|[\\s|~<>$^\\\\`{}]+)\\d+){0,11})';
const WORD_REGEX = "((?:[A-Za-z]|[^\\s\\x00-\\x7f])(?:[A-Za-z0-9']|[^\\s\\x00-\\x7f])*)";
const SEPARATOR_CLASS = '[\\s|~<>$^\\\\`{}]';
const SEPARATOR_REGEX = `${SEPARATOR_CLASS}+`;
// "any character" is spelled [\s\S], not [^]: an empty negated class does not compile in the
// ICU engine behind NSRegularExpression, so the iOS app would silently drop every pattern that has
// a free-text slot. [\s\S] means the same in V8, Hermes and ICU.
const FREE_TEXT_STEP = `(?:(?!${NEGATION_SOURCE})[\\s\\S])`;

const FEE_WORDS = new Set(['fee', 'fees', 'charge', 'charges', 'icyiciro', 'ikiguzi']);
const BALANCE_WORDS = new Set(['balance', 'bal', 'musigaranye', 'asigaye', 'mufite', 'ufite']);
const AMOUNT_WORDS = new Set(['amt', 'amount']);
const TXN_WORDS = new Set(['txid', 'txnid', 'tid', 'transactionid']);
const NOT_MONEY_WORDS = new Set(['code', 'kode', 'ref', 'reference', 'no', 'number']);
const NOT_ACCOUNT_WORDS = new Set(['id', 'ref', 'reference', 'token', 'code', 'kode', 'otp', 'pin']);

const TYPE_KEYWORDS = [
    ['transfer', new Set(['transferred', 'transfer', 'sent', 'kohereza'])],
    ['receive', new Set(['received', 'receive', 'mwakiriye', 'wakiriye', 'yakiriye'])],
    ['withdraw', new Set(['withdrawn', 'withdraw', 'withdrawal', 'kubikuza'])],
    ['deposit', new Set(['deposit', 'deposited', 'kubitsa'])],
    ['payment', new Set(['payment', 'paid', 'pay', 'purchase', 'bought', 'kwishyura', 'kugura', 'mwakoresheje'])],
];
const WEAK_PAYMENT_WORDS = new Set(['transaction', 'airtime', 'bundle']);

const NAME_PREPOSITIONS = new Set(['to', 'from', 'by', 'via', 'at', 'with', 'kuri', 'avuye', 'agent', 'merchant', 'receiver', 'sender']);

const KINYARWANDA_WORDS = new Set([
    'kohereza', 'mwakiriye', 'wakiriye', 'kwishyura', 'kugura', 'byagenze', 'byakunze', 'avuye', 'musigaranye',
    'asigaye', 'mufite', 'ufite', 'kuri', 'ubu', 'konti', 'byemeye', 'ikiguzi', 'neza', 'inite',
]);

const KEYWORD_WORDS = Array.from(
    new Set(
        [
            FEE_WORDS, BALANCE_WORDS, AMOUNT_WORDS, TXN_WORDS, NOT_MONEY_WORDS, NOT_ACCOUNT_WORDS, WEAK_PAYMENT_WORDS,
            NAME_PREPOSITIONS, KINYARWANDA_WORDS, ...TYPE_KEYWORDS.map(([, words]) => words),
            new Set(['tx', 'txn', 'transaction', 'financial', 'id', 'kr', 'en']),
        ].flatMap(set => Array.from(set)),
    ),
).sort();

function sha256Hex16(text) {
    return sha256Hex(text).slice(0, 16);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeSkeleton(skeleton) {
    if (typeof skeleton !== 'string' || skeleton.length === 0) {
        return {ok: false, reason: 'skeleton must be a non-empty string'};
    }
    if (skeleton.length > MAX_SKELETON_LENGTH) {
        return {ok: false, reason: `skeleton longer than ${MAX_SKELETON_LENGTH} characters`};
    }
    const residue = skeleton.replace(new RegExp(PLACEHOLDER_SRC, 'g'), '');
    if (/\d/.test(residue)) return {ok: false, reason: 'digit outside a placeholder'};
    if (!ALLOWED_RESIDUE.test(residue)) return {ok: false, reason: 'character outside the allowed set'};

    const tokens = [];
    let ordinal = 0;
    let slotNo = 0;
    for (const m of skeleton.matchAll(TOKEN_RE)) {
        if (m[1] !== undefined) {
            const kind = m[1];
            const numericOrWord = kind === 'N' || kind === 'PH' || kind === 'W' || kind === 'W+';
            tokens.push({type: 'ph', kind, ordinal: ordinal++, slotNo: numericOrWord ? ++slotNo : null});
        } else if (m[2] !== undefined) {
            tokens.push({type: 'word', text: m[2]});
        } else if (m[0] === ' ') {
            tokens.push({type: 'space'});
        } else {
            tokens.push({type: 'punct', text: m[0]});
        }
    }
    return {ok: true, tokens};
}

function normalizeTokens(tokens) {
    const out = [];
    for (const t of tokens) {
        if (t.type === 'space' && (out.length === 0 || out[out.length - 1].type === 'space')) continue;
        out.push(t);
    }
    while (out.length && out[out.length - 1].type === 'space') out.pop();
    return out;
}

function tokensToSkeleton(tokens) {
    return tokens
        .map(t => (t.type === 'ph' ? `{${t.kind}}` : t.type === 'space' ? ' ' : t.text))
        .join('');
}

function computeLayout(tokens) {
    let group = 0;
    const slots = [];
    tokens.forEach((t, index) => {
        if (t.type !== 'ph') return;
        const slot = {index, ordinal: t.ordinal, slotNo: t.slotNo, kind: t.kind, group: null};
        if (t.kind !== 'URL' && t.kind !== 'EMAIL') slot.group = ++group;
        slots.push(slot);
    });
    return {slots, groupCount: group};
}

function layoutOf(skeleton) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return null;
    return computeLayout(normalizeTokens(parsed.tokens));
}

function wordTokens(tokens) {
    return tokens.filter(t => t.type === 'word').map(t => t.text.toLowerCase());
}

// Participles and Kinyarwanda verbs name the event itself; the bare nouns ("transfer
// of", "payment received") are usually just a label for it.
const VERB_TYPE_WORDS = new Set([
    'transferred', 'sent', 'received', 'withdrawn', 'deposited', 'paid', 'bought', 'kohereza', 'mwakiriye', 'wakiriye',
    'yakiriye', 'kubikuza', 'kubitsa', 'kwishyura', 'kugura', 'mwakoresheje',
]);
const TYPE_DIRECTION = {transfer: 'out', receive: 'in', payment: 'out', withdraw: 'out', deposit: 'in'};
const TYPE_SPECIFICITY = {withdraw: 3, deposit: 3, receive: 2, transfer: 1, payment: 1};
const DIRECTION_PREPOSITIONS = new Set(['from', 'to', 'by', 'kuri', 'avuye']);
const INCOMING_VERBS = new Set(['sent', 'paid', 'transferred']);

function wordIndexes(tokens) {
    const out = [];
    tokens.forEach((t, i) => {
        if (t.type === 'word') out.push({word: t.text.toLowerCase(), index: i});
    });
    return out;
}

function nextWords(tokens, index, count) {
    const out = [];
    for (let i = index + 1; i < tokens.length && out.length < count; i++) {
        const t = tokens[i];
        if (t.type === 'space') continue;
        if (t.type !== 'word') break;
        out.push(t.text.toLowerCase());
    }
    return out;
}

function prevWord(tokens, index) {
    for (let i = index - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t.type === 'space') continue;
        return t.type === 'word' ? t.text.toLowerCase() : null;
    }
    return null;
}

function hasAirtelReceivedMarker(tokens) {
    for (let i = 0; i + 2 < tokens.length; i++) {
        const [a, b, c] = [tokens[i], tokens[i + 1], tokens[i + 2]];
        if (a.type === 'punct' && a.text === '*' && b.type === 'word' && c.type === 'punct' && c.text === '*' && b.text.toLowerCase() === 'r') return true;
    }
    return false;
}

const PASSIVE_VERBS = new Set(['sent', 'transferred', 'credited', 'paid', 'deposited']);
const PASSIVE_AUXILIARIES = new Set(['been', 'was', 'were', 'got']);
const NAME_SLOT_KINDS = new Set(['W', 'W+', 'PH']);

function isNameSlot(token) {
    return !!token && token.type === 'ph' && NAME_SLOT_KINDS.has(token.kind);
}

// Wordings that say the money came to the customer although the type keyword is an outgoing
// one ("been sent ... by", "transfer ... to your account", "credited"). `strong` cues name the
// direction; `passive` ones ("has been transferred") are only suspicious, since the sender's own
// receipt reads the same unless a name follows "to".
function incomingCues(tokens, type) {
    const strong = [];
    const passive = [];
    const add = (list, text) => {
        if (!list.includes(text)) list.push(text);
    };
    const hasPassiveVerb = tokens.some((t, i) => t.type === 'word' && PASSIVE_VERBS.has(t.text.toLowerCase()) && PASSIVE_AUXILIARIES.has(prevWord(tokens, i)));
    const toName = tokens.some((t, i) => t.type === 'word' && ['to', 'kuri'].includes(t.text.toLowerCase()) && isNameSlot(neighbour(tokens, i, 1)));
    tokens.forEach((t, index) => {
        if (t.type !== 'word') return;
        const word = t.text.toLowerCase();
        const next = neighbour(tokens, index, 1);
        const nextWord = next && next.type === 'word' ? next.text.toLowerCase() : null;
        if (word === 'credited') add(strong, '"credited" says the money was added to an account');
        else if (word === 'to' && (nextWord === 'your' || nextWord === 'you')) add(strong, `"to ${nextWord}" says the money came to the customer`);
        else if (word === 'by' && isNameSlot(next) && hasPassiveVerb) add(strong, '"by" a name after a passive verb says someone else sent the money');
        else if (type !== 'withdraw' && (word === 'avuye' || word === 'yavuye' || (word === 'from' && isNameSlot(next)))) {
            add(strong, `"${word}" a name says the money came from that person`);
        } else if (PASSIVE_VERBS.has(word) && PASSIVE_AUXILIARIES.has(prevWord(tokens, index)) && !toName) {
            add(passive, `"${prevWord(tokens, index)} ${word}" can mean the money came in`);
        }
    });
    return {strong, passive};
}

function withIncomingCues(tokens, guess) {
    if (TYPE_DIRECTION[guess.type] !== 'out') return guess;
    const {strong, passive} = incomingCues(tokens, guess.type);
    if (!strong.length && !passive.length) return guess;
    return {
        ...guess,
        type: strong.length ? 'receive' : guess.type,
        defaulted: true,
        confidence: Math.min(guess.confidence, 0.4),
        reason: `${guess.reason}, but ${[...strong, ...passive].join('; ')}`,
    };
}

// Money coming in must never be recorded as going out, so the guess is only trusted
// when the text agrees with itself: one type keyword, or keywords of one direction,
// and no cue that says the money came in ("sent you", "been paid", "to your account",
// "credited", the Airtel *R* marker) next to an outgoing type. Otherwise the best
// candidate is still offered, but as a default the admin has to confirm.
function guessType(tokens) {
    return withIncomingCues(tokens, guessTypeFromKeywords(tokens));
}

function guessTypeFromKeywords(tokens) {
    const words = wordIndexes(tokens);
    const found = [];
    for (const {word, index} of words) {
        for (const [type, set] of TYPE_KEYWORDS) {
            if (!set.has(word)) continue;
            let score = VERB_TYPE_WORDS.has(word) ? 3 : 0;
            const following = nextWords(tokens, index, 2);
            if (following[0] === 'of') score -= 1;
            else if (following.some(w => DIRECTION_PREPOSITIONS.has(w))) score += 1;
            found.push({type, word, index, score});
        }
    }
    const marker = hasAirtelReceivedMarker(tokens);

    if (found.length === 0) {
        const weak = words.find(({word}) => WEAK_PAYMENT_WORDS.has(word));
        if (marker) {
            return weak
                ? {type: 'receive', confidence: 0.4, reason: `Airtel *R* marker says received, but "${weak.word}" suggests a payment`, defaulted: true}
                : {type: 'receive', confidence: 0.6, reason: 'Airtel *R* marker', defaulted: false};
        }
        if (weak) return {type: 'payment', confidence: 0.55, reason: `weak keyword "${weak.word}"`, defaulted: false};
        return {type: 'payment', confidence: 0.35, reason: 'no type keyword found, defaulted to payment', defaulted: true};
    }

    const directions = new Set(found.map(f => TYPE_DIRECTION[f.type]));
    let chosen = found[0];
    if (directions.size > 1) {
        chosen = found.reduce((best, f) => (f.score > best.score ? f : best), found[0]);
    } else {
        // Same direction, so the balance is right either way; the more specific type
        // wins over the generic one ("transfer to agent: ... withdrawn" is a withdrawal).
        chosen = found.reduce((best, f) => (TYPE_SPECIFICITY[f.type] > TYPE_SPECIFICITY[best.type] ? f : best), found[0]);
    }
    const guess = {type: chosen.type, confidence: 0.85, reason: `keyword "${chosen.word}"`, defaulted: false};
    const others = Array.from(new Set(found.filter(f => f.type !== chosen.type).map(f => `"${f.word}"`)));
    if (directions.size === 1 && others.length) guess.reason += ` (the more specific type wins over ${others.join(', ')})`;

    const doubts = [];
    let incoming = false;
    if (directions.size > 1) {
        doubts.push(`keywords of opposite directions (${Array.from(new Set(found.map(f => `"${f.word}"`))).join(', ')})`);
    }
    if (marker && TYPE_DIRECTION[chosen.type] === 'out') {
        doubts.push('the Airtel *R* marker says the money was received');
        incoming = true;
    }
    for (const {word, index} of words) {
        const following = nextWords(tokens, index, 1);
        if (INCOMING_VERBS.has(word) && following[0] === 'you' && TYPE_DIRECTION[chosen.type] === 'out') {
            doubts.push(`"${word} you" says the money came in`);
            incoming = true;
        }
        if (word === 'paid' && ['been', 'was'].includes(prevWord(tokens, index)) && TYPE_DIRECTION[chosen.type] === 'out') {
            doubts.push('"been paid" can mean the money came in');
            incoming = true;
        }
    }
    if (doubts.length) {
        guess.defaulted = true;
        guess.confidence = 0.4;
        guess.reason = `${guess.reason}, but ${doubts.join('; ')}`;
        if (incoming && TYPE_DIRECTION[chosen.type] === 'out') guess.type = 'receive';
    }
    return guess;
}

function guessLocale(tokens, given) {
    if (typeof given === 'string' && /^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/.test(given.trim())) {
        const [lang, region] = given.trim().split('-');
        return `${lang.toLowerCase()}-${(region || 'RW').toUpperCase()}`;
    }
    const words = wordTokens(tokens);
    if (words.includes('kr')) return 'rw-RW';
    if (words.includes('en')) return 'en-RW';
    return words.some(w => KINYARWANDA_WORDS.has(w)) ? 'rw-RW' : 'en-RW';
}

function prevWords(tokens, index, radius) {
    const out = [];
    for (let i = index - 1; i >= 0 && out.length < radius; i--) {
        const t = tokens[i];
        if (t.type === 'space') continue;
        if (t.type === 'ph') break;
        out.push(t.text.toLowerCase());
    }
    return out;
}

function keywordRole(prev) {
    for (let i = 0; i < prev.length; i++) {
        const w = prev[i];
        if (FEE_WORDS.has(w)) return 'fee';
        if (BALANCE_WORDS.has(w)) return 'balance';
        if (AMOUNT_WORDS.has(w)) return 'amount';
        if (TXN_WORDS.has(w)) return 'transactionId';
        if (w === 'id' && ['tx', 'txn', 'transaction', 'financial'].includes(prev[i + 1])) return 'transactionId';
    }
    return null;
}

function neighbour(tokens, index, step) {
    for (let i = index + step; i >= 0 && i < tokens.length; i += step) {
        if (tokens[i].type !== 'space') return tokens[i];
    }
    return null;
}

function currencyAdjacent(tokens, index) {
    const prev = neighbour(tokens, index, -1);
    const next = neighbour(tokens, index, 1);
    if (prev && prev.type === 'word' && /(?:rwf|frw)$/i.test(prev.text)) return true;
    return !!(next && next.type === 'word' && /^(?:rwf|frw)/i.test(next.text));
}

function looksLikeServiceCode(tokens, index) {
    const prev = neighbour(tokens, index, -1);
    const next = neighbour(tokens, index, 1);
    if (prev && prev.type === 'punct' && prev.text === '*' && next && next.type === 'punct' && next.text === '*') return true;
    return !!(prev && prev.type === 'word' && NOT_MONEY_WORDS.has(prev.text.toLowerCase()));
}

function followsWordSlot(tokens, index) {
    let hops = 0;
    for (let i = index - 1; i >= 0 && hops < 3; i--) {
        const t = tokens[i];
        if (t.type === 'space') continue;
        if (t.type === 'ph') return t.kind === 'W' || t.kind === 'W+' ? t : null;
        if (t.type === 'punct' && '(:-,'.includes(t.text)) {
            hops++;
            continue;
        }
        return null;
    }
    return null;
}

function precedesWordSlot(tokens, index) {
    let hops = 0;
    for (let i = index + 1; i < tokens.length && hops < 3; i++) {
        const t = tokens[i];
        if (t.type === 'space') continue;
        if (t.type === 'ph') return t.kind === 'W' || t.kind === 'W+' ? t : null;
        if (t.type === 'punct' && '(:-,'.includes(t.text)) {
            hops++;
            continue;
        }
        return null;
    }
    return null;
}

function roleCompatible(role, kind) {
    if (role === 'amount' || role === 'fee' || role === 'balance') return kind === 'N' || kind === 'PH';
    if (role === 'secondParty' || role === 'agentName') return kind === 'W' || kind === 'W+';
    if (role === 'accountNumber' || role === 'agentNumber' || role === 'transactionId') return kind === 'N' || kind === 'PH';
    return false;
}

function summariseHints(hintVotes) {
    const out = new Map();
    if (!hintVotes || typeof hintVotes !== 'object') return out;
    for (const [rawSlot, votes] of Object.entries(hintVotes)) {
        const slotNo = Number(rawSlot);
        if (!Number.isInteger(slotNo) || slotNo < 1 || !votes || typeof votes !== 'object') continue;
        let total = 0;
        let top = null;
        for (const role of HINT_ROLES) {
            const n = Number(votes[role]);
            if (!Number.isFinite(n) || n <= 0) continue;
            total += n;
            if (!top || n > top.n) top = {role, n};
        }
        if (!top) continue;
        const share = top.n / total;
        // Each vote is a distinct device. One device must never decide a mapping on its own, and
        // a split vote decides nothing.
        if (top.n >= 2 && share >= 0.6) out.set(slotNo, {role: top.role, votes: top.n, share, strong: true});
    }
    return out;
}

function precededByPreposition(tokens, index) {
    for (let i = index - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t.type === 'space') continue;
        if (t.type === 'punct' && ':(,-'.includes(t.text)) continue;
        return t.type === 'word' && NAME_PREPOSITIONS.has(t.text.toLowerCase());
    }
    return false;
}

const GREETING_WORDS = new Set(['dear', 'muraho', 'hello', 'hi', 'mr', 'mrs', 'ms', 'miss', 'sir', 'madam']);
const BEFORE_NAME_OK = new Set([
    ...NAME_PREPOSITIONS, 'for', 'on', 'of', 'in', 'the', 'a', 'an', 'and', 'or', 'na', 'ni', 'ya', 'ku', 'kwa', 'customer',
    'recipient', 'beneficiary', 'payee', 'payer', 'vendor', 'seller', 'buyer', 'user', 'subscriber', 'client', 'account', 'name',
    'dear', 'muraho', 'hello', 'hi', 'mr', 'mrs', 'ms', 'miss', 'sir', 'madam',
]);
const BEFORE_PHONE_OK = new Set([
    'to', 'from', 'by', 'via', 'for', 'at', 'on', 'in', 'of', 'with', 'number', 'no', 'nr', 'account', 'acct', 'id', 'ref', 'reference',
    'txn', 'txid', 'tid', 'transactionid', 'transaction', 'amt', 'amount', 'wallet', 'phone', 'tel', 'mobile', 'line', 'sim', 'msisdn',
    'token', 'code', 'kode', 'otp', 'kuri', 'avuye', 'na', 'ya', 'ni', 'ku', 'konti', 'nimero', 'agent',
]);
const AFTER_GREETING_OK = new Set(['customer', 'subscriber', 'user', 'client', 'member', 'friend', 'sir', 'madam', 'valued', 'team']);

function slotBoundWord(tokens, index, dir, skipPunct) {
    for (let i = index + dir; i >= 0 && i < tokens.length; i += dir) {
        const t = tokens[i];
        if (t.type === 'space') continue;
        if (t.type === 'punct' && skipPunct.includes(t.text)) continue;
        return t;
    }
    return null;
}

function precededByGreeting(tokens, index) {
    const t = slotBoundWord(tokens, index, -1, ':(,-');
    return !!t && t.type === 'word' && GREETING_WORDS.has(t.text.toLowerCase());
}

function nextToPhone(tokens, index) {
    const after = slotBoundWord(tokens, index, 1, '(:,-');
    const before = slotBoundWord(tokens, index, -1, '(:,-');
    return [after, before].some(t => !!t && t.type === 'ph' && t.kind === 'PH');
}

function nameCandidates(tokens, slots, indexOf) {
    return slots
        .map(t => {
            const i = indexOf(t);
            const prep = precededByPreposition(tokens, i);
            const phone = nextToPhone(tokens, i);
            const greeting = precededByGreeting(tokens, i);
            return {t, i, prep, phone, greeting, score: (prep ? 4 : 0) + (phone ? 2 : 0) + (t.kind === 'W+' ? 1 : 0) - (greeting ? 5 : 0)};
        })
        .filter(c => c.t.kind === 'W+' || c.prep);
}

// The person on the other side of the transaction is the free-text slot that follows
// a preposition ("from", "to", "kuri") or sits next to the phone number; the slot after
// a greeting is the customer's own name and is never the counterparty. With several
// candidates and no single preposition-led one the choice is a guess, which the gate
// makes the admin confirm.
function chooseNameSlot(tokens, freeWords, indexOf) {
    const candidates = nameCandidates(tokens, freeWords, indexOf).filter(c => !c.greeting);
    if (!candidates.length) return {slot: null};
    const best = candidates.reduce((a, c) => (c.score > a.score ? c : a), candidates[0]);
    const prepLed = candidates.filter(c => c.prep);
    const ambiguous = candidates.length > 1 && !(best.prep && prepLed.length === 1);
    const reason = best.prep ? 'free-text slot after a preposition' : best.phone ? 'free-text slot next to a phone number' : 'first free-text slot';
    return {slot: best.t, ambiguous, reason};
}

const ordinalWord = slotNo => `free-text slot ${slotNo}`;

// What the gate checks about the person-name capture: that it is the slot a person
// stands in, and that no literal word sits where a name or a phone number is expected
// (a name that is also a vocabulary word would otherwise be baked into the regex).
// An admin who has looked at the mapping confirms it by setting it explicitly.
function nameSlotProblems(skeleton, captureMap, confirmed) {
    if (confirmed) return [];
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return [];
    const tokens = normalizeTokens(parsed.tokens);
    const layout = computeLayout(tokens);
    const tokenIndex = new Map(tokens.map((t, i) => [t, i]));
    const indexOf = t => tokenIndex.get(t);
    const wordSlots = tokens.filter(t => t.type === 'ph' && (t.kind === 'W' || t.kind === 'W+'));
    const candidates = nameCandidates(tokens, wordSlots, indexOf);
    const prepLed = candidates.filter(c => c.prep);
    const problems = [];

    for (const role of ['secondParty', 'agentName']) {
        const group = captureMap && captureMap[role];
        const slot = group ? layout.slots.find(x => x.group === group) : null;
        if (!slot) continue;
        const token = tokens[slot.index];
        if (token.kind !== 'W' && token.kind !== 'W+') continue;
        const mine = candidates.find(c => c.t === token);
        const prep = !!mine && mine.prep;
        const label = ordinalWord(token.slotNo);
        if (precededByGreeting(tokens, slot.index)) {
            problems.push(`${role} is the ${label}, which follows a greeting: that is the customer's own name`);
        } else if (!prep && prepLed.length > 0) {
            problems.push(`${role} is the ${label}, but ${ordinalWord(prepLed[0].t.slotNo)} follows a preposition (to, from, by, kuri...), which is where the other person stands`);
        } else if (!prep && wordSlots.length > 1) {
            problems.push(`${role} is the ${label}, which follows no preposition, and the text has other free-text slots`);
        } else if (prep && prepLed.length > 1) {
            problems.push(`${role} is the ${label}, but ${prepLed.length} free-text slots follow a preposition`);
        }
        const before = slotBoundWord(tokens, slot.index, -1, ':(,-');
        if (before && before.type === 'word' && !BEFORE_NAME_OK.has(before.text.toLowerCase())) {
            problems.push(`the literal word "${before.text}" sits right before the ${label}: if it is part of a person's name the pattern would carry it`);
        }
    }

    tokens.forEach((t, i) => {
        if (t.type === 'ph' && t.kind === 'PH') {
            const before = slotBoundWord(tokens, i, -1, '(');
            if (before && before.type === 'word' && !BEFORE_PHONE_OK.has(before.text.toLowerCase())) {
                problems.push(`the literal word "${before.text}" sits right before a phone number: it may be a person's name`);
            }
        }
        if (t.type === 'word' && GREETING_WORDS.has(t.text.toLowerCase())) {
            const after = slotBoundWord(tokens, i, 1, '');
            if (after && after.type === 'word' && !AFTER_GREETING_OK.has(after.text.toLowerCase()) && !GREETING_WORDS.has(after.text.toLowerCase())) {
                problems.push(`the literal word "${after.text}" follows the greeting "${t.text}": it may be the customer's name`);
            }
        }
    });
    return Array.from(new Set(problems));
}

function assignRoles(tokens, type, hintVotes) {
    const byRole = {};
    const slotRole = new Map();
    const notes = [];
    const conflicts = [];
    const slotTokens = tokens.filter(t => t.type === 'ph');
    const tokenIndex = new Map(tokens.map((t, i) => [t, i]));
    const indexOf = t => tokenIndex.get(t);

    const claim = (token, role, confidence, reason) => {
        if (byRole[role] || slotRole.has(token.ordinal)) return false;
        byRole[role] = {token, confidence, reason};
        slotRole.set(token.ordinal, role);
        notes.push(`${role}: ${reason}`);
        return true;
    };

    const firstTS = slotTokens.find(t => t.kind === 'TS');
    const firstTID = slotTokens.find(t => t.kind === 'TID');
    if (firstTS) {
        byRole.timestamp = {token: firstTS, confidence: 0.9, reason: 'ISO-style timestamp placeholder', parser: 'iso8601'};
        notes.push('timestamp: ISO-style timestamp placeholder');
    }
    if (firstTID) {
        byRole.transactionId = {token: firstTID, confidence: 0.9, reason: 'Airtel TID-shaped placeholder'};
        notes.push('transactionId: Airtel TID-shaped placeholder (full TID)');
        if (!firstTS) {
            byRole.timestamp = {
                token: firstTID,
                confidence: 0.85,
                reason: 'date/time embedded in the Airtel TID',
                parser: 'airtel-shortcode',
            };
            notes.push('timestamp: read from the same full-TID group (airtel-shortcode)');
        }
        slotRole.set(firstTID.ordinal, 'transactionId');
    }
    if (firstTS) slotRole.set(firstTS.ordinal, 'timestamp');

    const hints = summariseHints(hintVotes);
    const agentRoles = {secondParty: 'agentName', accountNumber: 'agentNumber'};
    for (const hint of hints.values()) {
        hint.role = type === 'withdraw' && agentRoles[hint.role] ? agentRoles[hint.role] : hint.role;
    }
    const slotByNo = new Map(slotTokens.filter(t => t.slotNo).map(t => [t.slotNo, t]));

    const numeric = slotTokens.filter(t => t.kind === 'N' || t.kind === 'PH');
    for (const token of numeric) {
        if (slotRole.has(token.ordinal)) continue;
        const role = keywordRole(prevWords(tokens, indexOf(token), 3));
        if (role) claim(token, role, 0.75, `keyword before slot ${token.slotNo}`);
    }

    // The text is evidence, a device hint is a vote: the keyword and currency heuristics claim their
    // slots first, a hint only settles what they could not, and a hint that disagrees with one is
    // reported instead of applied.
    if (!byRole.amount) {
        const candidates = numeric.filter(t => !slotRole.has(t.ordinal) && !looksLikeServiceCode(tokens, indexOf(t)));
        const adjacent = candidates.find(t => currencyAdjacent(tokens, indexOf(t)));
        if (adjacent) claim(adjacent, 'amount', 0.65, `first number next to a currency word (slot ${adjacent.slotNo})`);
    }

    const nameRole = type === 'withdraw' ? 'agentName' : 'secondParty';
    const unclaimedWords = () => slotTokens.filter(t => (t.kind === 'W' || t.kind === 'W+') && !slotRole.has(t.ordinal));
    const claimName = choice => {
        const how = choice.ambiguous ? ', a guess among several free-text slots: confirm it' : '';
        claim(choice.slot, nameRole, choice.ambiguous ? 0.4 : 0.6, `${choice.reason} (slot ${choice.slot.slotNo})${how}`);
    };
    const clearName = chooseNameSlot(tokens, unclaimedWords(), indexOf);
    if (clearName.slot && !clearName.ambiguous) claimName(clearName);

    const ordered = Array.from(hints.entries()).sort((a, b) => a[0] - b[0]);
    for (const [slotNo, hint] of ordered) {
        const token = slotByNo.get(slotNo);
        if (!token || !roleCompatible(hint.role, token.kind)) continue;
        const holder = slotRole.get(token.ordinal);
        if (holder && holder !== hint.role) {
            conflicts.push({slotNo, hintRole: hint.role, keywordRole: holder});
            notes.push(`conflict: device hints say slot ${slotNo} is ${hint.role}, but the text says ${holder}; keeping ${holder}`);
            continue;
        }
        if (holder) continue;
        if (byRole[hint.role]) {
            conflicts.push({slotNo, hintRole: hint.role, keywordRole: hint.role});
            notes.push(`conflict: device hints say slot ${slotNo} is ${hint.role}, but ${hint.role} is already mapped to slot ${byRole[hint.role].token.slotNo}`);
            continue;
        }
        claim(token, hint.role, 0.8, `device hint for slot ${slotNo} (${hint.votes} votes)`);
    }

    if (!byRole.amount) {
        const candidates = numeric.filter(t => !slotRole.has(t.ordinal) && !looksLikeServiceCode(tokens, indexOf(t)));
        if (candidates.length) claim(candidates[0], 'amount', 0.45, `first unlabelled number (slot ${candidates[0].slotNo}), confirm manually`);
    }

    if (!byRole[nameRole]) {
        const guess = chooseNameSlot(tokens, unclaimedWords(), indexOf);
        if (guess.slot) claimName(guess);
    }

    const phones = numeric.filter(t => !slotRole.has(t.ordinal));
    const accountEligible = t => !prevWords(tokens, indexOf(t), 3).some(w => NOT_ACCOUNT_WORDS.has(w));
    let account = phones.find(t => t.kind === 'PH' && accountEligible(t));
    if (!account) {
        account = phones.find(t => {
            const i = indexOf(t);
            const nextToName = followsWordSlot(tokens, i) || precedesWordSlot(tokens, i);
            return nextToName && !currencyAdjacent(tokens, i) && !looksLikeServiceCode(tokens, i) && accountEligible(t);
        });
    }
    if (account) {
        const before = followsWordSlot(tokens, indexOf(account));
        const agentFirst = before && byRole.agentName && byRole.agentName.token === before;
        claim(account, agentFirst ? 'agentNumber' : 'accountNumber', 0.6, `number slot ${account.slotNo} next to a name or phone-length digits`);
    }

    return {byRole, notes, conflicts};
}

function personGroups(captureMap) {
    return new Set([captureMap && captureMap.secondParty, captureMap && captureMap.agentName].filter(Boolean));
}

// Single unknown words ({W}) are only acceptable as a person name right after a
// preposition. Anything else (a status word such as "approved" next to "reversed",
// a marker letter) would be matched by any text, so the admin has to turn it into
// a literal (wordsAsLiteral) before the pattern can be approved.
function ambiguousWordSlots(skeleton, captureMap) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return [];
    const tokens = normalizeTokens(parsed.tokens);
    const layout = computeLayout(tokens);
    const persons = personGroups(captureMap);
    const out = [];
    let wordNo = 0;
    tokens.forEach((t, i) => {
        if (t.type !== 'ph' || (t.kind !== 'W' && t.kind !== 'W+')) return;
        wordNo += 1;
        if (t.kind !== 'W') return;
        const slot = layout.slots.find(x => x.ordinal === t.ordinal);
        if (slot && persons.has(slot.group) && precededByPreposition(tokens, i)) return;
        out.push({slotNo: t.slotNo, wordNo, group: slot ? slot.group : null});
    });
    return out;
}

// Numeric slots whose neighbouring words name one role (Fee, Balance, Amt) while
// the capture map assigns another.
function keywordConflicts(skeleton, captureMap) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok || !captureMap) return [];
    const tokens = normalizeTokens(parsed.tokens);
    const layout = computeLayout(tokens);
    const roleByGroup = new Map(Object.entries(captureMap).map(([role, group]) => [Number(group), role]));
    const out = [];
    tokens.forEach((t, i) => {
        if (t.type !== 'ph' || (t.kind !== 'N' && t.kind !== 'PH')) return;
        const slot = layout.slots.find(x => x.ordinal === t.ordinal);
        const assigned = slot && roleByGroup.get(slot.group);
        if (!assigned || !['amount', 'fee', 'balance'].includes(assigned)) return;
        const expected = keywordRole(prevWords(tokens, i, 3));
        if (expected && ['amount', 'fee', 'balance'].includes(expected) && expected !== assigned) {
            out.push({slotNo: t.slotNo, assigned, expected});
        }
    });
    return out;
}

// The amount is the one number the app records as money moved, so it must be a slot the text itself
// points at: a keyword before it ("Amt", "Amount") or a currency word next to it. A mapping that rests on
// "the first number" or on device votes is the admin's call, which they make by setting it.
function amountProblems(skeleton, captureMap, confirmed) {
    if (confirmed) return [];
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok || !captureMap || !captureMap.amount) return [];
    const tokens = normalizeTokens(parsed.tokens);
    const slot = computeLayout(tokens).slots.find(x => x.group === captureMap.amount);
    if (!slot) return [];
    const token = tokens[slot.index];
    if (token.kind !== 'N' && token.kind !== 'PH') return [];
    if (keywordRole(prevWords(tokens, slot.index, 3)) === 'amount' || currencyAdjacent(tokens, slot.index)) return [];
    return [`amount is mapped to slot ${token.slotNo}, which has no amount keyword before it and no currency word next to it`];
}

function guessTypeOfSkeleton(skeleton) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return null;
    return guessType(normalizeTokens(parsed.tokens));
}

function slotRegex(token, isLast) {
    switch (token.kind) {
        case 'N':
            return NUMBER_REGEX;
        case 'PH':
            return PHONE_REGEX;
        case 'TS':
            return TS_REGEX;
        case 'TID':
            return TID_REGEX;
        case 'URL':
        case 'EMAIL':
            return '\\S+';
        case 'W':
            return WORD_REGEX;
        default:
            return `(${FREE_TEXT_STEP}${isLast ? '+' : '*?'})`;
    }
}

function buildPattern(tokens) {
    let lastIdx = tokens.length - 1;
    while (lastIdx >= 0 && tokens[lastIdx].type === 'space') lastIdx--;
    const first = tokens.find(t => t.type !== 'space');
    let source = first && first.type === 'ph' ? '' : '.*?';
    const isFreeText = t => !!t && t.type === 'ph' && t.kind === 'W+';
    tokens.forEach((t, i) => {
        if (t.type === 'space') source += isFreeText(tokens[i - 1]) || isFreeText(tokens[i + 1]) ? SEPARATOR_CLASS : SEPARATOR_REGEX;
        else if (t.type === 'ph') source += slotRegex(t, i === lastIdx);
        else source += escapeRegExp(t.text);
    });
    return source;
}

// Two variable-width slots that touch, or are joined only by characters that both can
// match, let the regex split the same text between them in many ways: after a long run
// of such text a failed match costs a polynomial number of steps in its length (six
// dot-separated {N} slots take seconds on a 200-character message). A shape device can
// only produce that by hand: a number token swallows its own dots, and runs of words
// are one {W+}.
const ASCII_PROBE = Array.from({length: 128}, (_, i) => String.fromCharCode(i)).concat(['é']);
const SLOT_CHARS = {
    N: c => /[0-9,.]/.test(c),
    PH: c => /[0-9+.,\- ]/.test(c),
    W: c => /[A-Za-z0-9']/.test(c) || c.charCodeAt(0) > 127,
    'W+': () => true,
    URL: c => /\S/.test(c),
    EMAIL: c => /\S/.test(c),
};
const SLOT_FIRST_CHARS = {
    N: c => /[0-9]/.test(c),
    PH: c => /[0-9+]/.test(c),
    W: c => /[A-Za-z]/.test(c) || c.charCodeAt(0) > 127,
    'W+': () => true,
    URL: c => /\S/.test(c),
    EMAIL: c => /\S/.test(c),
};

function ambiguousSlotChains(skeleton) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return [];
    const out = [];
    let prev = null;
    let between = '';
    for (const t of normalizeTokens(parsed.tokens)) {
        if (t.type === 'ph' && SLOT_CHARS[t.kind]) {
            if (prev) {
                const inA = c => SLOT_CHARS[prev.kind](c);
                const inB = c => SLOT_CHARS[t.kind](c);
                const touches = between === '' ? ASCII_PROBE.some(c => inA(c) && SLOT_FIRST_CHARS[t.kind](c)) : ASCII_PROBE.some(c => inA(c) && inB(c));
                if (touches && Array.from(between).every(inA) && Array.from(between).every(inB)) {
                    out.push({first: prev.ordinal + 1, second: t.ordinal + 1, kinds: [prev.kind, t.kind], separator: between});
                }
            }
            prev = t;
            between = '';
        } else if (t.type === 'word' || t.type === 'punct') {
            between += t.text;
        } else {
            prev = null;
            between = '';
        }
    }
    return out;
}

function groupOf(layoutSlots, role) {
    if (!role) return null;
    const slot = layoutSlots.find(s => s.ordinal === role.token.ordinal);
    return slot ? slot.group : null;
}

function parseWordsAsLiteral(entries, tokens, notes) {
    const replacements = new Map();
    if (!Array.isArray(entries) || entries.length === 0) return replacements;
    const wordSlots = tokens.filter(t => t.type === 'ph' && (t.kind === 'W' || t.kind === 'W+'));
    let cursor = 0;
    for (const raw of entries) {
        if (typeof raw !== 'string') continue;
        let slotIdx = null;
        let text = raw.trim();
        const m = /^(\d{1,2})\s*[:=]\s*(.+)$/.exec(text);
        if (m) {
            slotIdx = Number(m[1]) - 1;
            text = m[2].trim();
        }
        const parts = text.split(/\s+/).filter(Boolean);
        if (!parts.length || !parts.every(p => /^[A-Za-z][A-Za-z'-]{0,29}$/.test(p))) {
            notes.push('ignored an invalid wordsAsLiteral entry');
            continue;
        }
        let target;
        if (slotIdx !== null) {
            target = wordSlots[slotIdx];
        } else {
            while (cursor < wordSlots.length && (wordSlots[cursor].kind !== 'W' || replacements.has(wordSlots[cursor].ordinal))) cursor++;
            target = wordSlots[cursor];
        }
        if (!target || replacements.has(target.ordinal)) {
            notes.push(`wordsAsLiteral "${text}" has no free word slot`);
            continue;
        }
        if ((target.kind === 'W' && parts.length !== 1) || (target.kind === 'W+' && parts.length < 2)) {
            notes.push(`wordsAsLiteral "${text}" does not fit a ${target.kind} slot`);
            continue;
        }
        replacements.set(target.ordinal, parts);
    }
    return replacements;
}

function applyWordReplacements(tokens, replacements) {
    if (replacements.size === 0) return tokens;
    const out = [];
    for (const t of tokens) {
        if (t.type === 'ph' && replacements.has(t.ordinal)) {
            replacements.get(t.ordinal).forEach((word, i) => {
                if (i > 0) out.push({type: 'space'});
                out.push({type: 'word', text: word});
            });
        } else {
            out.push(t);
        }
    }
    return out;
}

module.exports = {
    MAX_SKELETON_LENGTH,
    VALID_TYPES,
    CAPTURE_ROLES,
    sha256Hex16,
    escapeRegExp,
    KEYWORD_WORDS,
    NAME_PREPOSITIONS,
    tokenizeSkeleton,
    normalizeTokens,
    tokensToSkeleton,
    computeLayout,
    layoutOf,
    guessType,
    guessTypeOfSkeleton,
    ambiguousWordSlots,
    ambiguousSlotChains,
    nameSlotProblems,
    amountProblems,
    keywordConflicts,
    guessLocale,
    assignRoles,
    buildPattern,
    groupOf,
    parseWordsAsLiteral,
    applyWordReplacements,
    TS_REGEX,
    TID_REGEX,
    NUMBER_REGEX,
    PHONE_REGEX,
    WORD_REGEX,
    SEPARATOR_CLASS,
    SEPARATOR_REGEX,
};
