const express = require('express');
const path = require('path');

require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'storage/uploads'), {
    dotfiles: 'deny',
    index: false,
    maxAge: '1d',
    setHeaders: (res, filePath) => {
        const extension = path.extname(filePath).toLowerCase();
        const audioContentTypes = {
            '.webm': 'audio/webm',
            '.ogg': 'audio/ogg',
            '.m4a': 'audio/mp4',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav'
        };

        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (audioContentTypes[extension]) {
            res.setHeader('Content-Type', audioContentTypes[extension]);
            res.setHeader('Content-Disposition', 'inline');
        } else {
            res.setHeader('Content-Security-Policy', 'sandbox');
            res.setHeader('Content-Disposition', 'attachment');
        }
    }
}));

// routes
app.use('/', require('./routes/main.routes'));
app.use('/auth', require('./routes/auth.routes'));
app.use('/rooms', require('./routes/chat.routes'));
app.use('/api/rooms', require('./routes/chat.api.routes'));

app.use((error, _req, res, _next) => {
    console.error('Unhandled request error:', error);
    res.status(500).json({ message: 'Server error' });
});

module.exports = app;
