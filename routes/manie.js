const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const express = require('express')

const { sanitizeSkeletonDetailed, canonicalSkeleton, shapeId: computeShapeId } = require('../lib/manie/anonymize')
const { isNoiseSkeleton } = require('../lib/manie/noise')
const { draftFromShape } = require('../lib/manie/draft')
const { runGate, testPattern, createSandbox } = require('../lib/manie/gate')
const { createStore } = require('../lib/manie/store')
const { createGuardedStore } = require('../lib/manie/guard')
const { KEYS, ID_RE, getServedConfig, saveApproved, setDisabled, readApproved, touchChangedQuietly } = require('../lib/manie/formats')
const { requireAdmin, ipHash, stripCors, hashSalt, isProduction } = require('../lib/manie/auth')
const { rateLimit, refund, createLocalLimiter } = require('../lib/manie/ratelimit')
const { ADMIN_WORD_RE, literalWordsOfRegexSource } = require('../lib/manie/vocab')
const { RESTRICTED_VOCAB_WORDS } = require('../lib/manie/_names')
const { VALID_TYPES, CAPTURE_ROLES, HINT_ROLES, CARRIERS, MINTED_ID_RE, isPlainObject, sha256Hex } = require('../lib/manie/_shared')
const { DRAFT_CODE_VERSION } = require('../lib/manie/_version')

// Every rate limit of the public submission endpoint, in one place. Many mobile users in
// Rwanda share a carrier-NAT address, so the per-address limits are generous (counted in
// submitted items, not requests); the global cap is what bounds the storage and CPU that
// an abuser spread over many addresses can cost. Over any limit the endpoint answers 429
// with a Retry-After.
const RATE_LIMITS = Object.freeze({
    perIpPerHour: 600, // items per address in a one-hour window that starts at its first item
    perIpPerDay: 3000, // items per address in a 24-hour window that starts at its first item
    newShapesPerIpPerDay: 100, // new pending shapes one address may create per day; the rest are discarded
    globalPerDay: 30000, // items from all addresses together per UTC calendar day
    localRequestsPer10Min: 120, // per-instance pre-filter in front of the store, requests per address
})

const BASE_FILE = path.join(__dirname, '..', 'assets', 'manie', 'sms-formats.json')
const SEED_FILE = path.join(__dirname, '..', 'assets', 'manie', 'vocab-seed.json')
const ADMIN_HTML_FILE = path.join(__dirname, '..', 'assets', 'manie', 'admin.html')

const K = {
    shape: (id) => `manie:shape:${id}`,
    pending: 'manie:shapes:pending',
    approvedShapes: 'manie:shapes:approved',
    rejectedShapes: 'manie:shapes:rejected',
    approved: KEYS.approved,
    disabled: KEYS.disabled,
    vocab: KEYS.vocabAdmin,
    subHour: (bucket) => `manie:stats:sub:${bucket}`,
    evicted: 'manie:stats:evicted',
    evictedHour: (bucket) => `manie:stats:evicted:${bucket}`,
    rlHour: (h) => `manie:rl:sub:h:${h}`,
    rlDay: (h) => `manie:rl:sub:d:${h}`,
    rlGlobal: (yyyymmdd) => `manie:rl:global:${yyyymmdd}`,
    newShapesDay: (h) => `manie:rl:new:d:${h}`,
    approveLock: (id) => `manie:approve:lock:${id}`,
}

const LIMITS = {
    submissionBytes: 16 * 1024,
    adminBodyBytes: 64 * 1024,
    maxItems: 20,
    maxSkeleton: 400,
    maxCount: 50,
    maxHints: 20,
    maxAppVersions: 5,
    maxPending: 2000,
    maxVoters: 100,
    protectedVoters: 5,
    protectedShare: 0.25,
    minResidencyMs: 6 * 3600 * 1000,
    bulkRejectMax: 100,
    keepDays: 14,
    maxPattern: 2400,
    maxMessage: 2000,
    maxGroup: 20,
    maxAdminVocab: 2000,
    servedTtlMs: 30 * 1000,
    degradedTtlMs: 5 * 1000,
    listDraftBudgetMs: 4000,
    testTimeoutMs: 250,
    coverageTimeoutMs: 10,
    coverageBudgetMs: 60,
    publicBudgetMs: 3000,
    adminBudgetMs: 8000,
    approveLockSec: 30,
}

// Built-in patterns that exist only in the served base file; every other base id
// is also compiled into the app, so switching it off server-side changes nothing
// on devices.
const REMOTE_ONLY_BASE_IDS = ['mtn-token-payment-v1']

const PLATFORMS = new Set(['android', 'ios'])
const HINT_ROLE_SET = new Set(HINT_ROLES)
const TYPE_SET = new Set(VALID_TYPES)
const CARRIER_SET = new Set(CARRIERS)
const CAPTURE_KEYS = new Set(CAPTURE_ROLES)
const TS_PARSERS = new Set(['iso8601', 'airtel-shortcode'])
const DRAFT_KEYS = [
    'id',
    'carrier',
    'locale',
    'type',
    'pattern',
    'flags',
    'captureMap',
    'timestamp',
    'tags',
    'status',
    'sourceShape',
    'confidence',
    'notes',
    'gate',
    'shapeId',
]
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SHAPE_ID_RE = /^[0-9a-f]{16}$/
const LOCALE_RE = /^(?:en|rw|fr|sw)(?:-[A-Za-z]{2})?$/
const DRAFT_LOCALE_RE = /^[a-z]{2}-[A-Z]{2}$/
const APP_VERSION_RE = /^\d{1,3}(?:\.\d{1,3}){1,3}(?:\+\d{1,6}| \(\d{1,6}\))?$/
const LITERAL_RE = /^[\x20-\x7E]{0,60}$/
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/

class ApiError extends Error {
    constructor(status, code, detail, extra) {
        super(code)
        this.status = status
        this.code = code
        this.detail = detail
        this.extra = extra
    }
}

const bad = (detail) => new ApiError(400, 'invalid_body', detail)

function logError(context, err) {
    const name = err && err.name ? err.name : 'Error'
    const message = err && typeof err.message === 'string' ? err.message.slice(0, 120) : ''
    console.error(`[manie] ${context}: ${name} ${message}`.trim())
}

function sendError(res, status, error, detail, extra) {
    const body = { error }
    if (detail !== undefined) body.detail = detail
    return res.status(status).json(Object.assign(body, extra))
}

function hasForbiddenKey(value, depth = 0) {
    if (depth > 8) return true
    if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, depth + 1))
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            if (FORBIDDEN_KEYS.has(key) || hasForbiddenKey(value[key], depth + 1)) return true
        }
    }
    return false
}

const safeName = (k) => (/^[\w-]{1,32}$/.test(k) ? k : '?')

function assertKeys(obj, allowed, where) {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) throw bad(`unexpected field ${safeName(key)} in ${where}`)
    }
}

function assertInt(value, min, max, where) {
    if (!Number.isInteger(value) || value < min || value > max) throw bad(`${where} must be an integer ${min}..${max}`)
    return value
}

function assertString(value, min, max, where) {
    if (typeof value !== 'string' || value.length < min || value.length > max) {
        throw bad(`${where} must be a string of ${min}..${max} characters`)
    }
    return value
}

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
        logError(`cannot read ${path.basename(file)}`, err)
        return null
    }
}

const hasActivePattern = (parsed) =>
    Boolean(parsed) && Array.isArray(parsed.patterns) && parsed.patterns.some((p) => p && p.status === 'active' && typeof p.pattern === 'string')

// A base file that cannot be read, cannot be parsed or has no active pattern is
// never replaced by an empty one: the router refuses to serve a config built on it.
let baseCache = null
function loadBase() {
    if (baseCache) return baseCache
    const parsed = readJsonFile(BASE_FILE)
    if (hasActivePattern(parsed)) baseCache = parsed
    return baseCache
}

let seedCache = null
function loadSeedVocab() {
    if (seedCache) return seedCache
    const parsed = readJsonFile(SEED_FILE)
    let words = []
    if (Array.isArray(parsed)) words = parsed
    else if (parsed && Array.isArray(parsed.words)) words = parsed.words
    words = words.filter((w) => typeof w === 'string')
    if (words.length) seedCache = words
    return words
}

let adminHtmlCache = null
function loadAdminHtml() {
    if (adminHtmlCache) return adminHtmlCache
    try {
        adminHtmlCache = fs.readFileSync(ADMIN_HTML_FILE, 'utf8')
    } catch (err) {
        if (!err || err.code !== 'ENOENT') logError('cannot read admin page', err)
        return null
    }
    return adminHtmlCache
}

const FALLBACK_ADMIN_HTML =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Manie admin</title></head><body><p>The admin page is not available on this deployment yet.</p></body></html>'

