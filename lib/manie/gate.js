'use strict';

const vm = require('node:vm');

const {
    layoutOf,
    tokenizeSkeleton,
    normalizeTokens,
    guessTypeOfSkeleton,
    ambiguousWordSlots,
    ambiguousSlotChains,
    nameSlotProblems,
    amountProblems,
    keywordConflicts,
    TID_REGEX,
} = require('./_fields');
const {VALID_TYPES, CAPTURE_ROLES, TIMESTAMP_PARSERS, countGroupsSandboxed: countGroups} = require('./_shared');
const {synthesize, sampleFromRegex} = require('./_synth');
const {NEGATION_PHRASES} = require('./_negation');

// A drafted pattern carries the failure-word guard once per free-text slot, so it is long by design.
const MAX_SOURCE_LENGTH = 2400;
const MAX_GROUPS = 20;
const EXEC_LIMIT_MS = 25;
const HARD_TIMEOUT_MS = 100;
const MAX_TIMEOUTS_PER_SANDBOX = 3;
const IDLE_RETRIES = 2;
const STRESS_LIMIT_MS = 5;
const GROWTH_FLOOR_MS = 2;
const GROWTH_RATIO = 6;
const STRESS_LENGTHS = [200, 400];
const MAX_STRESS_FAMILIES = 100;
const MAX_FREE_TEXT_SLOTS = 3;
const MAX_TEST_PATTERN_LENGTH = 3000;
const MAX_TEST_MESSAGE_LENGTH = 5000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const PARSERS = TIMESTAMP_PARSERS;

const CHECK_NAMES = [
    'regex-compiles',
    'capture-map',
    'required-captures',
    'valid-type',
    'redos-guard',
    'self-match',
    'negative-corpus',
    'no-shadow',
    'word-slots',
    'role-keywords',
    'name-slot',
    'negation-slots',
    'ios-timestamp',
    'carrier-signals',
];

const COMPILE_SCRIPT = new vm.Script('__re = new RegExp(__s, __f); 0', {filename: 'manie-regex-compile'});
const EXEC_SCRIPT = new vm.Script(
    '(function(){var m = __re.exec(__i); return m ? JSON.stringify(Array.prototype.slice.call(m)) : "null";})()',
    {filename: 'manie-regex-exec'},
);

function hrMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

function safeFlagsOf(flags) {
    return typeof flags === 'string' ? flags.replace(/[gy]/g, '') : '';
}

function cpuMsSince(start) {
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
}

