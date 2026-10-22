'use strict';

// Differential fuzz of the two anonymizers: the server reference (lib/manie/anonymize.js) and
// the on-device port (the app's src/lib/utils/anonymize.ts compiled to CommonJS).
//
// A PRIVACY divergence is a literal word that the reference keeps where the device port
// replaced it by a placeholder: the reference must never let through anything an honest
// device would hide. The other direction (the reference hides more than the device) is
// allowed and only counted. Everything generated here is invented: fake names, fake phone
// numbers, fake amounts.

const path = require('node:path');
const {buildVocabulary} = require('../../lib/manie/vocab');
const seedFile = require('../../assets/manie/vocab-seed.json');
const base = require('../../assets/manie/sms-formats.json');

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ------------------------------ synthetic material ------------------------------ */

const FIRST = [
    'Alice', 'Bosco', 'Chantal', 'Didier', 'Eric', 'Fabrice', 'Gaspard', 'Henriette', 'Immaculee', 'Jean', 'Kevin', 'Laurent',
    'Marie', 'Nadine', 'Olive', 'Patrick', 'Querida', 'Rachel', 'Samuel', 'Theo', 'Uwimana', 'Vestine', 'Yvonne', 'Zawadi',
    'Grace', 'Hope', 'Faith', 'Joy', 'Love', 'Will', 'Mercy', 'Cash', 'King', 'Rose', 'May', 'Lucky', 'Peace', 'Victor', 'Sunday',
    'Neza', 'Kanda', 'Bank', 'Pack', 'Sweet', 'Trust', 'Gift', 'Glory', 'Felix', 'Pearl', 'Ruby', 'Prince', 'Queen', 'Rich',
];
const LAST = [
    'Mukamana', 'Habimana', 'Uwase', 'Kamanzi', 'Nkusi', 'Ndayisaba', 'Niyonzima', 'Ineza', 'Mugisha', 'Ishimwe', 'Uwera',
    "O'Brien", "D'Souza", "N'Diaye", 'Ndayi-Sabimana', 'Mukeshimana-Uwase', 'Nuñez', 'Müller', 'Zoë', 'Åke', 'Çelik', 'Łukasz',
    'MUKAMANA', 'HABIMANA', 'UWASE', 'ndayisaba', "o'neil", 'Van Der Berg', 'De La Cruz', 'Jr', 'Sr', 'Ltd', 'Co',
];
const INITIALS = ['J', 'K', 'A', 'B', 'S', 'M', 'R', 'F', 'a', 'j', 'k', 'S.', 'J.', 'A.', 'R.K.', 'J. K.', 'A. B.', 'M-R', 'X'];
const MERCHANTS = [
    'Shoppy Ltd', 'ACME SHOP', 'Merchant', 'MoMo', 'Money', 'Test', 'Fake Merchant Ltd', 'MoMo Advance', 'Test Merchant',
    'Merchant Uwase', 'Bank', 'Pack', 'Bank of Kigali', 'Kigali Pack', 'Neza Store', 'Kanda Shop', 'Mobile Money', 'Airtel Money',
    'Agent', 'Customer', 'User', 'Sender', 'Receiver', 'Payee',
];
const CUES = ['to', 'from', 'for', 'by', 'dear', 'via', 'kuri', 'avuye', 'sender', 'receiver', 'agent', 'customer', 'merchant', 'user', 'payee', 'na', 'ya', 'ni', 'thank', 'thanks'];
const GREETINGS = ['Dear', 'Muraho', 'Hello', 'Hi', 'dear', 'muraho', 'hello', 'hi', 'DEAR', 'HELLO'];
const EDGE = [',', ';', ':', '(', ')', '&', '/', '"', '[', ']', "'", '!', '?', '%', '@', '#', '*', '_', '=', '+'];
const PUNCT_OTHER = ['|', '~', '<', '>', '$', '^', '\\', '`', '{', '}', '\n', '\t', ' ', ' ', '€', '£'];
const AMOUNTS = ['5000', '5,000', '1,234,567', '12.50', '0', '7', '250', '100,000', '3.5', '10000000', '99'];
const TIDS = ['PP260411.1430.A12345', 'RC260502.1015.H75073', 'MP261002.0905.C77', 'CI261231.2359.Z9', 'pp260411.1430.a1', 'PP26.1.A1', 'AB1.2.C3', 'P260411.1430.A1', 'PP260411.1430.1'];
const TSS = ['2026-04-11 14:30:00', '2026-04-11T14:30:00', '2026-04-11T14:30:00.123Z', '2026-10-02T09:05:07+02:00', '2026-04-11 14:30:00Z', '11/04/2026 14:30', '11-04-2026', '2026-04-11 14:30', '14:30:05', '2026-4-1 1:2:3'];
const URLS = ['https://momo.rw/x', 'http://example.com/pay?x=1', 'www.mtn.co.rw', 'mtn.rw', 'a@b.com', 'user.name+tag@example.co.rw', 'bit.ly/xyz', 'ftp://files.example.org/a', 'HTTPS://MOMO.RW', 'example.com.', 'm.me/zzz'];
// The TLDs of the URL rule that the fixed URLS above never use (com org rw co me ly they do).
const FUZZ_TLDS = [
    'net', 'info', 'biz', 'edu', 'gov', 'int', 'ug', 'ke', 'tz', 'bi', 'cd', 'io', 'app', 'dev', 'xyz', 'link', 'site', 'online',
    'top', 'club', 'shop', 'store', 'page', 'ai', 'tv', 'cc', 'mobi', 'africa',
];
// Hosts that are also ordinary words (to, pay, fee, shop, money), so that a host sits next to the vocabulary.
const HOSTS = ['momo', 'pay', 'to', 'shop', 'mtn', 'x', 'kigali-bank', 'a1', 'fee', 'money'];

