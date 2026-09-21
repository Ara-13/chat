const { containsMention } = require('./mentions');

function buildChatSummaries({ memberships = [], chats = [], unreadMessages = [], latestActivity = [], username }) {
    const chatById = new Map(chats.map(chat => [String(chat.id), chat]));
    const activityByChat = new Map(latestActivity.map(item => [
        String(item.chat_id),
        item.last_message_at || null
    ]));
    const countsByChat = new Map();

    unreadMessages.forEach(message => {
        const chatId = String(message.chat_id);
        const counts = countsByChat.get(chatId) || { unreadCount: 0, mentionCount: 0 };
        counts.unreadCount += 1;
        if (containsMention(message.content, username)) counts.mentionCount += 1;
        countsByChat.set(chatId, counts);
    });

    return memberships
        .map(membership => {
            const chatId = String(membership.chat_id);
            const chat = chatById.get(chatId);
            if (!chat) return null;
            const counts = countsByChat.get(chatId) || { unreadCount: 0, mentionCount: 0 };
            return {
                id: chatId,
                name: chat.name,
                unreadCount: counts.unreadCount,
                mentionCount: counts.mentionCount,
                lastMessageAt: activityByChat.get(chatId),
                joinedAt: membership.joined_at || null
            };
        })
        .filter(Boolean)
        .sort((first, second) => {
            const firstDate = new Date(first.lastMessageAt || first.joinedAt || 0).getTime();
            const secondDate = new Date(second.lastMessageAt || second.joinedAt || 0).getTime();
            return secondDate - firstDate || first.name.localeCompare(second.name, 'fa');
        });
}

module.exports = { buildChatSummaries };
