const { StoreError } = require('./store')
const { VALID_TYPES, CAPTURE_ROLES, TIMESTAMP_PARSERS, CARRIERS, PATTERN_ID_RE, isPlainObject, sha256Hex, countGroups } = require('./_shared')
const { buildVocabulary, WORD_RE } = require('./vocab')

const KEYS = {
    approved: 'manie:approved',
    disabled: 'manie:approved:disabled',
    vocabAdmin: 'manie:vocab:admin',
    changedAt: 'manie:served:changedAt',
}

const CAPTURE_KEYS = CAPTURE_ROLES
const ID_RE = PATTERN_ID_RE
const LOCALE_RE = /^[a-z]{2}-[A-Z]{2}$/
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
const LOOSE_TIME_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/
const MAX_PATTERN_LENGTH = 2400
const MAX_GROUPS = 20
const MAX_TAGS = 10
const MAX_VOCAB_WORDS = 5000
const DEFAULT_LOCALE = 'en-RW'
const EPOCH_ISO = '1970-01-01T00:00:00.000Z'
const DEFAULT_DEADLINE_MS = 6000

function canonicalJson(value) {
    if (value === null) return 'null'
    switch (typeof value) {
        case 'string':
            return JSON.stringify(value)
        case 'number':
            return Number.isFinite(value) ? JSON.stringify(value) : 'null'
        case 'boolean':
            return value ? 'true' : 'false'
        case 'object': {
            if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON())
            if (Array.isArray(value)) {
                return `[${value.map(v => (isSerialisable(v) ? canonicalJson(v) : 'null')).join(',')}]`
            }
            const parts = []
            for (const k of Object.keys(value).sort()) {
                if (isSerialisable(value[k])) parts.push(`${JSON.stringify(k)}:${canonicalJson(value[k])}`)
            }
            return `{${parts.join(',')}}`
        }
        default:
            return 'null'
    }
}

function isSerialisable(v) {
    return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol'
}

function toTime(value) {
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
    if (typeof value === 'string' && ISO_RE.test(value)) return Date.parse(value)
    return NaN
}

// The base file is edited by hand, so a date-only, space-separated or zone-less
// time is read as UTC and normalised instead of being dropped (a dropped time used
// to make the served version depend on the request time).
function toBaseTime(value) {
    const strict = toTime(value)
    if (Number.isFinite(strict)) return { ms: strict, text: typeof value === 'string' ? value : null }
    const m = typeof value === 'string' ? LOOSE_TIME_RE.exec(value.trim()) : null
    if (m) {
        const ms = Date.parse(`${m[1]}T${m[2] || '00:00'}${m[3] || 'Z'}`)
        if (Number.isFinite(ms)) return { ms, text: new Date(ms).toISOString() }
    }
    return { ms: NaN, text: null }
}

let warnedNoBaseTime = false

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value))
}

function fail(id, reason) {
    return { ok: false, id: typeof id === 'string' ? id : null, reason }
}

