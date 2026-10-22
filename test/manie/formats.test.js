const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { MemoryStore, UpstashStore, StoreError } = require('../../lib/manie/store')
const {
    KEYS,
    canonicalJson,
    sha256Hex,
    normalizePattern,
    validateApprovedPattern,
    normalizeVocabulary,
    selectServedPatterns,
    buildServedConfig,
    getServedConfig,
    touchChanged,
    saveApproved,
    setDisabled,
    readApproved,
} = require('../../lib/manie/formats')

const BASE_FILE = path.join(__dirname, '..', '..', 'assets', 'manie', 'sms-formats.json')
const REAL_BASE = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'))
const NOW = '2026-10-21T10:00:00.000Z'
const SILENT = () => {}

function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function shuffle(list, rand) {
    const out = [...list]
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
}

function shuffleKeys(obj, rand) {
    if (Array.isArray(obj)) return obj.map(v => shuffleKeys(v, rand))
    if (obj && typeof obj === 'object') {
        const out = {}
        for (const k of shuffle(Object.keys(obj), rand)) out[k] = shuffleKeys(obj[k], rand)
        return out
    }
    return obj
}

function deepFreeze(v) {
    if (v && typeof v === 'object') {
        Object.freeze(v)
        for (const k of Object.keys(v)) deepFreeze(v[k])
    }
    return v
}

function clone(v) {
    return JSON.parse(JSON.stringify(v))
}

const smallBase = () => ({
    version: 'regex-v20260801',
    defaultLocale: 'en-RW',
    fetchedAt: '2026-08-01T00:00:00Z',
    patterns: [
        {
            id: 'base-one',
            carrier: 'mtn',
            locale: 'en-RW',
            type: 'transfer',
            pattern: '.*?(\\d+) RWF to (.*?) at ([\\d\\-\\s:]+)',
            flags: 'i',
            captureMap: { amount: 1, secondParty: 2 },
            timestamp: { group: 3, parser: 'iso8601' },
            tags: ['transfer'],
            status: 'active',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2025-02-07T00:00:00Z',
        },
        {
            id: 'base-two',
            carrier: 'airtel',
            locale: 'rw-RW',
            type: 'receive',
            pattern: 'TID ([A-Za-z]{2}(\\d+\\.\\d+)\\.[A-Za-z]\\d+) Yakiriye (\\d+)',
            flags: '',
            captureMap: { transactionId: 1, amount: 3 },
            timestamp: { group: 2, parser: 'airtel-shortcode' },
            tags: ['receive', 'airtel'],
            status: 'active',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2025-02-07T00:00:00Z',
        },
    ],
})

function makeApproved(i, overrides) {
    return {
        id: `mtn-auto-${i}`,
        carrier: 'mtn',
        locale: 'en-RW',
        type: 'payment',
        pattern: `.*?Paid${i} ([\\d,.]+) RWF to (.*?) ref (\\d+) bal ([\\d,.]+)`,
        flags: 'i',
        captureMap: { amount: 1, secondParty: 2, transactionId: 3, balance: 4 },
        tags: ['payment', 'auto'],
        status: 'active',
        createdAt: '2026-10-01T08:00:00.000Z',
        updatedAt: '2026-10-02T08:00:00.000Z',
        ...overrides,
    }
}

function makeAirtelApproved(i, overrides) {
    return {
        id: `airtel-auto-${i}`,
        carrier: 'airtel',
        locale: 'rw-RW',
        type: 'transfer',
        pattern: `.*?TID\\s+([A-Za-z]{2}(\\d+\\.\\d+)\\.[A-Za-z]\\d+) Wohereje${i} (\\d+) bal (\\d+)`,
        flags: 'i',
        captureMap: { transactionId: 1, amount: 3, balance: 4 },
        timestamp: { group: 2, parser: 'airtel-shortcode' },
        tags: ['transfer', 'airtel'],
        status: 'active',
        createdAt: '2026-10-03T08:00:00.000Z',
        updatedAt: '2026-10-04T08:00:00.000Z',
        ...overrides,
    }
}

const VALID_TYPES = new Set(['transfer', 'receive', 'payment', 'withdraw', 'deposit'])

// mirrors the acceptance rules in the app's remoteRegexConfig.ts parseConfig
function clientAccepts(p) {
    if (!p || typeof p.id !== 'string' || typeof p.pattern !== 'string') return false
    if (p.type !== undefined && !VALID_TYPES.has(p.type)) return false
    const flags = typeof p.flags === 'string' ? p.flags.replace(/[gy]/g, '') : ''
    try {
        new RegExp(p.pattern, flags)
    } catch (err) {
        return false
    }
    const tid = Number(p.captureMap && p.captureMap.transactionId)
    const hasTid = Number.isFinite(tid) && tid > 0
    const hasTs = p.timestamp && Number.isFinite(Number(p.timestamp.group))
    return Boolean(hasTid || hasTs)
}

function body(built) {
    const { contentHash, ...rest } = built.config
    return rest
}

describe('canonicalJson', () => {
    it('sorts object keys recursively and keeps array order', () => {
        assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 'x' } }), '{"a":{"c":"x","d":[3,1,2]},"b":1}')
        assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
    })

    it('matches JSON.stringify for already-sorted plain data', () => {
        const v = { a: [1, 'two', null, true, { b: 'q"uote\n' }], c: 1.5, d: '' }
        assert.equal(canonicalJson(v), JSON.stringify(v))
    })

    it('skips undefined/function properties, nulls array holes and non-finite numbers', () => {
        assert.equal(canonicalJson({ a: undefined, b: () => 1, c: 1 }), '{"c":1}')
        assert.equal(canonicalJson([undefined, () => 1, NaN, Infinity]), '[null,null,null,null]')
    })

    it('is injective across different structures', () => {
        assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }))
        assert.notEqual(canonicalJson(['a', 'b']), canonicalJson(['b', 'a']))
        assert.notEqual(canonicalJson({ a: [] }), canonicalJson({ a: {} }))
    })
})