function fakePhone(rnd) {
    const d = n => Array.from({length: n}, () => Math.floor(rnd() * 10)).join('');
    const forms = [
        () => `0${d(9)}`,
        () => `250${d(9)}`,
        () => `+250${d(9)}`,
        () => `+250 ${d(3)} ${d(3)} ${d(3)}`,
        () => `0${d(3)}-${d(3)}-${d(3)}`,
        () => `0${d(3)} ${d(3)} ${d(3)}`,
        () => `250-${d(3)}-${d(3)}-${d(3)}`,
        () => `(0${d(9)})`,
        () => `0${d(3)}***${d(3)}`,
        () => `*****${d(3)}`,
        () => `${d(8)}`,
        () => `${d(10)}`,
        () => `${d(4)} ${d(4)} ${d(4)}`,
        () => `${d(2)}.${d(3)}.${d(4)}`,
        () => `250 ${d(9)}`,
        () => `0${d(9)}.`,
        () => `00250${d(9)}`,
    ];
    return forms[Math.floor(rnd() * forms.length)]();
}

const TEMPLATES = [
    'You have received {A} RWF from {NAME} ({PH}) on your mobile money account at {TS} Your new balance:{A} RWF',
    '{A} RWF transferred to {NAME}({PH}) at {TS} Fee was: {A} RWF New balance: {A} RWF',
    '*165* TID {TID}*S* Money successfully sent to {NAME} {PH} Amt {N}Fee RWF {N}. BAL is RWF {N}. *EN#',
    '*165*Txn ID {TID}*R* You received Rwf{N} from {NAME} {PH}.Your NEW BALANCE is Rwf {N}. *EN#',
    '*161*TXN ID ({TID})*S*Payment of RWF {N} to {MERCH} - successful.Your NEW BALANCE is RWF {N}. *EN#',
    '*161*TID {TID}*R* You have received Rwf{N} from {N} {MERCH}.CHARGES Rwf{N}.BAL is Rwf {N}. *EN#',
    '*165* TID {TID}*S* Kohereza Rwf {N} kuri {NAME} {PH} byakunze. Fee Rwf{N}. Ubu mufite Rwf {N}. *KR#',
    '*165*TXN ID {TID}*S* Mwakiriye RWF {N} avuye kuri {NAME} {PH}.Kuri konti ubu mufite RWF {N}.*KR#',
    'Muraho {NAME}! Wakoresheje {A} kuri {MERCH} ku wa {TS}. Amafaranga asigaye {A}.',
    'Dear {NAME}, your payment of {A} to {MERCH} was successful. Fee {A}. Balance {A}. Ref {N}',
    'Hello {NAME} you sent {A} to {NAME} ({PH}) on {TS}. Thank {NAME}',
    'Your payment of {A} to {MERCH} completed on {TS}. Fee: {A}. Balance: {A}. TxId: {PH}',
    'Cash withdrawn {A} at agent {NAME} ({PH}) on {TS}. Fee {A}. Balance {A}',
    'Kanda *182*8*1# kugira ngo {CUE} {NAME}',
    'Neza {PH} {NAME} kanda *182# {NAME}',
    'Sender: {NAME}. Receiver: {NAME} {PH}. Customer {NAME}, merchant {MERCH}, user {NAME}',
    'To {STOP}. From {STOP}, {STOP}; ({STOP}) [{STOP}] "{STOP}" {STOP}! {STOP}? {STOP}% {STOP}@ {STOP}# {STOP}* {STOP}_ {STOP}= {STOP}+',
    'Dear {INIT}, thank {INIT} {INIT} {INIT}. {INIT}. {PH}',
    'You paid {A} to {COLL} {PH}. Hi {COLL}, hello {COLL} {NAME}, to {COLL}. from {COLL}, via {COLL}!',
    'Visit {URL} or mail {URL} to claim {A}. Ref {TID}',
    'Pay {URL} fee {A}. Ref {TID}',
];