function normalizePattern(raw) {
    if (!isPlainObject(raw)) return fail(null, 'not_object')
    const id = raw.id
    if (typeof id !== 'string' || !ID_RE.test(id)) return fail(id, 'bad_id')
    if (!CARRIERS.includes(raw.carrier)) return fail(id, 'bad_carrier')
    if (!VALID_TYPES.includes(raw.type)) return fail(id, 'bad_type')
    if (typeof raw.status !== 'string') return fail(id, 'bad_status')

    const source = raw.pattern
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_PATTERN_LENGTH) return fail(id, 'bad_pattern')
    const flags = raw.flags
    if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) {
        return fail(id, 'bad_flags')
    }

    let locale = DEFAULT_LOCALE
    if (raw.locale !== undefined) {
        if (typeof raw.locale !== 'string' || !LOCALE_RE.test(raw.locale)) return fail(id, 'bad_locale')
        locale = raw.locale
    }

    let groups
    try {
        new RegExp(source, flags)
        groups = countGroups(source, flags)
    } catch (err) {
        return fail(id, 'regex_compile')
    }
    if (groups < 1 || groups > MAX_GROUPS) return fail(id, 'bad_group_count')

    if (!isPlainObject(raw.captureMap)) return fail(id, 'bad_capture_map')
    const used = new Set()
    const captureMap = {}
    for (const k of Object.keys(raw.captureMap)) {
        if (!CAPTURE_KEYS.includes(k)) return fail(id, 'bad_capture_map')
    }
    for (const k of CAPTURE_KEYS) {
        const v = raw.captureMap[k]
        if (v === undefined) continue
        if (!Number.isInteger(v) || v < 1 || v > groups || used.has(v)) return fail(id, 'bad_capture_map')
        used.add(v)
        captureMap[k] = v
    }
    if (captureMap.amount === undefined) return fail(id, 'missing_amount')
    if (captureMap.balance === undefined) return fail(id, 'missing_balance')

    let timestamp
    if (raw.timestamp !== undefined && raw.timestamp !== null) {
        const t = raw.timestamp
        if (!isPlainObject(t) || !Number.isInteger(t.group) || t.group < 1 || t.group > groups) return fail(id, 'bad_timestamp')
        if (!TIMESTAMP_PARSERS.includes(t.parser)) return fail(id, 'bad_timestamp')
        timestamp = { group: t.group, parser: t.parser }
    }
    if (captureMap.transactionId === undefined && timestamp === undefined) return fail(id, 'missing_identity')

    let tags = [raw.type]
    if (raw.tags !== undefined) {
        if (!Array.isArray(raw.tags) || raw.tags.length > MAX_TAGS) return fail(id, 'bad_tags')
        tags = []
        for (const tag of raw.tags) {
            if (typeof tag !== 'string' || !TAG_RE.test(tag)) return fail(id, 'bad_tags')
            if (!tags.includes(tag)) tags.push(tag)
        }
    }

    if (raw.carrier === 'airtel' && !/airtel/i.test(id) && !tags.some(tag => /airtel/i.test(tag))) tags.push('airtel')

    const times = {}
    for (const k of ['createdAt', 'updatedAt', 'approvedAt']) {
        if (raw[k] === undefined) continue
        const ms = toTime(raw[k])
        if (!Number.isFinite(ms)) return fail(id, 'bad_time')
        times[k] = new Date(ms).toISOString()
    }
    const createdAt = times.createdAt || times.updatedAt || times.approvedAt || EPOCH_ISO
    const updatedAt = times.updatedAt || times.approvedAt || times.createdAt || EPOCH_ISO

    const pattern = { id, carrier: raw.carrier, locale, type: raw.type, pattern: source, flags, captureMap }
    if (timestamp) pattern.timestamp = timestamp
    pattern.tags = tags
    pattern.status = raw.status
    pattern.createdAt = createdAt
    pattern.updatedAt = updatedAt
    return { ok: true, pattern }
}

function validateApprovedPattern(raw) {
    const res = normalizePattern(raw)
    if (!res.ok) return res
    if (res.pattern.status !== 'active') return fail(res.pattern.id, 'inactive')
    return res
}

function normalizeVocabulary(list) {
    const items = list instanceof Set ? [...list] : list
    if (!Array.isArray(items)) return []
    const out = new Set()
    for (const w of items) {
        if (typeof w !== 'string') continue
        const word = w.trim().toLowerCase()
        if (WORD_RE.test(word)) out.add(word)
    }
    return [...out].sort().slice(0, MAX_VOCAB_WORDS)
}

function pickWinner(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
    return canonicalJson(a) >= canonicalJson(b) ? a : b
}

function selectServedPatterns(input) {
    const base = input && input.base
    if (!isPlainObject(base) || !Array.isArray(base.patterns)) throw new TypeError('base.patterns must be an array')
    const approved = input.approved === undefined ? [] : input.approved
    if (!Array.isArray(approved)) throw new TypeError('approved must be an array')
    const disabled = new Set((Array.isArray(input.disabledIds) ? input.disabledIds : []).filter(id => typeof id === 'string'))

    const dropped = []
    const byId = new Map()
    for (const raw of approved) {
        const res = validateApprovedPattern(raw)
        if (!res.ok) {
            dropped.push({ id: res.id, reason: res.reason })
            continue
        }
        const prev = byId.get(res.pattern.id)
        byId.set(res.pattern.id, prev ? pickWinner(prev, res.pattern) : res.pattern)
    }
    for (const id of [...byId.keys()]) {
        if (disabled.has(id)) byId.delete(id)
    }

    const patterns = []
    const served = []
    const used = new Set()
    for (const p of base.patterns) {
        if (!isPlainObject(p) || typeof p.id !== 'string' || typeof p.pattern !== 'string' || p.status !== 'active') continue
        if (disabled.has(p.id)) continue
        const override = byId.get(p.id)
        if (override) {
            patterns.push(cloneJson(override))
            served.push(override)
            used.add(p.id)
        } else {
            patterns.push(cloneJson(p))
        }
    }
    for (const id of [...byId.keys()].sort()) {
        if (used.has(id)) continue
        patterns.push(cloneJson(byId.get(id)))
        served.push(byId.get(id))
    }
    return { patterns, served, dropped }
}