function renderAdminPage(nonce) {
    const html = loadAdminHtml() || FALLBACK_ADMIN_HTML
    return html.replace(/<(script|style)(?![^>]*\snonce=)/gi, `<$1 nonce="${nonce}"`)
}

function adminCsp(nonce) {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join('; ')
}

function validateCaptureMap(value, where, allowRemoval = false) {
    if (!isPlainObject(value)) throw bad(`${where} must be an object`)
    const clean = {}
    for (const key of Object.keys(value)) {
        if (!CAPTURE_KEYS.has(key)) throw bad(`unexpected field ${safeName(key)} in ${where}`)
        if (allowRemoval && (value[key] === null || value[key] === 0)) clean[key] = null
        else clean[key] = assertInt(value[key], 1, LIMITS.maxGroup, `${where}.${key}`)
    }
    return clean
}

function validateTimestamp(value, where) {
    if (!isPlainObject(value)) throw bad(`${where} must be an object`)
    assertKeys(value, ['group', 'parser'], where)
    const group = assertInt(value.group, 1, LIMITS.maxGroup, `${where}.group`)
    if (typeof value.parser !== 'string' || !TS_PARSERS.has(value.parser)) throw bad(`${where}.parser is not supported`)
    return { group, parser: value.parser }
}

function validateFlags(value, where) {
    assertString(value, 0, 8, where)
    const stripped = value.replace(/[gy]/g, '')
    if (!/^[imsu]*$/.test(stripped)) throw bad(`${where} contains unsupported flags`)
    return Array.from(new Set(stripped.split(''))).join('')
}

function validatePatternId(value, where) {
    if (typeof value !== 'string' || !MINTED_ID_RE.test(value)) throw bad(`${where} must match ${MINTED_ID_RE.source}`)
    return value
}

function validAppVersion(value) {
    return APP_VERSION_RE.test(value) && (value.match(/\d/g) || []).length <= 8
}

function validateSubmission(body) {
    if (!isPlainObject(body)) throw bad('body must be a JSON object')
    assertKeys(body, ['v', 'items', 'app'], 'body')
    if (body.v !== 1) throw bad('v must be 1')
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > LIMITS.maxItems) {
        throw bad(`items must be an array of 1..${LIMITS.maxItems}`)
    }
    if (!isPlainObject(body.app)) throw bad('app must be an object')
    assertKeys(body.app, ['version', 'platform'], 'app')
    assertString(body.app.version, 1, 32, 'app.version')
    if (!validAppVersion(body.app.version)) throw bad('app.version is not a version number')
    if (typeof body.app.platform !== 'string' || !PLATFORMS.has(body.app.platform)) throw bad('app.platform is not supported')

    const items = body.items.map((item, i) => {
        const where = `items[${i}]`
        if (!isPlainObject(item)) throw bad(`${where} must be an object`)
        assertKeys(item, ['skeleton', 'carrier', 'locale', 'count', 'hints'], where)
        assertString(item.skeleton, 1, LIMITS.maxSkeleton, `${where}.skeleton`)
        if (typeof item.carrier !== 'string' || !CARRIER_SET.has(item.carrier)) throw bad(`${where}.carrier is not supported`)
        let locale
        if (item.locale !== undefined) {
            assertString(item.locale, 2, 10, `${where}.locale`)
            if (!LOCALE_RE.test(item.locale)) throw bad(`${where}.locale is not a supported locale`)
            locale = item.locale
        }
        if (item.count !== undefined) assertInt(item.count, 1, LIMITS.maxCount, `${where}.count`)
        const hints = []
        if (item.hints !== undefined) {
            if (!Array.isArray(item.hints) || item.hints.length > LIMITS.maxHints) {
                throw bad(`${where}.hints must be an array of at most ${LIMITS.maxHints}`)
            }
            item.hints.forEach((hint, j) => {
                const hw = `${where}.hints[${j}]`
                if (!isPlainObject(hint)) throw bad(`${hw} must be an object`)
                assertKeys(hint, ['slot', 'role'], hw)
                assertInt(hint.slot, 1, LIMITS.maxHints, `${hw}.slot`)
                if (typeof hint.role !== 'string' || !HINT_ROLE_SET.has(hint.role)) throw bad(`${hw}.role is not supported`)
                hints.push({ slot: hint.slot, role: hint.role })
            })
        }
        return { skeleton: item.skeleton, carrier: item.carrier, locale, hints }
    })

    return { items, app: { version: body.app.version, platform: body.app.platform } }
}

// The server rewrites out-of-vocabulary words, which can renumber the slots a
// device counted. Hints follow their slot to the new number, and hints whose slot
// was merged into a run or did not exist on the device are dropped.
function remapHints(hints, slotMap) {
    const seen = new Set()
    const out = []
    for (const { slot, role } of hints) {
        const mapped = slotMap[slot - 1]
        if (!mapped || seen.has(mapped)) continue
        seen.add(mapped)
        out.push({ slot: mapped, role })
    }
    return out
}

function validateDraft(draft, where = 'draft') {
    if (!isPlainObject(draft)) throw bad(`${where} must be an object`)
    assertKeys(draft, DRAFT_KEYS, where)
    const clean = {}
    if (draft.id !== undefined) clean.id = validatePatternId(draft.id, `${where}.id`)
    if (typeof draft.carrier !== 'string' || !CARRIER_SET.has(draft.carrier)) throw bad(`${where}.carrier is not supported`)
    clean.carrier = draft.carrier
    if (draft.locale !== undefined) {
        assertString(draft.locale, 5, 5, `${where}.locale`)
        if (!DRAFT_LOCALE_RE.test(draft.locale)) throw bad(`${where}.locale is malformed`)
        clean.locale = draft.locale
    }
    if (typeof draft.type !== 'string' || !TYPE_SET.has(draft.type)) throw bad(`${where}.type is not supported`)
    clean.type = draft.type
    assertString(draft.pattern, 1, LIMITS.maxPattern, `${where}.pattern`)
    clean.pattern = draft.pattern
    clean.flags = draft.flags === undefined ? 'i' : validateFlags(draft.flags, `${where}.flags`)
    clean.captureMap = validateCaptureMap(draft.captureMap, `${where}.captureMap`)
    if (draft.timestamp !== undefined && draft.timestamp !== null) {
        clean.timestamp = validateTimestamp(draft.timestamp, `${where}.timestamp`)
    }
    if (draft.tags !== undefined) {
        if (!Array.isArray(draft.tags) || draft.tags.length > 8) throw bad(`${where}.tags must be an array of at most 8`)
        clean.tags = draft.tags.map((tag, i) => {
            if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw bad(`${where}.tags[${i}] is malformed`)
            return tag
        })
    }
    return clean
}

function validateRedraft(body) {
    if (!isPlainObject(body)) throw bad('body must be a JSON object')
    assertKeys(body, ['type', 'captureMap', 'timestamp', 'id', 'wordsAsLiteral'], 'body')
    const overrides = {}
    if (body.type !== undefined) {
        if (typeof body.type !== 'string' || !TYPE_SET.has(body.type)) throw bad('type is not supported')
        overrides.type = body.type
    }
    if (body.id !== undefined && body.id !== '') overrides.id = validatePatternId(body.id, 'id')
    if (body.captureMap !== undefined) overrides.captureMap = validateCaptureMap(body.captureMap, 'captureMap', true)
    if (body.timestamp === null) overrides.timestamp = null
    else if (body.timestamp !== undefined) overrides.timestamp = validateTimestamp(body.timestamp, 'timestamp')
    if (body.wordsAsLiteral !== undefined) {
        if (!Array.isArray(body.wordsAsLiteral) || body.wordsAsLiteral.length > LIMITS.maxGroup) {
            throw bad(`wordsAsLiteral must be an array of at most ${LIMITS.maxGroup}`)
        }
        overrides.wordsAsLiteral = body.wordsAsLiteral.map((w, i) => {
            if (typeof w !== 'string' || !LITERAL_RE.test(w)) throw bad(`wordsAsLiteral[${i}] must be up to 60 printable characters`)
            return w
        })
    }
    return overrides
}

function validateTestBody(body) {
    if (!isPlainObject(body)) throw bad('body must be a JSON object')
    assertKeys(body, ['pattern', 'flags', 'captureMap', 'timestamp', 'message'], 'body')
    assertString(body.pattern, 1, LIMITS.maxPattern, 'pattern')
    assertString(body.message, 1, LIMITS.maxMessage, 'message')
    return {
        spec: {
            pattern: body.pattern,
            flags: body.flags === undefined ? 'i' : validateFlags(body.flags, 'flags'),
            captureMap: body.captureMap === undefined ? {} : validateCaptureMap(body.captureMap, 'captureMap'),
            timestamp:
                body.timestamp === undefined || body.timestamp === null ? undefined : validateTimestamp(body.timestamp, 'timestamp'),
        },
        message: body.message,
    }
}

