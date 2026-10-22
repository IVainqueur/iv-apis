'use strict';

const {tokenizeSkeleton, normalizeTokens} = require('./_fields');

const N_PLAIN = ['5000', '100', '123450', '2500', '75', '310', '60', '45', '1200', '900'];
const N_ALT = ['12,500', '1,000', '1,234,567', '3,250', '20', '4,100', '88', '60', '150', '700'];
const PH_PLAIN = ['0780000001', '0730000002', '250780000003', '0780000004'];
// The alternate variant writes phone numbers the way the anonymizer folds them into {PH}:
// digit groups joined by one space or hyphen, with an optional leading plus.
const PH_ALT = ['+250 780 000 011', '0788-000-012', '0720 000 013', '250730000014'];
const W_PLAIN = ['Alice', 'Bosco', 'Chantal', 'Didier'];
const W_ALT = ['Bravo', 'Delta', 'Echo', 'Foxtrot'];
const WP_PLAIN = ['Alice Sample', 'Bob Example', 'Carol Tester', 'Dave Mockson'];
const WP_ALT = ['Bob Example Jr', 'Erin Sample Ltd', 'Frank Placeholder', 'Gina Testwood'];

const ROLE_VALUES = [
    {
        amount: '5000',
        fee: '100',
        balance: '123450',
        accountNumber: {PH: '0780000001', N: '4321'},
        agentNumber: {PH: '0730000002', N: '5432'},
        transactionId: {PH: '12345678901', N: '654321'},
        secondParty: {W: 'Alice', 'W+': 'Alice Sample'},
        agentName: {W: 'Bosco', 'W+': 'Bob Example'},
    },
    {
        amount: '12,500',
        fee: '1,000',
        balance: '1,234,567',
        accountNumber: {PH: '+250 780 000 011', N: '8765'},
        agentNumber: {PH: '0788-000-012', N: '9876'},
        transactionId: {PH: '10987654321', N: '123789'},
        secondParty: {W: 'Bravo', 'W+': 'Bob Example Jr'},
        agentName: {W: 'Delta', 'W+': 'Erin Sample Ltd'},
    },
];

// Full Airtel codes with real dates and times: every released and current parser reads them
// to the same time (see airtelTimestampProblem in gate.js), and so does the iOS parser.
const TS_VALUES = ['2026-04-11 14:30:00', '2026-10-02T09:05:07+02:00'];
const TID_VALUES = ['PP260411.1430.A12345', 'MP261002.0905.C77'];

function pick(list, n) {
    return list[n % list.length];
}

function defaultValue(kind, kindIndex, variant) {
    const alt = variant === 1;
    switch (kind) {
        case 'N':
            return pick(alt ? N_ALT : N_PLAIN, kindIndex);
        case 'PH':
            return pick(alt ? PH_ALT : PH_PLAIN, kindIndex);
        case 'TS':
            return TS_VALUES[alt ? 1 : 0];
        case 'TID':
            return TID_VALUES[alt ? 1 : 0];
        case 'URL':
            return 'https://example.test/a';
        case 'EMAIL':
            return 'user@example.test';
        case 'W':
            return pick(alt ? W_ALT : W_PLAIN, kindIndex);
        default:
            return pick(alt ? WP_ALT : WP_PLAIN, kindIndex);
    }
}

const PH_MONEY = [
    {amount: '123456789', fee: '100200300', balance: '987654321'},
    {amount: '555666777', fee: '111222333', balance: '444555666'},
];

function roleValue(role, kind, variant) {
    if (kind === 'PH' && PH_MONEY[0][role]) return PH_MONEY[variant === 1 ? 1 : 0][role];
    const entry = ROLE_VALUES[variant === 1 ? 1 : 0][role];
    if (!entry) return null;
    if (typeof entry === 'string') return kind === 'N' || kind === 'PH' ? entry : null;
    return entry[kind] || null;
}

function synthesizeTokens(tokens, {variant = 0, roleByOrdinal, overrideByOrdinal} = {}) {
    const kindCounters = {};
    const parts = [];
    let message = '';
    for (const t of tokens) {
        if (t.type === 'space') {
            message += ' ';
        } else if (t.type === 'ph') {
            const idx = kindCounters[t.kind] || 0;
            kindCounters[t.kind] = idx + 1;
            const role = roleByOrdinal && roleByOrdinal.get(t.ordinal);
            const forced = overrideByOrdinal && overrideByOrdinal.get(t.ordinal);
            const text = forced || (role && roleValue(role, t.kind, variant)) || defaultValue(t.kind, idx, variant);
            parts.push({kind: t.kind, ordinal: t.ordinal, text, role: role || null});
            message += text;
        } else {
            message += t.text;
        }
    }
    return {message, parts};
}

function synthesize(skeleton, options = {}) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) throw Object.assign(new Error(`invalid skeleton: ${parsed.reason}`), {code: 'invalid_skeleton'});
    return synthesizeTokens(normalizeTokens(parsed.tokens), options);
}

/* ---- regex source -> concrete sample message (used for shadow checks) ---- */

const CLASS_CANDIDATES = ['5', 'A', 'a', ' ', '-', ':', '.', ',', '_', '*', '#', '/', '+'];

