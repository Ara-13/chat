function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsMention(content, username) {
    if (typeof content !== 'string' || !username) return false;

    const escapedUsername = escapeRegExp(username);
    const mentionPattern = new RegExp(
        `(^|[^\\p{L}\\p{N}_])@${escapedUsername}(?=$|[^\\p{L}\\p{N}_])`,
        'iu'
    );
    return mentionPattern.test(content);
}

module.exports = { containsMention, escapeRegExp };
