const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const authMiddleware = require('../middlewares/auth.middleware');
const path = require('path');

router.get('/login', (req, res) => {
    res.sendFile(
        path.join(__dirname, '../public/auth/login.html')
    );
});

router.get('/register', (req, res) => {
    res.sendFile(
        path.join(__dirname, '../public/auth/register.html')
    );
});

router.post('/register', authController.register);
router.post('/login', authController.login);

router.get('/me', authMiddleware, (req, res) => {
    res.json({
        username: req.user.username
    });
});

module.exports = router;