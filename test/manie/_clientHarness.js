'use strict';

// Runs the REAL Manie client sources (remoteRegexConfig.ts, classify.ts,
// balanceProcessing.ts) in Node against a served config. Only the platform
// edges are faked: AsyncStorage, fetch, clock, the iOS RegexConfigBridge and the
// unmatched-message reprocessor (counted). Nothing here ships to production.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');

const APP_REPO = process.env.MANIE_APP_REPO || '/Users/ivainqueur/Documents/Code/React/mobile/Manie';

const FILES = {
    rrc: 'src/lib/utils/remoteRegexConfig.ts',
    classify: 'src/lib/utils/classify.ts',
    balance: 'src/lib/utils/balanceProcessing.ts',
};

let ts = null;
try {
    ts = require(path.join(APP_REPO, 'node_modules/typescript'));
} catch (error) {
    ts = null;
}

function unavailableReason() {
    if (!ts) return `typescript not found under ${APP_REPO}/node_modules (set MANIE_APP_REPO)`;
    for (const rel of Object.values(FILES)) {
        if (!fs.existsSync(path.join(APP_REPO, rel))) return `missing client source ${rel} under ${APP_REPO}`;
    }
    return null;
}

const available = () => unavailableReason() === null;

class PatchDriftError extends Error {}

