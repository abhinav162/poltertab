"use strict";

// In-memory pairing state. The pair code NEVER leaves this module except
// via the pair_code push to one socket. It is never written to config.json,
// to uploads.log.jsonl, to the console, or returned in get_status / state_update.
//
// generateForSocket  — push a fresh code to an extension socket.
// handleCodeRequest  — throttled re-push (30 s / socket).
// submitCode         — validate a code from the CLI; returns { ok, extensionId, extWs }
//                       or { ok: false, reason, triesLeft? / secsLeft? }.
// onSocketClose      — void the code for a socket when it disconnects.

const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars; no I L O 0 1
const CODE_LENGTH = 4;
const CODE_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const REQUEST_THROTTLE_MS = 30 * 1000;   // 30 s per socket
const LOCKOUT_MAX_WRONG = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function _randomCode() {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return s;
}

class PairHost {
  // opts.codeTtlMs — injectable TTL for unit tests (defaults to 5 minutes).
  constructor({ codeTtlMs = CODE_TTL_MS } = {}) {
    this._codeTtlMs = codeTtlMs;
    // code → { ws, extensionId, expiresAt, timer }
    this._codes = new Map();
    // ws → code
    this._socketCodes = new Map();
    // ws → timestamp of last pair_code_request
    this._socketLastRequest = new Map();
    // global wrong-guess counter
    this._lockout = { wrongCount: 0, lockedUntil: 0 };
    // codes that recently expired — kept for one TTL window so submitCode can
    // tell the user "expired, try the new one" without counting it as wrong.
    this._recentlyExpired = new Set();
  }

  _isLockedOut() {
    return this._lockout.lockedUntil > Date.now();
  }

  _uniqueCode() {
    let code;
    let attempts = 0;
    do {
      code = _randomCode();
    } while (this._codes.has(code) && ++attempts < 200);
    return code;
  }

  // Push a pair_code to this extension socket.
  // Voids any previous code for the same socket first.
  generateForSocket(ws, extensionId) {
    // Void old code for this socket without removing throttle tracking.
    const old = this._socketCodes.get(ws);
    if (old) {
      const entry = this._codes.get(old);
      if (entry) clearTimeout(entry.timer);
      this._codes.delete(old);
      this._socketCodes.delete(ws);
      // Track as recently-expired so a late submitCode returns "expired" not "wrong".
      this._recentlyExpired.add(old);
      setTimeout(() => this._recentlyExpired.delete(old), this._codeTtlMs).unref();
    }

    const code = this._uniqueCode();
    const expiresAt = Date.now() + this._codeTtlMs;
    const timer = setTimeout(() => {
      if (this._codes.get(code)) {
        this._codes.delete(code);
        this._socketCodes.delete(ws);
        // Track as recently-expired so a late submitCode returns "expired" (not
        // "wrong") and does not burn a lockout try.
        this._recentlyExpired.add(code);
        setTimeout(() => this._recentlyExpired.delete(code), this._codeTtlMs).unref();
        // Spec: push a fresh code down the same socket so the popup never shows
        // a dead code. If the socket is already closed, nothing to do.
        if (ws.readyState === 1 /* OPEN */) {
          this.generateForSocket(ws, extensionId);
        }
      }
    }, this._codeTtlMs);

    this._codes.set(code, { ws, extensionId, expiresAt, timer });
    this._socketCodes.set(ws, code);

    try {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: "pair_code", code, expiresAt }));
      }
    } catch (_) {}
  }

  // Throttled re-request from an extension socket.
  handleCodeRequest(ws, extensionId) {
    const now = Date.now();
    const last = this._socketLastRequest.get(ws) || 0;
    if (now - last < REQUEST_THROTTLE_MS) {
      // Re-send the existing code if one exists; otherwise ignore.
      const existing = this._socketCodes.get(ws);
      if (existing && this._codes.has(existing)) {
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "pair_code", code: existing }));
          }
        } catch (_) {}
      }
      return;
    }
    this._socketLastRequest.set(ws, now);
    this.generateForSocket(ws, extensionId);
  }

  // Validate a submitted code. Called by bridge.js (from CLI) or by the temp
  // listener (directly from the local readline prompt).
  // Returns { ok: true, extensionId, extWs }
  //      or { ok: false, reason: "locked_out"|"wrong"|"expired", secsLeft?, triesLeft? }
  submitCode(rawCode) {
    const now = Date.now();
    if (this._isLockedOut()) {
      const secsLeft = Math.ceil((this._lockout.lockedUntil - now) / 1000);
      return { ok: false, reason: "locked_out", secsLeft };
    }

    const code = String(rawCode || "").toUpperCase().trim();
    const entry = this._codes.get(code);

    // Expired code: tell the user to wait for the new one; do NOT count as a
    // wrong guess — the expiry timer already regenerated a fresh code.
    // This handles both the sub-second race (entry still present but past
    // expiresAt) and the post-timer case (entry deleted, code in _recentlyExpired).
    if ((entry && entry.expiresAt < now) || this._recentlyExpired.has(code)) {
      return { ok: false, reason: "expired" };
    }

    if (!entry) {
      this._lockout.wrongCount += 1;
      if (this._lockout.wrongCount >= LOCKOUT_MAX_WRONG) {
        this._lockout = { wrongCount: 0, lockedUntil: now + LOCKOUT_DURATION_MS };
        return {
          ok: false,
          reason: "locked_out",
          secsLeft: Math.ceil(LOCKOUT_DURATION_MS / 1000),
        };
      }
      return {
        ok: false,
        reason: "wrong",
        triesLeft: LOCKOUT_MAX_WRONG - this._lockout.wrongCount,
      };
    }

    // Consume — single-use.
    clearTimeout(entry.timer);
    this._codes.delete(code);
    this._socketCodes.delete(entry.ws);
    this._lockout.wrongCount = 0;

    return { ok: true, extensionId: entry.extensionId, extWs: entry.ws };
  }

  // Called on every socket close in the Primary's connection handler.
  onSocketClose(ws) {
    const code = this._socketCodes.get(ws);
    if (code) {
      const entry = this._codes.get(code);
      if (entry) clearTimeout(entry.timer);
      this._codes.delete(code);
      this._socketCodes.delete(ws);
    }
    this._socketLastRequest.delete(ws);
  }
}

module.exports = { PairHost };