function makeGen(seed, vocabWords) {
    const rnd = mulberry32(seed);
    const pick = list => list[Math.floor(rnd() * list.length)];
    const chance = p => rnd() < p;
    const vocab = [...vocabWords];

    const caseOf = w => {
        const r = rnd();
        if (r < 0.7) return w;
        if (r < 0.8) return w.toUpperCase();
        if (r < 0.9) return w.toLowerCase();
        return w.charAt(0).toLowerCase() + w.slice(1).toUpperCase();
    };
    const name = () => {
        const r = rnd();
        if (r < 0.3) return `${pick(FIRST)} ${pick(LAST)}`;
        if (r < 0.45) return pick(FIRST);
        if (r < 0.55) return pick(LAST);
        if (r < 0.65) return `${pick(FIRST)} ${pick(INITIALS)}`;
        if (r < 0.72) return `${pick(INITIALS)} ${pick(LAST)}`;
        if (r < 0.78) return `${pick(FIRST)} ${pick(FIRST)} ${pick(LAST)}`;
        if (r < 0.84) return pick(INITIALS);
        if (r < 0.9) return `${pick(vocab)} ${pick(LAST)}`;
        if (r < 0.95) return caseOf(pick(vocab));
        return `${pick(LAST)}-${pick(LAST)}`;
    };
    const tldHost = () => {
        const host = pick(HOSTS);
        const tld = caseOf(pick(FUZZ_TLDS));
        switch (Math.floor(rnd() * 8)) {
            case 0: return `${host}.${tld}`;
            case 1: return `${host}.${tld}/pay?x=1`;
            case 2: return `https://${host}.${tld}`;
            case 3: return `www.${host}.${tld}`;
            case 4: return `${host}.${tld}.`;
            case 5: return `${host}.${tld}x`;
            case 6: return `${host}.${tld}-x`;
            default: return `${host}.co.${tld}`;
        }
    };
    const merchant = () => (chance(0.6) ? pick(MERCHANTS) : name());
    const amount = () => {
        const a = pick(AMOUNTS);
        const r = rnd();
        if (r < 0.15) return `RWF${a}`;
        if (r < 0.25) return `Rwf ${a}`;
        if (r < 0.3) return `${a}RWF`;
        return a;
    };
    const slot = {
        N: () => pick(AMOUNTS),
        A: amount,
        NAME: name,
        MERCH: merchant,
        PH: () => fakePhone(rnd),
        TID: () => pick(TIDS),
        TS: () => pick(TSS),
        URL: () => (chance(0.5) ? tldHost() : pick(URLS)),
        V: () => pick(vocab),
        CUE: () => caseOf(pick(CUES)),
        INIT: () => pick(INITIALS),
        STOP: () => caseOf(pick(FIRST)),
        COLL: () => caseOf(pick(['merchant', 'momo', 'money', 'test'])),
    };

    function tokenSoup() {
        const n = 3 + Math.floor(rnd() * 28);
        const parts = [];
        for (let i = 0; i < n; i++) {
            const r = rnd();
            let t;
            if (r < 0.22) t = slot.V();
            else if (r < 0.3) t = slot.CUE();
            else if (r < 0.38) t = slot.STOP();
            else if (r < 0.42) t = slot.COLL();
            else if (r < 0.47) t = pick(GREETINGS);
            else if (r < 0.55) t = slot.INIT();
            else if (r < 0.65) t = name();
            else if (r < 0.72) t = amount();
            else if (r < 0.78) t = slot.PH();
            else if (r < 0.8) t = slot.TID();
            else if (r < 0.82) t = slot.TS();
            else if (r < 0.84) t = slot.URL();
            else if (r < 0.9) t = pick(EDGE);
            else if (r < 0.93) t = pick(['.', '-', '.', '-', '. ', ' - ']);
            else if (r < 0.95) t = pick(PUNCT_OTHER);
            else if (r < 0.97) t = pick(['*', '#', '*182#', '*1*2#', '*****', '***123']);
            else t = pick(['to', 'from', 'kuri', 'avuye', 'via', 'by']);
            parts.push(t);
        }
        let out = '';
        for (let i = 0; i < parts.length; i++) {
            out += parts[i];
            if (i < parts.length - 1) out += chance(0.82) ? ' ' : chance(0.5) ? '' : pick(['  ', '\t', ' | ', '\n']);
        }
        return out;
    }

    function fromTemplate() {
        let out = pick(TEMPLATES).replace(/\{([A-Z]+)\}/g, (m, k) => slot[k]());
        if (chance(0.3)) out = out.replace(/ /g, () => (chance(0.9) ? ' ' : pick(['  ', ' | ', '\t', '\n', ' ~ ', ' $ '])));
        if (chance(0.1)) out = out.toUpperCase();
        if (chance(0.05)) out = `${pick(['', 'Hello. ', 'FW: ', '*** '])}${out}${pick(['', ' .', ' #', ' *'])}`;
        return out;
    }

    return {rnd, pick, chance, message: () => (chance(0.5) ? fromTemplate() : tokenSoup())};
}