// Executable form of the CLIENT CHANGE LIST. Each entry is an exact-once text
// replacement on the real source; if the app source drifted (or already has the
// fix) the anchor is missing and PatchDriftError is thrown so callers can skip.
const PATCHES = [
    {
        id: 'P1-parse-validate',
        file: 'rrc',
        find: '      const hasTransactionId =\n',
        replace: `      if (nextPattern.status !== undefined && nextPattern.status !== 'active') {
        return null;
      }

      if (nextPattern.tags !== undefined) {
        nextPattern.tags = Array.isArray(nextPattern.tags)
          ? nextPattern.tags.filter((tag: any) => typeof tag === 'string')
          : [];
      }

      const rawCaptureMap =
        nextPattern.captureMap &&
        typeof nextPattern.captureMap === 'object' &&
        !Array.isArray(nextPattern.captureMap)
          ? (nextPattern.captureMap as {[key: string]: unknown})
          : {};
      const cleanCaptureMap: {[key: string]: number} = {};
      const knownKeys = new Set<string>(Object.values(captureMapKeys));
      for (const key of Object.keys(rawCaptureMap)) {
        const index = Number(rawCaptureMap[key]);
        if (knownKeys.has(key) && Number.isInteger(index) && index > 0) {
          cleanCaptureMap[key] = index;
        }
      }
      nextPattern.captureMap = cleanCaptureMap as any;

      let groupCount = 0;
      try {
        const probe = new RegExp(\`\${nextPattern.pattern}|\`, nextPattern.flags ?? '').exec('');
        groupCount = probe ? probe.length - 1 : 0;
      } catch (error) {
        console.warn('[RegexConfig] Rejecting uncompilable pattern', nextPattern.id);
        return null;
      }
      const usedGroups: number[] = Object.values(cleanCaptureMap);
      if (typeof nextPattern.timestamp?.group === 'number') {
        usedGroups.push(nextPattern.timestamp.group);
      }
      if (usedGroups.some(index => index > groupCount)) {
        console.warn('[RegexConfig] Rejecting pattern with out-of-range group', nextPattern.id);
        return null;
      }
      if (!cleanCaptureMap.amount || !cleanCaptureMap.balance) {
        console.warn('[RegexConfig] Rejecting pattern without amount/balance capture', nextPattern.id);
        return null;
      }

      const hasTransactionId =
`,
    },
    {
        id: 'P2-keep-extras',
        file: 'rrc',
        find: "    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : undefined,\n    patterns: sanitizedPatterns,\n  };",
        replace: `    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : undefined,
    contentHash:
      typeof raw.contentHash === 'string' && raw.contentHash.length > 0
        ? raw.contentHash
        : undefined,
    vocabulary: Array.isArray(raw.vocabulary)
      ? raw.vocabulary
          .filter(
            (word: any) =>
              typeof word === 'string' &&
              word.length <= 40 &&
              /^[a-z]+(?:'[a-z]+)*$/.test(word),
          )
          .slice(0, 5000)
      : undefined,
    patterns: sanitizedPatterns,
  };`,
    },
    {
        id: 'P2-types',
        file: 'rrc',
        find: '  fetchedAt?: string;\n  patterns: RemoteRegexPattern[];\n};',
        replace: '  fetchedAt?: string;\n  contentHash?: string;\n  vocabulary?: string[];\n  patterns: RemoteRegexPattern[];\n};',
    },
    {
        id: 'P3-content-hash',
        file: 'rrc',
        find: 'const applyConfig = async (config: RemoteRegexConfig): Promise<boolean> => {\n  const overrides = compileOverrides(config);\n  if (overrides.length === 0) {\n    return false;\n  }\n\n  setPatternOverrides(overrides);\n  inMemoryConfig = config;\n\n  if (Platform.OS === \'ios\' && RegexConfigBridge?.applyConfig) {\n    try {\n      RegexConfigBridge.applyConfig(JSON.stringify(config));\n    } catch (error) {\n      if (__DEV__) {\n        console.warn(\n          \'[RegexConfig] Failed to forward config to native side\',\n          error,\n        );\n      }\n    }\n  }\n\n  reprocessUnmatchedMessages().catch(error => {\n    if (__DEV__) {\n      console.warn(\n        \'[RegexConfig] Failed to reprocess unmatched messages\',\n        error,\n      );\n    }\n  });\n\n  return true;\n};',
        replace: `const APPLIED_STATE_KEY = 'remote_regex_applied_state_v1';

type AppliedState = {bridged?: string; reprocessed?: string};

const hashString = (input: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

const getContentHash = (config: RemoteRegexConfig): string =>
  config.contentHash ??
  hashString(
    JSON.stringify(
      config.patterns.map(p => [
        p.id,
        p.pattern,
        p.flags ?? '',
        p.type ?? '',
        p.captureMap ?? null,
        p.timestamp ?? null,
        p.tags ?? null,
      ]),
    ),
  );

const loadAppliedState = async (): Promise<AppliedState> => {
  try {
    const stored = await AsyncStorage.getItem(APPLIED_STATE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
};

const saveAppliedState = async (patch: AppliedState) => {
  try {
    const current = await loadAppliedState();
    await AsyncStorage.setItem(
      APPLIED_STATE_KEY,
      JSON.stringify({...current, ...patch}),
    );
  } catch (error) {
    if (__DEV__) {
      console.warn('[RegexConfig] Failed to persist applied state', error);
    }
  }
};

const applyConfig = async (config: RemoteRegexConfig): Promise<boolean> => {
  const hash = getContentHash(config);
  if (inMemoryConfig && getContentHash(inMemoryConfig) === hash) {
    return true;
  }

  const overrides = compileOverrides(config);
  if (overrides.length === 0) {
    return false;
  }

  setPatternOverrides(overrides);
  inMemoryConfig = config;

  const state = await loadAppliedState();

  if (
    Platform.OS === 'ios' &&
    RegexConfigBridge?.applyConfig &&
    state.bridged !== hash
  ) {
    try {
      const {vocabulary, ...forNative} = config;
      RegexConfigBridge.applyConfig(JSON.stringify(forNative));
      await saveAppliedState({bridged: hash});
    } catch (error) {
      if (__DEV__) {
        console.warn(
          '[RegexConfig] Failed to forward config to native side',
          error,
        );
      }
    }
  }

  if (state.reprocessed !== hash) {
    reprocessUnmatchedMessages()
      .then(() => saveAppliedState({reprocessed: hash}))
      .catch(error => {
        if (__DEV__) {
          console.warn(
            '[RegexConfig] Failed to reprocess unmatched messages',
            error,
          );
        }
      });
  }

  return true;
};`,
    },
    {
        id: 'P3-sync-compare',
        file: 'rrc',
        find: '      const unchanged =\n        inMemoryConfig &&\n        inMemoryConfig.version === remoteConfig.version &&\n        remoteConfig.fetchedAt === inMemoryConfig.fetchedAt;\n',
        replace: '      const unchanged =\n        inMemoryConfig &&\n        getContentHash(inMemoryConfig) === getContentHash(remoteConfig);\n',
    },
    {
        id: 'P3-sync-await-cached',
        file: 'rrc',
        find: '    if (cached?.config) {\n      applyConfig(cached.config);\n    }\n\n    const needRefresh',
        replace: '    if (cached?.config) {\n      await applyConfig(cached.config);\n    }\n\n    const needRefresh',
    },
    {
        id: 'P3-clear-marker',
        file: 'rrc',
        find: '    await AsyncStorage.removeItem(REGEX_CONFIG_CACHE_KEY);\n',
        replace: '    await AsyncStorage.removeItem(REGEX_CONFIG_CACHE_KEY);\n    await AsyncStorage.removeItem(APPLIED_STATE_KEY);\n',
    },
    {
        id: 'P6-ignore-degraded',
        file: 'rrc',
        find: '    if (!response.ok) {\n      return null;\n    }\n\n    const json = await response.json();',
        replace: "    if (!response.ok || response.headers?.get?.('X-Manie-Degraded')) {\n      return null;\n    }\n\n    const json = await response.json();",
    },
    {
        id: 'P4-airtel-shortcode',
        file: 'classify',
        find: 'const REMOTE_PATTERN_COPYABLE_KEYS = [',
        replace: `const AIRTEL_SHORTCODE_PATTERN = /^(?:[A-Za-z]{2})?(\\d{2})(\\d{2})(\\d{2})\\.(\\d{2})(\\d{2})/;

const parseAirtelShortcode = (value: string): number => {
  const parts = AIRTEL_SHORTCODE_PATTERN.exec(value);
  if (!parts) {
    return NaN;
  }
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return NaN;
  }
  return new Date(2000 + year, month - 1, day, hour, minute, 0).getTime();
};

const REMOTE_PATTERN_COPYABLE_KEYS = [`,
    },
    {
        id: 'P4-timestamp-use',
        file: 'classify',
        find: `        if (
          remotePattern.timestamp.parser ===
          RemoteRegexTimestampParser.AIRTEL_SHORTCODE
        ) {
          result.timestamp = parseAirtelTimestamp(rawTimestamp);
        } else {
          result.timestamp = new Date(rawTimestamp).getTime();
        }`,
        replace: `        const parsedTimestamp =
          remotePattern.timestamp.parser ===
          RemoteRegexTimestampParser.AIRTEL_SHORTCODE
            ? parseAirtelShortcode(rawTimestamp)
            : new Date(rawTimestamp).getTime();
        if (Number.isFinite(parsedTimestamp)) {
          result.timestamp = parsedTimestamp;
        }`,
    },
    {
        id: 'P5-handler0-signature',
        file: 'classify',
        find: "    {body}: Pick<SMSMessage, 'body'>,\n    remotePattern?: RemoteRegexPattern,\n  ): Omit<Transaction, 'date' | 'date_sent'> => {",
        replace: "    {body, date}: Pick<SMSMessage, 'body'> & {date?: number},\n    remotePattern?: RemoteRegexPattern,\n  ): Omit<Transaction, 'date' | 'date_sent'> | null => {",
    },
    {
        id: 'P5-sms-date-fallback',
        file: 'classify',
        find: "      timestamp: Date.now(),\n      direction:\n        remotePattern?.type === 'receive'",
        replace: "      timestamp:\n        Number.isFinite(Number(date)) && Number(date) > 0\n          ? Number(date)\n          : Date.now(),\n      direction:\n        remotePattern?.type === 'receive'",
    },
    {
        id: 'P5-amount-balance-guard',
        file: 'classify',
        find: '    // Handle timestamp parsing\n    if (remotePattern?.timestamp) {',
        replace: `    if (
      !Number.isFinite(result.amount) ||
      result.amount <= 0 ||
      !Number.isFinite(result.balance) ||
      !captureMap?.balance ||
      !match[captureMap.balance]
    ) {
      return null;
    }

    // Handle timestamp parsing
    if (remotePattern?.timestamp) {`,
    },
    {
        id: 'P5-skip-null',
        file: 'classify',
        find: '            transactions.push(\n              handlers[pattern.handler](match, message, pattern.remotePattern),\n            );\n          } else {\n            transactions.push(handlers[pattern.handler](match, message));\n',
        replace: '            const remoteTransaction = handlers[0](\n              match,\n              message,\n              pattern.remotePattern,\n            );\n            if (!remoteTransaction) {\n              continue;\n            }\n            transactions.push(remoteTransaction);\n          } else {\n            transactions.push(handlers[pattern.handler](match, message)!);\n',
    },
];