function createSandbox(source, flags, {compileTimeoutMs = HARD_TIMEOUT_MS} = {}) {
    const context = vm.createContext(
        {__s: source, __f: flags, __i: '', __re: null},
        {codeGeneration: {strings: false, wasm: false}},
    );
    COMPILE_SCRIPT.runInContext(context, {timeout: compileTimeoutMs});
    const sandbox = {
        timeouts: 0,
        exec(input, timeoutMs = HARD_TIMEOUT_MS) {
            if (sandbox.timeouts >= MAX_TIMEOUTS_PER_SANDBOX) {
                return {matched: false, groups: null, elapsedMs: 0, busyMs: 0, timedOut: true};
            }
            context.__i = input;
            let last;
            for (let attempt = 0; attempt < IDLE_RETRIES + 1; attempt++) {
                const wallStart = hrMs();
                const cpuStart = process.cpuUsage();
                let groups = null;
                let timedOut = false;
                try {
                    groups = JSON.parse(EXEC_SCRIPT.runInContext(context, {timeout: timeoutMs}));
                } catch (error) {
                    if (!error || error.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error;
                    timedOut = true;
                }
                const elapsedMs = hrMs() - wallStart;
                const cpuMs = cpuMsSince(cpuStart);
                last = {matched: groups !== null, groups, elapsedMs, busyMs: timedOut ? elapsedMs : Math.min(elapsedMs, cpuMs), timedOut};
                const descheduled = timedOut && cpuMs < timeoutMs / 2;
                if (!descheduled) break;
            }
            if (last.timedOut) sandbox.timeouts += 1;
            return last;
        },
    };
    return sandbox;
}

function fastParseInt(text) {
    return parseInt(text.includes(',') ? text.replace(/,/g, '') : text, 10);
}

// The three readers of an Airtel code that the gate holds a timestamp group to. They must
// all return the same finite time for everything the pattern can capture:
// - parseAirtelShipped is parseAirtelTimestamp as it ships in every released Android
//   build and is used by the built-in handlers: it drops two characters and reads fixed
//   offsets, so it only understands the full code ("PP260411.1430.A12345");
// - parseAirtelTolerant is parseAirtelShortcode of the current app, which accepts the
//   code with or without the two letters and rejects impossible dates;
// - airtelReferenceDate is what the code actually says: the whole code in its exact
//   shape, and a calendar date that exists.
const AIRTEL_SHORTCODE_PATTERN = /^(?:[A-Za-z]{2})?(\d{2})(\d{2})(\d{2})\.(\d{2})(\d{2})/;
const AIRTEL_FULL_CODE = /^[A-Za-z]{2}(\d{2})(\d{2})(\d{2})\.(\d{2})(\d{2})\.[A-Za-z]\d+$/;

function parseAirtelShipped(raw) {
    const short = raw.slice(2);
    const year = 2000 + parseInt(short.substring(0, 2), 10);
    const month = parseInt(short.substring(2, 4), 10) - 1;
    const day = parseInt(short.substring(4, 6), 10);
    const hour = parseInt(short.substring(7, 9), 10);
    const minute = parseInt(short.substring(9, 11), 10);
    return new Date(year, month, day, hour, minute, 0).getTime();
}

function parseAirtelTolerant(raw) {
    const parts = AIRTEL_SHORTCODE_PATTERN.exec(raw);
    if (!parts) return NaN;
    const [year, month, day, hour, minute] = parts.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return NaN;
    const date = new Date(2000 + year, month - 1, day, hour, minute, 0);
    return date.getMonth() === month - 1 ? date.getTime() : NaN;
}

function airtelReferenceDate(raw) {
    const parts = AIRTEL_FULL_CODE.exec(raw);
    if (!parts) return NaN;
    const [year, month, day, hour, minute] = parts.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return NaN;
    const date = new Date(2000 + year, month - 1, day, hour, minute, 0);
    return date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : NaN;
}

// null when the three readers agree on a finite time, otherwise why they do not.
function airtelTimestampProblem(raw) {
    const reference = airtelReferenceDate(raw);
    if (!Number.isFinite(reference)) {
        if (Number.isFinite(parseAirtelTolerant(raw)) && !Number.isFinite(parseAirtelShipped(raw))) {
            return `"${raw}" has no two-letter prefix: app builds before the tolerant parser read it as an invalid date. Capture the full Airtel code, the group that holds the transaction id`;
        }
        return `"${raw}" is not a full Airtel code (two letters, YYMMDD.HHMM, a dot and a letter with digits) with a real date and time`;
    }
    const shipped = parseAirtelShipped(raw);
    if (shipped !== reference) return `"${raw}" is read as ${Number.isFinite(shipped) ? new Date(shipped).toISOString() : 'an invalid date'} by released app builds`;
    const tolerant = parseAirtelTolerant(raw);
    if (tolerant !== reference) return `"${raw}" is read as ${Number.isFinite(tolerant) ? new Date(tolerant).toISOString() : 'an invalid date'} by the current app`;
    return null;
}

function parseTimestamp(raw, parser) {
    if (parser === 'airtel-shortcode') return parseAirtelTolerant(raw);
    return new Date(raw).getTime();
}

// What ios/RegexPatternProvider.swift parseStandardDate reads (checked against the real
// DateFormatter / ISO8601DateFormatter code): "yyyy-MM-dd HH:mm:ss" with no zone and no
// fraction, or an ISO 8601 date-time with a T and a zone (Z or an offset), with or
// without a fraction. Anything else is not parsed and the transaction gets the time it
// was processed at.
const IOS_PLAIN_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const IOS_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function iosCanParseTimestamp(raw) {
    return (IOS_PLAIN_TIMESTAMP.test(raw) || IOS_ISO_TIMESTAMP.test(raw)) && Number.isFinite(new Date(raw).getTime());
}

function extractFields(def, groups, warnings) {
    const map = def.captureMap && typeof def.captureMap === 'object' ? def.captureMap : {};
    const take = role => {
        const g = Number(map[role]);
        return Number.isInteger(g) && g > 0 && groups[g] ? groups[g] : null;
    };
    const fields = {
        type: typeof def.type === 'string' ? def.type : 'payment',
        direction: def.type === 'receive' || def.type === 'deposit' ? 'in' : 'out',
        amount: 0,
        balance: 0,
    };
    const amount = take('amount');
    if (amount !== null) fields.amount = fastParseInt(amount);
    const balance = take('balance');
    if (balance !== null) fields.balance = fastParseInt(balance);
    const fee = take('fee');
    if (fee !== null) fields.fee = fastParseInt(fee);
    for (const role of ['secondParty', 'accountNumber', 'transactionId', 'agentName', 'agentNumber']) {
        const value = take(role);
        if (value !== null) fields[role] = value.trim();
    }
    const ts = def.timestamp && typeof def.timestamp === 'object' ? def.timestamp : null;
    if (ts) {
        const g = Number(ts.group);
        if (Number.isFinite(g) && groups[g]) {
            const raw = groups[g].trim();
            const ms = parseTimestamp(raw, ts.parser);
            fields.timestampRaw = raw;
            fields.timestampMs = Number.isFinite(ms) ? ms : null;
            fields.timestampIso = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
            if (ts.parser === 'airtel-shortcode') {
                const problem = airtelTimestampProblem(raw);
                if (problem) warnings.push(`airtel-shortcode timestamp: ${problem}`);
            } else if (!Number.isFinite(ms)) {
                warnings.push('timestamp group could not be parsed with the declared parser');
            }
        }
    }
    return fields;
}

function testPattern(def, message, options) {
    const timeoutMs = options && options.timeoutMs !== undefined ? options.timeoutMs : 50;
    const result = {matched: false, captures: null, fields: null, elapsedMs: 0, timedOut: false, warnings: []};
    const fail = error => ({...result, error});
    if (!def || typeof def !== 'object') return fail('pattern definition missing');
    if (typeof def.pattern !== 'string' || def.pattern.length === 0) return fail('pattern must be a non-empty string');
    if (def.pattern.length > MAX_TEST_PATTERN_LENGTH) return fail(`pattern longer than ${MAX_TEST_PATTERN_LENGTH} characters`);
    if (typeof message !== 'string') return fail('message must be a string');
    if (message.length > MAX_TEST_MESSAGE_LENGTH) return fail(`message longer than ${MAX_TEST_MESSAGE_LENGTH} characters`);
    const flags = safeFlagsOf(def.flags);
    if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) return fail('flags must be a subset of i, m, s, u');
    const requested = Number(timeoutMs);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.max(requested, 1), 1000) : 50;

    let sandbox;
    try {
        sandbox = createSandbox(def.pattern, flags, {compileTimeoutMs: limit});
    } catch (error) {
        if (error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return {...result, timedOut: true, error: 'regex compilation timed out'};
        return fail(`invalid regex: ${error && error.message ? error.message : 'could not compile'}`);
    }
    const run = sandbox.exec(message, limit);
    result.elapsedMs = run.elapsedMs;
    result.timedOut = run.timedOut;
    if (run.timedOut) {
        result.error = `regex execution exceeded ${limit} ms and was stopped`;
        return result;
    }
    if (!run.matched) return result;
    result.matched = true;
    result.captures = run.groups.map(g => (g === null ? null : g));
    result.fields = extractFields(def, run.groups, result.warnings);
    return result;
}

function readQuantifier(src, i) {
    const c = src[i];
    let len = 0;
    let unbounded = false;
    if (c === '*' || c === '+') {
        len = 1;
        unbounded = true;
    } else if (c === '?') {
        len = 1;
    } else if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 24));
        if (m) {
            len = m[0].length;
            unbounded = m[2] !== undefined && m[3] === '';
        }
    }
    if (len && src[i + len] === '?') len += 1;
    return {len, unbounded};
}

function findNestedUnboundedQuantifier(src) {
    const stack = [];
    let inClass = false;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (inClass) {
            if (c === ']') inClass = false;
            i++;
            continue;
        }
        if (c === '[') {
            inClass = true;
            i++;
            continue;
        }
        if (c === '(') {
            stack.push({inner: false});
            i++;
            if (src[i] === '?') {
                if (src[i + 1] === '<' && src[i + 2] !== '=' && src[i + 2] !== '!') {
                    const end = src.indexOf('>', i);
                    i = end === -1 ? src.length : end + 1;
                } else if (src[i + 1] === '<') {
                    i += 3;
                } else {
                    i += 2;
                }
            }
            continue;
        }
        if (c === ')') {
            const group = stack.pop() || {inner: false};
            i++;
            const q = readQuantifier(src, i);
            i += q.len;
            if (q.unbounded && group.inner) return true;
            if (stack.length && (group.inner || q.unbounded)) stack[stack.length - 1].inner = true;
            continue;
        }
        const q = readQuantifier(src, i);
        if (q.len) {
            if (q.unbounded && stack.length) stack[stack.length - 1].inner = true;
            i += q.len;
            continue;
        }
        i++;
    }
    return false;
}

let corpusCache = null;

