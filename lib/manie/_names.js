'use strict';

// Words that are ordinary vocabulary AND common given names, nicknames or business
// names. The anonymizer must never let one of them survive as literal text where a
// person's name can be (see absorbNameLike), and the admin vocabulary endpoint refuses
// to add them without an explicit force. The on-device port must carry the same lists;
// they are published to the port through test/manie/vectors/sanitize-vectors.json.
const NAME_STOPLIST = [
    'bank', 'blessing', 'cash', 'charity', 'christian', 'clement', 'dawn', 'destiny', 'diamond', 'faith',
    'felix', 'gift', 'glory', 'grace', 'hope', 'innocent', 'jade', 'jewel', 'joy', 'justice',
    'kanda', 'king', 'lily', 'love', 'lucky', 'may', 'mercy', 'neza', 'pack', 'patience',
    'peace', 'pearl', 'precious', 'prince', 'princess', 'queen', 'rich', 'rose', 'ruby', 'sunday',
    'sweet', 'trust', 'victor', 'victory', 'will', 'wisdom',
];

// A name-like word right after one of these (English and Kinyarwanda) is a person, as
// is one before a placeholder or beside a name delimiter (every kept punctuation mark
// except "." and "-", which already tie words together).
const NAME_CUE_WORDS = [
    'to', 'from', 'for', 'by', 'dear', 'via', 'kuri', 'avuye', 'sender', 'receiver', 'agent', 'customer', 'merchant', 'user',
    'payee', 'na', 'ya', 'ni', 'thank', 'thanks',
];
const NAME_EDGE_PUNCT = ',;:()&/"[]\'!?%@#*_=+';

// Vocabulary words that are also real template words and so cannot go on the stoplist:
// "Money successfully sent to" opens most Airtel notices, and "*S* Money" would be read
// as a name next to a delimiter; "kuri MoMo advance" and "Fake Merchant Ltd" are template
// text too. They stop being literal only by position (see collisionInNamePosition in
// anonymize.js). "agent" is deliberately not here either: "at agent NAME (phone)" and
// "via agent: NAME" are template text, and absorbing the word would reshape about one
// shape in thirty.
const NAME_COLLISION_WORDS = ['merchant', 'momo', 'money', 'test'];
const NAME_GREETING_WORDS = ['dear', 'muraho', 'hello', 'hi'];
const NAME_SOLE_CUE_WORDS = ['to', 'from', 'kuri', 'avuye', 'via', 'by'];
const NAME_SOLE_TERMINATORS = '.,;!?)';

// Spelled-out digits are not absorbed by the anonymizer ("one" is part of the
// one-time-password noise rule, and PIN/OTP notices are dropped before storage),
// but the admin vocabulary endpoint still refuses them.
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const NAME_STOPSET = new Set(NAME_STOPLIST);
const NAME_CUE_SET = new Set(NAME_CUE_WORDS);
const NAME_EDGE_SET = new Set(NAME_EDGE_PUNCT.split(''));
const NAME_COLLISION_SET = new Set(NAME_COLLISION_WORDS);
const NAME_GREETING_SET = new Set(NAME_GREETING_WORDS);
const NAME_SOLE_CUE_SET = new Set(NAME_SOLE_CUE_WORDS);
const NAME_SOLE_TERMINATOR_SET = new Set(NAME_SOLE_TERMINATORS.split(''));
const RESTRICTED_VOCAB_WORDS = new Set([...NAME_STOPLIST, ...DIGIT_WORDS]);

const isNameLike = word => typeof word === 'string' && NAME_STOPSET.has(word.toLowerCase());
const isCollisionWord = word => typeof word === 'string' && NAME_COLLISION_SET.has(word.toLowerCase());

module.exports = {
    NAME_STOPLIST,
    NAME_STOPSET,
    NAME_CUE_WORDS,
    NAME_CUE_SET,
    NAME_EDGE_PUNCT,
    NAME_EDGE_SET,
    NAME_COLLISION_WORDS,
    NAME_COLLISION_SET,
    NAME_GREETING_WORDS,
    NAME_GREETING_SET,
    NAME_SOLE_CUE_WORDS,
    NAME_SOLE_CUE_SET,
    NAME_SOLE_TERMINATORS,
    NAME_SOLE_TERMINATOR_SET,
    DIGIT_WORDS,
    RESTRICTED_VOCAB_WORDS,
    isNameLike,
    isCollisionWord,
};
