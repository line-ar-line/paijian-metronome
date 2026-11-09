'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

const ENV_ID = 'fast-junglefowl-d3fqxnq941dd1c4e';
const ALLOWED_ORIGIN = 'https://fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com';
const MAX_BODY_BYTES = 2048;
const PATHS = new Set(['/', '/community-register']);

class RegistrationError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.publicCode = code;
  }
}
const responseError = (status, code) => new RegistrationError(status, code);

function validateRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'username') || !Object.hasOwn(input, 'password')) throw responseError(400, 'registration_unavailable');
  if (typeof input.username !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{1,30}[A-Za-z0-9]$/.test(input.username)) throw responseError(400, 'invalid_username');
  const password = input.password;
  if (typeof password !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9()!@#$%^&*|?><_-]{7,31}$/.test(password) || [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length < 3) throw responseError(400, 'weak_password');
  return { username: input.username, password };
}

function registrationBucket(request) {
  // CloudBase's HTTP gateway appends its observed peer to X-Forwarded-For.
  // Only the rightmost address is eligible; never use a caller's first entry,
  // X-Real-IP, request body, cookies, or a claimed user identity.
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = typeof forwarded === 'string' ? forwarded.split(',').at(-1).trim() : '';
  let address = isIP(candidate) ? candidate : request.socket.remoteAddress || 'unknown';
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  return createHash('sha256').update(`${ENV_ID}:${address}`).digest('hex');
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const timer = setTimeout(() => finish(responseError(408, 'registration_unavailable')), 5000);
    function finish(error, value) {
      clearTimeout(timer);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      request.removeListener('error', failed);
      if (error) { request.resume(); reject(error); }
      else resolve(value);
    }
    function data(chunk) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { finish(responseError(413, 'registration_unavailable')); return; }
      chunks.push(chunk);
    }
    function end() {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        finish(null, JSON.parse(text));
      } catch (_) { finish(responseError(400, 'registration_unavailable')); }
    }
    function aborted() { finish(responseError(400, 'registration_unavailable')); }
    function failed() { finish(responseError(400, 'registration_unavailable')); }
    request.on('data', data);
    request.on('end', end);
    request.on('aborted', aborted);
    request.on('error', failed);
  });
}

function createRegistrationServer({ createUser, consumeSlot, reserveName, gatewayCors = false }) {
  if (typeof createUser !== 'function' || typeof consumeSlot !== 'function' || typeof reserveName !== 'function') throw new TypeError('Registration services are required.');
  const server = http.createServer(async (request, response) => {
    // Client disconnects may emit an error after the body reader has settled.
    // Keep a listener for the request lifetime without logging request data.
    request.on('error', () => {});
    const origin = request.headers.origin;
    const allowedOrigin = origin === ALLOWED_ORIGIN;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    if (allowedOrigin && !gatewayCors) response.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    function send(status, body) {
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(body));
    }
    try {
      const path = new URL(request.url, 'http://registration.internal').pathname;
      if (!PATHS.has(path)) throw responseError(404, 'registration_unavailable');
      if (request.method === 'GET') { send(200, { ok: true }); return; }
      if (!['POST', 'OPTIONS'].includes(request.method)) {
        response.setHeader('Allow', 'GET, POST, OPTIONS');
        throw responseError(405, 'registration_unavailable');
      }
      if (!allowedOrigin) throw responseError(403, 'registration_unavailable');
      if (request.method === 'OPTIONS') {
        const requestedHeaders = (request.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (request.headers['access-control-request-method'] !== 'POST' || requestedHeaders.some(value => value !== 'content-type')) throw responseError(403, 'registration_unavailable');
        if (!gatewayCors) {
          response.setHeader('Access-Control-Allow-Methods', 'POST');
          response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          response.setHeader('Access-Control-Max-Age', '600');
        }
        response.statusCode = 204;
        response.end();
        return;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '') || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) throw responseError(415, 'registration_unavailable');
      const declaredBytes = Number(request.headers['content-length']);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) throw responseError(413, 'registration_unavailable');
      const { username, password } = validateRegistration(await readJson(request));
      // consumeSlot enforces shared global and IP limits in PostgreSQL. Any
      // unavailable or unexpected result fails closed before account creation.
      if (await consumeSlot(registrationBucket(request)) !== true) throw responseError(429, 'rate_limited');
      // CloudBase createUser can return success for an existing username. The
      // database checks real users and atomically reserves this name first.
      // Keep the reservation after failures: a timeout can still create a user.
      if (await reserveName(username) !== true) throw responseError(409, 'username_taken');
      const result = await createUser({ name: username, password, type: 'externalUser', userStatus: 'ACTIVE' });
      if (typeof result?.Data?.Uid !== 'string' || !result.Data.Uid) throw responseError(503, 'registration_unavailable');
      send(201, { ok: true });
    } catch (error) {
      // Never return or log upstream errors, submitted credentials, or user IDs.
      const status = error instanceof RegistrationError ? error.status : 503;
      const code = error instanceof RegistrationError ? error.publicCode : 'registration_unavailable';
      send(status, { error: { code } });
    } finally {
      request.resume();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 30;
  return server;
}

module.exports = { createRegistrationServer, ENV_ID, ALLOWED_ORIGIN };