describe('normalizePattern / validateApprovedPattern', () => {
    it('accepts a well-formed MTN pattern and whitelists output fields in a fixed order', () => {
        const res = validateApprovedPattern({ ...makeApproved(1), sourceShape: 'x', confidence: 0.9, notes: ['n'], gate: { ok: true }, extra: 1 })
        assert.equal(res.ok, true)
        assert.deepEqual(Object.keys(res.pattern), ['id', 'carrier', 'locale', 'type', 'pattern', 'flags', 'captureMap', 'tags', 'status', 'createdAt', 'updatedAt'])
        assert.deepEqual(Object.keys(res.pattern.captureMap), ['amount', 'balance', 'secondParty', 'transactionId'])
    })

    it('accepts the Airtel TID shape of the draft generator: one group is both the transactionId and the timestamp', () => {
        const res = validateApprovedPattern(
            makeAirtelApproved(1, {
                pattern: '.*?TID\\s+([A-Za-z]{2}\\d{6}\\.\\d{4}\\.[A-Za-z]\\d+) Wohereje1 (\\d+) bal (\\d+)',
                captureMap: { transactionId: 1, amount: 2, balance: 3 },
                timestamp: { group: 1, parser: 'airtel-shortcode' },
            })
        )
        assert.equal(res.ok, true)
        assert.deepEqual(res.pattern.timestamp, { group: 1, parser: 'airtel-shortcode' })
        assert.equal(res.pattern.captureMap.transactionId, 1)
    })

    it('still accepts the older Airtel TID shape with nested groups (outer = transactionId, inner = timestamp)', () => {
        const res = validateApprovedPattern(makeAirtelApproved(1))
        assert.equal(res.ok, true)
        assert.deepEqual(res.pattern.timestamp, { group: 2, parser: 'airtel-shortcode' })
        assert.deepEqual(Object.keys(res.pattern), ['id', 'carrier', 'locale', 'type', 'pattern', 'flags', 'captureMap', 'timestamp', 'tags', 'status', 'createdAt', 'updatedAt'])
    })

    it('accepts a timestamp-only pattern (no transactionId) and empty flags', () => {
        const res = validateApprovedPattern(makeApproved(1, { flags: '', captureMap: { amount: 1, balance: 4 }, timestamp: { group: 3, parser: 'iso8601' } }))
        assert.equal(res.ok, true)
        assert.equal(res.pattern.flags, '')
    })

    it('applies defaults for locale, tags and timestamps and normalizes times', () => {
        const input = makeApproved(1)
        delete input.locale
        delete input.tags
        input.createdAt = '2026-10-01T08:00:00Z'
        delete input.updatedAt
        input.approvedAt = '2026-10-05T09:30:00+02:00'
        const { pattern } = validateApprovedPattern(input)
        assert.equal(pattern.locale, 'en-RW')
        assert.deepEqual(pattern.tags, ['payment'])
        assert.equal(pattern.createdAt, '2026-10-01T08:00:00.000Z')
        assert.equal(pattern.updatedAt, '2026-10-05T07:30:00.000Z')
        const bare = makeApproved(2)
        delete bare.createdAt
        delete bare.updatedAt
        const res = validateApprovedPattern(bare)
        assert.equal(res.pattern.createdAt, '1970-01-01T00:00:00.000Z')
        assert.equal(res.pattern.updatedAt, '1970-01-01T00:00:00.000Z')
        const onlyCreated = makeApproved(3)
        delete onlyCreated.updatedAt
        assert.equal(validateApprovedPattern(onlyCreated).pattern.updatedAt, '2026-10-01T08:00:00.000Z')
    })

    describe('carrier tag convention (the client detects Airtel by tag or id)', () => {
        const tagsOf = input => validateApprovedPattern(input).pattern.tags

        it('adds an airtel tag to Airtel patterns whose tags and id never mention it', () => {
            assert.deepEqual(tagsOf(makeAirtelApproved(1, { id: 'auto-cashout-en', tags: ['withdraw'] })), ['withdraw', 'airtel'])
            const noTags = makeAirtelApproved(1, { id: 'auto-cashout-en' })
            delete noTags.tags
            assert.deepEqual(tagsOf(noTags), ['transfer', 'airtel'])
        })

        it('leaves Airtel patterns alone when the id or any tag already mentions airtel', () => {
            assert.deepEqual(tagsOf(makeAirtelApproved(1, { id: 'airtel-auto-cashout', tags: ['withdraw'] })), ['withdraw'])
            assert.deepEqual(tagsOf(makeAirtelApproved(1, { id: 'auto-x', tags: ['withdraw', 'Airtel-Money'] })), ['withdraw', 'Airtel-Money'])
            assert.deepEqual(tagsOf(makeAirtelApproved(1, { id: 'auto-AIRTEL-x', tags: ['withdraw'] })), ['withdraw'])
        })

        it('never tags MTN patterns as airtel', () => {
            assert.deepEqual(tagsOf(makeApproved(1, { tags: ['payment'] })), ['payment'])
        })

        it('is applied in the served config too', () => {
            const built = buildServedConfig({ base: smallBase(), approved: [makeAirtelApproved(1, { id: 'auto-cashout-en', tags: ['withdraw'] })], vocabulary: [], now: NOW })
            assert.deepEqual(built.config.patterns.find(p => p.id === 'auto-cashout-en').tags, ['withdraw', 'airtel'])
        })
    })

    it('requires a balance capture because the client would otherwise record a balance of 0', () => {
        const res = validateApprovedPattern(makeApproved(1, { captureMap: { amount: 1, transactionId: 3 } }))
        assert.deepEqual(res, { ok: false, id: 'mtn-auto-1', reason: 'missing_balance' })
    })

    it('dedupes tags and does not mutate its input', () => {
        const input = deepFreeze(makeApproved(1, { tags: ['a', 'a', 'b'] }))
        assert.deepEqual(validateApprovedPattern(input).pattern.tags, ['a', 'b'])
    })

    const invalid = [
        ['not an object', null, 'not_object'],
        ['an array', [], 'not_object'],
        ['a string', '{"id":"x"}', 'not_object'],
        ['missing id', { ...makeApproved(1), id: undefined }, 'bad_id'],
        ['id with spaces', makeApproved(1, { id: 'bad id' }), 'bad_id'],
        ['id with slash', makeApproved(1, { id: 'a/b' }), 'bad_id'],
        ['id too long', makeApproved(1, { id: 'a'.repeat(81) }), 'bad_id'],
        ['id numeric', makeApproved(1, { id: 5 }), 'bad_id'],
        ['unknown carrier', makeApproved(1, { carrier: 'vodafone' }), 'bad_carrier'],
        ['uppercase carrier', makeApproved(1, { carrier: 'MTN' }), 'bad_carrier'],
        ['unknown type', makeApproved(1, { type: 'refund' }), 'bad_type'],
        ['missing status', makeApproved(1, { status: undefined }), 'bad_status'],
        ['missing pattern', makeApproved(1, { pattern: undefined }), 'bad_pattern'],
        ['non-string pattern', makeApproved(1, { pattern: 5 }), 'bad_pattern'],
        ['empty pattern', makeApproved(1, { pattern: '' }), 'bad_pattern'],
        ['oversized pattern', makeApproved(1, { pattern: `(\\d+)${'a'.repeat(2400)}` }), 'bad_pattern'],
        ['uncompilable pattern', makeApproved(1, { pattern: '(\\d+' }), 'regex_compile'],
        ['trailing backslash', makeApproved(1, { pattern: '(\\d+)\\' }), 'regex_compile'],
        ['g flag', makeApproved(1, { flags: 'gi' }), 'bad_flags'],
        ['y flag', makeApproved(1, { flags: 'y' }), 'bad_flags'],
        ['duplicate flags', makeApproved(1, { flags: 'ii' }), 'bad_flags'],
        ['unknown flag', makeApproved(1, { flags: 'x' }), 'bad_flags'],
        ['non-string flags', makeApproved(1, { flags: 5 }), 'bad_flags'],
        ['missing flags', makeApproved(1, { flags: undefined }), 'bad_flags'],
        ['bad locale', makeApproved(1, { locale: 'english' }), 'bad_locale'],
        ['no capture groups', makeApproved(1, { pattern: 'no groups here', captureMap: { amount: 1 } }), 'bad_group_count'],
        ['more than 20 groups', makeApproved(1, { pattern: '(a)'.repeat(21), captureMap: { amount: 1, transactionId: 2 } }), 'bad_group_count'],
        ['captureMap missing', makeApproved(1, { captureMap: undefined }), 'bad_capture_map'],
        ['captureMap array', makeApproved(1, { captureMap: [1] }), 'bad_capture_map'],
        ['captureMap without amount', makeApproved(1, { captureMap: { transactionId: 3 } }), 'missing_amount'],
        ['captureMap index beyond groups', makeApproved(1, { captureMap: { amount: 1, balance: 4, transactionId: 5 } }), 'bad_capture_map'],
        ['captureMap without balance', makeApproved(1, { captureMap: { amount: 1, transactionId: 3 } }), 'missing_balance'],
        ['captureMap index zero', makeApproved(1, { captureMap: { amount: 0, transactionId: 3 } }), 'bad_capture_map'],
        ['captureMap fractional index', makeApproved(1, { captureMap: { amount: 1.5, transactionId: 3 } }), 'bad_capture_map'],
        ['captureMap string index', makeApproved(1, { captureMap: { amount: '1', transactionId: 3 } }), 'bad_capture_map'],
        ['two roles on one group', makeApproved(1, { captureMap: { amount: 1, secondParty: 1, transactionId: 3 } }), 'bad_capture_map'],
        ['unknown capture role', makeApproved(1, { captureMap: { amount: 1, transactionId: 3, ammount: 2 } }), 'bad_capture_map'],
        ['timestamp as a role', makeApproved(1, { captureMap: { amount: 1, transactionId: 3, timestamp: 2 } }), 'bad_capture_map'],
        ['timestamp unknown parser', makeAirtelApproved(1, { timestamp: { group: 2, parser: 'epoch' } }), 'bad_timestamp'],
        ['timestamp group beyond groups', makeAirtelApproved(1, { timestamp: { group: 9, parser: 'airtel-shortcode' } }), 'bad_timestamp'],
        ['timestamp group missing', makeAirtelApproved(1, { timestamp: { parser: 'airtel-shortcode' } }), 'bad_timestamp'],
        ['timestamp not an object', makeAirtelApproved(1, { timestamp: 'now' }), 'bad_timestamp'],
        ['neither transactionId nor timestamp', makeApproved(1, { captureMap: { amount: 1, secondParty: 2, balance: 4 } }), 'missing_identity'],
        ['tags not an array', makeApproved(1, { tags: 'payment' }), 'bad_tags'],
        ['tag with bad characters', makeApproved(1, { tags: ['<script>'] }), 'bad_tags'],
        ['non-string tag', makeApproved(1, { tags: [1] }), 'bad_tags'],
        ['too many tags', makeApproved(1, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), 'bad_tags'],
        ['createdAt garbage', makeApproved(1, { createdAt: 'yesterday' }), 'bad_time'],
        ['updatedAt number-like string', makeApproved(1, { updatedAt: '1700000000' }), 'bad_time'],
        ['updatedAt object', makeApproved(1, { updatedAt: {} }), 'bad_time'],
    ]
    for (const [name, input, reason] of invalid) {
        it(`rejects ${name} (${reason})`, () => {
            const res = validateApprovedPattern(input)
            assert.equal(res.ok, false)
            assert.equal(res.reason, reason)
        })
    }

    it('reports non-active statuses as inactive but normalizePattern still accepts them', () => {
        for (const status of ['pending_review', 'rejected', 'retired', 'disabled', 'ACTIVE', '']) {
            const input = makeApproved(1, { status })
            assert.deepEqual(validateApprovedPattern(input), { ok: false, id: 'mtn-auto-1', reason: 'inactive' })
            assert.equal(normalizePattern(input).ok, true)
        }
    })

    it('returns the id in failures when it is a string and null otherwise', () => {
        assert.equal(validateApprovedPattern(makeApproved(7, { carrier: 'x' })).id, 'mtn-auto-7')
        assert.equal(validateApprovedPattern(null).id, null)
        assert.equal(validateApprovedPattern(makeApproved(1, { id: 5 })).id, null)
    })

    it('cannot be poisoned through __proto__ keys', () => {
        const hostile = JSON.parse(`{"id":"x1","carrier":"mtn","type":"payment","status":"active","pattern":"(\\\\d+)","flags":"i","captureMap":{"amount":1,"__proto__":{"polluted":true}}}`)
        assert.equal(validateApprovedPattern(hostile).ok, false)
        assert.equal(({}).polluted, undefined)
    })
})

