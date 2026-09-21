module.exports = function mediaPermissionMiddleware(req, res, next) {
    if (!req.chatMember?.can_send_media) {
        return res.status(403).json({
            code: 'MEDIA_RESTRICTED',
            message: 'Your permission to send media has been disabled by an admin'
        });
    }
    return next();
};