function loadNegativeCorpus() {
    if (corpusCache) return corpusCache;
    let raw;
    try {
        raw = require('../../assets/manie/negative-corpus.json');
    } catch (_) {
        return [];
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.messages) ? raw.messages : [];
    corpusCache = list
        .filter(m => m && typeof m.body === 'string' && m.body.length > 0)
        .map((m, i) => ({id: m.id || `neg-${i + 1}`, body: m.body, category: m.category || null}));
    return corpusCache;
}

function isIntegerInRange(value, max) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

function coerceGroup(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
    return value;
}

function checkCompiles(draft, state) {
    const name = CHECK_NAMES[0];
    if (typeof draft.pattern !== 'string' || draft.pattern.length === 0) return {name, ok: false, detail: 'pattern must be a non-empty string'};
    if (draft.pattern.length > 20000) return {name, ok: false, detail: 'pattern is far too long to compile safely'};
    const flags = safeFlagsOf(draft.flags);
    if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) {
        return {name, ok: false, detail: `flags "${flags}" not supported (allowed: i, m, s, u; g and y are stripped)`};
    }
    try {
        state.groupCount = countGroups(draft.pattern, flags);
    } catch (error) {
        return {name, ok: false, detail: `does not compile: ${error.message}`};
    }
    state.flags = flags;
    return {name, ok: true, detail: `compiles with flags "${flags}", ${state.groupCount} capture groups`};
}

function checkCaptureMap(draft, state) {
    const name = CHECK_NAMES[1];
    if (state.groupCount === undefined) return {name, ok: false, detail: 'skipped: regex does not compile'};
    const problems = [];
    const used = new Map();
    const map = draft.captureMap;
    if (map === undefined || map === null || typeof map !== 'object' || Array.isArray(map)) {
        return {name, ok: false, detail: 'captureMap must be an object of role -> group number'};
    }
    state.captureMap = {};
    for (const [role, raw] of Object.entries(map)) {
        const value = coerceGroup(raw);
        if (!CAPTURE_ROLES.includes(role)) {
            problems.push(`unknown role "${role}"`);
            continue;
        }
        if (!isIntegerInRange(value, state.groupCount)) {
            problems.push(`${role}=${JSON.stringify(raw)} is not an integer in 1..${state.groupCount}`);
            continue;
        }
        if (used.has(value)) problems.push(`group ${value} used by both ${used.get(value)} and ${role}`);
        else used.set(value, role);
        state.captureMap[role] = value;
    }
    if (draft.timestamp !== undefined && draft.timestamp !== null) {
        const ts = draft.timestamp;
        const group = coerceGroup(ts && ts.group);
        if (typeof ts !== 'object') problems.push('timestamp must be an object {group, parser}');
        else if (!isIntegerInRange(group, state.groupCount)) problems.push(`timestamp.group=${JSON.stringify(ts.group)} is not an integer in 1..${state.groupCount}`);
        else {
            // An Airtel code carries its own time, so the one group that holds the full code
            // is both the transaction id and the airtel-shortcode timestamp.
            const sharesFullCode = used.get(group) === 'transactionId' && ts.parser === 'airtel-shortcode';
            if (used.has(group) && !sharesFullCode) problems.push(`group ${group} used by both ${used.get(group)} and timestamp`);
            state.timestampGroup = group;
        }
        if (typeof ts === 'object' && !PARSERS.includes(ts.parser)) problems.push(`timestamp.parser must be one of ${PARSERS.join(', ')}`);
    }
    if (problems.length) return {name, ok: false, detail: problems.join('; ')};
    return {name, ok: true, detail: `${Object.keys(state.captureMap).length} roles mapped to distinct groups`};
}

function checkRequired(draft, state) {
    const name = CHECK_NAMES[2];
    if (!state.captureMap) return {name, ok: false, detail: 'skipped: captureMap invalid'};
    const problems = [];
    if (!state.captureMap.amount) problems.push('amount capture is required');
    if (!state.captureMap.balance) problems.push('balance capture is required (the app would otherwise store a balance of 0)');
    if (!state.captureMap.transactionId && !state.timestampGroup) {
        problems.push('needs a transactionId or timestamp capture (the app rejects patterns with neither, to avoid duplicate transactions)');
    }
    if (problems.length) return {name, ok: false, detail: problems.join('; ')};
    const via = [state.captureMap.transactionId ? 'transactionId' : null, state.timestampGroup ? 'timestamp' : null].filter(Boolean);
    return {name, ok: true, detail: `amount + balance + ${via.join(' and ')} present`};
}

function checkType(draft) {
    const name = CHECK_NAMES[3];
    const problems = [];
    if (!VALID_TYPES.includes(draft.type)) problems.push(`type must be one of ${VALID_TYPES.join(', ')}`);
    if (typeof draft.id !== 'string' || !ID_RE.test(draft.id)) problems.push('id must be 2-64 chars of letters, digits, dot, dash, underscore');
    const skeleton = skeletonOf(draft);
    const guess = skeleton ? guessTypeOfSkeleton(skeleton) : null;
    const confirmed = Boolean(draft.sourceShape && draft.sourceShape.typeConfirmed);
    if (guess && guess.defaulted && draft.type === guess.type && !confirmed) {
        problems.push(`the type "${guess.type}" is only a default: ${guess.reason}. Pick the type explicitly (money coming in must not be recorded as going out)`);
    }
    if (problems.length) return {name, ok: false, detail: problems.join('; ')};
    return {name, ok: true, detail: `type ${draft.type}, id ${draft.id}`};
}

function repeatTo(text, length) {
    let out = '';
    while (out.length < length) out += text;
    return out.slice(0, length);
}

function literalWordsOf(skeleton) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return [];
    const seen = new Set();
    for (const t of parsed.tokens) if (t.type === 'word') seen.add(t.text);
    return [...seen].sort((a, b) => b.length - a.length).slice(0, 6);
}

function stressMessage(skeleton) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return null;
    let out = '';
    for (const t of normalizeTokens(parsed.tokens)) {
        if (t.type === 'space') out += ' ';
        else if (t.type === 'ph') {
            if (t.kind === 'N') out += repeatTo('9,', 80);
            else if (t.kind === 'PH') out += repeatTo('9', 60);
            else if (t.kind === 'W' || t.kind === 'W+') out += repeatTo('a ', 80);
            else out += synthesize(`{${t.kind}}`).message;
        } else out += t.text;
    }
    return out;
}

const STRESS_UNITS = {
    N: ['9', '9.', '9,', '9.9,', ' ', ' | '],
    PH: ['9', '9 ', '9-', '9.', '9,', ' ', ' | '],
    W: ['a', "a'", 'a9', ' ', ' | '],
    'W+': ['a', 'a ', 'a|', 'a\n', ' ', ' | '],
    URL: ['a', 'a.', 'a/', ' ', ' | '],
    EMAIL: ['a', 'a.', 'a@', ' ', ' | '],
};

