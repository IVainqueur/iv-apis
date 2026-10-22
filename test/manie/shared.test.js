const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const shared = require('../../lib/manie/_shared')
const fields = require('../../lib/manie/_fields')
const formats = require('../../lib/manie/formats')
const gate = require('../../lib/manie/gate')
const vocab = require('../../lib/manie/vocab')
const ratelimit = require('../../lib/manie/ratelimit')
const auth = require('../../lib/manie/auth')

const LIB = path.join(__dirname, '..', '..', 'lib', 'manie')
const read = (name) => fs.readFileSync(path.join(LIB, name), 'utf8')

describe('one implementation per shared rule (REL-12)', () => {
    it('shares type, role and id definitions instead of copying them', () => {
        assert.strictEqual(fields.VALID_TYPES, shared.VALID_TYPES)
        assert.strictEqual(fields.CAPTURE_ROLES, shared.CAPTURE_ROLES)
        assert.strictEqual(formats.VALID_TYPES, shared.VALID_TYPES)
        assert.strictEqual(formats.ID_RE, shared.PATTERN_ID_RE)
        assert.strictEqual(vocab.WORD_RE.source, '^[a-z][a-z\']{0,29}$')
        for (const file of ['formats.js', 'gate.js', '_fields.js', 'store.js']) {
            const source = read(file)
            assert.ok(/require\('\.\/_shared'\)/.test(source), `${file} imports _shared`);
            assert.ok(!/function isPlainObject|function sha256Hex\(|function countGroups/.test(source), `${file} does not redefine shared helpers`)
        }
        assert.ok(!/const (?:VALID_TYPES|CAPTURE_ROLES|CAPTURE_KEYS) = \[/.test(read('formats.js')))
        assert.ok(!/const (?:VALID_TYPES|CAPTURE_ROLES|HINT_ROLES) = \[/.test(read('_fields.js')))
    })

    it('counts regex groups the same way everywhere: in-thread for trusted sources, sandboxed for admin-typed ones', () => {
        for (const count of [shared.countGroups, shared.countGroupsSandboxed]) {
            assert.equal(count('(a)(b(c))', 'i'), 3)
            assert.equal(count('a', ''), 0)
            assert.equal(count('(?:a)(?<n>b)', ''), 1)
            assert.throws(() => count('(', ''))
        }
        assert.equal(typeof gate.createSandbox, 'function')
        assert.ok(/countGroupsSandboxed/.test(read('gate.js')), 'the gate keeps the sandboxed variant')
        assert.ok(!/countGroupsSandboxed/.test(read('formats.js')), 'the served config must not depend on a wall-clock timeout')
    })

    it('the strict object test used everywhere rejects exotic prototypes', () => {
        assert.equal(shared.isPlainObject({}), true)
        assert.equal(shared.isPlainObject(Object.create(null)), true)
        assert.equal(shared.isPlainObject([]), false)
        assert.equal(shared.isPlainObject(new Map()), false)
        assert.equal(shared.isPlainObject(null), false)
        assert.equal(shared.isPlainObject(new (class Foo {})()), false)
    })

    it('has a single IP hash implementation, in auth.js, and the old salt code is gone from ratelimit.js', () => {
        for (const dead of ['hashIdentifier', 'rateKey', 'resetProcessSaltForTests', 'resolveSalt']) {
            assert.equal(ratelimit[dead], undefined, dead)
        }
        assert.equal(typeof auth.ipHash, 'function')
        const source = read('ratelimit.js')
        assert.ok(!/createHmac|processSalt|MANIE_HASH_SALT/.test(source))
        assert.ok(!/manie-ip-salt-v1|MANIE_IP_SALT/.test(read('auth.js')), 'no public constant and no second salt variable')
    })

    it('has no dead fallback config path or always-true switch in the config builder and router', () => {
        assert.ok(!/VERSION_COVERS_VOCABULARY/.test(read('formats.js')))
        assert.ok(!/fallbackServed/.test(fs.readFileSync(path.join(LIB, '..', '..', 'routes', 'manie.js'), 'utf8')))
    })
})
