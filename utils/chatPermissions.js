const { ChatMember, sequelize } = require('../models');

const MEMBER_ATTRIBUTES = [
    'chat_id',
    'username',
    'joined_at',
    'is_admin',
    'can_send_messages',
    'can_send_media'
];

/**
 * Older chats predate roles. Promote their first member once so every chat has
 * an administrator without requiring a manual database migration.
 */
async function ensureChatAdmin(chatId) {
    return sequelize.transaction(async transaction => {
        const admin = await ChatMember.findOne({
            where: { chat_id: chatId, is_admin: true },
            attributes: MEMBER_ATTRIBUTES,
            transaction
        });
        if (admin) return admin;

        const firstMember = await ChatMember.findOne({
            where: { chat_id: chatId },
            attributes: MEMBER_ATTRIBUTES,
            order: [['joined_at', 'ASC'], ['username', 'ASC']],
            transaction
        });
        if (!firstMember) return null;

        firstMember.is_admin = true;
        await firstMember.save({ transaction });
        return firstMember;
    });
}

function serializeMember(member) {
    const value = typeof member.get === 'function' ? member.get({ plain: true }) : member;
    return {
        username: value.username,
        is_admin: Boolean(value.is_admin),
        can_send_messages: value.can_send_messages !== false && value.can_send_messages !== 0,
        can_send_media: value.can_send_media !== false && value.can_send_media !== 0
    };
}

module.exports = { MEMBER_ATTRIBUTES, ensureChatAdmin, serializeMember };
