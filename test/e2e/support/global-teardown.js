'use strict';
const { cleanup } = require('./server');

module.exports = async () => {
  if (global.__e2eServer) await global.__e2eServer.stop();
  cleanup();
};