/* ------------------------------ vocabularies ------------------------------ */

function servedVocabulary() {
    return buildVocabulary({seed: Array.isArray(seedFile) ? seedFile : seedFile.words, patterns: base.patterns, adminWords: []});
}

// The vocabulary the server really serves, and two in which an admin (or a pattern) has added
// the words the name rules are about, so that those rules are exercised and not only skipped.
function vocabularyProfiles(names) {
    const served = servedVocabulary();
    const common = ['shop', 'store', 'market', 'school', 'church', 'taxi', 'moto', 'tuesday', 'friday', 'monday', 'payment', 'transfer', 'thank', 'thanks', 'user', 'payee', 'muraho', 'hello', 'hi', 'dear', 'your', 'you', 'we', 'our', 'and', 'the', 'of', 'to', 'in'];
    return {
        served,
        withNames: new Set([...served, ...names.NAME_STOPLIST, ...names.NAME_COLLISION_WORDS, ...names.NAME_GREETING_WORDS, ...names.NAME_CUE_WORDS, 'agent']),
        wide: new Set([...served, ...common, ...names.NAME_CUE_WORDS, ...names.NAME_GREETING_WORDS, 'a', 'b', 'c', 'd', 'e', 'x', 'y', 'z']),
    };
}

/* ------------------------------ comparison ------------------------------ */

