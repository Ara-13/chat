const bcrypt = require('bcrypt');
const { User } = require('../models');
const jwt = require('jsonwebtoken');

exports.register = async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password)
            return res.status(400).json({ message: 'Invalid data' });

        const existing = await User.findByPk(username);
        if (existing)
            return res.status(409).json({ message: 'Username already exists' });

        const hashed = await bcrypt.hash(password, 10);

        await User.create({
            username,
            password: hashed
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};
exports.login = async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await User.findByPk(username);
        if (!user)
            return res.status(401).json({ message: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (!match)
            return res.status(401).json({ message: 'Invalid credentials' });

        const token = jwt.sign(
            { username: user.username },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            username: user.username
        });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
};