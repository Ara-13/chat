const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const messageController = require('../controllers/message.controller');
const mediaPermissionMiddleware = require('../middlewares/mediaPermission.middleware');

const router = express.Router({ mergeParams: true });
const uploadDirectory = path.join(__dirname, '../storage/uploads');
const MAX_FILE_SIZE = 20 * 1024 * 1024;

fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
        callback(null, `${crypto.randomUUID()}${safeExtension}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1,
        fields: 5
    }
});

router.post('/files', mediaPermissionMiddleware, (req, res, next) => {
    upload.single('file')(req, res, error => {
        if (!error) return next();

        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'File size must not exceed 20 MB' });
        }

        if (error instanceof multer.MulterError) {
            return res.status(400).json({ message: error.message });
        }

        console.error('Upload middleware error:', error);
        return res.status(500).json({ message: 'Upload failed' });
    });
}, messageController.uploadFile);

module.exports = router;