// For every variable slot: the text of the message up to that slot, then a long run built
// from what the slot can match and from every punctuation character the skeleton puts
// next to slots, and nothing after it, so that whatever the pattern expects next fails
// only after the run has been explored in every way. A fixed filler would miss a chain
// like {N}.{N}.{N}, whose slots only compete when the run contains a dot.
function slotStressFamilies(skeleton) {
    const parsed = tokenizeSkeleton(skeleton);
    if (!parsed.ok) return [];
    const tokens = normalizeTokens(parsed.tokens);
    const filled = synthesize(skeleton, {variant: 0});
    const textOf = new Map(filled.parts.map(part => [part.ordinal, part.text]));
    const punct = Array.from(new Set(tokens.filter(t => t.type === 'punct').map(t => t.text))).slice(0, 4);
    const families = [];
    let prefix = '';
    tokens.forEach((t, index) => {
        if (t.type === 'ph' && STRESS_UNITS[t.kind]) {
            const wildcard = t.kind === 'W+' || t.kind === 'URL' || t.kind === 'EMAIL';
            const units = STRESS_UNITS[t.kind].concat(wildcard ? punct.map(p => `a${p}`) : punct.map(p => `9${p}`));
            const next = tokens.slice(index + 1).find(x => x.type !== 'space');
            // free text followed by a word repeats that word, so that a pattern with several
            // free-text slots can split the run between them in many ways
            if (wildcard && next && next.type === 'word') units.push(`a ${next.text} `);
            for (const unit of new Set(units)) families.push({label: `${t.kind} slot ${t.ordinal + 1}, run of ${JSON.stringify(unit)}`, prefix, unit});
        }
        if (t.type === 'space') prefix += ' ';
        else if (t.type === 'ph') prefix += textOf.get(t.ordinal) || '';
        else prefix += t.text;
    });
    return families.slice(0, MAX_STRESS_FAMILIES);
}

function adversarialInputs(skeleton) {
    const inputs = [
        repeatTo('9', 800),
        repeatTo(' ', 800),
        repeatTo('RWF ', 800),
        repeatTo('a', 800),
        repeatTo('1,', 800),
        repeatTo('.', 800),
        repeatTo('x ', 800),
        repeatTo('5000 RWF ', 800),
        repeatTo(' | ', 800),
        `${repeatTo(' ', 400)}0${repeatTo(' ', 399)}`,
    ];
    if (skeleton) {
        try {
            const base = synthesize(skeleton).message;
            inputs.push(
                `${repeatTo(' ', 700)}${base}`,
                `${base}${repeatTo(' ', 700)}`,
                base.slice(0, Math.max(1, base.length - 3)),
                repeatTo(`${base} `, 800),
            );
            const words = literalWordsOf(skeleton);
            if (words.length) inputs.push(repeatTo(`${words.join(' ')} `, 800));
            const stress = stressMessage(skeleton);
            if (stress) inputs.push(stress.slice(0, 1000), stress.slice(0, Math.max(1, stress.length - 3)).slice(0, 1000));
        } catch (_) {
            // skeleton problems are reported by the self-match check
        }
    }
    return inputs;
}

function skeletonOf(draft) {
    const shape = draft && draft.sourceShape;
    if (!shape || typeof shape !== 'object') return null;
    if (typeof shape.synthSkeleton === 'string' && shape.synthSkeleton) return shape.synthSkeleton;
    return typeof shape.skeleton === 'string' && shape.skeleton ? shape.skeleton : null;
}

function describeChain(chain) {
    const joined = chain.separator ? `only by ${JSON.stringify(chain.separator)}` : 'directly';
    return `placeholders ${chain.first} and ${chain.second} (${chain.kinds.join(', ')}) touch ${joined}, so both can claim the same text and a failed match backtracks over every split`;
}

function execBest(sandbox, input) {
    let run = sandbox.exec(input, HARD_TIMEOUT_MS);
    if (!run.timedOut && run.busyMs > EXEC_LIMIT_MS) {
        const retry = sandbox.exec(input, HARD_TIMEOUT_MS);
        if (retry.timedOut || retry.busyMs < run.busyMs) run = retry;
    }
    return run;
}

function checkRedos(draft, state) {
    const name = CHECK_NAMES[4];
    if (state.groupCount === undefined) return {name, ok: false, detail: 'skipped: regex does not compile'};
    const problems = [];
    if (draft.pattern.length > MAX_SOURCE_LENGTH) problems.push(`pattern is ${draft.pattern.length} chars (max ${MAX_SOURCE_LENGTH})`);
    if (state.groupCount > MAX_GROUPS) problems.push(`${state.groupCount} capture groups (max ${MAX_GROUPS})`);
    if (findNestedUnboundedQuantifier(draft.pattern)) problems.push('nested unbounded quantifiers such as (...*)*');
    const skeleton = skeletonOf(draft);
    if (skeleton) for (const chain of ambiguousSlotChains(skeleton).slice(0, 2)) problems.push(describeChain(chain));
    if (skeleton) {
        const parsed = tokenizeSkeleton(skeleton);
        const freeText = parsed.ok ? parsed.tokens.filter(t => t.type === 'ph' && (t.kind === 'W+' || t.kind === 'URL' || t.kind === 'EMAIL')).length : 0;
        if (freeText > MAX_FREE_TEXT_SLOTS) {
            problems.push(`${freeText} free-text slots (max ${MAX_FREE_TEXT_SLOTS}): a failed match costs a polynomial of that degree in the length of the message`);
        }
    }
    if (problems.length) {
        state.redosFailed = true;
        return {name, ok: false, detail: `${problems.join('; ')}; dynamic probe skipped`};
    }
    let sandbox;
    try {
        sandbox = createSandbox(draft.pattern, state.flags);
    } catch (error) {
        state.redosFailed = true;
        return {name, ok: false, detail: `could not prepare the probe: ${error.message}`};
    }
    sandbox.exec('warm up', HARD_TIMEOUT_MS);
    sandbox.exec('warm up again', HARD_TIMEOUT_MS);
    let worst = 0;
    let probes = 0;
    const fail = (input, what) => {
        state.redosFailed = true;
        return {name, ok: false, detail: `adversarial input #${probes} (${input.length} chars) ${what} (limit ${EXEC_LIMIT_MS} ms)`};
    };
    for (const input of adversarialInputs(skeleton)) {
        const run = execBest(sandbox, input);
        probes += 1;
        worst = Math.max(worst, run.busyMs);
        if (run.timedOut || run.busyMs > EXEC_LIMIT_MS) {
            return fail(input, run.timedOut ? `was interrupted after ${HARD_TIMEOUT_MS} ms` : `took ${run.busyMs.toFixed(1)} ms of CPU`);
        }
    }
    // The same run at two lengths: a phone is slower than this server, so growth matters
    // as much as the absolute time.
    if (skeleton) {
        for (const family of slotStressFamilies(skeleton)) {
            const [short, long] = STRESS_LENGTHS.map(length => `${family.prefix}${repeatTo(family.unit, length)}`);
            const runShort = execBest(sandbox, short);
            let runLong = execBest(sandbox, long);
            probes += 2;
            for (let retry = 0; retry < 2 && !runLong.timedOut && runLong.busyMs > STRESS_LIMIT_MS; retry++) {
                const again = sandbox.exec(long, HARD_TIMEOUT_MS);
                if (again.timedOut || again.busyMs < runLong.busyMs) runLong = again;
            }
            worst = Math.max(worst, runShort.busyMs, runLong.busyMs);
            if (runLong.timedOut || runLong.busyMs > STRESS_LIMIT_MS) {
                const what = runLong.timedOut ? `was interrupted after ${HARD_TIMEOUT_MS} ms` : `took ${runLong.busyMs.toFixed(1)} ms of CPU`;
                state.redosFailed = true;
                return {name, ok: false, detail: `a ${long.length}-char message (${family.label}) ${what} (limit ${STRESS_LIMIT_MS} ms at this length, a phone is far slower than this server)`};
            }
            if (runLong.busyMs >= GROWTH_FLOOR_MS) {
                const again = [execBest(sandbox, short), execBest(sandbox, long)];
                const t1 = Math.min(runShort.busyMs, again[0].busyMs);
                const t2 = Math.min(runLong.busyMs, again[1].busyMs);
                if (t2 >= GROWTH_FLOOR_MS && t2 / Math.max(t1, 0.1) > GROWTH_RATIO) {
                    return fail(long, `(${family.label}) took ${t2.toFixed(1)} ms against ${t1.toFixed(1)} ms at half the length, which is super-linear growth`);
                }
            }
        }
    }
    state.sandbox = sandbox;
    return {name, ok: true, detail: `${probes} adversarial inputs, slowest ${worst.toFixed(2)} ms (limit ${EXEC_LIMIT_MS} ms)`};
}