function yyyymmdd(ms) {
    return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')
}

function buildServedConfig(input) {
    const selection = selectServedPatterns(input)
    const base = input.base
    const vocabulary = normalizeVocabulary(input.vocabulary)

    let best = { ms: NaN, text: null }
    const consider = (ms, text) => {
        if (Number.isFinite(ms) && !(ms <= best.ms)) best = { ms, text }
    }
    const baseTime = toBaseTime(base.fetchedAt)
    consider(baseTime.ms, baseTime.text)
    const changedMs = toTime(input.changedAt)
    if (Number.isFinite(changedMs)) consider(changedMs, new Date(changedMs).toISOString())
    for (const p of selection.served) consider(Date.parse(p.updatedAt), p.updatedAt)
    if (!Number.isFinite(best.ms)) {
        if (!warnedNoBaseTime) {
            warnedNoBaseTime = true
            console.warn('[manie] the base file has no usable fetchedAt, serving the epoch so that the version never depends on the request time')
        }
        best = { ms: 0, text: EPOCH_ISO }
    }
    const fetchedAt = best.text || new Date(best.ms).toISOString()

    const version = `regex-v${yyyymmdd(best.ms)}-${sha256Hex(canonicalJson({ patterns: selection.patterns, vocabulary })).slice(0, 8)}`
    const body = {
        version,
        defaultLocale: typeof base.defaultLocale === 'string' ? base.defaultLocale : DEFAULT_LOCALE,
        fetchedAt,
        patterns: selection.patterns,
        vocabulary,
    }
    const contentHash = sha256Hex(canonicalJson(body))
    return { config: { ...body, contentHash }, contentHash, dropped: selection.dropped }
}

function withDeadline(promise, ms) {
    let timer
    promise.catch(() => {})
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new StoreError('timeout', 'served config read timed out')), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function readServedInputs(store) {
    const [approvedRaw, disabledRaw, wordsRaw, changedAt] = await Promise.all([
        store.hgetall(KEYS.approved),
        store.smembers(KEYS.disabled),
        store.smembers(KEYS.vocabAdmin),
        store.get(KEYS.changedAt),
    ])
    if (approvedRaw !== null && !isPlainObject(approvedRaw)) throw new StoreError('protocol', 'approved store is malformed')
    if (!Array.isArray(disabledRaw)) throw new StoreError('protocol', 'disabled set is malformed')
    if (!Array.isArray(wordsRaw)) throw new StoreError('protocol', 'vocabulary set is malformed')

    const approved = []
    const dropped = []
    for (const field of Object.keys(approvedRaw || {})) {
        const value = approvedRaw[field]
        if (!isPlainObject(value)) {
            dropped.push({ id: field, reason: 'not_object' })
        } else if (value.id === undefined) {
            approved.push({ ...value, id: field })
        } else if (value.id !== field) {
            dropped.push({ id: field, reason: 'id_mismatch' })
        } else {
            approved.push(value)
        }
    }
    return {
        approved,
        dropped,
        disabledIds: disabledRaw.filter(id => typeof id === 'string'),
        adminWords: wordsRaw.filter(w => typeof w === 'string'),
        changedAt,
    }
}

function degradedConfig(base, seedVocab, nowIso) {
    try {
        const built = buildServedConfig({ base, approved: [], disabledIds: [], vocabulary: seedVocab, now: nowIso })
        return { config: built.config, contentHash: built.contentHash, degraded: true, dropped: [] }
    } catch (err) {
        const body = {
            version: `regex-v${yyyymmdd(Date.parse(nowIso))}-00000000`,
            defaultLocale: DEFAULT_LOCALE,
            fetchedAt: nowIso,
            patterns: [],
            vocabulary: [],
        }
        const contentHash = sha256Hex(canonicalJson(body))
        return { config: { ...body, contentHash }, contentHash, degraded: true, dropped: [] }
    }
}