// Words that are also common given names or digits must not become literal text of a served pattern
// (and so served vocabulary) by the side door of a draft: the vocabulary endpoint refuses them too.
// A word the vocabulary already has is not new, so it is not asked about again.
function restrictedNewWords(words, served) {
    const out = new Set()
    for (const word of words) {
        const w = String(word).toLowerCase()
        if (RESTRICTED_VOCAB_WORDS.has(w) && !served.vocab.has(w)) out.add(w)
    }
    return Array.from(out)
}

const restrictedWordError = (words) =>
    new ApiError(409, 'restricted_word', 'these words are common given names or spelled-out digits; a literal copy would leak them from real messages (send force: true to add them anyway)', { words })

function wordsOfLiteralEntries(entries) {
    return entries.flatMap((entry) => entry.replace(/^\s*\d{1,2}\s*[:=]\s*/, '').split(/\s+/).filter(Boolean))
}

function synthesizeFromSkeleton(skeleton) {
    const fill = { N: '1000', PH: '250788123456', TS: '2026-01-02 03:04:05', TID: 'AB260102.0304.C12345', URL: 'https://example.com/x', EMAIL: 'a@example.com', W: 'Alice', 'W+': 'Alice Bob' }
    return skeleton.replace(/\{(N|PH|TS|TID|URL|EMAIL|W\+|W)\}/g, (m, k) => fill[k])
}

// One vm context per served pattern, kept between requests: every submitted item is run against
// every served pattern, so a cache smaller than the served set would rebuild the contexts of the
// whole set for every item. The cache is sized to the set (plus room for superseded versions) and
// drops its least recently used entry, never everything at once.
const coverageSandboxes = new Map()
const COVERAGE_COOLDOWN_MS = 60 * 1000
const COVERAGE_CACHE_MIN = 150
const COVERAGE_CACHE_SLACK = 100
const COVERAGE_STATS = { created: 0, skipped: 0, budgetStops: 0 }

function coverageSandbox(pattern, capacity = COVERAGE_CACHE_MIN) {
    const flags = typeof pattern.flags === 'string' ? pattern.flags.replace(/[gy]/g, '') : ''
    const key = `${flags}\u0000${pattern.pattern}`
    let entry = coverageSandboxes.get(key)
    if (entry) {
        coverageSandboxes.delete(key)
        coverageSandboxes.set(key, entry)
        return entry
    }
    entry = { sandbox: null, disabledAt: 0 }
    try {
        COVERAGE_STATS.created += 1
        entry.sandbox = createSandbox(pattern.pattern, flags)
    } catch (err) {
        if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return entry
        logError(`served pattern ${String(pattern.id).slice(0, 60)} does not compile`, err)
    }
    while (coverageSandboxes.size >= Math.max(1, capacity)) coverageSandboxes.delete(coverageSandboxes.keys().next().value)
    coverageSandboxes.set(key, entry)
    return entry
}

const cpuMsSince = (start) => {
    const used = process.cpuUsage(start)
    return (used.user + used.system) / 1000
}

// Runs the served patterns against a message synthesized from attacker-shaped
// text, so every execution is time-boxed in a vm sandbox, a pattern that keeps
// timing out is skipped for a minute, and the whole check has a small CPU budget
// (CPU time, so that a busy process does not mistake waiting for work).
function matchesActivePattern(served, skeleton) {
    const message = synthesizeFromSkeleton(skeleton)
    const cpuStart = process.cpuUsage()
    const capacity = Math.max(COVERAGE_CACHE_MIN, served.patterns.length + COVERAGE_CACHE_SLACK)
    for (const p of served.patterns) {
        if (!p || typeof p.pattern !== 'string') continue
        if (cpuMsSince(cpuStart) > LIMITS.coverageBudgetMs) {
            COVERAGE_STATS.budgetStops += 1
            return false
        }
        const entry = coverageSandbox(p, capacity)
        const sandbox = entry.sandbox
        if (!sandbox) continue
        if (sandbox.timeouts >= 3) {
            if (!entry.disabledAt) entry.disabledAt = Date.now()
            if (Date.now() - entry.disabledAt < COVERAGE_COOLDOWN_MS) {
                COVERAGE_STATS.skipped += 1
                continue
            }
            sandbox.timeouts = 0
            entry.disabledAt = 0
        }
        if (sandbox.exec(message, LIMITS.coverageTimeoutMs).matched) return true
    }
    return false
}

// The app decides the carrier of a stored transaction from the live pattern list
// (isAirtelMessage), so pulling an Airtel pattern also re-labels what it captured.
const AIRTEL_DISABLE_WARNING =
    'This is an Airtel pattern. The app works out the carrier of every stored transaction from the live pattern list, so while it is off the transactions it captured read as MTN (cards, exports and balances) until it is switched on again.'

function isAirtelPattern(id, record) {
    if (/airtel/i.test(id)) return true
    if (!record || typeof record !== 'object') return false
    return record.carrier === 'airtel' || (Array.isArray(record.tags) && record.tags.some((tag) => typeof tag === 'string' && /airtel/i.test(tag)))
}

function dayKey(date) {
    return date.toISOString().slice(0, 10)
}

// The global daily counter belongs to one UTC calendar day: its key carries the date and it
// expires at the next UTC midnight, which is also when a refused caller should come back.
const utcDayStamp = (date) => dayKey(date).replace(/-/g, '')

function secondsToUtcMidnight(date) {
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
    return Math.max(1, Math.ceil((next - date.getTime()) / 1000))
}

function hourBucket(date) {
    return date.toISOString().slice(0, 13).replace(/\D/g, '')
}

function pendingScore(voters, createdMs) {
    return Math.max(1, voters) + createdMs / 1e14
}

function isShape(rec) {
    return Boolean(rec) && typeof rec === 'object' && typeof rec.skeleton === 'string'
}

function unpackShape(rec) {
    const hintVotes = isPlainObject(rec.hintVotes) ? JSON.parse(JSON.stringify(rec.hintVotes)) : {}
    const perDayCounts = {}
    let voters = 0
    for (const field of Object.keys(rec)) {
        if (field.startsWith('h:')) {
            const [, slot, role] = field.split(':')
            if (slot && role) {
                hintVotes[slot] = hintVotes[slot] || {}
                hintVotes[slot][role] = Number(rec[field]) || 0
            }
        } else if (field.startsWith('d:')) {
            perDayCounts[field.slice(2)] = Number(rec[field]) || 0
        } else if (field.startsWith('v:')) {
            voters++
        }
    }
    return Object.assign({}, rec, { hintVotes, perDayCounts, voters })
}