function parseRegexSource(src) {
    let i = 0;

    function parseAlt(inGroup) {
        const alts = [parseSeq(inGroup)];
        while (src[i] === '|') {
            i++;
            alts.push(parseSeq(inGroup));
        }
        return alts.length === 1 ? alts[0] : {t: 'alt', alts};
    }

    function parseSeq(inGroup) {
        const items = [];
        while (i < src.length && src[i] !== '|' && !(inGroup && src[i] === ')')) {
            const atom = parseAtom();
            if (atom) items.push(parseQuantifier(atom));
        }
        return {t: 'seq', items};
    }

    function parseQuantifier(atom) {
        const c = src[i];
        let min = null;
        let max = null;
        if (c === '*') {
            min = 0;
            max = Infinity;
            i++;
        } else if (c === '+') {
            min = 1;
            max = Infinity;
            i++;
        } else if (c === '?') {
            min = 0;
            max = 1;
            i++;
        } else if (c === '{') {
            const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i));
            if (m) {
                min = Number(m[1]);
                max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
                i += m[0].length;
            }
        }
        if (min === null) return atom;
        if (src[i] === '?') i++;
        return {t: 'rep', node: atom, min, max};
    }

    function parseClass() {
        let j = i + 1;
        while (j < src.length && src[j] !== ']') {
            if (src[j] === '\\') j++;
            j++;
        }
        const body = src.slice(i, j + 1);
        i = j + 1;
        return {t: 'class', src: body};
    }

    function parseAtom() {
        const c = src[i];
        if (c === '\\') {
            const next = src[i + 1];
            i += 2;
            if (next === undefined) return null;
            if ('dDsSwW'.includes(next)) return {t: 'esc', k: next};
            if (next === 'b' || next === 'B') return null;
            return {t: 'lit', ch: next};
        }
        if (c === '(') {
            i++;
            let look = null;
            if (src[i] === '?') {
                if (src[i + 1] === ':') i += 2;
                else if (src[i + 1] === '=' || src[i + 1] === '!') {
                    look = 'ahead';
                    i += 2;
                } else if (src[i + 1] === '<' && (src[i + 2] === '=' || src[i + 2] === '!')) {
                    look = 'behind';
                    i += 3;
                } else if (src[i + 1] === '<') {
                    const end = src.indexOf('>', i);
                    i = end === -1 ? src.length : end + 1;
                }
            }
            const node = parseAlt(true);
            if (src[i] === ')') i++;
            return {t: 'group', look, node};
        }
        if (c === '[') return parseClass();
        if (c === '.') {
            i++;
            return {t: 'any'};
        }
        if (c === '^' || c === '$') {
            i++;
            return null;
        }
        i++;
        return {t: 'lit', ch: c};
    }

    const ast = parseAlt(false);
    return ast;
}

function classChar(classSrc) {
    let re;
    try {
        re = new RegExp(`^${classSrc}$`);
    } catch (_) {
        return 'x';
    }
    for (const ch of CLASS_CANDIDATES) if (re.test(ch)) return ch;
    return 'x';
}

function isWildcard(node) {
    if (node.t === 'rep') {
        const inner = node.node;
        if (inner.t === 'any') return true;
        if (inner.t === 'class' && (/^\[\\s\\S\]$/.test(inner.src) || /^\[\^/.test(inner.src))) return true;
        if (inner.t === 'esc' && (inner.k === 'D' || inner.k === 'S' || inner.k === 'W')) return true;
    }
    return false;
}

function isTimestampClass(classSrc) {
    try {
        const re = new RegExp(`^${classSrc}$`);
        return ['5', '-', ' ', ':'].every(ch => re.test(ch)) && !re.test('A');
    } catch (_) {
        return false;
    }
}

function quickText(item) {
    if (item.t === 'lit') return item.ch;
    if (item.t === 'esc' && item.k === 's') return ' ';
    if (item.t === 'rep' && item.node.t === 'esc' && item.node.k === 's') return ' ';
    return '';
}

function generate(node, ctx) {
    switch (node.t) {
        case 'seq': {
            let out = '';
            node.items.forEach((item, idx) => {
                const follow = node.items.slice(idx + 1, idx + 5).map(quickText).join('');
                out += generate(item, {...ctx, first: ctx.first && idx === 0, numeric: /^\s*rwf/i.test(follow)});
            });
            return out;
        }
        case 'alt':
            return generate(node.alts[0], ctx);
        case 'lit':
            return node.ch;
        case 'any':
            return 'a';
        case 'esc':
            return {d: '5', D: 'A', s: ' ', S: 'x', w: 'a', W: '-'}[node.k];
        case 'class':
            return classChar(node.src);
        case 'group': {
            if (node.look) return '';
            const inner = node.node;
            const single = inner.t === 'seq' && inner.items.length === 1 ? inner.items[0] : inner;
            if (isWildcard(single)) return ctx.numeric ? '5000' : 'Alice Sample';
            return generate(inner, ctx);
        }
        case 'rep': {
            const inner = node.node;
            if (isWildcard(node)) return ctx.first || node.min === 0 && node.max === 1 ? '' : ' ';
            if (inner.t === 'class' && isTimestampClass(inner.src)) return '2026-04-11 14:30:00';
            let count = node.min;
            if (count === 0) count = node.max >= 1 ? 1 : 0;
            if (inner.t === 'esc' && inner.k === 'd' && count < 4 && node.max >= 4) count = 4;
            if (inner.t === 'class' && count < 4 && node.max >= 4 && classChar(inner.src) === '5') count = 4;
            if (node.max !== Infinity) count = Math.min(count, node.max);
            let out = '';
            for (let k = 0; k < count; k++) out += generate(inner, {...ctx, first: false});
            return out;
        }
        default:
            return '';
    }
}

function sampleFromRegex(source) {
    if (typeof source !== 'string' || source.length === 0 || source.length > 3000) return null;
    try {
        const ast = parseRegexSource(source);
        const sample = generate(ast, {first: true});
        return sample.length > 0 && sample.length <= 1000 ? sample : null;
    } catch (_) {
        return null;
    }
}

module.exports = {synthesize, synthesizeTokens, sampleFromRegex, roleValue, defaultValue, TS_VALUES, TID_VALUES};
