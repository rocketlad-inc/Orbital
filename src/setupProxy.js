// CRA dev-server proxy: routes /api/* (and /api/*/ws WebSocket upgrades) to
// wrangler dev. Run `npm start` and `npm run worker:dev` in two terminals.
//
// In production this file is irrelevant — Workers serves both the asset
// bundle (build/) and the /api/* routes on the same origin.

const { createProxyMiddleware } = require('http-proxy-middleware');

const WORKER_TARGET = process.env.WORKER_DEV_URL || 'http://127.0.0.1:8787';

module.exports = function (app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: WORKER_TARGET,
      changeOrigin: true,
      ws: true, // upgrade WS for /api/rooms/:id/ws
      logLevel: 'warn',
    }),
  );
};
