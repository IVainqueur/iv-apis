'use strict';

const {literalWordsOfRegexSource} = require('./vocab');
const {FAILURE_GROUPS, CONDITIONAL_FAILURE_WORDS, CONTRACTIONS, groupSource} = require('./_negation');

// Skeleton-level counterpart of the app's tools/sms-pattern-tool noiseFilter:
// works on lowercased skeleton text where every digit is already a {n}/{ph}
// placeholder. Rules are deliberately high-precision: wrongly dropping a real
// new format silently stalls the pipeline, wrongly keeping noise only costs an
// admin a click. Every word used here must be in the vocabulary seed, or the
// skeleton would show {W} instead and the rule could never fire.

const SUCCESS_WORDS = /\b(?:completed|successful|succeeded)\b/;

// A contraction or a plain negation in a transaction notice means it did not happen
// ("couldn't be completed", "never completed"). The words must be in the vocabulary
// seed, or the anonymizer would fold them into a {W+} name slot where no rule sees them.
// The failure wording itself lives in _negation.js, which the name-slot guard and the gate read too.
const failureGroup = reason => FAILURE_GROUPS.find(g => g.reason === reason);
const NEGATED_SENTENCE = new RegExp(
    `\\b(?:${CONTRACTIONS.join('|')})(?![a-z'])|${groupSource(failureGroup('negated-sentence'))}|\\bnot\\s+(?:allowed|available|processed)\\b`,
);

const NOISE_RULES = [
    {
        reason: 'otp',
        test: /one[- ]time\s+password|\botp\b|verification\s+code|\bpasscode\b|\bpassword\b|\buse\s+code\b|confirm\s+(?:the\s+)?(?:payment|transaction)/,
    },
    {reason: 'account-security', test: /\bpin\b|security\s+question/},
    {
        reason: 'service-notice-en',
        test: /scheduled\s+maintenance|\bmaintenance\b|\bbe\s+(?:unavailable|down)|temporarily\s+(?:unavailable|suspended)/,
    },
    {
        reason: 'service-notice-rw',
        test: /kubera\s+imirimo|iteganyijwe|ziraba\s+zidakora|zidakora|zadakora|tubiseguyeho|turabamenyesha/,
    },
    {
        reason: 'promo',
        test: /kanda\s*\*\s*[{]|utifuza\s+ubu\s+butumwa|download\s+momoapp|cashback|ushobora\s+kwishyura\s+amaduka|wamenye\s+waguan|waruziko|bikuza\s+kuri\s+airtel/,
    },
    {reason: 'pending-ack', test: /being\s+processed|confirmation\s+message\s+shortly|biri\s+gukorwa/},
    {reason: 'account-notice', test: /changed\s+your\s+user\s+profile/},
    {reason: 'failed-transaction', test: new RegExp(groupSource(failureGroup('failed-transaction')))},
    {reason: 'reversed-or-refused', test: new RegExp(groupSource(failureGroup('reversed-or-refused')))},
    {reason: 'negated-sentence', test: NEGATED_SENTENCE},
    {reason: 'failed-marker', test: /\*\s*f\s*\*/},
    {reason: 'failed-transaction', test: new RegExp(`\\b(?:${CONDITIONAL_FAILURE_WORDS.join('|')})\\b`), unless: SUCCESS_WORDS},
];

const NOISE_WORDS = Array.from(
    new Set(
        NOISE_RULES.flatMap(rule => [
            ...literalWordsOfRegexSource(rule.test.source),
            ...(rule.unless ? literalWordsOfRegexSource(rule.unless.source) : []),
        ]),
    ),
).sort();

function isNoiseSkeleton(skeleton) {
    if (typeof skeleton !== 'string' || skeleton.trim().length === 0) {
        return {noise: true, reason: 'empty'};
    }
    const text = skeleton.toLowerCase();
    for (const rule of NOISE_RULES) {
        if (rule.test.test(text) && !(rule.unless && rule.unless.test(text))) {
            return {noise: true, reason: rule.reason};
        }
    }
    if (!/rwf/.test(text) || !/\{(?:n|ph)\}/.test(text)) {
        return {noise: true, reason: 'no-amount-mentioned'};
    }
    return {noise: false};
}

module.exports = {isNoiseSkeleton, NOISE_RULES, NOISE_WORDS};