const OPTIONAL_PATCHES = [
    {
        id: 'P7-refresh-1h',
        file: 'rrc',
        find: 'const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours',
        replace: 'const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour',
    },
];

PATCHES.push(...OPTIONAL_PATCHES);

const OPTIONAL_IDS = OPTIONAL_PATCHES.map(patch => patch.id);
const ALL_FIX_IDS = PATCHES.map(patch => patch.id).filter(id => !OPTIONAL_IDS.includes(id));

function applyPatches(fileKey, source, ids) {
    let out = source;
    for (const patch of PATCHES) {
        if (patch.file !== fileKey || !ids.includes(patch.id)) continue;
        const first = out.indexOf(patch.find);
        if (first === -1 || out.indexOf(patch.find, first + 1) !== -1) {
            throw new PatchDriftError(`anchor for ${patch.id} not found exactly once in ${FILES[fileKey]}`);
        }
        out = out.slice(0, first) + patch.replace + out.slice(first + patch.find.length);
    }
    return out;
}

function makeEnv(opts = {}) {
    return {
        storage: opts.storage || new Map(),
        clock: opts.clock || {now: 1_800_000_000_000},
        calls: {reprocess: 0, bridgeApply: 0, bridgeClear: 0, fetch: 0, storageSet: 0},
        bridgePayloads: [],
        platform: opts.platform || 'android',
        fetchImpl: opts.fetchImpl || (async () => {
            throw new Error('no fetch impl');
        }),
        storageLatencyMs: opts.storageLatencyMs ?? 0,
        warns: [],
        dev: opts.dev ?? false,
    };
}

