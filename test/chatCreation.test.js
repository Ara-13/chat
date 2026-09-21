const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_CHAT_NAME_LENGTH,
    validateChatName,
    createChatId
} = require('../utils/chatCreation');

test('chat name validation trims and normalizes whitespace', () => {
    assert.deepEqual(validateChatName('  گروه   دوستان\nقدیمی  '), {
        value: 'گروه دوستان قدیمی'
    });
});

test('chat name validation rejects missing, empty, and long names', () => {
    assert.ok(validateChatName().error);
    assert.ok(validateChatName('   ').error);
    assert.ok(validateChatName('ا'.repeat(MAX_CHAT_NAME_LENGTH + 1)).error);
    assert.equal(
        Array.from(validateChatName('ا'.repeat(MAX_CHAT_NAME_LENGTH)).value).length,
        MAX_CHAT_NAME_LENGTH
    );
});

test('chat ids fit the existing 24-character model field and are unique', () => {
    const first = createChatId();
    const second = createChatId();

    assert.match(first, /^[a-f0-9]{24}$/);
    assert.match(second, /^[a-f0-9]{24}$/);
    assert.notEqual(first, second);
});