const SHAPE_VALIDATORS = {
    amount: v => /^\d[\d,.]*$/.test(v) && Number.isFinite(fastParseInt(v)),
    fee: v => /^\d[\d,.]*$/.test(v) && Number.isFinite(fastParseInt(v)),
    balance: v => /^\d[\d,.]*$/.test(v) && Number.isFinite(fastParseInt(v)),
    accountNumber: v => /^\+?\d[\d,. -]{2,30}$/.test(v),
    agentNumber: v => /^\+?\d[\d,. -]{2,30}$/.test(v),
    transactionId: v => /^\S{3,40}$/.test(v),
    secondParty: v => v.length > 0 && /[A-Za-z]/.test(v),
    agentName: v => v.length > 0 && /[A-Za-z]/.test(v),
};

function plantedFor(layout, group, parts) {
    const slot = layout.slots.find(s => s.group === group);
    if (!slot) return null;
    const part = parts.find(p => p.ordinal === slot.ordinal);
    return part ? part.text : null;
}

function verifyVariant(draft, state, skeleton, layout, aligned, variant) {
    const roleByOrdinal = new Map();
    if (aligned) {
        for (const [role, group] of Object.entries(state.captureMap)) {
            const slot = layout.slots.find(s => s.group === group);
            if (slot) roleByOrdinal.set(slot.ordinal, role);
        }
    }
    const {message, parts} = synthesize(skeleton, {variant, roleByOrdinal});
    const run = state.sandbox.exec(message, HARD_TIMEOUT_MS);
    if (run.timedOut) return {ok: false, problem: `variant ${variant}: execution timed out`};
    if (!run.matched) return {ok: false, problem: `variant ${variant}: synthesized message does not match`};
    const problems = [];
    let verified = 0;
    for (const [role, group] of Object.entries(state.captureMap)) {
        const raw = run.groups[group];
        if (raw === null || raw === undefined) {
            problems.push(`${role} (group ${group}) captured nothing`);
            continue;
        }
        const text = raw.trim();
        if (!SHAPE_VALIDATORS[role](text)) problems.push(`${role} (group ${group}) captured a value of the wrong shape`);
        else if (aligned) {
            const planted = plantedFor(layout, group, parts);
            if (planted !== null && planted !== text) problems.push(`${role} (group ${group}) captured a different slot than expected`);
            else verified += 1;
        } else verified += 1;
    }
    if (state.timestampGroup) {
        const raw = run.groups[state.timestampGroup];
        const parser = draft.timestamp.parser;
        const text = typeof raw === 'string' ? raw.trim() : '';
        let timestampProblem = null;
        if (typeof raw !== 'string') timestampProblem = `does not parse with ${parser}`;
        else if (parser === 'airtel-shortcode') timestampProblem = airtelTimestampProblem(text);
        else if (!Number.isFinite(parseTimestamp(text, parser))) timestampProblem = `does not parse with ${parser}`;
        else if (!iosCanParseTimestamp(text)) timestampProblem = `captured "${text}", a form the iOS app cannot read (it would store the processing time instead)`;
        if (timestampProblem) {
            problems.push(`timestamp (group ${state.timestampGroup}) ${timestampProblem}`);
        } else if (aligned) {
            const planted = plantedFor(layout, state.timestampGroup, parts);
            if (planted !== null && planted !== text) problems.push(`timestamp (group ${state.timestampGroup}) captured a different slot than expected`);
            else verified += 1;
        } else verified += 1;
    }
    if (problems.length) return {ok: false, problem: `variant ${variant}: ${problems.join(', ')}`};
    return {ok: true, verified};
}

// Codes that are not dates under the fixed-offset readers: if the pattern lets one of them
// through, the app stores a wrong time for it (released builds roll the date over instead
// of refusing it). A pattern has to reject them, not rely on the parsers to notice.
// The list is not a hand-picked sample: it is every code one edit away from a valid one (a
// character deleted, replaced or inserted, which covers a prefix of the wrong length, a missing
// dot, an optional part, a month or hour out of range) that is not a real code, plus the
// codes the first version of this check named.
const VALID_AIRTEL_CODE = 'PP260411.1430.A12345';
const FIXED_MALFORMED_AIRTEL_CODES = [
    'PP261301.1430.A12345',
    'PP260011.1430.A12345',
    'PP260400.1430.A12345',
    'PP260432.1430.A12345',
    'PP260411.2430.A12345',
    'PP260411.1460.A12345',
    'PP2604111.1430.A12345',
    'PP26041.1430.A12345',
    'PP260411.143.A12345',
    'PP260411.14300.A12345',
];

// Not a real code by shape or by range; a day that merely does not exist in its month is left out
// (the generated expression accepts those, as Airtel never writes one).
function malformedAirtelCode(code) {
    const parts = AIRTEL_FULL_CODE.exec(code);
    if (!parts) return true;
    const [, month, day, hour, minute] = parts.slice(1).map(Number);
    return month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59;
}