function fakeDate(env) {
    const RealDate = Date;
    function FakeDate(...args) {
        return args.length ? new RealDate(...args) : new RealDate(env.clock.now);
    }
    FakeDate.now = () => env.clock.now;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    return FakeDate;
}

const transpiled = new Map();

const EXPORT_TAILS = {
    rrc: '\nexports.__parseConfig = parseConfig; exports.__compileOverrides = compileOverrides;\n',
    classify: '\nexports.__parseAirtelTimestamp = parseAirtelTimestamp; exports.__handlers = handlers; exports.__fastParseInt = fastParseInt;\n',
};

const DROP_BUILTINS = ['return [...PATTERNS, ...remotePatterns];', 'return [...remotePatterns];'];

// fix: 'none' (real client as it is today), 'all' (reference patch set), 'all+optional' or an id list.
// root: another checkout of src/lib/utils/{classify,remoteRegexConfig}.ts (see extractReleasedClient),
// loaded with the same fake platform edges; dropBuiltins leaves only remote patterns active so that
// a drafted pattern is the only thing that can classify a message.
function loadClient(env, {fix = 'none', root = APP_REPO, dropBuiltins = false} = {}) {
    const reason = unavailableReason();
    if (reason) throw new Error(reason);
    const ids = fix === 'none' ? [] : fix === 'all' ? ALL_FIX_IDS : fix === 'all+optional' ? [...ALL_FIX_IDS, ...OPTIONAL_IDS] : fix;
    const cache = new Map();
    const fileKeyOf = abs => Object.keys(FILES).find(key => path.join(root, FILES[key]) === abs);

    const load = abs => {
        if (cache.has(abs)) return cache.get(abs).exports;
        const fileKey = fileKeyOf(abs);
        const cacheKey = `${abs}|${fileKey ? ids.join(',') : ''}|${fileKey === 'classify' && dropBuiltins ? 'drop' : ''}`;
        let out = transpiled.get(cacheKey);
        if (out === undefined) {
            let source = fs.readFileSync(abs, 'utf8');
            if (fileKey) source = applyPatches(fileKey, source, ids);
            if (fileKey === 'classify' && dropBuiltins) {
                if (!source.includes(DROP_BUILTINS[0])) throw new PatchDriftError('classify.ts changed: the drop-builtins anchor is gone');
                source = source.replace(DROP_BUILTINS[0], DROP_BUILTINS[1]);
            }
            out = ts.transpileModule(source, {
                compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true},
                fileName: abs,
            }).outputText;
            if (fileKey && EXPORT_TAILS[fileKey]) out += EXPORT_TAILS[fileKey];
            transpiled.set(cacheKey, out);
        }
        const mod = {exports: {}};
        cache.set(abs, mod);
        const dir = path.dirname(abs);
        const localRequire = spec => {
            if (spec.endsWith('reprocessUnmatched')) {
                return {
                    reprocessUnmatchedMessages: async () => {
                        env.calls.reprocess++;
                        return {processed: 0, saved: 0};
                    },
                };
            }
            if (spec.endsWith('smsFetching')) return {fetchLastMessagesForBalance: async () => []};
            if (spec === 'react-native') {
                return {
                    NativeModules: {
                        RegexConfigBridge: {
                            applyConfig: payload => {
                                env.calls.bridgeApply++;
                                env.bridgePayloads.push(payload);
                            },
                            clearConfig: () => {
                                env.calls.bridgeClear++;
                            },
                        },
                    },
                    Platform: {OS: env.platform},
                };
            }
            if (spec === '@react-native-async-storage/async-storage') {
                const latency = () => new Promise(resolve => setTimeout(resolve, env.storageLatencyMs));
                return {
                    __esModule: true,
                    default: {
                        getItem: async key => {
                            await latency();
                            return env.storage.has(key) ? env.storage.get(key) : null;
                        },
                        setItem: async (key, value) => {
                            await latency();
                            env.calls.storageSet++;
                            env.storage.set(key, value);
                        },
                        removeItem: async key => {
                            await latency();
                            env.storage.delete(key);
                        },
                    },
                };
            }
            if (spec.startsWith('.')) {
                let resolved = path.resolve(dir, spec);
                if (fs.existsSync(`${resolved}.ts`)) resolved += '.ts';
                else if (fs.existsSync(`${resolved}.tsx`)) resolved += '.tsx';
                return load(resolved);
            }
            return require(spec);
        };
        const sandboxConsole = {
            log() {},
            warn: (...args) => env.warns.push(args.map(String).join(' ')),
            error: (...args) => env.warns.push(`ERR ${args.map(String).join(' ')}`),
        };
        const run = vm.compileFunction(out, ['module', 'exports', 'require', '__filename', '__dirname', '__DEV__', 'console', 'Date', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout'], {filename: abs});
        run(
            mod,
            mod.exports,
            localRequire,
            abs,
            dir,
            env.dev,
            sandboxConsole,
            fakeDate(env),
            (...args) => {
                env.calls.fetch++;
                return env.fetchImpl(...args);
            },
            AbortController,
            setTimeout,
            clearTimeout,
        );
        return mod.exports;
    };

    return {
        env,
        rrc: load(path.join(root, FILES.rrc)),
        classify: load(path.join(root, FILES.classify)),
        balance: root === APP_REPO ? load(path.join(APP_REPO, FILES.balance)) : null,
    };
}

// The client as it was released: classify.ts and remoteRegexConfig.ts at a git ref of the app
// checkout, written to a temp directory with the same relative layout so that loadClient can take
// it as `root`. Read-only on the app repo. Returns null when the ref (or git) is not available.
const releasedRoots = new Map();

function extractReleasedClient(ref = 'feat/sms-pattern-tool') {
    if (releasedRoots.has(ref)) return releasedRoots.get(ref);
    let root = null;
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manie-old-client-'));
        for (const key of ['classify', 'rrc']) {
            const text = execFileSync('git', ['-C', APP_REPO, 'show', `${ref}:${FILES[key]}`], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']});
            const target = path.join(dir, FILES[key]);
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(target, text);
        }
        root = dir;
    } catch (error) {
        root = null;
    }
    releasedRoots.set(ref, root);
    return root;
}

process.on('exit', () => {
    for (const root of releasedRoots.values()) {
        if (root) {
            try {
                fs.rmSync(root, {recursive: true, force: true});
            } catch (error) {
                // a temp directory left behind is harmless
            }
        }
    }
});

// True when the reference patch set still applies cleanly to the app sources.
function patchSetStatus() {
    const reason = unavailableReason();
    if (reason) return {ok: false, reason};
    try {
        loadClient(makeEnv(), {fix: 'all'});
        return {ok: true};
    } catch (error) {
        if (error instanceof PatchDriftError) return {ok: false, reason: `client source drifted or already patched: ${error.message}`};
        throw error;
    }
}

const jsonResponse = (body, {ok = true, status = 200, headers = {}} = {}) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        ok,
        status,
        headers: {get: name => (lower[String(name).toLowerCase()] ?? null)},
        json: async () => JSON.parse(JSON.stringify(body)),
    };
};

