const { Chat, ChatMember } = require('../models');

module.exports = async function chatMemberMiddleware(req, res, next) {
    const chatId = req.params.chat_id;
    const username = req.user?.username;

    try {
        const chat = await Chat.findByPk(chatId, { attributes: ['id'] });
        if (!chat) {
            return res.status(404).json({ message: 'Chat not found' });
        }

        const member = await ChatMember.findOne({
            where: { chat_id: chatId, username },
            attributes: [
                'chat_id', 'username', 'is_admin',
                'can_send_messages', 'can_send_media'
            ]
        });

        if (!member) {
            return res.status(403).json({ message: 'You are not a member of this chat' });
        }

        req.chatMember = member;
        return next();
    } catch (error) {
        console.error('Chat membership check error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};
