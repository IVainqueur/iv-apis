'use strict';

// The wording that turns a success notice into a failure notice, in one place. Three things read it:
// the noise filter drops skeletons that contain it, a free-text slot of a drafted pattern refuses
// to swallow it (so "to SHOPPY LTD couldn't be completed" is never read as a payment to a merchant
// called "SHOPPY LTD couldn't"), and the gate appends every entry after each name slot to prove
// the pattern stopped matching. A word added here reaches all three.
//
// `stems` match anywhere in the text, `words` only as whole words; a space stands for any run of
// whitespace. The groups keep the order and the reasons of the noise rules they feed.
const FAILURE_GROUPS = [
    {
        reason: 'failed-transaction',
        stems: [
            'not successful', 'unsuccessful', 'not completed', 'could not', 'unable to', 'insufficient', 'declined', 'rejected',
            'cancelled', 'canceled', 'timed out', 'ntibyakunze', 'ntabwo byakunze', 'byanze', 'ntibyagenze neza', 'ntibyashobotse',
            'adahagije',
        ],
        words: ['failure'],
    },
    {
        reason: 'reversed-or-refused',
        stems: ['ntibishobotse', 'byahagaritswe', 'ntahagije'],
        words: [
            'reversed', 'reversal', 'denied', 'refused', 'aborted', 'invalid', 'expired', 'rolled back', 'was not', 'did not',
            'has not', 'refunded', 'returned', 'blocked', 'voided', 'incomplete', 'withheld', 'stopped', 'awaiting', 'pending',
            'error', 'exceed', 'exceeds', 'exceeded', 'limit reached', 'siyo', 'halted', 'suspended', 'unavailable', 'on hold', 'bounced', 'disputed', 'frozen', 'terminated', 'interrupted',
        ],
    },
    {reason: 'negated-sentence', stems: [], words: ['cannot', 'never', 'no longer']},
];

// "failed" is a failure notice unless the text also says it completed, so the noise filter keeps it
// apart; the free-text guard has no such context and always refuses it.
const CONDITIONAL_FAILURE_WORDS = ['failed'];

const CONTRACTIONS = [
    "aren't", "can't", "couldn't", "didn't", "doesn't", "don't", "hadn't", "hasn't", "haven't", "isn't", "mustn't", "needn't",
    "shouldn't", "wasn't", "weren't", "won't", "wouldn't",
];

// Words the guard refuses although no noise rule is built on them: the bare negation, and the roots
// that the noise rules only know inside a longer phrase ("unable to", "ntabwo byakunze").
const GUARD_WORDS = ['not', 'fail', 'unable', 'ntabwo', 'ntibyagenze'];

const spaced = text => text.replace(/ /g, '\\s+');
const wholeWord = text => `\\b${spaced(text)}\\b`;

function groupSource(group) {
    return [...group.stems.map(spaced), ...group.words.map(wholeWord)].join('|');
}

const unique = list => Array.from(new Set(list));

const GUARD_SINGLE_WORDS = unique([
    ...FAILURE_GROUPS.flatMap(g => g.words).filter(w => !w.includes(' ')),
    ...CONDITIONAL_FAILURE_WORDS,
    ...GUARD_WORDS,
]);

// "was not" or "unable to" add nothing once the guard refuses "not" and "unable" on their own, and
// the pattern is copied into the app once per free-text slot, so every character counts.
const redundant = phrase => phrase.includes(' ') && phrase.split(' ').some(word => GUARD_SINGLE_WORDS.includes(word));
const GUARD_PHRASES = unique(FAILURE_GROUPS.flatMap(g => [...g.stems, ...g.words]).filter(p => p.includes(' ') && !redundant(p)));
const GUARD_STEMS = FAILURE_GROUPS.flatMap(g => g.stems).filter(stem => !redundant(stem));

// Inside the guard a gap is a bounded run: an unbounded quantifier in a lookahead that sits in a
// repeated group is exactly what the gate's nested-quantifier check refuses.
const guardSpaced = text => text.replace(/ /g, '\\s{1,4}');

// n and t sit in character classes on purpose: a bare letter in a served regex source would be
// added to the served vocabulary as a one-letter word.
const NEGATION_SOURCE = [
    `\\b(?:${unique([...GUARD_SINGLE_WORDS, ...GUARD_PHRASES.filter(p => !GUARD_STEMS.includes(p))]).map(guardSpaced).join('|')})\\b`,
    ...GUARD_STEMS.map(guardSpaced),
    "[n]['\\u2019][t]",
].join('|');

const NEGATION_PHRASES = unique([
    ...FAILURE_GROUPS.flatMap(g => [...g.stems, ...g.words]),
    ...CONDITIONAL_FAILURE_WORDS,
    ...GUARD_WORDS,
    ...CONTRACTIONS,
    'couldn’t',
    'wasn’t',
]);

// What a pattern's source looks like with the guard inside it.
const NEGATION_LOOKAHEAD = `(?!${NEGATION_SOURCE})`;

module.exports = {
    NEGATION_SOURCE,
    NEGATION_LOOKAHEAD,
    NEGATION_PHRASES,
    FAILURE_GROUPS,
    CONDITIONAL_FAILURE_WORDS,
    CONTRACTIONS,
    groupSource,
};
