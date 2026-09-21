const { ensureChatAdmin } = require('../utils/chatPermissions');

module.exports = async function chatAdminMiddleware(req, res, next) {
    try {
        if (!req.chatMember) {
            return res.status(403).json({ message: 'You are not a member of this chat' });
        }

        if (!req.chatMember.is_admin) {
            await ensureChatAdmin(req.params.chat_id);
            await req.chatMember.reload();
        }

        if (!req.chatMember.is_admin) {
            return res.status(403).json({ message: 'Only chat admins can perform this action' });
        }

        return next();
    } catch (error) {
        console.error('Chat admin check error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};