describe('normalizeVocabulary', () => {
    it('lowercases, dedupes, sorts and drops anything that is not a plain word', () => {
        const out = normalizeVocabulary(['Zeta', 'alpha', 'ALPHA', ' beta ', 'n\'', 'a1b', '12', 'two words', '', 5, null, {}, 'é', 'x'.repeat(31), 'rwf'])
        assert.deepEqual(out, ['alpha', 'beta', "n'", 'rwf', 'zeta'])
    })

    it('accepts Sets and rejects non-collections', () => {
        assert.deepEqual(normalizeVocabulary(new Set(['b', 'a'])), ['a', 'b'])
        assert.deepEqual(normalizeVocabulary('abc'), [])
        assert.deepEqual(normalizeVocabulary(undefined), [])
    })
})

describe('buildServedConfig', () => {
    it('serves the real base file byte-identically when nothing else is configured', () => {
        const built = buildServedConfig({ base: REAL_BASE, approved: [], disabledIds: [], vocabulary: ['balance'], now: NOW })
        assert.equal(built.config.patterns.length, REAL_BASE.patterns.length)
        for (let i = 0; i < REAL_BASE.patterns.length; i++) {
            assert.equal(JSON.stringify(built.config.patterns[i]), JSON.stringify(REAL_BASE.patterns[i]))
        }
        assert.equal(built.config.fetchedAt, REAL_BASE.fetchedAt)
        assert.equal(built.config.defaultLocale, REAL_BASE.defaultLocale)
        assert.match(built.config.version, /^regex-v20260801-[0-9a-f]{8}$/)
    })

    it('exposes version, defaultLocale, fetchedAt, patterns, vocabulary and contentHash', () => {
        const built = buildServedConfig({ base: smallBase(), approved: [makeApproved(1)], disabledIds: [], vocabulary: ['Paid', 'rwf', 'rwf'], now: NOW })
        assert.deepEqual(Object.keys(built.config), ['version', 'defaultLocale', 'fetchedAt', 'patterns', 'vocabulary', 'contentHash'])
        assert.deepEqual(built.config.vocabulary, ['paid', 'rwf'])
        assert.match(built.contentHash, /^[0-9a-f]{64}$/)
        assert.equal(built.config.contentHash, built.contentHash)
        assert.equal(built.contentHash, sha256Hex(canonicalJson(body(built))))
    })

    it('appends valid active approved patterns after the base, ordered by id, with a clean shape', () => {
        const built = buildServedConfig({ base: smallBase(), approved: [makeApproved(2), makeAirtelApproved(1), makeApproved(1)], vocabulary: [], now: NOW })
        assert.deepEqual(built.config.patterns.map(p => p.id), ['base-one', 'base-two', 'airtel-auto-1', 'mtn-auto-1', 'mtn-auto-2'])
        for (const p of built.config.patterns) assert.ok(clientAccepts(p), `client would reject ${p.id}`)
    })

    it('lets KV win over the base on the same id, replacing in place', () => {
        const override = makeApproved(1, { id: 'base-one', updatedAt: '2026-10-09T00:00:00.000Z' })
        const built = buildServedConfig({ base: smallBase(), approved: [override], vocabulary: [], now: NOW })
        assert.deepEqual(built.config.patterns.map(p => p.id), ['base-one', 'base-two'])
        assert.equal(built.config.patterns[0].pattern, override.pattern)
        assert.equal(built.config.patterns[0].carrier, 'mtn')
    })

    it('serves only active patterns: other statuses are filtered and never shadow the base', () => {
        const approved = [
            makeApproved(1, { status: 'pending_review' }),
            makeApproved(2, { status: 'rejected' }),
            makeApproved(3, { status: 'retired' }),
            makeApproved(4),
            makeApproved(5, { id: 'base-one', status: 'retired' }),
        ]
        const built = buildServedConfig({ base: smallBase(), approved, vocabulary: [], now: NOW })
        assert.deepEqual(built.config.patterns.map(p => p.id), ['base-one', 'base-two', 'mtn-auto-4'])
        assert.equal(built.config.patterns[0].pattern, smallBase().patterns[0].pattern)
        assert.equal(built.dropped.filter(d => d.reason === 'inactive').length, 4)
    })

    it('filters base patterns that are not active', () => {
        const base = smallBase()
        base.patterns[1].status = 'retired'
        base.patterns.push({ id: 'no-status', pattern: '(\\d+)' }, null, 'junk', { pattern: '(x)' })
        const built = buildServedConfig({ base, approved: [], vocabulary: [], now: NOW })
        assert.deepEqual(built.config.patterns.map(p => p.id), ['base-one'])
    })

    it('removes disabled ids from both base and KV patterns and ignores junk ids', () => {
        const built = buildServedConfig({
            base: smallBase(),
            approved: [makeApproved(1), makeApproved(2)],
            disabledIds: ['base-two', 'mtn-auto-1', 5, null, {}, 'not-present'],
            vocabulary: [],
            now: NOW,
        })
        assert.deepEqual(built.config.patterns.map(p => p.id), ['base-one', 'mtn-auto-2'])
    })

    it('a disabled KV override also removes the base pattern it overrides', () => {
        const built = buildServedConfig({ base: smallBase(), approved: [makeApproved(1, { id: 'base-one' })], disabledIds: ['base-one'], vocabulary: [], now: NOW })
        assert.deepEqual(built.config.patterns.map(p => p.id), ['base-two'])
    })

    it('drops invalid approved entries individually and reports why, never poisoning the rest', () => {
        const approved = [
            makeApproved(1),
            null,
            'garbage',
            42,
            [],
            {},
            { id: 'half' },
            makeApproved(2, { pattern: '(\\d+' }),
            makeApproved(3, { captureMap: {} }),
            makeApproved(4, { type: 'steal' }),
            makeApproved(5),
        ]
        const built = buildServedConfig({ base: smallBase(), approved, vocabulary: [], now: NOW })
        assert.deepEqual(built.config.patterns.map(p => p.id), ['base-one', 'base-two', 'mtn-auto-1', 'mtn-auto-5'])
        assert.equal(built.dropped.length, 9)
        assert.ok(built.dropped.every(d => typeof d.reason === 'string'))
    })

    it('resolves duplicate approved ids deterministically (newest updatedAt wins, any order)', () => {
        const older = makeApproved(1, { updatedAt: '2026-10-01T00:00:00.000Z', pattern: '.*?Old (\\d+) ref (\\d+) bal (\\d+)', captureMap: { amount: 1, transactionId: 2, balance: 3 } })
        const newer = makeApproved(1, { updatedAt: '2026-10-05T00:00:00.000Z' })
        const a = buildServedConfig({ base: smallBase(), approved: [older, newer], vocabulary: [], now: NOW })
        const b = buildServedConfig({ base: smallBase(), approved: [newer, older], vocabulary: [], now: NOW })
        assert.equal(a.contentHash, b.contentHash)
        assert.equal(a.config.patterns.find(p => p.id === 'mtn-auto-1').pattern, newer.pattern)
    })

    it('breaks updatedAt ties deterministically', () => {
        const x = makeApproved(1, { pattern: '.*?X (\\d+) ref (\\d+) bal (\\d+)', captureMap: { amount: 1, transactionId: 2, balance: 3 } })
        const y = makeApproved(1, { pattern: '.*?Y (\\d+) ref (\\d+) bal (\\d+)', captureMap: { amount: 1, transactionId: 2, balance: 3 } })
        const a = buildServedConfig({ base: smallBase(), approved: [x, y], vocabulary: [], now: NOW })
        const b = buildServedConfig({ base: smallBase(), approved: [y, x], vocabulary: [], now: NOW })
        assert.equal(a.contentHash, b.contentHash)
    })

    it('does not mutate its inputs (frozen deep) and returns detached data', () => {
        const base = deepFreeze(smallBase())
        const approved = deepFreeze([makeApproved(1), makeAirtelApproved(2)])
        const built = buildServedConfig({ base, approved, disabledIds: deepFreeze(['x']), vocabulary: deepFreeze(['a']), now: NOW })
        built.config.patterns[0].pattern = 'tampered'
        assert.notEqual(base.patterns[0].pattern, 'tampered')
    })

    it('throws a TypeError for an unusable base (callers guard with getServedConfig)', () => {
        assert.throws(() => buildServedConfig({ base: null, approved: [] }), TypeError)
        assert.throws(() => buildServedConfig({ base: { patterns: 'x' }, approved: [] }), TypeError)
        assert.throws(() => buildServedConfig({ base: smallBase(), approved: 'x' }), TypeError)
    })

    describe('fetchedAt and version date', () => {
        it('is the base time when nothing newer exists, independent of now', () => {
            const a = buildServedConfig({ base: smallBase(), approved: [], vocabulary: [], now: '2026-10-21T00:00:00Z' })
            const b = buildServedConfig({ base: smallBase(), approved: [], vocabulary: [], now: '2030-01-01T00:00:00Z' })
            assert.equal(a.config.fetchedAt, '2026-08-01T00:00:00Z')
            assert.equal(a.contentHash, b.contentHash)
            assert.equal(a.config.version, b.config.version)
            assert.match(a.config.version, /^regex-v20260801-/)
        })

        it('is the latest of base, changedAt and served approved updatedAt', () => {
            const approved = [makeApproved(1, { updatedAt: '2026-10-02T08:00:00.000Z' }), makeApproved(2, { updatedAt: '2026-10-07T23:59:59.000Z' })]
            const built = buildServedConfig({ base: smallBase(), approved, vocabulary: [], now: NOW })
            assert.equal(built.config.fetchedAt, '2026-10-07T23:59:59.000Z')
            assert.match(built.config.version, /^regex-v20261007-/)
            const later = buildServedConfig({ base: smallBase(), approved, vocabulary: [], changedAt: '2026-10-12T05:00:00Z', now: NOW })
            assert.equal(later.config.fetchedAt, '2026-10-12T05:00:00.000Z')
            assert.match(later.config.version, /^regex-v20261012-/)
        })

        it('ignores invalid changedAt values and the updatedAt of patterns that are not served', () => {
            const approved = [makeApproved(1, { status: 'retired', updatedAt: '2030-01-01T00:00:00.000Z' }), makeApproved(2, { updatedAt: '2030-02-01T00:00:00.000Z' })]
            for (const changedAt of ['soon', 5, {}, null, undefined, '']) {
                const built = buildServedConfig({ base: smallBase(), approved, disabledIds: ['mtn-auto-2'], vocabulary: [], changedAt, now: NOW })
                assert.equal(built.config.fetchedAt, '2026-08-01T00:00:00Z')
            }
        })

        it('uses the version date from UTC, not local time', () => {
            const built = buildServedConfig({ base: smallBase(), approved: [], vocabulary: [], changedAt: '2026-10-12T23:30:00-05:00', now: NOW })
            assert.equal(built.config.fetchedAt, '2026-10-13T04:30:00.000Z')
            assert.match(built.config.version, /^regex-v20261013-/)
        })

        it('falls back to the epoch, never to the request time, when no timestamp exists anywhere (R2-REL-04)', () => {
            const base = { ...smallBase(), fetchedAt: undefined }
            const warnings = []
            const original = console.warn
            console.warn = (...a) => warnings.push(a.join(' '))
            try {
                const a = buildServedConfig({ base, approved: [], vocabulary: [], now: '2026-10-21T00:00:00Z' })
                const b = buildServedConfig({ base, approved: [], vocabulary: [], now: '2031-05-05T05:05:05Z' })
                assert.equal(a.config.fetchedAt, '1970-01-01T00:00:00.000Z')
                assert.equal(buildServedConfig({ base, approved: [], vocabulary: [] }).config.fetchedAt, '1970-01-01T00:00:00.000Z')
                assert.equal(a.contentHash, b.contentHash)
                assert.equal(a.config.version, b.config.version)
            } finally {
                console.warn = original
            }
            assert.ok(warnings.length <= 1, 'warns at most once per process')
        })

        it('reads a hand-edited base fetchedAt that is not strict ISO as UTC and keeps it stable (R2-REL-04)', () => {
            const cases = {
                '2026-10-22': '2026-10-22T00:00:00.000Z',
                '2026-10-22 10:00:00': '2026-10-22T10:00:00.000Z',
                '2026-10-22T10:00:00': '2026-10-22T10:00:00.000Z',
                '2026-10-22 10:00': '2026-10-22T10:00:00.000Z',
                '2026-10-22 10:00:00+02:00': '2026-10-22T08:00:00.000Z',
                '2026-10-22T10:00:00Z': '2026-10-22T10:00:00Z',
            }
            for (const [raw, expected] of Object.entries(cases)) {
                const base = { ...smallBase(), fetchedAt: raw }
                const a = buildServedConfig({ base, approved: [], vocabulary: [], now: '2026-10-23T00:00:00Z' })
                const b = buildServedConfig({ base, approved: [], vocabulary: [], now: '2030-01-01T00:00:00Z' })
                assert.equal(a.config.fetchedAt, expected, raw)
                assert.equal(a.contentHash, b.contentHash, raw)
                assert.equal(a.config.version, b.config.version, raw)
                assert.match(a.config.version, /^regex-v20261022-/, raw)
            }
        })
    })

    describe('properties', () => {
        function randomApproved(rand, n) {
            const out = []
            for (let i = 0; i < n; i++) {
                const k = Math.floor(rand() * 10000)
                out.push(rand() < 0.3 ? makeAirtelApproved(k, { updatedAt: new Date(1_790_000_000_000 + Math.floor(rand() * 1e9)).toISOString() }) : makeApproved(k, { updatedAt: new Date(1_790_000_000_000 + Math.floor(rand() * 1e9)).toISOString() }))
            }
            return out
        }

        it('same inputs give the same config, hash and version (fresh clones, repeated calls)', () => {
            const rand = mulberry32(1)
            for (let i = 0; i < 100; i++) {
                const approved = randomApproved(rand, Math.floor(rand() * 12))
                const input = { base: smallBase(), approved, disabledIds: ['base-two'], vocabulary: ['a', 'b'], now: NOW }
                const a = buildServedConfig(input)
                const b = buildServedConfig(clone(input))
                assert.equal(JSON.stringify(a.config), JSON.stringify(b.config))
                assert.equal(a.contentHash, b.contentHash)
            }
        })

        it('reordering the approved list (or shuffling object keys) never changes the hash', () => {
            const rand = mulberry32(2)
            for (let i = 0; i < 150; i++) {
                const approved = randomApproved(rand, 1 + Math.floor(rand() * 15))
                const reference = buildServedConfig({ base: smallBase(), approved, disabledIds: [], vocabulary: ['x', 'y'], now: NOW })
                const shuffled = shuffleKeys(shuffle(approved, rand), rand)
                const other = buildServedConfig({ base: smallBase(), approved: shuffled, disabledIds: [], vocabulary: ['y', 'x'], now: NOW })
                assert.equal(other.contentHash, reference.contentHash)
                assert.equal(other.config.version, reference.config.version)
                assert.equal(JSON.stringify(other.config), JSON.stringify(reference.config))
            }
        })

        it('reordering disabledIds or vocabulary does not change the hash', () => {
            const rand = mulberry32(3)
            const approved = randomApproved(rand, 6)
            const ids = approved.map(p => p.id)
            const reference = buildServedConfig({ base: smallBase(), approved, disabledIds: ids.slice(0, 3), vocabulary: ['a', 'b', 'c'], now: NOW })
            for (let i = 0; i < 30; i++) {
                const other = buildServedConfig({ base: smallBase(), approved, disabledIds: shuffle(ids.slice(0, 3), rand), vocabulary: shuffle(['a', 'b', 'c', 'A'], rand), now: NOW })
                assert.equal(other.contentHash, reference.contentHash)
            }
        })

        it('adding one pattern changes the version and the hash', () => {
            const rand = mulberry32(4)
            for (let i = 0; i < 100; i++) {
                const approved = randomApproved(rand, Math.floor(rand() * 10))
                const before = buildServedConfig({ base: smallBase(), approved, vocabulary: ['a'], now: NOW })
                const extra = makeApproved(20000 + i)
                const after = buildServedConfig({ base: smallBase(), approved: [...approved, extra], vocabulary: ['a'], now: NOW })
                assert.notEqual(after.config.version, before.config.version)
                assert.notEqual(after.contentHash, before.contentHash)
                assert.equal(after.config.patterns.length, before.config.patterns.length + 1)
            }
        })

        it('adding a pattern with an old updatedAt still changes the version (content-derived, not date-derived)', () => {
            const before = buildServedConfig({ base: smallBase(), approved: [], vocabulary: [], now: NOW })
            const after = buildServedConfig({ base: smallBase(), approved: [makeApproved(1, { createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' })], vocabulary: [], now: NOW })
            assert.equal(after.config.version.slice(0, 16), before.config.version.slice(0, 16))
            assert.notEqual(after.config.version, before.config.version)
        })

        it('any content change changes the version: pattern text, capture map, disabling, vocabulary', () => {
            const approved = [makeApproved(1), makeApproved(2)]
            const run = (over = {}) => buildServedConfig({ base: smallBase(), approved, disabledIds: [], vocabulary: ['a'], now: NOW, ...over })
            const reference = run()
            const versions = new Set([reference.config.version])
            const variants = [
                run({ approved: [makeApproved(1, { pattern: '.*?Paid1 ([\\d,.]+) RWF to (.*?) ref (\\d+) bal ([\\d,.]+)x' }), approved[1]] }),
                run({ approved: [makeApproved(1, { captureMap: { amount: 1, secondParty: 3, transactionId: 2, balance: 4 } }), approved[1]] }),
                run({ approved: [makeApproved(1, { type: 'receive' }), approved[1]] }),
                run({ approved: [makeApproved(1, { tags: ['other'] }), approved[1]] }),
                run({ disabledIds: ['mtn-auto-2'] }),
                run({ vocabulary: ['a', 'b'] }),
                run({ approved: approved.slice(1) }),
            ]
            for (const v of variants) {
                assert.ok(!versions.has(v.config.version), `version collision ${v.config.version}`)
                versions.add(v.config.version)
            }
        })

        it('contentHash also changes with defaultLocale and fetchedAt', () => {
            const a = buildServedConfig({ base: smallBase(), approved: [], vocabulary: [], now: NOW })
            const b = buildServedConfig({ base: { ...smallBase(), defaultLocale: 'rw-RW' }, approved: [], vocabulary: [], now: NOW })
            const c = buildServedConfig({ base: smallBase(), approved: [], vocabulary: [], changedAt: '2026-09-01T00:00:00Z', now: NOW })
            assert.notEqual(a.contentHash, b.contentHash)
            assert.notEqual(a.contentHash, c.contentHash)
        })

        it('hash collisions across random distinct pattern sets do not occur', () => {
            const rand = mulberry32(5)
            const seen = new Map()
            for (let i = 0; i < 200; i++) {
                const approved = randomApproved(rand, 1 + Math.floor(rand() * 6))
                const built = buildServedConfig({ base: smallBase(), approved, vocabulary: [], now: NOW })
                const key = canonicalJson(built.config.patterns)
                if (seen.has(built.config.version)) assert.equal(seen.get(built.config.version), key)
                seen.set(built.config.version, key)
            }
        })
    })
})

describe('selectServedPatterns', () => {
    it('returns the served KV patterns separately from dropped ones', () => {
        const res = selectServedPatterns({ base: smallBase(), approved: [makeApproved(1), { id: 'x' }], disabledIds: [] })
        assert.equal(res.served.length, 1)
        assert.equal(res.dropped.length, 1)
        assert.equal(res.patterns.length, 3)
    })
})

describe('getServedConfig', () => {
    let store
    let logs
    const log = (...args) => logs.push(args.join(' '))

    const stubVocab = ({ seed, patterns, adminWords }) => new Set([...seed, ...adminWords, ...patterns.map(p => `p${p.id.length}`)].filter(w => /^[a-z]+$/.test(w)))

    beforeEach(() => {
        store = new MemoryStore()
        logs = []
    })

    function serve(extra) {
        return getServedConfig({ store, base: smallBase(), seedVocab: ['balance', 'fee'], now: NOW, log, ...extra })
    }

    it('serves base plus seed vocabulary from an empty store, healthy', async () => {
        const res = await serve()
        assert.equal(res.degraded, false)
        assert.deepEqual(res.config.patterns.map(p => p.id), ['base-one', 'base-two'])
        assert.ok(res.config.vocabulary.includes('balance'))
        assert.ok(res.config.vocabulary.includes('fee'))
        assert.equal(res.config.fetchedAt, '2026-08-01T00:00:00Z')
        assert.equal(res.contentHash, res.config.contentHash)
        assert.deepEqual(logs, [])
    })

    it('includes literal words of served patterns and admin words using the real vocab builder', async () => {
        await saveApproved(store, makeApproved(1, { pattern: '.*?Yishyuye (\\d+) RWF kuri (.*?) ref (\\d+) bal (\\d+)' }), { now: '2026-10-05T00:00:00Z' })
        await store.sadd(KEYS.vocabAdmin, 'inyongera')
        const res = await serve()
        for (const w of ['yishyuye', 'rwf', 'kuri', 'ref', 'inyongera', 'balance']) assert.ok(res.config.vocabulary.includes(w), `missing ${w}`)
    })

    it('uses an injected vocabulary builder', async () => {
        await store.sadd(KEYS.vocabAdmin, 'zebra')
        const res = await serve({ buildVocabulary: stubVocab })
        assert.deepEqual(res.config.vocabulary, ['balance', 'fee', 'zebra'])
    })

    it('falls back to seed and admin words when the vocabulary builder throws', async () => {
        await store.sadd(KEYS.vocabAdmin, 'zebra')
        const res = await serve({ buildVocabulary: () => { throw new Error('boom') } })
        assert.equal(res.degraded, false)
        assert.deepEqual(res.config.vocabulary, ['balance', 'fee', 'zebra'])
        assert.equal(logs.length, 1)
    })

    it('reflects the full approve, disable, enable lifecycle with a new version at every step', async () => {
        const v0 = (await serve()).config.version
        const saved = await saveApproved(store, makeApproved(1, { status: 'whatever' }), { now: '2026-10-05T12:00:00Z' })
        assert.equal(saved.ok, true)
        assert.equal(saved.pattern.status, 'active')
        const approved = await serve()
        assert.deepEqual(approved.config.patterns.map(p => p.id), ['base-one', 'base-two', 'mtn-auto-1'])
        assert.equal(approved.config.fetchedAt, '2026-10-05T12:00:00.000Z')
        assert.notEqual(approved.config.version, v0)

        assert.equal(await setDisabled(store, 'mtn-auto-1', true, { now: '2026-10-06T12:00:00Z' }), true)
        const disabled = await serve()
        assert.deepEqual(disabled.config.patterns.map(p => p.id), ['base-one', 'base-two'])
        assert.equal(disabled.config.fetchedAt, '2026-10-06T12:00:00.000Z')
        assert.match(disabled.config.version, /^regex-v20261006-/)
        assert.notEqual(disabled.config.version, approved.config.version)

        assert.equal(await setDisabled(store, 'mtn-auto-1', false, { now: '2026-10-07T12:00:00Z' }), true)
        const enabled = await serve()
        assert.deepEqual(enabled.config.patterns.map(p => p.id), ['base-one', 'base-two', 'mtn-auto-1'])
        assert.match(enabled.config.version, /^regex-v20261007-/)
        assert.notEqual(enabled.config.version, disabled.config.version)
    })

    it('the kill switch works on built-in patterns too', async () => {
        await setDisabled(store, 'base-two', true, { now: '2026-10-06T12:00:00Z' })
        const res = await serve()
        assert.deepEqual(res.config.patterns.map(p => p.id), ['base-one'])
    })

    it('fetchedAt, version and hash are stable between requests regardless of request time', async () => {
        await saveApproved(store, makeApproved(1), { now: '2026-10-05T12:00:00Z' })
        const a = await serve({ now: '2026-10-21T00:00:00Z' })
        const b = await serve({ now: '2027-03-01T00:00:00Z' })
        assert.equal(JSON.stringify(a.config), JSON.stringify(b.config))
        assert.equal(a.contentHash, b.contentHash)
    })

    it('a vocabulary-only change (with touchChanged) moves version, fetchedAt and hash', async () => {
        const before = await serve()
        await store.sadd(KEYS.vocabAdmin, 'newword')
        await touchChanged(store, '2026-10-15T00:00:00Z')
        const after = await serve()
        assert.notEqual(after.config.version, before.config.version)
        assert.notEqual(after.config.fetchedAt, before.config.fetchedAt)
        assert.notEqual(after.contentHash, before.contentHash)
    })

    it('saveApproved refuses invalid patterns without writing anything', async () => {
        const res = await saveApproved(store, makeApproved(1, { pattern: '(\\d+' }), { now: NOW })
        assert.equal(res.ok, false)
        assert.equal(res.reason, 'regex_compile')
        assert.equal(await store.exists(KEYS.approved), false)
        assert.equal(await store.exists(KEYS.changedAt), false)
        assert.equal((await saveApproved(store, null, { now: NOW })).ok, false)
    })

    it('saveApproved stamps createdAt/updatedAt, keeps an existing createdAt and re-save updates', async () => {
        const first = await saveApproved(store, makeApproved(1, { createdAt: undefined }), { now: '2026-10-05T00:00:00Z' })
        assert.equal(first.pattern.createdAt, '2026-10-05T00:00:00.000Z')
        const again = await saveApproved(store, { ...first.pattern }, { now: '2026-10-09T00:00:00Z' })
        assert.equal(again.pattern.createdAt, '2026-10-05T00:00:00.000Z')
        assert.equal(again.pattern.updatedAt, '2026-10-09T00:00:00.000Z')
        assert.equal(await store.scard(KEYS.disabled), 0)
    })

    it('touchChanged is strict, while approve and disable still succeed when only the change-time write fails', async () => {
        const flaky = {
            hset: (...a) => store.hset(...a),
            sadd: (...a) => store.sadd(...a),
            srem: (...a) => store.srem(...a),
            set: async () => {
                throw new StoreError('timeout', 'slow')
            },
        }
        await assert.rejects(touchChanged(flaky, NOW), err => err instanceof StoreError && err.code === 'timeout')
        const warnings = []
        const original = console.warn
        console.warn = (...a) => warnings.push(a.join(' '))
        try {
            const saved = await saveApproved(flaky, makeApproved(1), { now: '2026-10-05T00:00:00Z' })
            assert.equal(saved.ok, true)
            assert.equal(await setDisabled(flaky, 'base-two', true, { now: '2026-10-06T00:00:00Z' }), true)
        } finally {
            console.warn = original
        }
        assert.equal(warnings.length, 2)
        assert.ok(warnings.every(w => /timeout/.test(w)))
        const res = await serve()
        assert.deepEqual(res.config.patterns.map(p => p.id), ['base-one', 'mtn-auto-1'])
    })

    it('setDisabled validates ids and reports whether anything changed', async () => {
        assert.equal(await setDisabled(store, 'bad id', true, { now: NOW }), false)
        assert.equal(await setDisabled(store, 5, true, { now: NOW }), false)
        assert.equal(await setDisabled(store, 'x1', true, { now: NOW }), true)
        assert.equal(await setDisabled(store, 'x1', true, { now: NOW }), false)
        assert.equal(await setDisabled(store, 'x1', false, { now: NOW }), true)
        assert.equal(await setDisabled(store, 'x1', false, { now: NOW }), false)
    })

    it('readApproved lists valid, invalid and disabled entries', async () => {
        await saveApproved(store, makeApproved(1), { now: NOW })
        await saveApproved(store, makeAirtelApproved(2), { now: NOW })
        await setDisabled(store, 'airtel-auto-2', true, { now: NOW })
        await store._run(['HSET', KEYS.approved, 'broken', '{"id":"broken"', 'mismatch', JSON.stringify(makeApproved(3))])
        const { items, disabledIds } = await readApproved(store)
        assert.deepEqual(items.map(i => [i.id, i.valid, i.disabled]), [
            ['airtel-auto-2', true, true],
            ['broken', false, false],
            ['mismatch', false, false],
            ['mtn-auto-1', true, false],
        ])
        assert.equal(items.find(i => i.id === 'broken').reason, 'not_object')
        assert.equal(items.find(i => i.id === 'mismatch').reason, 'id_mismatch')
        assert.equal(items.find(i => i.id === 'mtn-auto-1').pattern.id, 'mtn-auto-1')
        assert.deepEqual(disabledIds, ['airtel-auto-2'])
    })

    describe('garbage inside the KV values never poisons the config', () => {
        it('drops truncated JSON, wrong types and incomplete records one by one', async () => {
            await saveApproved(store, makeApproved(1), { now: '2026-10-05T00:00:00Z' })
            await saveApproved(store, makeAirtelApproved(2), { now: '2026-10-06T00:00:00Z' })
            const good = JSON.stringify(makeApproved(9))
            await store._run([
                'HSET', KEYS.approved,
                'trunc', good.slice(0, 40),
                'num', '42',
                'arr', '[1,2,3]',
                'nul', 'null',
                'str', '"hello"',
                'empty', '',
                'noamount', JSON.stringify(makeApproved(3, { id: 'noamount', captureMap: { transactionId: 3 } })),
                'badregex', JSON.stringify(makeApproved(4, { id: 'badregex', pattern: '(\\d+' })),
                'badtype', JSON.stringify(makeApproved(5, { id: 'badtype', type: 'steal' })),
                'mismatch', JSON.stringify(makeApproved(6)),
                'fieldless', JSON.stringify({ ...makeApproved(7), id: undefined }),
                'wrongstatus', JSON.stringify(makeApproved(8, { id: 'wrongstatus', status: 'pending_review' })),
            ])
            const res = await serve()
            assert.equal(res.degraded, false)
            assert.deepEqual(res.config.patterns.map(p => p.id), ['base-one', 'base-two', 'airtel-auto-2', 'fieldless', 'mtn-auto-1'])
            const reasons = Object.fromEntries(res.dropped.map(d => [d.id, d.reason]))
            assert.equal(reasons.trunc, 'not_object')
            assert.equal(reasons.num, 'not_object')
            assert.equal(reasons.arr, 'not_object')
            assert.equal(reasons.nul, 'not_object')
            assert.equal(reasons.str, 'not_object')
            assert.equal(reasons.noamount, 'missing_amount')
            assert.equal(reasons.badregex, 'regex_compile')
            assert.equal(reasons.badtype, 'bad_type')
            assert.equal(reasons.mismatch, 'id_mismatch')
            assert.equal(reasons.wrongstatus, 'inactive')
            assert.equal(res.config.patterns.find(p => p.id === 'fieldless').pattern, makeApproved(7).pattern)
            assert.equal(logs.length, 1)
            assert.match(logs[0], /dropped 10 invalid/)
            for (const p of res.config.patterns) assert.ok(clientAccepts(p))
        })

        it('does not leak dropped record content into logs or the dropped list', async () => {
            await store._run(['HSET', KEYS.approved, 'trunc', '{"pattern":"SECRET-PATTERN-TEXT'])
            const res = await serve()
            assert.ok(!JSON.stringify(res.dropped).includes('SECRET'))
            assert.ok(!logs.join(' ').includes('SECRET'))
        })

        it('ignores non-string entries in the disabled and vocabulary sets', async () => {
            await saveApproved(store, makeApproved(1), { now: NOW })
            const garbageStore = {
                hgetall: s => store.hgetall(s),
                get: k => store.get(k),
                smembers: async k => (k === KEYS.disabled ? ['mtn-auto-1', 5, null, { a: 1 }] : ['good', 7, null, 'Bad Word', '123']),
            }
            const res = await getServedConfig({ store: garbageStore, base: smallBase(), seedVocab: [], now: NOW, log, buildVocabulary: stubVocab })
            assert.deepEqual(res.config.patterns.map(p => p.id), ['base-one', 'base-two'])
            assert.deepEqual(res.config.vocabulary, ['good'])
        })

        it('ignores a garbage changedAt', async () => {
            for (const garbage of ['not a date', 5, { a: 1 }, ['x'], true, '']) {
                await store.set(KEYS.changedAt, garbage)
                const res = await serve()
                assert.equal(res.degraded, false)
                assert.equal(res.config.fetchedAt, '2026-08-01T00:00:00Z')
            }
        })
    })

    describe('degrades to base-only (never throws) on any store failure', () => {
        function baseOnly() {
            return buildServedConfig({ base: smallBase(), approved: [], disabledIds: [], vocabulary: ['balance', 'fee'], now: NOW })
        }

        function brokenStore(overrides) {
            return {
                hgetall: async () => null,
                smembers: async () => [],
                get: async () => null,
                ...overrides,
            }
        }

        async function expectDegraded(storeLike, extra) {
            const res = await getServedConfig({ store: storeLike, base: smallBase(), seedVocab: ['balance', 'fee'], now: NOW, log, ...extra })
            assert.equal(res.degraded, true)
            assert.deepEqual(res.config.patterns, smallBase().patterns)
            assert.equal(res.contentHash, baseOnly().contentHash)
            assert.equal(res.config.contentHash, res.contentHash)
            return res
        }

        it('when any individual read throws a StoreError', async () => {
            const boom = async () => {
                throw new StoreError('network', 'down')
            }
            await expectDegraded(brokenStore({ hgetall: boom }))
            await expectDegraded(brokenStore({ get: boom }))
            await expectDegraded(brokenStore({ smembers: boom }))
            assert.equal(logs.length, 3)
            assert.match(logs[0], /network/)
        })

        it('when the store throws a plain Error, a non-Error, or synchronously', async () => {
            await expectDegraded(brokenStore({ hgetall: async () => { throw new Error('x') } }))
            await expectDegraded(brokenStore({ hgetall: async () => { throw 'string failure' } }))
            await expectDegraded(brokenStore({ hgetall: () => { throw new Error('sync') } }))
            await expectDegraded(brokenStore({ get: () => Promise.reject(undefined) }))
        })

        it('when the store is missing, null or lacks methods', async () => {
            await expectDegraded(undefined)
            await expectDegraded(null)
            await expectDegraded({})
            await expectDegraded('store')
        })

        it('when the store returns top-level garbage of the wrong type', async () => {
            await expectDegraded(brokenStore({ hgetall: async () => 'oops' }))
            await expectDegraded(brokenStore({ hgetall: async () => [1, 2] }))
            await expectDegraded(brokenStore({ hgetall: async () => 7 }))
            await expectDegraded(brokenStore({ smembers: async () => 'oops' }))
            await expectDegraded(brokenStore({ smembers: async () => ({ a: 1 }) }))
            await expectDegraded(brokenStore({ smembers: async () => null }))
        })

        it('when a key holds the wrong Redis type', async () => {
            await store.set(KEYS.approved, 'not a hash')
            await expectDegraded(store)
        })

        it('when the store hangs past the deadline', async () => {
            const hang = () => new Promise(() => {})
            const started = Date.now()
            await expectDegraded(brokenStore({ hgetall: hang }), { timeoutMs: 60 })
            assert.ok(Date.now() - started < 2000)
            assert.match(logs[0], /timeout/)
        })

        it('with a real UpstashStore whose transport fails', async () => {
            const failing = new UpstashStore({ url: 'https://kv.example.invalid', token: 'tok', fetch: async () => { throw new Error('ECONNRESET') }, timeoutMs: 100 })
            await expectDegraded(failing)
            const http500 = new UpstashStore({ url: 'https://kv.example.invalid', token: 'tok', fetch: async () => ({ ok: false, status: 500, text: async () => '<html>' }) })
            await expectDegraded(http500)
            const garbage = new UpstashStore({ url: 'https://kv.example.invalid', token: 'tok', fetch: async () => ({ ok: true, status: 200, text: async () => '{"result":' }) })
            await expectDegraded(garbage)
        })

        it('with an unusable base it still returns a safe empty config instead of throwing', async () => {
            const res = await getServedConfig({ store, base: null, seedVocab: [], now: NOW, log })
            assert.equal(res.degraded, true)
            assert.deepEqual(res.config.patterns, [])
            assert.match(res.config.version, /^regex-v20261021-/)
            const res2 = await getServedConfig({ store, base: { patterns: 'x' }, now: NOW, log })
            assert.equal(res2.degraded, true)
        })

        it('works without any options and tolerates missing seedVocab and now', async () => {
            const res = await getServedConfig({ store, base: smallBase(), log })
            assert.equal(res.degraded, false)
            const original = console.warn
            console.warn = () => {}
            try {
                const bad = await getServedConfig(undefined)
                assert.equal(bad.degraded, true)
            } finally {
                console.warn = original
            }
        })

        it('degraded output is valid for old clients: same patterns and a parseable shape', async () => {
            const res = await expectDegraded(undefined)
            assert.equal(typeof res.config.version, 'string')
            assert.ok(Array.isArray(res.config.patterns))
            for (const p of res.config.patterns) assert.ok(clientAccepts(p))
        })
    })

    it('recovers on its own once the store is healthy again (no sticky degraded state)', async () => {
        let fail = true
        const flaky = {
            hgetall: async k => {
                if (fail) throw new StoreError('http', 'down')
                return store.hgetall(k)
            },
            smembers: k => store.smembers(k),
            get: k => store.get(k),
        }
        await saveApproved(store, makeApproved(1), { now: NOW })
        const down = await getServedConfig({ store: flaky, base: smallBase(), seedVocab: [], now: NOW, log })
        assert.equal(down.degraded, true)
        assert.equal(down.config.patterns.length, 2)
        fail = false
        const up = await getServedConfig({ store: flaky, base: smallBase(), seedVocab: [], now: NOW, log })
        assert.equal(up.degraded, false)
        assert.equal(up.config.patterns.length, 3)
    })

    it('passes the whole real base file through a MemoryStore round trip byte-identically', async () => {
        const res = await getServedConfig({ store, base: REAL_BASE, seedVocab: [], now: NOW, log })
        assert.equal(res.degraded, false)
        assert.equal(res.config.patterns.length, REAL_BASE.patterns.length)
        for (let i = 0; i < REAL_BASE.patterns.length; i++) {
            assert.equal(JSON.stringify(res.config.patterns[i]), JSON.stringify(REAL_BASE.patterns[i]))
        }
    })

    it('ETag material: contentHash matches a recomputation from the served body', async () => {
        await saveApproved(store, makeApproved(1), { now: '2026-10-05T00:00:00Z' })
        const res = await serve()
        const { contentHash, ...rest } = res.config
        assert.equal(contentHash, crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex'))
    })
})