function singleEditCodes(code) {
    const out = new Set();
    for (let i = 0; i < code.length; i++) {
        out.add(code.slice(0, i) + code.slice(i + 1));
        for (const c of ['0', '9', 'Z', '.', ' ', '-']) if (c !== code[i]) out.add(code.slice(0, i) + c + code.slice(i + 1));
    }
    for (let i = 0; i <= code.length; i++) for (const c of ['0', '9', 'A', '.']) out.add(code.slice(0, i) + c + code.slice(i));
    return Array.from(out);
}

const MALFORMED_AIRTEL_CODES = Array.from(new Set([...FIXED_MALFORMED_AIRTEL_CODES, ...singleEditCodes(VALID_AIRTEL_CODE).filter(malformedAirtelCode)]));

// The source text of the n-th capture group of a pattern (null when there is none).
function captureGroupSource(source, n) {
    const stack = [];
    let count = 0;
    let inClass = false;
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === '\\') {
            i += 1;
        } else if (inClass) {
            if (c === ']') inClass = false;
        } else if (c === '[') {
            inClass = true;
        } else if (c === '(') {
            const capturing = source[i + 1] !== '?' || (source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!');
            stack.push({capturing, index: capturing ? ++count : 0, start: i + 1});
        } else if (c === ')') {
            const group = stack.pop();
            if (group && group.capturing && group.index === n) return source.slice(group.start, i);
        }
    }
    return null;
}

// The Airtel code is the one value that three readers (two Android builds and the iOS parser) turn
// into a time, so the group that captures it is held to exactly what the generator writes, and, as
// a property rather than a blacklist, to rejecting every near-miss of a real code. Both run
// whether or not the pattern's groups line up with the skeleton.
function airtelGroupProblem(draft, state, skeleton) {
    const layout = layoutOf(skeleton);
    const slot = layout && layout.slots.find(x => x.kind === 'TID');
    if (slot) {
        const planted = plantedMessage(skeleton, state, new Map([[slot.ordinal, VALID_AIRTEL_CODE]]));
        for (const code of MALFORMED_AIRTEL_CODES) {
            const message = planted.synth.message.split(VALID_AIRTEL_CODE).join(code);
            const run = state.sandbox.exec(message, HARD_TIMEOUT_MS);
            if (run.timedOut) return `execution timed out on the code "${code}"`;
            if (!run.matched) continue;
            const captured = typeof run.groups[state.timestampGroup] === 'string' ? run.groups[state.timestampGroup].trim() : '';
            const problem = airtelTimestampProblem(captured);
            if (problem) return `the pattern accepts the malformed Airtel code "${code}" and would store a wrong time for it: ${problem}`;
        }
    }
    if (captureGroupSource(draft.pattern, state.timestampGroup) !== TID_REGEX.slice(1, -1)) {
        return `the group that holds the Airtel code (group ${state.timestampGroup}) is not the expression the generator writes: released app builds read that text at fixed offsets, so it has to accept exactly the codes the generator accepts`;
    }
    return null;
}

function checkSelfMatch(draft, state) {
    const name = CHECK_NAMES[5];
    if (state.redosFailed) return {name, ok: false, detail: 'skipped: ReDoS guard failed'};
    if (!state.sandbox || !state.captureMap) return {name, ok: false, detail: 'skipped: earlier structural checks failed'};
    const skeleton = skeletonOf(draft);
    if (!skeleton) return {name, ok: false, detail: 'draft has no sourceShape.skeleton to synthesize a message from'};
    const layout = layoutOf(skeleton);
    if (!layout) return {name, ok: false, detail: 'sourceShape.skeleton is not a valid skeleton'};
    const aligned = layout.groupCount === state.groupCount;
    const results = [0, 1].map(variant => verifyVariant(draft, state, skeleton, layout, aligned, variant));
    const failed = results.filter(r => !r.ok);
    if (failed.length) return {name, ok: false, detail: failed.map(f => f.problem).join('; ')};
    let probed = '';
    if (state.timestampGroup && draft.timestamp.parser === 'airtel-shortcode') {
        const problem = airtelGroupProblem(draft, state, skeleton);
        if (problem) return {name, ok: false, detail: problem};
        probed = `, ${MALFORMED_AIRTEL_CODES.length} malformed Airtel codes rejected`;
    }
    return {
        name,
        ok: true,
        detail: `2 synthesized variants matched, ${results[0].verified + results[1].verified} captures verified${aligned ? ' against planted values' : ' by shape'}${probed}`,
    };
}

function checkNegatives(draft, state) {
    const name = CHECK_NAMES[6];
    if (state.redosFailed) return {name, ok: false, detail: 'skipped: ReDoS guard failed'};
    if (!state.sandbox) return {name, ok: false, detail: 'skipped: earlier structural checks failed'};
    const corpus = loadNegativeCorpus();
    if (corpus.length === 0) return {name, ok: false, detail: 'negative corpus is missing or empty'};
    const hits = [];
    for (const item of corpus) {
        const run = state.sandbox.exec(item.body, HARD_TIMEOUT_MS);
        if (run.timedOut) return {name, ok: false, detail: `execution timed out on corpus message ${item.id}`};
        if (run.matched) hits.push(item.id);
    }
    if (hits.length) {
        return {name, ok: false, detail: `matches ${hits.length} non-transaction message(s): ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', ...' : ''}`};
    }
    return {name, ok: true, detail: `matches none of ${corpus.length} failed/OTP/PIN/promo/maintenance messages`};
}

const SAMPLE_AIRTEL_CODE = 'PP260411.1430.A12345';
const sampleCache = new Map();

function samplesFor(existing) {
    const skeleton = existing.sourceShape && typeof existing.sourceShape.skeleton === 'string' ? existing.sourceShape.skeleton : '';
    const key = [existing.id, existing.pattern, existing.flags || '', skeleton].join('\u0000');
    if (sampleCache.has(key)) return sampleCache.get(key);
    const candidates = [];
    if (skeleton) {
        try {
            candidates.push(synthesize(skeleton, {variant: 0}).message, synthesize(skeleton, {variant: 1}).message);
        } catch (_) {
            // fall through to regex-derived sample
        }
    }
    if (candidates.length === 0) {
        const sample = sampleFromRegex(existing.pattern);
        if (sample) {
            candidates.push(sample);
            // The regex sampler writes any digits it likes into a transaction code; real
            // codes are dates, and a draft that only accepts real codes must still be
            // compared against the messages of the pattern it could shadow.
            const realistic = sample.replace(/[A-Za-z]{2}\d+\.\d+\.[A-Za-z]\d+/g, SAMPLE_AIRTEL_CODE);
            if (realistic !== sample) candidates.push(realistic);
        }
    }
    const verified = [];
    try {
        const sandbox = createSandbox(existing.pattern, safeFlagsOf(existing.flags).replace(/[^imsu]/g, ''));
        for (const sample of candidates) {
            const run = sandbox.exec(sample, HARD_TIMEOUT_MS);
            if (run.matched) verified.push(sample);
        }
    } catch (_) {
        // an existing pattern that will not compile contributes no samples
    }
    if (sampleCache.size > 1000) sampleCache.clear();
    sampleCache.set(key, verified);
    return verified;
}

