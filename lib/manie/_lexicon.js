'use strict';

// Ordinary transaction vocabulary and function words that real messages use but
// the built-in patterns do not spell out. Keeping them literal stops them from
// collapsing into {W} slots (where "approved" and "reversed" are indistinguishable)
// and from being mistaken for names. Merchant-name words (shop, store, service...)
// are deliberately absent: they would make shapes depend on who was paid.
const EXTRA_VOCAB_WORDS = [
    'account', 'airtime', 'amount', 'an', 'approved', 'are', 'balance', 'been', 'bundle', 'can', 'charge',
    'charges', 'confirmed', 'customer', 'date', 'dear', 'deposited', 'did', 'do', 'does', 'done', 'fee',
    'fees', 'for', 'had', 'have', 'is', 'it', 'its', 'made', 'may', 'mobile', 'money', 'new', 'number',
    'or', 'paid', 'pay', 'payment', 'please', 'received', 'reference', 'request', 'requested', 'sent',
    'successfully', 'thank', 'thanks', 'that', 'the', 'this', 'total', 'transaction', 'transfer',
    'transferred', 'wallet', 'were', 'withdrawal', 'withdrawn',
];

module.exports = {EXTRA_VOCAB_WORDS};