async function getServedConfig(opts) {
    const { store, base, seedVocab, timeoutMs, log } = opts || {}
    const warn = typeof log === 'function' ? log : console.warn
    const nowMs = toTime(opts && opts.now)
    const nowIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString()
    const seed = seedVocab === undefined ? [] : seedVocab
    try {
        const inputs = await withDeadline(readServedInputs(store), timeoutMs || DEFAULT_DEADLINE_MS)
        const selection = selectServedPatterns({ base, approved: inputs.approved, disabledIds: inputs.disabledIds })

        let vocabSet
        try {
            const build = (opts && opts.buildVocabulary) || buildVocabulary
            vocabSet = build({
                seed: normalizeVocabulary(seed),
                patterns: selection.patterns,
                adminWords: inputs.adminWords,
            })
        } catch (err) {
            warn('[manie] vocabulary builder failed, serving seed and admin words only:', err && err.name)
            vocabSet = [...normalizeVocabulary(seed), ...inputs.adminWords]
        }

        const built = buildServedConfig({
            base,
            approved: inputs.approved,
            disabledIds: inputs.disabledIds,
            vocabulary: vocabSet,
            changedAt: inputs.changedAt,
            now: nowIso,
        })
        const dropped = [...inputs.dropped, ...built.dropped]
        const invalid = dropped.filter(d => d.reason !== 'inactive').length
        if (invalid > 0) warn(`[manie] dropped ${invalid} invalid approved pattern(s) from the served config`)
        return { config: built.config, contentHash: built.contentHash, degraded: false, dropped }
    } catch (err) {
        warn('[manie] served config degraded to base only:', (err && (err.code || err.name)) || 'error')
        return degradedConfig(base, seed, nowIso)
    }
}

async function touchChanged(store, now) {
    const ms = toTime(now)
    await store.set(KEYS.changedAt, new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString())
}

async function touchChangedQuietly(store, now) {
    try {
        await touchChanged(store, now)
    } catch (err) {
        console.warn('[manie] could not record the change time:', (err && (err.code || err.name)) || 'error')
    }
}

async function saveApproved(store, record, opts) {
    const ms = toTime(opts && opts.now)
    const nowIso = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString()
    const input = isPlainObject(record) ? record : {}
    const res = normalizePattern({
        ...input,
        status: 'active',
        createdAt: input.createdAt === undefined ? nowIso : input.createdAt,
        updatedAt: nowIso,
    })
    if (!res.ok) return res
    // The shape that wrote a pattern is recorded next to it (never served), so that a retried
    // approval can tell its own earlier write from another shape's pattern under the same id.
    const stored = opts && typeof opts.shapeId === 'string' ? { ...res.pattern, sourceShapeId: opts.shapeId } : res.pattern
    if (opts && opts.claim) {
        // The id is taken atomically: of two approvals racing for the same id exactly
        // one writes it, the other is told the id is taken and nothing is overwritten.
        const claimed = await store.hsetnx(KEYS.approved, res.pattern.id, stored)
        if (!claimed) return fail(res.pattern.id, 'id_conflict')
    } else {
        await store.hset(KEYS.approved, { [res.pattern.id]: stored })
    }
    await touchChangedQuietly(store, nowIso)
    return res
}

async function setDisabled(store, id, disabled, opts) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return false
    const n = disabled ? await store.sadd(KEYS.disabled, id) : await store.srem(KEYS.disabled, id)
    await touchChangedQuietly(store, opts && opts.now)
    return n > 0
}

async function readApproved(store) {
    const [raw, disabledRaw] = await Promise.all([store.hgetall(KEYS.approved), store.smembers(KEYS.disabled)])
    const disabled = new Set(Array.isArray(disabledRaw) ? disabledRaw : [])
    const items = []
    for (const id of Object.keys(raw || {}).sort()) {
        const value = raw[id]
        const res = isPlainObject(value) && value.id === undefined ? normalizePattern({ ...value, id }) : normalizePattern(value)
        const valid = res.ok && res.pattern.id === id
        items.push({
            id,
            valid,
            reason: valid ? undefined : res.ok ? 'id_mismatch' : res.reason,
            pattern: valid ? res.pattern : null,
            disabled: disabled.has(id),
        })
    }
    return { items, disabledIds: [...disabled].sort() }
}

module.exports = {
    KEYS,
    ID_RE,
    VALID_TYPES,
    canonicalJson,
    sha256Hex,
    normalizePattern,
    validateApprovedPattern,
    normalizeVocabulary,
    selectServedPatterns,
    buildServedConfig,
    getServedConfig,
    touchChanged,
    touchChangedQuietly,
    saveApproved,
    setDisabled,
    readApproved,
}