function checkShadow(draft, state, existingPatterns) {
    const name = CHECK_NAMES[7];
    if (state.redosFailed) return {name, ok: false, detail: 'skipped: ReDoS guard failed'};
    if (!state.sandbox) return {name, ok: false, detail: 'skipped: earlier structural checks failed'};
    const active = (Array.isArray(existingPatterns) ? existingPatterns : []).filter(
        p => p && typeof p.pattern === 'string' && p.id !== draft.id && (p.status === undefined || p.status === 'active') && !p.disabled,
    );
    if (active.length === 0) return {name, ok: true, detail: 'no existing active patterns supplied, nothing to compare against'};
    const conflicts = [];
    let compared = 0;
    for (const existing of active) {
        const existingType = typeof existing.type === 'string' && existing.type ? existing.type : 'payment';
        if (existingType === draft.type) continue;
        for (const sample of samplesFor(existing)) {
            compared += 1;
            const run = state.sandbox.exec(sample, HARD_TIMEOUT_MS);
            if (run.timedOut) return {name, ok: false, detail: `execution timed out on a sample of ${existing.id}`};
            if (run.matched) {
                conflicts.push(`${existing.id} (${existingType})`);
                break;
            }
        }
    }
    if (conflicts.length) {
        return {name, ok: false, detail: `also matches samples of ${conflicts.slice(0, 4).join(', ')} which are typed differently from ${draft.type}`};
    }
    return {name, ok: true, detail: `no conflict across ${compared} samples from ${active.length} existing patterns`};
}

function checkWordSlots(draft, state) {
    const name = CHECK_NAMES[8];
    if (!state.captureMap) return {name, ok: false, detail: 'skipped: captureMap invalid'};
    const skeleton = skeletonOf(draft);
    if (!skeleton) return {name, ok: false, detail: 'draft has no sourceShape.skeleton to inspect'};
    const open = ambiguousWordSlots(skeleton, state.captureMap);
    if (open.length) {
        const list = open.map(slot => `word slot ${slot.wordNo}`).join(', ');
        return {
            name,
            ok: false,
            detail: `${list}: a single unknown word that the pattern would match against any text (a status such as "approved" would match "reversed" too). Add the real word with wordsAsLiteral, for example ["${open[0].wordNo}: word"]`,
        };
    }
    return {name, ok: true, detail: 'no single unknown word is left to match against arbitrary text'};
}

function checkRoleKeywords(draft, state) {
    const name = CHECK_NAMES[9];
    if (!state.captureMap) return {name, ok: false, detail: 'skipped: captureMap invalid'};
    const skeleton = skeletonOf(draft);
    if (!skeleton) return {name, ok: false, detail: 'draft has no sourceShape.skeleton to inspect'};
    const conflicts = keywordConflicts(skeleton, state.captureMap);
    const unsupported = amountProblems(skeleton, state.captureMap, Boolean(draft.sourceShape && draft.sourceShape.amountConfirmed));
    if (conflicts.length || unsupported.length) {
        const problems = conflicts.map(c => `slot ${c.slotNo} is mapped to ${c.assigned} but the words before it say ${c.expected}`).concat(unsupported);
        return {
            name,
            ok: false,
            detail: `${problems.join('; ')}${unsupported.length ? '. If the amount slot is right, set the amount capture in the capture map (set it again) to confirm it' : ''}`,
        };
    }
    return {name, ok: true, detail: 'amount, fee and balance agree with the keywords next to them'};
}

function checkNameSlot(draft, state) {
    const name = CHECK_NAMES[10];
    if (!state.captureMap) return {name, ok: false, detail: 'skipped: captureMap invalid'};
    const skeleton = skeletonOf(draft);
    if (!skeleton) return {name, ok: false, detail: 'draft has no sourceShape.skeleton to inspect'};
    const confirmed = Boolean(draft.sourceShape && draft.sourceShape.nameConfirmed);
    const problems = nameSlotProblems(skeleton, state.captureMap, confirmed);
    if (problems.length) {
        return {
            name,
            ok: false,
            detail: `${problems.slice(0, 3).join('; ')}. If the mapping is right, confirm the person-name capture in the capture map (set it again, or clear it) to approve`,
        };
    }
    return {
        name,
        ok: true,
        detail: confirmed
            ? 'the person-name capture was confirmed by the admin'
            : 'the person-name capture follows a preposition or is the only free-text slot, and no literal word stands where a name or phone number is expected',
    };
}

function plantedMessage(skeleton, state, overrideByOrdinal) {
    const layout = layoutOf(skeleton);
    if (!layout) return null;
    const aligned = layout.groupCount === state.groupCount;
    const roleByOrdinal = new Map();
    if (aligned) {
        for (const [role, group] of Object.entries(state.captureMap)) {
            const slot = layout.slots.find(x => x.group === group);
            if (slot) roleByOrdinal.set(slot.ordinal, role);
        }
    }
    return {layout, aligned, synth: synthesize(skeleton, {variant: 0, roleByOrdinal, overrideByOrdinal})};
}

// A success pattern must not read "to SHOPPY LTD couldn't be completed" as a payment to
// a merchant: after every name slot the failure phrases are appended and the pattern has
// to stop matching. A name slot that ends the message cannot be tested this way, since
// nothing after it constrains the match.
function checkNegationSlots(draft, state) {
    const name = CHECK_NAMES[11];
    if (state.redosFailed) return {name, ok: false, detail: 'skipped: ReDoS guard failed'};
    if (!state.sandbox || !state.captureMap) return {name, ok: false, detail: 'skipped: earlier structural checks failed'};
    const skeleton = skeletonOf(draft);
    if (!skeleton) return {name, ok: false, detail: 'draft has no sourceShape.skeleton to inspect'};
    const base = plantedMessage(skeleton, state);
    if (!base) return {name, ok: false, detail: 'sourceShape.skeleton is not a valid skeleton'};
    const tokens = normalizeTokens(tokenizeSkeleton(skeleton).tokens);
    const lastToken = tokens[tokens.length - 1];
    const slots = base.synth.parts.filter(part => (part.kind === 'W' || part.kind === 'W+') && !(lastToken && lastToken.type === 'ph' && lastToken.ordinal === part.ordinal));
    if (slots.length === 0) return {name, ok: true, detail: 'no free-text slot is followed by more text, nothing to inject a failure phrase into'};
    const hits = [];
    for (const part of slots) {
        for (const phrase of NEGATION_PHRASES) {
            const planted = plantedMessage(skeleton, state, new Map([[part.ordinal, `${part.text} ${phrase}`]]));
            const run = state.sandbox.exec(planted.synth.message, HARD_TIMEOUT_MS);
            if (run.timedOut) return {name, ok: false, detail: `execution timed out with "${phrase}" after free-text slot ${part.ordinal + 1}`};
            if (run.matched) {
                hits.push(`free-text slot ${part.ordinal + 1} still matches when "${phrase}" follows the name`);
                break;
            }
        }
    }
    if (hits.length) {
        return {name, ok: false, detail: `${hits.join('; ')}: a failed or reversed payment would be recorded as a success. Build the slot from the generated pattern or spell the status word out`};
    }
    return {name, ok: true, detail: `${slots.length} free-text slot(s) stop matching when ${NEGATION_PHRASES.length} failure phrases follow the name`};
}

