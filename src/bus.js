'use strict';
/** In-process event bus. Events: positions, vehicles, gate, gate:update, alert, health. */
const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(1000); // one listener per open browser stream
module.exports = bus;
