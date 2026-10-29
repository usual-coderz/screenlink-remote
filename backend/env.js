"use strict";

/**
 * env.js = config.js ka adapter.
 * Pehle ye apna alag config banata tha (alag cookie name + per-process random
 * secret), jisse server.js cookie env se sign karta tha aur ws.js/auth.js
 * config se verify karte the -> admin WS hamesha unauthorized, sessions
 * restart/cluster me toot jaate the.
 * Ab ek hi source of truth: ./config
 */

const config = require("./config");

module.exports = {
  BASE_DIR: config.BASE_DIR,
  VERSION: config.VERSION,

  COOKIE_NAME: config.COOKIE_NAME,
  COOKIE_NAMES: config.COOKIE_NAMES,
  COOKIE_DOMAIN: config.COOKIE_DOMAIN,
  FORCE_SECURE: config.FORCE_SECURE,
  SESSION_MAX_AGE: config.SESSION_MAX_AGE,
  SESSION_TTL: config.SESSION_TTL,
  TOKEN_TTL: config.TOKEN_TTL,

  SESSION_SECRET: config.SESSION_SECRET,
  SESSION_SECRET_OLD: config.SESSION_SECRET_OLD,
  SESSION_SECRET_SRC: config.SESSION_SECRET_SRC,

  ADMINS: config.ADMINS,
  ADMIN_USERNAME: config.ADMIN_USERNAME,
  ADMIN_FILE: config.ADMIN_FILE,
  ADMIN_API_KEY: config.ADMIN_API_KEY,

  TRUST_PROXY: config.TRUST_PROXY,

  ONLINE_WINDOW_SECONDS: config.ONLINE_WINDOW_SECONDS,
  IDLE_AFTER_HOURS: config.IDLE_AFTER_HOURS,
  STALE_AFTER_DAYS: config.STALE_AFTER_DAYS,
  MAX_WS_TEXT_BYTES: config.MAX_WS_TEXT_BYTES,
  MAX_SMS_BODY: config.MAX_SMS_BODY,
  MAX_BROADCAST: config.MAX_BROADCAST,
  WS_PING_INTERVAL: config.WS_PING_INTERVAL,
  WS_IDLE_TIMEOUT: config.WS_IDLE_TIMEOUT,
  OUTBOX_REPUSH_AFTER: config.OUTBOX_REPUSH_AFTER,
  NUMBER_RETRY_AFTER: config.NUMBER_RETRY_AFTER,
  SEND_STUCK_AFTER: config.SEND_STUCK_AFTER,
  EVENT_PRUNE_LIMIT: config.EVENT_PRUNE_LIMIT,
  TG_LOG_LIMIT: config.TG_LOG_LIMIT,
  ACTIVITY_LOG_LIMIT: config.ACTIVITY_LOG_LIMIT,
  LOGIN_MAX_TRIES: config.LOGIN_MAX_TRIES,
  LOGIN_LOCK_SECONDS: config.LOGIN_LOCK_SECONDS,
  KEY_ALPHABET: config.KEY_ALPHABET,

  TELE_API_ID: config.TELE_API_ID,
  TELE_API_HASH: config.TELE_API_HASH,
  TARGET_CHANNEL_ID: config.TARGET_CHANNEL_ID,
  DEFAULT_FWD_USER: config.DEFAULT_FWD_USER,
  RELAY_SESSION_FILE: config.RELAY_SESSION_FILE,

  LOG_LEVEL: config.LOG_LEVEL,
  MONGO_URL: config.MONGO_URL,
  DB_NAME: config.DB_NAME,
  UPI_KEYWORDS: config.UPI_KEYWORDS,
  AMOUNT_RE: config.AMOUNT_RE,
  DEFAULT_KEY_DAYS: config.DEFAULT_KEY_DAYS,

  RAW: config,
};