const TIMESTAMP_FORMS = [
    '2026-04-11 14:30:00',
    '2026-04-11T14:30:00',
    '2026-04-11 14:30:00.123',
    '2026-04-11T14:30:00.123',
    '2026-04-11T14:30:00Z',
    '2026-04-11T14:30:00.123Z',
    '2026-04-11T14:30:00+02:00',
    '2026-04-11 14:30:00Z',
    '2026-04-11 14:30:00+02:00',
];

// Not a failure: the {TS} regex deliberately accepts every form the anonymizer folds into
// the placeholder, so that an approved pattern never silently stops matching a message.
// iOS reads fewer forms than that; this reports which, so the admin knows what a
// transaction in such a form would get on an iPhone (the time it was processed).
function checkIosTimestamp(draft, state) {
    const name = CHECK_NAMES[12];
    if (state.timestampGroup && draft.timestamp && draft.timestamp.parser === 'airtel-shortcode') {
        return {
            name,
            ok: true,
            warn: true,
            detail: 'warning: iOS builds before the tolerant parseAirtelShort cannot read the two-letter prefix of the full Airtel code, so on those an iPhone stores the time the message was processed; current iOS builds read it correctly. Android builds before 0.0.32 (before 2026-02-19) read the full code as an invalid date: the row is dated 1970 and the same message is stored again on every rescan',
        };
    }
    if (!state.timestampGroup || !draft.timestamp || draft.timestamp.parser !== 'iso8601') {
        return {name, ok: true, detail: 'no ISO timestamp capture, nothing for the iOS date parser to read'};
    }
    if (state.redosFailed || !state.sandbox) return {name, ok: false, detail: 'skipped: earlier structural checks failed'};
    const skeleton = skeletonOf(draft);
    const layout = skeleton ? layoutOf(skeleton) : null;
    const slot = layout && layout.slots.find(x => x.group === state.timestampGroup && x.kind === 'TS');
    if (!slot || layout.groupCount !== state.groupCount) return {name, ok: true, detail: 'the timestamp capture is not a {TS} slot of the skeleton, forms were not probed'};
    const unreadable = [];
    let accepted = 0;
    for (const form of TIMESTAMP_FORMS) {
        const planted = plantedMessage(skeleton, state, new Map([[slot.ordinal, form]]));
        const run = state.sandbox.exec(planted.synth.message, HARD_TIMEOUT_MS);
        if (run.timedOut || !run.matched || typeof run.groups[state.timestampGroup] !== 'string' || run.groups[state.timestampGroup].trim() !== form) continue;
        accepted += 1;
        if (!iosCanParseTimestamp(form)) unreadable.push(form);
    }
    if (unreadable.length) {
        return {
            name,
            ok: true,
            warn: true,
            detail: `warning: the pattern accepts ${unreadable.length} timestamp form(s) that the iOS app cannot read, for example "${unreadable[0]}"; on an iPhone such a message would get the time it was processed. Extend parseStandardDate in the app, or narrow the timestamp group`,
        };
    }
    return {name, ok: true, detail: `all ${accepted} timestamp forms the pattern accepts are readable on iOS`};
}

// The carrier is what the app uses to label the transaction, and it is decided from the
// pattern id and tags alone. Only Airtel writes a transaction code of the {TID} shape or
// puts a *R* / *S* / *F* marker between asterisks, so a draft that claims MTN and carries
// either was filed under the wrong carrier.
function checkCarrierSignals(draft) {
    const name = CHECK_NAMES[13];
    const skeleton = skeletonOf(draft);
    if (!skeleton) return {name, ok: false, detail: 'draft has no sourceShape.skeleton to inspect'};
    const signals = [];
    if (/\{TID\}/.test(skeleton)) signals.push('an Airtel transaction code ({TID})');
    if (/\*\s*[RSF]\s*\*/i.test(skeleton)) signals.push('an Airtel *R*/*S*/*F* marker');
    if (draft.carrier === 'mtn' && signals.length) {
        return {name, ok: false, detail: `the draft is filed under MTN but the text has ${signals.join(' and ')}: the app would label its transactions as MTN. Reject it, or approve the Airtel shape instead`};
    }
    return {name, ok: true, detail: signals.length ? 'Airtel markers on an Airtel draft' : `no carrier-specific marker conflicts with carrier ${draft.carrier}`};
}

function runGate(draft, options) {
    const existingPatterns = options && Array.isArray(options.existingPatterns) ? options.existingPatterns : [];
    if (!draft || typeof draft !== 'object') {
        const checks = CHECK_NAMES.map(name => ({name, ok: false, detail: 'draft is not an object'}));
        return {ok: false, checks};
    }
    const state = {};
    const steps = [
        () => checkCompiles(draft, state),
        () => checkCaptureMap(draft, state),
        () => checkRequired(draft, state),
        () => checkType(draft),
        () => checkRedos(draft, state),
        () => checkSelfMatch(draft, state),
        () => checkNegatives(draft, state),
        () => checkShadow(draft, state, existingPatterns),
        () => checkWordSlots(draft, state),
        () => checkRoleKeywords(draft, state),
        () => checkNameSlot(draft, state),
        () => checkNegationSlots(draft, state),
        () => checkIosTimestamp(draft, state),
        () => checkCarrierSignals(draft),
    ];
    const checks = steps.map((step, i) => {
        try {
            return step();
        } catch (error) {
            return {name: CHECK_NAMES[i], ok: false, detail: `internal error: ${error && error.message ? error.message : 'unknown'}`};
        }
    });
    return {ok: checks.every(c => c.ok), checks};
}

module.exports = {
    runGate,
    testPattern,
    loadNegativeCorpus,
    findNestedUnboundedQuantifier,
    createSandbox,
    samplesFor,
    iosCanParseTimestamp,
    parseAirtelShipped,
    parseAirtelTolerant,
    airtelReferenceDate,
    airtelTimestampProblem,
    MALFORMED_AIRTEL_CODES,
    CHECK_NAMES,
    EXEC_LIMIT_MS,
    STRESS_LIMIT_MS,
    GROWTH_FLOOR_MS,
    GROWTH_RATIO,
    MAX_SOURCE_LENGTH,
    MAX_GROUPS,
};
