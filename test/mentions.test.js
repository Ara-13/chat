const test = require('node:test');
const assert = require('node:assert/strict');
const { containsMention } = require('../utils/mentions');

test('containsMention matches a complete username', () => {
    assert.equal(containsMention('سلام @ali، خوبی؟', 'ali'), true);
    assert.equal(containsMention('سلام @ALI', 'ali'), true);
    assert.equal(containsMention('@سارا لطفا ببین', 'سارا'), true);
});

test('containsMention does not match username prefixes or email addresses', () => {
    assert.equal(containsMention('سلام @alireza', 'ali'), false);
    assert.equal(containsMention('mail@example.com', 'example'), false);
});

test('containsMention safely handles regex characters in usernames', () => {
    assert.equal(containsMention('سلام @a.b!', 'a.b'), true);
});