// Faithful port of RegexPatternProvider.swift parseAirtelShort (device-local time).
function swiftParseAirtelShort(value) {
    if (value.length < 11) return null;
    const slice = (from, length) => value.slice(from, from + length);
    const toInt = text => (/^[+-]?\d+$/.test(text) ? parseInt(text, 10) : null);
    const parts = [toInt(slice(0, 2)), toInt(slice(2, 2)), toInt(slice(4, 2)), toInt(slice(7, 2)), toInt(slice(9, 2))];
    if (parts.some(part => part === null)) return null;
    const [yy, mm, dd, hh, mi] = parts;
    return new Date(2000 + yy, mm - 1, dd, hh, mi, 0).getTime();
}

// What I2 (optional Swift change) would do: drop an optional 2-letter prefix before parsing.
const swiftParseAirtelShortTolerant = value => swiftParseAirtelShort(/^[A-Za-z]{2}/.test(value) ? value.slice(2) : value);

const localParts = ts_ => {
    const date = new Date(ts_);
    return {y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate(), h: date.getHours(), mi: date.getMinutes()};
};

function servedConfig({patterns, version = 'regex-v20261021-0a1b2c3d', fetchedAt = '2026-10-21T08:00:00Z', contentHash, vocabulary}) {
    const config = {version, defaultLocale: 'en-RW', fetchedAt, patterns};
    if (contentHash !== undefined) config.contentHash = contentHash;
    if (vocabulary !== undefined) config.vocabulary = vocabulary;
    return config;
}

