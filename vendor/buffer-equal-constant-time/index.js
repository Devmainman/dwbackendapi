'use strict';
// Constant-time Buffer comparison, API-compatible with buffer-equal-constant-time@1.0.1.
// The original module reads SlowBuffer.prototype at load time; SlowBuffer was removed
// in Node 25, which crashes jsonwebtoken (via jws -> jwa) on Node 25+.
const { Buffer } = require('buffer');
const { timingSafeEqual } = require('crypto');

function bufferEq(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const origBufEqual = Buffer.prototype.equal;
bufferEq.install = function install() {
  Buffer.prototype.equal = function equal(that) { return bufferEq(this, that); };
};
bufferEq.restore = function restore() {
  Buffer.prototype.equal = origBufEqual;
};

module.exports = bufferEq;