const WORD_LITERAL = /^[A-Za-z][A-Za-z']*$/;
const SKEL_TOKEN = /\{(?:N|PH|TS|TID|URL|EMAIL|W\+|W)\}|[A-Za-z][A-Za-z']*|[\s\S]/g;

const covered = (slots, start, end) => slots.some(s => s.start <= start && end <= s.end);

function literalWords(skeleton) {
    const out = [];
    for (const m of skeleton.matchAll(SKEL_TOKEN)) if (/^[A-Za-z]/.test(m[0])) out.push(m[0]);
    return out;
}

function isSubsequence(small, big) {
    let i = 0;
    for (const w of big) if (i < small.length && small[i] === w) i++;
    return i === small.length;
}

function newTally() {
    return {cases: 0, identical: 0, differ: 0, privacy: 0, apiStricter: 0, mixed: 0, other: 0, byCategoryPrivacy: {}, byCategoryApiStricter: {}, examplesPrivacy: [], examplesApiStricter: [], examplesOther: []};
}

function makeComparer({api, dev, names}) {
    const stopSet = new Set(names.NAME_STOPLIST);
    const devStop = new Set(dev.NAME_STOPLIST);
    const collSet = new Set(names.NAME_COLLISION_WORDS);
    const greetSet = new Set(names.NAME_GREETING_WORDS);
    const cueSet = new Set(names.NAME_CUE_WORDS);
    const category = word => {
        const w = word.toLowerCase();
        if (w.length === 1) return w === 'a' ? 'initial-a' : 'initial';
        if (devStop.has(w)) return 'stoplist-in-both';
        if (stopSet.has(w)) return 'stoplist-reference-only';
        if (collSet.has(w)) return 'collision';
        if (greetSet.has(w)) return 'greeting';
        if (cueSet.has(w)) return 'cue';
        return 'other';
    };
    const bump = (map, key) => {
        map[key] = (map[key] || 0) + 1;
    };
    const keep = (list, item) => {
        if (list.length < 8) list.push(item);
    };

    function anonymize(tally, message, vocab, profile) {
        tally.cases++;
        const a = api.anonymize(message, vocab);
        const d = dev.anonymize(message, vocab);
        const sameSlots = a.slots.length === d.slots.length && a.slots.every((x, i) => x.kind === d.slots[i].kind && x.index === d.slots[i].index && x.start === d.slots[i].start && x.end === d.slots[i].end);
        if (a.skeleton === d.skeleton && sameSlots) {
            tally.identical++;
            return;
        }
        tally.differ++;
        const weaker = [];
        const stricter = [];
        for (const t of dev.tokenize(message)) {
            if (t.kind !== 'word' || !WORD_LITERAL.test(t.text) || !vocab.has(t.text.toLowerCase())) continue;
            const litApi = !covered(a.slots, t.start, t.end);
            const litDev = !covered(d.slots, t.start, t.end);
            if (litApi && !litDev) weaker.push(t.text);
            else if (!litApi && litDev) stricter.push(t.text);
        }
        const sample = {profile, message, api: a.skeleton, dev: d.skeleton};
        if (weaker.length) {
            tally.privacy++;
            for (const w of new Set(weaker)) bump(tally.byCategoryPrivacy, category(w));
            keep(tally.examplesPrivacy, {...sample, words: weaker});
        }
        if (stricter.length) {
            if (!weaker.length) tally.apiStricter++;
            else tally.mixed++;
            for (const w of new Set(stricter)) bump(tally.byCategoryApiStricter, category(w));
            keep(tally.examplesApiStricter, {...sample, words: stricter});
        }
        if (!weaker.length && !stricter.length) {
            tally.other++;
            keep(tally.examplesOther, sample);
        }
    }

    function sanitize(tally, skeleton, vocab, profile, label) {
        tally.cases++;
        const a = api.sanitizeSkeletonDetailed(skeleton, vocab);
        const d = dev.sanitizeSkeleton(skeleton, vocab);
        const view = r => JSON.stringify(r.ok ? {...r} : {ok: false, reason: r.reason});
        if (view(a) === view(d)) {
            tally.identical++;
            return;
        }
        tally.differ++;
        const sample = {profile, label, skeleton, api: a.ok ? a.skeleton : a, dev: d.ok ? d.skeleton : d};
        if (!a.ok || !d.ok) {
            tally.other++;
            keep(tally.examplesOther, sample);
            return;
        }
        const la = literalWords(a.skeleton);
        const ld = literalWords(d.skeleton);
        if (la.length > ld.length && isSubsequence(ld, la)) {
            tally.privacy++;
            const extra = la.filter(w => !ld.includes(w));
            for (const w of new Set(extra.length ? extra : la)) bump(tally.byCategoryPrivacy, category(w));
            keep(tally.examplesPrivacy, sample);
        } else if (ld.length > la.length && isSubsequence(la, ld)) {
            tally.apiStricter++;
            const extra = ld.filter(w => !la.includes(w));
            for (const w of new Set(extra.length ? extra : ld)) bump(tally.byCategoryApiStricter, category(w));
            keep(tally.examplesApiStricter, sample);
        } else if (a.skeleton !== d.skeleton) {
            tally.mixed++;
            keep(tally.examplesOther, sample);
        } else {
            tally.other++;
            keep(tally.examplesOther, sample);
        }
    }

    return {anonymize, sanitize};
}

// A skeleton in which every literal word is distinct, so that the fate of each word is clear.
function skeletonSoup(gen, vocabList, names) {
    const {rnd, pick, chance} = gen;
    const used = new Set();
    const fresh = pool => {
        for (let tries = 0; tries < 12; tries++) {
            const w = pick(pool);
            const k = w.toLowerCase();
            if (!used.has(k)) {
                used.add(k);
                return w;
            }
        }
        return null;
    };
    const unknownPool = ['Zxqvbn', 'Alice', 'Bosco', 'Chantal', 'Didier', 'Eric', 'Fabrice', 'Gaspard', 'Mukamana', 'Habimana', 'Uwase', 'Kamanzi', "O'Brien", 'Ndayi'];
    const n = 3 + Math.floor(rnd() * 22);
    const parts = [];
    for (let i = 0; i < n; i++) {
        const r = rnd();
        let t = null;
        if (r < 0.2) t = fresh(vocabList);
        else if (r < 0.28) t = fresh(names.NAME_CUE_WORDS);
        else if (r < 0.38) t = fresh(names.NAME_STOPLIST);
        else if (r < 0.42) t = fresh(names.NAME_COLLISION_WORDS);
        else if (r < 0.47) t = fresh(names.NAME_GREETING_WORDS);
        else if (r < 0.55) t = fresh(['J', 'K', 'B', 'S', 'M', 'R', 'F', 'X', 'Q', 'T', 'a']);
        else if (r < 0.63) t = fresh(unknownPool);
        else if (r < 0.7) t = pick(['{N}', '{PH}', '{TS}', '{TID}', '{URL}', '{EMAIL}']);
        else if (r < 0.75) t = pick(['{W}', '{W+}']);
        else if (r < 0.85) t = pick(EDGE);
        else if (r < 0.9) t = pick(['.', '-', '.', '-']);
        else if (r < 0.93) t = pick(['*', '#', '*', '*', '*', '#']);
        else t = pick(['{N}', '{PH}']);
        if (t !== null) parts.push(t);
    }
    let out = '';
    for (let i = 0; i < parts.length; i++) {
        out += parts[i];
        if (i < parts.length - 1) out += chance(0.85) ? ' ' : '';
    }
    return out;
}

// Messages from templates and token soup, under three vocabularies, and the skeletons that
// come out of them (and fresh skeleton soup) through sanitizeSkeleton.
function runMessageFuzz({api, dev, names, n, seed}) {
    const compare = makeComparer({api, dev, names});
    const profiles = vocabularyProfiles(names);
    const tallies = {anonymize: newTally(), sanitize: newTally()};
    const keys = Object.keys(profiles);
    const per = Math.ceil(n / keys.length);
    let messages = 0;
    for (const profile of keys) {
        const vocab = profiles[profile];
        const list = [...vocab];
        const gen = makeGen(seed + profile.length * 7919, list);
        for (let i = 0; i < per && messages < n; i++, messages++) {
            const message = gen.message();
            compare.anonymize(tallies.anonymize, message, vocab, profile);
            if (i % 2 === 0) {
                const a = api.anonymize(message, vocab);
                const d = dev.anonymize(message, vocab);
                if (a.skeleton) compare.sanitize(tallies.sanitize, a.skeleton, vocab, profile, 'reference-skeleton');
                if (d.skeleton && d.skeleton !== a.skeleton) compare.sanitize(tallies.sanitize, d.skeleton, vocab, profile, 'device-skeleton');
                const reduced = new Set([...vocab].filter(() => gen.rnd() < 0.9));
                if (a.skeleton) compare.sanitize(tallies.sanitize, a.skeleton, reduced, profile, 'reference-skeleton-reduced-vocabulary');
            } else {
                compare.sanitize(tallies.sanitize, skeletonSoup(gen, list, names), vocab, profile, 'skeleton-soup');
            }
            if (i % 5 === 0) {
                const reduced = new Set([...vocab].filter(() => gen.rnd() < 0.85));
                compare.sanitize(tallies.sanitize, skeletonSoup(gen, list, names), reduced, profile, 'skeleton-soup-reduced-vocabulary');
            }
        }
    }
    return {messages, ...tallies};
}

const FRAGMENTS = [
    'a', 'A', 'b', 'Z', 'é', 'ñ', 'ß', '0', '5', '12', '123456789', '2026-04-11 14:30:00', ' ', ' ', ' ', ' ', '  ', '\t', '\n', '.', ',', '-', '+', '*', '#', '(', ')', "'", '@', '/', ':', ';', '{', '}', '_', '=', '!', '?', '%', '&', '[', ']', '"', '|', '~', '<', '>', '$', '^', '\\', '`',
    'http://', 'https://', 'www.', '.com', '.rw', '.co.rw', 'x.y', 'a@b', 'PP260411.1430.A1', 'AB1.2.C3', 'RWF', 'Rwf', 'rwf', '{N}', '{PH}', '{W}', '{W+}', '{TS}', '{TID}', '{URL}', '{EMAIL}', '{', '}x{',
    'Will', 'will', 'WILL', 'Grace', 'Hope', 'Faith', 'Bank', 'Pack', 'Merchant', 'MoMo', 'Money', 'Test', 'to', 'To', 'from', 'dear', 'Dear', 'hello', 'Muraho', 'hi', 'kuri', 'na', 'ya', 'ni', 'thank', 'agent', 'Neza', 'kanda',
    'ET123', 'A1B2', 'Zoë', "O'Brien", "D'Souza", 'Ndayi-Sabimana',
];

// Random strings over a hostile alphabet: any tokenisation difference between the two
// implementations shows up here.
function runCharFuzz({api, dev, names, n, seed}) {
    const compare = makeComparer({api, dev, names});
    const profiles = vocabularyProfiles(names);
    const served = profiles.served;
    const wide = new Set([...profiles.withNames, "don't", "can't", 'ok', 'x']);
    const rnd = mulberry32(seed);
    const pick = list => list[Math.floor(rnd() * list.length)];
    const vocabList = [...wide];
    const randomString = len => {
        let out = '';
        for (let i = 0; i < len; i++) {
            if (rnd() < 0.06) {
                const tld = pick(FUZZ_TLDS);
                out += '.' + (rnd() < 0.2 ? tld.toUpperCase() : tld);
            } else {
                out += rnd() < 0.55 ? pick(FRAGMENTS) : rnd() < 0.5 ? pick(vocabList) : pick(FRAGMENTS);
            }
        }
        return out;
    };
    const tallies = {anonymize: newTally(), sanitize: newTally()};
    for (let i = 0; i < n; i++) {
        const vocab = i % 3 === 0 ? served : wide;
        const profile = i % 3 === 0 ? 'served' : 'wide';
        const s = randomString(1 + Math.floor(rnd() * (i % 50 === 0 ? 120 : 24)));
        compare.anonymize(tallies.anonymize, s, vocab, profile);
        const a = api.anonymize(s, vocab);
        const d = dev.anonymize(s, vocab);
        for (const [label, sk] of [['raw', s], ['reference-skeleton', a.skeleton], ['device-skeleton', d.skeleton]]) {
            if (sk) compare.sanitize(tallies.sanitize, sk, vocab, profile, label);
        }
    }
    return {strings: n, ...tallies};
}

/* ------------------------------ the compiled device port ------------------------------ */

function appRepo() {
    return process.env.MANIE_APP_REPO || '/Users/ivainqueur/Documents/Code/React/mobile/Manie';
}

// Compiles the app's anonymize.ts with the app's own TypeScript. Returns the path of the
// compiled module, or null with a reason when the app checkout is not usable.
function compileDevicePort(outDir) {
    const {execFileSync} = require('node:child_process');
    const fs = require('node:fs');
    const repo = appRepo();
    const tsc = path.join(repo, 'node_modules/.bin/tsc');
    const source = path.join(repo, 'src/lib/utils/anonymize.ts');
    if (!fs.existsSync(tsc) || !fs.existsSync(source)) return {file: null, reason: `no tsc or anonymize.ts under ${repo} (set MANIE_APP_REPO)`};
    try {
        execFileSync(tsc, [source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], {cwd: repo, stdio: 'pipe'});
    } catch (error) {
        return {file: null, reason: `tsc failed: ${String(error.stdout || error.message).slice(0, 300)}`};
    }
    return {file: path.join(outDir, 'anonymize.js'), reason: null};
}

module.exports = {
    mulberry32,
    makeGen,
    vocabularyProfiles,
    servedVocabulary,
    runMessageFuzz,
    runCharFuzz,
    compileDevicePort,
    appRepo,
    literalWords,
    FUZZ_TLDS,
};
