const logger = require('../config/logger');

const PDOK_URL = process.env.PDOK_LOCATIESERVER_URL || 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';
const TIMEOUT_MS = 2500;

/**
 * Resolves a Dutch address to coordinates using PDOK's Locatieserver (the
 * Dutch government's free geocoder, no API key). Used when the booking form
 * did not supply coordinates, so the service-area check cannot be skipped
 * just by leaving latitude/longitude out of the request.
 *
 * Returns { latitude, longitude } or null. Never throws: a geocoder outage
 * must not block bookings, so callers treat null as "could not verify".
 */
async function geocodeNl({ postalCode, addressLine1, city } = {}) {
  const q = [addressLine1, postalCode, city].filter(Boolean).join(' ').trim();
  if (!q || !postalCode) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${PDOK_URL}?q=${encodeURIComponent(q)}&rows=1&fq=type:adres&fl=centroide_ll`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const wkt = json && json.response && json.response.docs && json.response.docs[0] && json.response.docs[0].centroide_ll;
    const m = typeof wkt === 'string' ? wkt.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/) : null;
    if (!m) return null;
    return { longitude: Number(m[1]), latitude: Number(m[2]) };
  } catch (e) {
    logger.warn('geocode failed', { error: e.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { geocodeNl };
