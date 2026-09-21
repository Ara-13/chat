const http = require('http');
const app = require('./app');
const setupWebSocket = require('./ws/socket');
const { sequelize } = require('./models');

const server = http.createServer(app);
const port = Number(process.env.PORT) || 5000;

setupWebSocket(server);

async function start() {
    try {
        await sequelize.authenticate();
        console.log('DB connected');

        await sequelize.sync({ alter: true });
        console.log('Models synced');

        server.listen(port, () => {
            console.log(`Server running on http://127.0.0.1:${port}`);
        });
    } catch (error) {
        console.error('Server startup error:', error);
        process.exitCode = 1;
    }
}

start();