function createManieRouter(options = {}) {
    const environment = options.env || process.env
    const rawStore = options.store || createStore(environment)
    const store = createGuardedStore(rawStore, options.guard)
    const loadedBase = options.base || loadBase()
    const seedVocab = loadSeedVocab()
    const configProblem = !loadedBase || !Array.isArray(loadedBase.patterns) ? 'base' : seedVocab.length === 0 ? 'seed' : null
    const base = configProblem === 'base' ? { version: 'regex-v0', defaultLocale: 'en-RW', fetchedAt: '1970-01-01T00:00:00Z', patterns: [] } : loadedBase
    const clock = typeof options.now === 'function' ? options.now : () => new Date()
    const servedTtlMs = options.servedTtlMs === undefined ? LIMITS.servedTtlMs : options.servedTtlMs
    const publicBudgetMs = options.publicBudgetMs || LIMITS.publicBudgetMs
    const adminBudgetMs = options.adminBudgetMs || LIMITS.adminBudgetMs
    loadAdminHtml()
    const baseIds = new Set(base.patterns.map((p) => p && p.id))
    const builtInIds = options.builtInIds
        ? new Set(options.builtInIds)
        : new Set([...baseIds].filter((id) => !REMOTE_ONLY_BASE_IDS.includes(id)))
    const production = isProduction(environment)
    const storageReady = !production || rawStore.persistent !== false
    const saltReady = !production || hashSalt(environment).configured
    const router = express.Router()
    const submissionsPre = createLocalLimiter({ max: RATE_LIMITS.localRequestsPer10Min, windowSec: 600 })
    const submissionsLocked = createLocalLimiter({ max: 1, windowSec: 1 })
    const globalLocked = createLocalLimiter({ max: 1, windowSec: 1, now: () => clock().getTime() })

    if (configProblem) {
        console.error(`[manie] config_unavailable: the ${configProblem === 'base' ? 'base pattern file (sms-formats.json)' : 'vocabulary seed (vocab-seed.json)'} is missing, unreadable or empty, so the served config and approvals are refused until it is repaired`)
    }
    if (production && !storageReady) {
        console.error('[manie] storage_not_configured: KV_REST_API_URL and KV_REST_API_TOKEN are missing, submissions and admin writes are disabled')
    }
    if (production && !saltReady) {
        console.error('[manie] hash_salt_not_configured: MANIE_HASH_SALT (at least 16 characters) is missing, submissions are disabled')
    }

    let servedCache = null
    let lastGood = null
    let inflight = null

    async function loadServed() {
        let result
        try {
            result = await getServedConfig({ store, base, seedVocab, now: clock().toISOString(), timeoutMs: publicBudgetMs })
        } catch (err) {
            logError('served config failed', err)
            result = null
        }
        if (!result || !result.config || !Array.isArray(result.config.patterns)) {
            return { config: Object.assign({}, base, { vocabulary: seedVocab }), contentHash: sha256Hex(JSON.stringify(base)), degraded: true }
        }
        const contentHash = typeof result.contentHash === 'string' && result.contentHash ? result.contentHash : sha256Hex(JSON.stringify(result.config))
        return { config: result.config, contentHash, degraded: Boolean(result.degraded) }
    }

    function describeServed(loaded) {
        return {
            config: loaded.config,
            contentHash: loaded.contentHash,
            degraded: loaded.degraded,
            stale: false,
            patterns: loaded.config.patterns,
            vocab: new Set((loaded.config.vocabulary || []).filter((w) => typeof w === 'string').map((w) => w.toLowerCase())),
            body: null,
        }
    }

    async function refreshServed() {
        const loaded = await loadServed()
        let value
        if (!loaded.degraded) {
            value = describeServed(loaded)
            lastGood = value
        } else if (lastGood) {
            value = Object.assign({}, lastGood, { degraded: true, stale: true })
        } else {
            value = describeServed(loaded)
        }
        servedCache = { at: Date.now(), value }
        return value
    }

    async function getServed({ fresh = false } = {}) {
        if (!fresh && servedCache) {
            const ttl = servedCache.value.degraded ? Math.min(servedTtlMs, LIMITS.degradedTtlMs) : servedTtlMs
            if (Date.now() - servedCache.at < ttl) return servedCache.value
        }
        if (!fresh && inflight) return inflight
        const pending = refreshServed().finally(() => {
            if (inflight === pending) inflight = null
        })
        if (!fresh) inflight = pending
        return pending
    }

    const invalidateServed = () => {
        servedCache = null
    }

    function servedBody(served) {
        if (!served.body) served.body = JSON.stringify(Object.assign({}, served.config, { contentHash: served.contentHash }))
        return served.body
    }

    const gateOptionsOf = (served) => ({ existingPatterns: served.patterns })
    const gateKeyOf = (served) => `${served.contentHash}:${DRAFT_CODE_VERSION}`

    async function safeGate(draft, served) {
        try {
            return await runGate(draft, gateOptionsOf(served))
        } catch (err) {
            logError('gate crashed', err)
            return { ok: false, checks: [{ name: 'gate', ok: false, detail: 'gate could not complete' }] }
        }
    }

    function shapeInputOf(rec, id) {
        const input = {
            shapeId: id,
            skeleton: rec.skeleton,
            carrier: rec.carrier,
            hintVotes: rec.hintVotes || {},
            count: Number(rec.count) || 1,
            revision: Number(rec.revision) || 1,
        }
        if (rec.locale) input.locale = rec.locale
        return input
    }

    async function refreshDraft(id, rec, served, overrides, writes) {
        let draft = rec.draft
        let gate
        const codeChanged = rec.draftCode !== DRAFT_CODE_VERSION && !rec.draftEdited
        if (!draft || overrides || codeChanged) {
            try {
                const full = await draftFromShape(shapeInputOf(rec, id), overrides, gateOptionsOf(served))
                gate = full.gate
                draft = Object.assign({}, full)
                delete draft.gate
            } catch (err) {
                logError(`draft failed for ${id}`, err)
                return rec
            }
        }
        if (!gate) gate = await safeGate(draft, served)
        const update = { draft, gate, gateHash: gateKeyOf(served), draftCode: rec.draftCode }
        if (!rec.draft || overrides || codeChanged) update.draftCode = DRAFT_CODE_VERSION
        if (overrides) update.draftEdited = Object.keys(overrides).length > 0
        if (writes) {
            writes.push(
                store.hset(K.shape(id), update).catch((err) => {
                    logError(`draft cache write failed for ${id}`, err)
                })
            )
        } else {
            await store.hset(K.shape(id), update)
        }
        return Object.assign({}, rec, update)
    }

    async function loadShape(id) {
        const rec = await store.hgetall(K.shape(id))
        return isShape(rec) ? unpackShape(rec) : null
    }

    function shapeView(id, rec) {
        return {
            shapeId: id,
            skeleton: rec.skeleton,
            carrier: rec.carrier,
            locale: rec.locale || null,
            status: rec.status,
            count: Number(rec.count) || 0,
            voters: rec.voters || 0,
            revision: Number(rec.revision) || 1,
            firstSeen: rec.firstSeen || null,
            lastSeen: rec.lastSeen || null,
            appVersions: rec.appVersions || [],
            hintVotes: rec.hintVotes || {},
            perDayCounts: rec.perDayCounts || {},
            approvedId: rec.approvedId || null,
            rejectReason: rec.rejectReason || null,
            previousApprovedIds: rec.previousApprovedIds || [],
            draft: rec.draft || null,
            gate: rec.gate || null,
        }
    }

    const voterToken = (hash, id) => sha256Hex(`${hash}:${id}`).slice(0, 10)

    async function allowNewShape(hash) {
        const res = await rateLimit(store, K.newShapesDay(hash), { max: RATE_LIMITS.newShapesPerIpPerDay, windowSec: 86400, log: (...a) => logError(a.join(' ')) })
        return res.allowed
    }

    async function recordItem({ skeleton, id, item, app, now, hash, served }) {
        const key = K.shape(id)
        const today = dayKey(now)
        const nowIso = now.toISOString()
        const token = voterToken(hash, id)
        let rec = await store.hgetall(key)
        let outcome = 'merged'

        // `status` is the commit marker of a shape: it is written in the same HSET as the
        // rest of the record, after the queue entry. A record that has a skeleton but no
        // status was left behind by a request that failed half-way (or is still being
        // created by a concurrent one); whoever sees it finishes it with the same
        // idempotent writes, so a storage blip can never leave a format unqueued.
        if (!isShape(rec) || typeof rec.status !== 'string') {
            const record = {
                carrier: item.carrier,
                status: 'pending',
                firstSeen: nowIso,
                lastSeen: nowIso,
                appVersions: [app.version],
            }
            if (item.locale) record.locale = item.locale
            let claimed = false
            if (!isShape(rec)) {
                let covered = false
                try {
                    covered = matchesActivePattern(served, skeleton)
                } catch (err) {
                    logError('coverage check failed', err)
                }
                if (covered) return 'dropped'
                if (!(await allowNewShape(hash))) return 'dropped'
                claimed = await store.hsetnx(key, 'skeleton', skeleton)
            }
            if (claimed) {
                await store.zadd(K.pending, pendingScore(1, now.getTime()), id)
                await store.hset(key, record)
                outcome = 'created'
                rec = { skeleton, status: 'pending' }
            } else {
                rec = (await store.hgetall(key)) || { skeleton, status: 'pending' }
                if (isShape(rec) && typeof rec.status !== 'string') {
                    const voters = Object.keys(rec).filter((f) => f.startsWith('v:')).length
                    await store.zadd(K.pending, pendingScore(Math.max(1, voters), now.getTime()), id)
                    await store.hset(key, record)
                    rec = Object.assign({}, rec, { status: 'pending' })
                }
            }
        }

        const voted = rec[`v:${token}`]
        const isNewVoter = voted === undefined
        const voterCount = Object.keys(rec).filter((f) => f.startsWith('v:')).length
        const counted = voted !== today && (!isNewVoter || voterCount < LIMITS.maxVoters)

        const fields = { lastSeen: nowIso }
        const writes = []
        const versions = Array.isArray(rec.appVersions) ? rec.appVersions : []
        if (outcome !== 'created' && !versions.includes(app.version) && versions.length < LIMITS.maxAppVersions) {
            fields.appVersions = versions.concat(app.version)
        }
        if (counted) {
            fields[`v:${token}`] = today
            writes.push(store.hincrby(key, 'count', 1), store.hincrby(key, `d:${today}`, 1))
            if (isNewVoter) {
                for (const { slot, role } of item.hints) writes.push(store.hincrby(key, `h:${slot}:${role}`, 1))
                if (outcome !== 'created' && (rec.status === 'pending' || rec.status === 'approving')) {
                    writes.push(store.zincrby(K.pending, 1, id))
                }
            }
        }
        const minDay = dayKey(new Date(now.getTime() - LIMITS.keepDays * 86400000))
        const stale = Object.keys(rec).filter((f) => f.startsWith('d:') && f.slice(2) < minDay)
        if (stale.length) writes.push(store.hdel(key, ...stale))
        writes.push(store.hset(key, fields))
        if (counted && isNewVoter && item.hints.length && rec.draft && !rec.draftEdited) writes.push(store.hdel(key, 'draft'))
        await Promise.all(writes)
        return outcome
    }

    // A shape earns protection from eviction with voters, and voters are cheap: a handful of addresses
    // can vote a whole queue of junk past the threshold, after which no genuine new format could ever be
    // queued. So protection is a ranking, not a threshold: only the best-voted quarter of the queue (and
    // only entries that reach protectedVoters) is shielded. Below the shield the lowest score goes first
    // (fewest voters, then oldest), except that a shape younger than minResidencyMs is only evicted when
    // nothing older is left: a genuine new format needs a few hours to collect its first votes, and must
    // not be pushed out by the next newcomer. The creation time is the fractional part of the score.
    const createdMsOfScore = (score) => Math.round((score - Math.floor(score)) * 1e14)

    async function enforcePendingCap(newIds) {
        const total = await store.zcard(K.pending)
        if (total <= LIMITS.maxPending) return new Set()
        const overflow = total - LIMITS.maxPending
        const shieldSize = Math.max(1, Math.floor(LIMITS.maxPending * LIMITS.protectedShare))
        const [edge] = await store.zrevrange(K.pending, shieldSize - 1, shieldSize - 1, { withScores: true })
        const shieldFloor = Math.max(LIMITS.protectedVoters, edge ? edge.score : 0)
        const nowMs = clock().getTime()
        const victims = []
        const young = []
        let boughtProtection = 0
        let offset = 0
        scan: while (victims.length < overflow) {
            const page = await store.zrange(K.pending, offset, offset + 199, { withScores: true })
            if (!page.length) break
            offset += page.length
            for (const { member, score } of page) {
                if (victims.length >= overflow) break scan
                if (newIds.has(member)) continue
                if (score >= shieldFloor) break scan
                if (nowMs - createdMsOfScore(score) < LIMITS.minResidencyMs) {
                    young.push(member)
                    continue
                }
                if (Math.floor(score) >= LIMITS.protectedVoters) boughtProtection += 1
                victims.push(member)
            }
        }
        for (const member of young) {
            if (victims.length >= overflow) break
            victims.push(member)
        }
        for (const id of newIds) {
            if (victims.length >= overflow) break
            victims.push(id)
        }
        for (const id of victims) {
            await store.zrem(K.pending, id)
            await store.del(K.shape(id))
        }
        if (victims.length) {
            console.error(`[manie] queue_full: evicted ${victims.length} pending shape(s) to stay at ${LIMITS.maxPending}, ${boughtProtection} of them with ${LIMITS.protectedVoters} or more voters`)
            try {
                await store.incr(K.evicted, { by: victims.length })
                await store.incr(K.evictedHour(hourBucket(clock())), { by: victims.length, ex: 26 * 3600 })
            } catch (err) {
                logError('eviction counter failed', err)
            }
        }
        return new Set(victims)
    }

    // Everything that changes the state of one shape (approve, reject, reopen) holds this lock, so that
    // two admins, or a double click, can never interleave their writes and leave a shape whose status
    // contradicts the pattern that is live.
    async function withShapeLock(id, busyCode, fn) {
        const lockKey = K.approveLock(id)
        const locked = await store.set(lockKey, crypto.randomBytes(8).toString('hex'), { ex: LIMITS.approveLockSec, nx: true })
        if (!locked) throw new ApiError(409, busyCode)
        try {
            return await fn()
        } finally {
            store.del(lockKey).catch((err) => logError('shape lock release failed', err))
        }
    }

    const wrap = (handler, budgetMs = publicBudgetMs) => (req, res, next) => {
        store
            .runWithDeadline(budgetMs, () => Promise.resolve().then(() => handler(req, res)))
            .catch((err) => {
                if (err instanceof ApiError) return sendError(res, err.status, err.code, err.detail, err.extra)
                return next(err)
            })
    }
    const wrapAdmin = (handler) => wrap(handler, adminBudgetMs)

    const requireStorage = (req, res, next) => (storageReady ? next() : sendError(res, 503, 'storage_not_configured'))

    router.use('/admin', (req, res, next) => {
        stripCors(res)
        res.set('Cache-Control', 'no-store')
        next()
    })

    router.use('/submissions', (req, res, next) => {
        stripCors(res)
        next()
    })

    const jsonParser = express.json({ limit: '100kb' })
    router.use((req, res, next) => {
        if (req._body) return next()
        return jsonParser(req, res, next)
    })

    router.get(
        '/sms-formats',
        wrap(async (req, res) => {
            if (configProblem) {
                res.set({ 'Retry-After': '300', 'Cache-Control': 'no-store', 'X-Manie-Degraded': 'config' })
                return sendError(res, 503, 'config_unavailable')
            }
            const served = await getServed()
            // A base-only answer is a 200 that devices apply as the new truth, dropping every approved
            // pattern: so a production deployment whose store is missing or failing refuses instead.
            // Only a development process (no persistent store expected) serves the base file as is.
            let degraded = null
            if (!storageReady) degraded = 'storage'
            else if (served.degraded) degraded = served.stale ? 'stale' : 'kv'
            if (degraded === 'kv' || degraded === 'storage') {
                res.set({ 'Retry-After': '30', 'Cache-Control': 'no-store', 'X-Manie-Degraded': degraded })
                return sendError(res, 503, 'config_unavailable')
            }
            const etag = `"${served.contentHash}"`
            res.set('ETag', etag)
            res.set('Cache-Control', degraded ? 'no-store' : 'public, max-age=0, s-maxage=300, stale-while-revalidate=600')
            if (degraded) res.set('X-Manie-Degraded', degraded)
            const presented = String(req.headers['if-none-match'] || '')
                .split(',')
                .map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
            if (presented.includes(served.contentHash) || presented.includes('*')) return res.status(304).end()
            return res.status(200).type('application/json').send(servedBody(served))
        })
    )

    router.post(
        '/submissions',
        wrap(async (req, res) => {
            if (configProblem) throw new ApiError(503, 'config_unavailable')
            if (!storageReady) throw new ApiError(503, 'storage_not_configured')
            if (!saltReady) throw new ApiError(503, 'hash_salt_not_configured')
            const declared = parseInt(req.headers['content-length'], 10)
            if (declared > LIMITS.submissionBytes) throw new ApiError(413, 'payload_too_large')
            if (!isPlainObject(req.body)) throw bad('body must be a JSON object')
            if (hasForbiddenKey(req.body)) throw bad('forbidden key')
            if (Buffer.byteLength(JSON.stringify(req.body)) > LIMITS.submissionBytes) throw new ApiError(413, 'payload_too_large')

            const { items, app } = validateSubmission(req.body)
            const served = await getServed()

            const cleaned = items.map((item, index) => {
                const result = sanitizeSkeletonDetailed(item.skeleton, served.vocab)
                if (!result || !result.ok) throw new ApiError(400, 'pii_guard', undefined, { index })
                const hints = remapHints(item.hints, result.slotMap).filter((h) => h.slot <= result.slotCount)
                return { item: Object.assign({}, item, { hints }), skeleton: canonicalSkeleton(result.skeleton) }
            })

            const hash = ipHash(req, environment)
            const lockedFor = submissionsLocked.lockedFor(hash)
            if (lockedFor) {
                res.set('Retry-After', String(lockedFor))
                throw new ApiError(429, 'rate_limited')
            }
            const pre = submissionsPre.hit(hash)
            if (!pre.allowed) {
                res.set('Retry-After', String(pre.retryAfterSec))
                throw new ApiError(429, 'rate_limited')
            }

            const now = clock()
            const globalKey = K.rlGlobal(utcDayStamp(now))
            const globalWindowSec = secondsToUtcMidnight(now)
            const globalLockedFor = globalLocked.lockedFor('global')
            if (globalLockedFor) {
                res.set('Retry-After', String(globalLockedFor))
                throw new ApiError(429, 'rate_limited')
            }

            const cost = cleaned.length
            const hourKey = K.rlHour(hash)
            const dayLimitKey = K.rlDay(hash)
            const [hourly, daily] = await Promise.all([
                rateLimit(store, hourKey, { max: RATE_LIMITS.perIpPerHour, windowSec: 3600, cost }),
                rateLimit(store, dayLimitKey, { max: RATE_LIMITS.perIpPerDay, windowSec: 86400, cost }),
            ])
            const refundAddress = () => {
                const refunds = []
                if (hourly.allowed && !hourly.degraded) refunds.push(refund(store, hourKey, cost, 3600))
                if (daily.allowed && !daily.degraded) refunds.push(refund(store, dayLimitKey, cost, 86400))
                return Promise.all(refunds)
            }
            if (!hourly.allowed || !daily.allowed) {
                await refundAddress()
                const denied = !hourly.allowed ? hourly : daily
                const retryAfter = denied.retryAfterSec || (!hourly.allowed ? 3600 : 86400)
                if (denied.remaining === 0) submissionsLocked.lock(hash, retryAfter)
                res.set('Retry-After', String(retryAfter))
                throw new ApiError(429, 'rate_limited')
            }

            // Only requests that passed the address limits are counted against the global cap,
            // so one noisy address cannot spend it on its own; a refusal here gives the
            // address its allowance back, since it was not the address's doing.
            // (When the address counters could not be read, the store is failing: fail open here too
            // instead of making a third call that can only fail.)
            const overall =
                hourly.degraded || daily.degraded
                    ? { allowed: true, degraded: true }
                    : await rateLimit(store, globalKey, { max: RATE_LIMITS.globalPerDay, windowSec: globalWindowSec, cost })
            if (!overall.allowed) {
                if (!overall.degraded) await refundAddress()
                const retryAfter = Math.min(globalWindowSec, overall.retryAfterSec || globalWindowSec)
                if (overall.remaining === 0) globalLocked.lock('global', retryAfter)
                res.set('Retry-After', String(retryAfter))
                throw new ApiError(429, 'rate_limited')
            }

            // The response counts every submitted item exactly once:
            //   accepted  = items that were stored: they created a new pending shape or were
            //               merged into one that already existed;
            //   deduped   = the part of `accepted` that did not create a shape (it merged into an
            //               existing one, or repeated another item of the same request), so
            //               `accepted - deduped` is the number of new shapes;
            //   discarded = items that were NOT stored: non-transaction notices (OTP, failed or
            //               reversed payments...), shapes an active pattern already covers, shapes
            //               refused by the per-address new-shape cap, and shapes evicted from a
            //               full queue. A discarded item is never reported as accepted.
            // accepted + discarded = the number of items sent. The status is 202 either way.
            const distinct = new Map()
            let discarded = 0
            for (const { item, skeleton } of cleaned) {
                if (isNoiseSkeleton(skeleton).noise) {
                    discarded += 1
                    continue
                }
                const id = computeShapeId(skeleton, item.carrier)
                const known = distinct.get(id)
                if (known) known.items += 1
                else distinct.set(id, { id, item, skeleton, items: 1 })
            }
            let outcomes = []
            let evicted = new Set()
            try {
                outcomes = await Promise.all(
                    [...distinct.values()].map((entry) =>
                        recordItem({ skeleton: entry.skeleton, id: entry.id, item: entry.item, app, now, hash, served }).then((outcome) => ({ entry, outcome }))
                    )
                )
                const created = outcomes.filter((o) => o.outcome === 'created').map((o) => o.entry.id)
                if (created.length > 0) evicted = await enforcePendingCap(new Set(created))
            } catch (err) {
                logError('submission storage failed', err)
                throw new ApiError(503, 'storage_unavailable')
            }
            let deduped = 0
            for (const { entry, outcome } of outcomes) {
                if (outcome === 'dropped' || evicted.has(entry.id)) discarded += entry.items
                else if (outcome === 'created') deduped += entry.items - 1
                else deduped += entry.items
            }
            try {
                await store.incr(K.subHour(hourBucket(now)), { ex: 26 * 3600 })
            } catch (err) {
                logError('submission counter failed', err)
            }
            return res.status(202).json({ accepted: cleaned.length - discarded, deduped, discarded })
        })
    )

    router.get('/admin', (req, res) => {
        const nonce = crypto.randomBytes(16).toString('base64')
        stripCors(res)
        res.set({
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': adminCsp(nonce),
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Opener-Policy': 'same-origin',
        })
        res.status(200).send(renderAdminPage(nonce))
    })

    const adminApi = express.Router()

    adminApi.use((req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff')
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            if (!isPlainObject(req.body)) req.body = {}
            if (hasForbiddenKey(req.body)) return sendError(res, 400, 'invalid_body', 'forbidden key')
            if (Buffer.byteLength(JSON.stringify(req.body)) > LIMITS.adminBodyBytes) return sendError(res, 413, 'payload_too_large')
        }
        return next()
    })

    adminApi.get(
        '/pending',
        wrapAdmin(async (req, res) => {
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25))
            const offset = /^\d{1,6}$/.test(String(req.query.cursor || '')) ? parseInt(req.query.cursor, 10) : 0
            const total = await store.zcard(K.pending)
            const ids = await store.zrevrange(K.pending, offset, offset + limit - 1)
            const served = await getServed({ fresh: true })
            const records = await Promise.all(ids.map((id) => loadShape(id)))
            const deadline = Date.now() + LIMITS.listDraftBudgetMs
            const writes = []
            const shapes = []
            for (let i = 0; i < ids.length; i++) {
                let rec = records[i]
                if (rec && typeof rec.status !== 'string') continue
                if (!rec || (rec.status !== 'pending' && rec.status !== 'approving')) {
                    await store.zrem(K.pending, ids[i])
                    continue
                }
                if ((!rec.draft || rec.gateHash !== gateKeyOf(served)) && Date.now() < deadline) {
                    rec = await refreshDraft(ids[i], rec, served, undefined, writes)
                }
                shapes.push(shapeView(ids[i], rec))
            }
            await Promise.all(writes)
            const consumed = offset + ids.length
            return res.json({ shapes, total, nextCursor: consumed < total ? String(consumed) : null })
        })
    )

    adminApi.get(
        '/shape/:shapeId',
        wrapAdmin(async (req, res) => {
            const id = req.params.shapeId
            if (!SHAPE_ID_RE.test(id)) throw new ApiError(404, 'not_found')
            let rec = await loadShape(id)
            if (!rec) throw new ApiError(404, 'not_found')
            if (rec.status === 'pending' || rec.status === 'approving') {
                const served = await getServed({ fresh: true })
                if (!rec.draft || rec.gateHash !== gateKeyOf(served)) rec = await refreshDraft(id, rec, served)
            }
            return res.json({ shape: shapeView(id, rec) })
        })
    )

    adminApi.post(
        '/shape/:shapeId/redraft',
        wrapAdmin(async (req, res) => {
            const id = req.params.shapeId
            if (!SHAPE_ID_RE.test(id)) throw new ApiError(404, 'not_found')
            const { force, ...rest } = isPlainObject(req.body) ? req.body : {}
            if (force !== undefined && typeof force !== 'boolean') throw bad('force must be a boolean')
            const overrides = validateRedraft(rest)
            const rec = await loadShape(id)
            if (!rec) throw new ApiError(404, 'not_found')
            if (rec.status === 'approved') throw new ApiError(409, 'already_approved')
            const served = await getServed({ fresh: true })
            if (overrides.wordsAsLiteral && force !== true) {
                const restricted = restrictedNewWords(wordsOfLiteralEntries(overrides.wordsAsLiteral), served)
                if (restricted.length) throw restrictedWordError(restricted)
            }
            const next = await refreshDraft(id, rec, served, overrides)
            if (!next.draft) throw new ApiError(422, 'draft_failed')
            return res.json({ shapeId: id, draft: next.draft, gate: next.gate })
        })
    )

    adminApi.post(
        '/test',
        wrapAdmin(async (req, res) => {
            const { spec, message } = validateTestBody(req.body)
            let result
            try {
                result = await testPattern(spec, message, { timeoutMs: LIMITS.testTimeoutMs })
            } catch (err) {
                throw new ApiError(422, 'invalid_pattern', String((err && err.message) || 'pattern failed').slice(0, 200))
            }
            return res.json(result)
        })
    )

    const ID_TAKEN = 'id already approved (reopen the shape and choose a new id to replace it)'
    const ownerOf = (record) => (isPlainObject(record) && typeof record.sourceShapeId === 'string' ? record.sourceShapeId : undefined)

    async function approveLocked(id, clean, res, force) {
        if (configProblem) throw new ApiError(503, 'config_unavailable')
        const rec = await loadShape(id)
        if (!rec) throw new ApiError(404, 'not_found')
        if (rec.status === 'approved') throw new ApiError(409, 'already_approved')

        const revision = Number(rec.revision) || 1
        const patternId = clean.id || `auto-${clean.carrier}-${clean.type}-${id.slice(0, 8)}${revision > 1 ? `-r${revision}` : ''}`
        if (baseIds.has(patternId)) throw new ApiError(409, 'id_conflict', 'id belongs to a built-in pattern')
        // A pattern that already exists under this id is only ours to rewrite when this very shape
        // wrote it during an approval that was interrupted: any other owner keeps its pattern.
        const resuming = rec.status === 'approving' && rec.approvingId === patternId
        const existing = await store.hget(K.approved, patternId)
        if (existing) {
            const owner = ownerOf(existing)
            if (!(resuming && (owner === undefined || owner === id))) throw new ApiError(409, 'id_conflict', ID_TAKEN)
        }

        const served = await getServed({ fresh: true })
        if (served.degraded) throw new ApiError(503, 'served_config_unavailable')
        if (force !== true) {
            const restricted = restrictedNewWords(literalWordsOfRegexSource(clean.pattern), served)
            if (restricted.length) throw restrictedWordError(restricted)
        }
        let sourceShape = rec.draft && rec.draft.sourceShape
        if (!sourceShape) {
            try {
                sourceShape = (await draftFromShape(shapeInputOf(rec, id), undefined, { gate: false })).sourceShape
            } catch (err) {
                logError(`reference draft failed for ${id}`, err)
                throw new ApiError(422, 'draft_failed')
            }
        }
        const candidate = Object.assign({}, clean, { id: patternId, status: 'pending_review', sourceShape })
        const gate = await safeGate(candidate, served)
        if (!gate || !gate.ok) throw new ApiError(422, 'gate_failed', 'the pattern did not pass the gate', { gate })

        const nowIso = clock().toISOString()
        const record = {
            id: patternId,
            carrier: clean.carrier,
            locale: clean.locale || served.config.defaultLocale || 'en-RW',
            type: clean.type,
            pattern: clean.pattern,
            flags: clean.flags,
            captureMap: clean.captureMap,
            tags: clean.tags && clean.tags.length ? clean.tags : [clean.type],
        }
        if (clean.timestamp) record.timestamp = clean.timestamp

        // An earlier approval of this shape under another id may have written its pattern before it
        // failed: that pattern is live but this shape would no longer point at it. Switch it off and keep
        // its id on the shape, so that it is never an untracked pattern.
        const previous = Array.isArray(rec.previousApprovedIds) ? rec.previousApprovedIds.slice() : []
        if (rec.status === 'approving' && rec.approvingId && rec.approvingId !== patternId) {
            const stale = await store.hget(K.approved, rec.approvingId)
            const staleOwner = ownerOf(stale)
            if (stale && (staleOwner === undefined || staleOwner === id)) {
                await setDisabled(store, rec.approvingId, true, { now: nowIso })
                if (!previous.includes(rec.approvingId)) previous.push(rec.approvingId)
            }
        }

        const key = K.shape(id)
        await store.hset(key, { status: 'approving', approvingId: patternId })
        let saved
        try {
            saved = await saveApproved(store, record, { now: nowIso, claim: !existing, shapeId: id })
        } catch (err) {
            logError(`approve ${id} was interrupted before the pattern was written`, err)
            throw err
        }
        if (!saved.ok) {
            await store.hset(key, { status: rec.status === 'approving' ? 'pending' : rec.status })
            await store.hdel(key, 'approvingId')
            if (saved.reason === 'id_conflict') throw new ApiError(409, 'id_conflict', ID_TAKEN)
            throw new ApiError(422, 'invalid_pattern', saved.reason)
        }
        const finalFields = {
            status: 'approved',
            approvedId: patternId,
            approvedAt: nowIso,
            draft: candidate,
            gate,
            gateHash: gateKeyOf(served),
        }
        if (previous.length) finalFields.previousApprovedIds = previous
        await store.hset(key, finalFields)
        await store.hdel(key, 'approvingId')
        await store.zrem(K.pending, id)
        await store.sadd(K.approvedShapes, id)
        invalidateServed()
        const after = await getServed({ fresh: true })
        return res.json({ ok: true, id: patternId, pattern: saved.pattern, version: after.config.version, contentHash: after.contentHash, gate })
    }

    adminApi.post(
        '/shape/:shapeId/approve',
        requireStorage,
        wrapAdmin(async (req, res) => {
            const id = req.params.shapeId
            if (!SHAPE_ID_RE.test(id)) throw new ApiError(404, 'not_found')
            if (!isPlainObject(req.body)) throw bad('body must be a JSON object')
            assertKeys(req.body, ['draft', 'force'], 'body')
            const clean = validateDraft(req.body.draft)
            if (req.body.force !== undefined && typeof req.body.force !== 'boolean') throw bad('force must be a boolean')

            return withShapeLock(id, 'approve_in_progress', () => approveLocked(id, clean, res, req.body.force))
        })
    )

    async function rejectLocked(id, reason) {
        const rec = await loadShape(id)
        if (!rec) throw new ApiError(404, 'not_found')
        if (rec.status === 'approved') throw new ApiError(409, 'already_approved')
        if (rec.status === 'approving' && rec.approvingId) {
            await setDisabled(store, rec.approvingId, true, { now: clock().toISOString() })
            invalidateServed()
        }
        await store.hset(K.shape(id), { status: 'rejected', rejectedAt: clock().toISOString(), rejectReason: reason })
        await store.hdel(K.shape(id), 'approvingId')
        await store.zrem(K.pending, id)
        await store.sadd(K.rejectedShapes, id)
    }

    adminApi.post(
        '/shape/:shapeId/reject',
        requireStorage,
        wrapAdmin(async (req, res) => {
            const id = req.params.shapeId
            if (!SHAPE_ID_RE.test(id)) throw new ApiError(404, 'not_found')
            if (!isPlainObject(req.body)) throw bad('body must be a JSON object')
            assertKeys(req.body, ['reason'], 'body')
            let reason = ''
            if (req.body.reason !== undefined) reason = assertString(req.body.reason, 0, 200, 'reason')
            await withShapeLock(id, 'shape_busy', () => rejectLocked(id, reason))
            return res.json({ ok: true })
        })
    )

    // Clears a queue that junk has filled: the lowest-ranked shapes (fewest voters first, oldest first
    // among equals) up to a vote count, optionally only those first seen long enough ago. Rejected, not
    // deleted, so that the same text does not come back as a new shape. A bounded batch per call; the
    // caller repeats until `remaining` stops falling.
    adminApi.post(
        '/pending/reject',
        requireStorage,
        wrapAdmin(async (req, res) => {
            if (!isPlainObject(req.body)) throw bad('body must be a JSON object')
            assertKeys(req.body, ['maxVoters', 'olderThanHours', 'limit', 'reason'], 'body')
            const maxVoters = assertInt(req.body.maxVoters, 1, 100000, 'maxVoters')
            const olderThanHours = req.body.olderThanHours === undefined ? 0 : assertInt(req.body.olderThanHours, 0, 24 * 365, 'olderThanHours')
            const limit = req.body.limit === undefined ? LIMITS.bulkRejectMax : assertInt(req.body.limit, 1, LIMITS.bulkRejectMax, 'limit')
            const reason = req.body.reason === undefined ? 'bulk reject' : assertString(req.body.reason, 0, 200, 'reason')
            const cutoff = clock().getTime() - olderThanHours * 3600000

            const chosen = []
            let offset = 0
            let busy = 0
            scan: while (chosen.length < limit) {
                const page = await store.zrange(K.pending, offset, offset + 49, { withScores: true })
                if (!page.length) break
                offset += page.length
                const eligible = page.filter(({ score }) => Math.floor(score) <= maxVoters)
                const records = await Promise.all(eligible.map(({ member }) => loadShape(member)))
                for (const [i, { member }] of eligible.entries()) {
                    if (chosen.length >= limit) break scan
                    const rec = records[i]
                    if (!rec || rec.status !== 'pending') continue
                    if (olderThanHours > 0 && !(Date.parse(rec.firstSeen) <= cutoff)) continue
                    chosen.push(member)
                }
                if (eligible.length < page.length) break
            }
            let rejected = 0
            for (let i = 0; i < chosen.length; i += 10) {
                const outcomes = await Promise.all(
                    chosen.slice(i, i + 10).map((id) =>
                        withShapeLock(id, 'shape_busy', () => rejectLocked(id, reason)).then(
                            () => 'rejected',
                            (err) => {
                                if (err instanceof ApiError) return err.code === 'shape_busy' ? 'busy' : 'skipped'
                                throw err
                            }
                        )
                    )
                )
                rejected += outcomes.filter((o) => o === 'rejected').length
                busy += outcomes.filter((o) => o === 'busy').length
            }
            return res.json({ ok: true, rejected, busy, remaining: await store.zcard(K.pending) })
        })
    )

    adminApi.post(
        '/shape/:shapeId/reopen',
        requireStorage,
        wrapAdmin(async (req, res) => {
            const id = req.params.shapeId
            if (!SHAPE_ID_RE.test(id)) throw new ApiError(404, 'not_found')
            return withShapeLock(id, 'shape_busy', () => reopenLocked(id, res))
        })
    )

    const REOPEN_MARKERS = ['approvedId', 'approvedAt', 'approvingId', 'rejectedAt', 'rejectReason']
    const REOPEN_STALE_DRAFT = ['draft', 'gate', 'gateHash', 'draftEdited']

    // Reopening is a sequence of writes and can stop anywhere, so the whole sequence can be run again:
    // every step is idempotent and the "already pending" answer is only given when there was nothing
    // left to clean up, which is what tells a double click from an interrupted reopen.
    async function reopenLocked(id, res) {
        const rec = await loadShape(id)
        if (!rec) throw new ApiError(404, 'not_found')
        const key = K.shape(id)
        if (rec.status === 'pending') {
            const markers = REOPEN_MARKERS.filter((field) => rec[field] !== undefined)
            if (markers.length) await store.hdel(key, ...markers, ...REOPEN_STALE_DRAFT)
            const stale = (await store.srem(K.approvedShapes, id)) + (await store.srem(K.rejectedShapes, id))
            const queued = (await store.zscore(K.pending, id)) !== null
            if (!queued) {
                // pending but missing from the queue (an earlier write was lost): put it back
                await store.zadd(K.pending, pendingScore(rec.voters, Date.parse(rec.firstSeen) || clock().getTime()), id)
                return res.json({ ok: true, shapeId: id, revision: Number(rec.revision) || 1, requeued: true })
            }
            if (markers.length || stale) return res.json({ ok: true, shapeId: id, revision: Number(rec.revision) || 1, recovered: true })
            throw new ApiError(409, 'already_pending')
        }
        if (rec.status === 'approving') throw new ApiError(409, 'approval_in_progress', 'retry the approval or reject the shape')
        if (rec.status === 'approved') {
            const disabled = await store.smembers(K.disabled)
            if (!disabled.includes(rec.approvedId)) {
                throw new ApiError(409, 'pattern_live', 'disable the approved pattern first, then reopen the shape')
            }
        }
        const revision = (Number(rec.revision) || 1) + 1
        const previous = (rec.previousApprovedIds || []).concat(rec.approvedId ? [rec.approvedId] : [])
        await store.zadd(K.pending, pendingScore(rec.voters, Date.parse(rec.firstSeen) || clock().getTime()), id)
        await store.hset(key, { status: 'pending', revision, previousApprovedIds: previous })
        await store.hdel(key, ...REOPEN_MARKERS, ...REOPEN_STALE_DRAFT)
        await store.srem(K.approvedShapes, id)
        await store.srem(K.rejectedShapes, id)
        return res.json({ ok: true, shapeId: id, revision })
    }

    adminApi.get(
        '/approved',
        wrapAdmin(async (req, res) => {
            const { items, disabledIds } = await readApproved(store)
            const approved = items
                .map((it) =>
                    it.valid
                        ? Object.assign({}, it.pattern, { enabled: !it.disabled })
                        : { id: it.id, invalid: true, reason: it.reason, enabled: false }
                )
                .sort((x, y) => String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')))
            return res.json({ approved, disabledIds })
        })
    )

    async function setEnabled(req, res, enabled) {
        const id = req.params.id
        if (!ID_RE.test(id)) throw new ApiError(404, 'not_found')
        const record = await store.hget(K.approved, id)
        if (!record && !baseIds.has(id)) throw new ApiError(404, 'not_found')
        if (!enabled && !record && builtInIds.has(id)) {
            throw new ApiError(409, 'builtin_pattern', 'this pattern is compiled into the app, so switching it off here would not change what devices do')
        }
        await setDisabled(store, id, !enabled, { now: clock().toISOString() })
        invalidateServed()
        const after = await getServed({ fresh: true })
        const body = { ok: true, id, enabled, version: after.config.version, contentHash: after.contentHash }
        if (!enabled && isAirtelPattern(id, record)) body.warnings = [AIRTEL_DISABLE_WARNING]
        return res.json(body)
    }

    adminApi.post('/approved/:id/disable', requireStorage, wrapAdmin((req, res) => setEnabled(req, res, false)))
    adminApi.post('/approved/:id/enable', requireStorage, wrapAdmin((req, res) => setEnabled(req, res, true)))

    adminApi.get(
        '/vocab',
        wrapAdmin(async (req, res) => {
            const words = await store.smembers(K.vocab)
            return res.json({ words: (Array.isArray(words) ? words : []).slice().sort() })
        })
    )

    adminApi.post(
        '/vocab',
        requireStorage,
        wrapAdmin(async (req, res) => {
            if (!isPlainObject(req.body)) throw bad('body must be a JSON object')
            assertKeys(req.body, ['add', 'remove', 'force'], 'body')
            if (req.body.force !== undefined && typeof req.body.force !== 'boolean') throw bad('force must be a boolean')
            const parse = (list, where) => {
                if (list === undefined) return []
                if (!Array.isArray(list) || list.length > 50) throw bad(`${where} must be an array of at most 50`)
                return Array.from(
                    new Set(
                        list.map((w, i) => {
                            if (typeof w !== 'string' || !ADMIN_WORD_RE.test(w.toLowerCase())) throw bad(`${where}[${i}] must be letters only (2..30)`)
                            return w.toLowerCase()
                        })
                    )
                )
            }
            const add = parse(req.body.add, 'add')
            const remove = parse(req.body.remove, 'remove')
            if (!add.length && !remove.length) throw bad('add or remove is required')
            const restricted = add.filter((w) => RESTRICTED_VOCAB_WORDS.has(w))
            if (restricted.length && req.body.force !== true) throw restrictedWordError(restricted)
            if (add.length && (await store.scard(K.vocab)) + add.length > LIMITS.maxAdminVocab) {
                throw new ApiError(409, 'vocab_full')
            }
            await Promise.all(add.map((w) => store.sadd(K.vocab, w)))
            await Promise.all(remove.map((w) => store.srem(K.vocab, w)))
            await touchChangedQuietly(store, clock().toISOString())
            invalidateServed()
            const words = await store.smembers(K.vocab)
            return res.json({ words: (Array.isArray(words) ? words : []).slice().sort(), added: add.length, removed: remove.length })
        })
    )

    adminApi.get(
        '/stats',
        wrapAdmin(async (req, res) => {
            const now = clock()
            const buckets = []
            for (let h = 0; h < 24; h++) buckets.push(hourBucket(new Date(now.getTime() - h * 3600000)))
            const [pending, approved, rejected, disabled, evicted, hours, evictedHours] = await Promise.all([
                store.zcard(K.pending),
                store.scard(K.approvedShapes),
                store.scard(K.rejectedShapes),
                store.scard(K.disabled),
                store.get(K.evicted),
                Promise.all(buckets.map((b) => store.get(K.subHour(b)))),
                Promise.all(buckets.map((b) => store.get(K.evictedHour(b)))),
            ])
            const submissions24h = hours.reduce((sum, v) => sum + (Number(v) || 0), 0)
            const evicted24h = evictedHours.reduce((sum, v) => sum + (Number(v) || 0), 0)
            return res.json({
                pending,
                approved,
                rejected,
                disabled,
                submissions24h,
                evicted: Number(evicted) || 0,
                evicted24h,
                storage: { kind: rawStore.kind || 'unknown', persistent: rawStore.persistent !== false, ready: storageReady },
            })
        })
    )

    adminApi.use((req, res) => sendError(res, 404, 'not_found'))

    router.use('/admin/api', requireAdmin({ store, env: environment }), adminApi)

    router.use((err, req, res, next) => {
        if (res.headersSent) return next(err)
        if (err && err.name === 'StoreError') {
            logError('store', err)
            return sendError(res, 503, 'storage_unavailable')
        }
        if (err && err.type === 'entity.too.large') return sendError(res, 413, 'payload_too_large')
        if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return sendError(res, 400, 'invalid_json')
        const status = err && (err.status || err.statusCode)
        if (status >= 400 && status < 500) return sendError(res, status, 'bad_request')
        logError('unhandled', err)
        return sendError(res, 500, 'internal')
    })

    return router
}

module.exports = { createManieRouter, router: createManieRouter(), K, LIMITS, RATE_LIMITS, COVERAGE_STATS }