// Synthetic fixtures. Values are fake; formats are invented and chosen so that no
// built-in pattern matches them (asserted in the tests), making the remote
// pattern the only path that can classify them.
const SYNTH = {
    mtnBody: 'Muraho! Wakoresheje RWF 2000 kuri TESTSHOP ku wa 2026-04-11 14:30:05. Amafaranga asigaye RWF 8000. Fee RWF 100. TxId 55512345.',
    mtnPattern: {
        id: 'auto-mtn-wakoresheje',
        carrier: 'mtn',
        locale: 'rw-RW',
        type: 'payment',
        pattern: '.*?Wakoresheje\\sRWF\\s([\\d,.]+)\\skuri\\s(.*?)\\sku\\swa\\s(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2})\\.\\sAmafaranga\\sasigaye\\sRWF\\s([\\d,.]+)\\.\\sFee\\sRWF\\s([\\d,.]+)\\.\\sTxId\\s(\\d+)\\.',
        flags: 'i',
        captureMap: {amount: 1, secondParty: 2, balance: 4, fee: 5, transactionId: 6},
        timestamp: {group: 3, parser: 'iso8601'},
        tags: ['payment', 'mtn'],
        status: 'active',
    },
    airtelBody: '*165* TID PP260411.1430.A12345*S* Cash out of RWF 2000 at agent ACME SHOP successful. Fee RWF 50. BAL is RWF 7000. *EN#',
    airtelPattern: {
        id: 'airtel-auto-cashout-en',
        carrier: 'airtel',
        locale: 'en-RW',
        type: 'withdraw',
        pattern: '.*?\\*165\\*\\sTID\\s([A-Za-z]{2}(\\d+\\.\\d+)\\.[A-Za-z]\\d+)\\*S\\*\\sCash\\sout\\sof\\sRWF\\s([\\d,.]+)\\sat\\sagent\\s(.*?)\\ssuccessful\\.\\sFee\\sRWF\\s([\\d,.]+)\\.\\sBAL\\sis\\sRWF\\s([\\d,.]+)\\.\\s\\*EN#',
        flags: 'i',
        captureMap: {transactionId: 1, amount: 3, agentName: 4, fee: 5, balance: 6},
        timestamp: {group: 2, parser: 'airtel-shortcode'},
        tags: ['withdraw', 'airtel'],
        status: 'active',
    },
};

module.exports = {
    APP_REPO,
    PATCHES,
    ALL_FIX_IDS,
    PatchDriftError,
    available,
    unavailableReason,
    patchSetStatus,
    makeEnv,
    loadClient,
    extractReleasedClient,
    jsonResponse,
    servedConfig,
    swiftParseAirtelShort,
    swiftParseAirtelShortTolerant,
    localParts,
    SYNTH,
};
