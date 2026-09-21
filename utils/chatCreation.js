const { randomBytes } = require('crypto');

const MAX_CHAT_NAME_LENGTH = 80;

function validateChatName(input) {
    if (typeof input !== 'string') {
        return { error: 'نام چت الزامی است' };
    }

    const value = input.trim().replace(/\s+/gu, ' ');
    if (!value) {
        return { error: 'نام چت نمی‌تواند خالی باشد' };
    }
    if (Array.from(value).length > MAX_CHAT_NAME_LENGTH) {
        return { error: `نام چت باید حداکثر ${MAX_CHAT_NAME_LENGTH} کاراکتر باشد` };
    }

    return { value };
}

function createChatId() {
    return randomBytes(12).toString('hex');
}

module.exports = {
    MAX_CHAT_NAME_LENGTH,
    validateChatName,
    createChatId
};
