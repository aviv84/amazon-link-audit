'use strict';

// Bridge: browser-collected records -> the same listing shape parse.js
// produces, so there is ONE classifier rather than two that can drift apart.
//
// Two code paths that each decide what counts as "unavailable" will eventually
// disagree, and the disagreement will be invisible. A shared detector is the
// fix; this file is the adapter that makes sharing possible.

function tidy(s) {
  if (s === null || s === undefined) return null;
  const out = String(s).replace(/\s+/g, ' ').trim();
  return out || null;
}

function brandFromByline(byline) {
  const b = tidy(byline);
  if (!b) return null;
  const store = b.match(/^Visit the (.+?) Store$/i);
  if (store) return store[1].trim();
  const label = b.match(/^Brand:\s*(.+)$/i);
  if (label) return label[1].trim();
  return b;
}

function availabilityFrom(record) {
  const text = tidy(record.availability) || '';
  if (record.noRestock) {
    return { state: 'DISCONTINUED', detail: text || 'no restock expected' };
  }
  if (/currently unavailable/i.test(text)) {
    return { state: 'UNAVAILABLE', detail: text };
  }
  if (/in stock/i.test(text)) {
    return { state: 'IN_STOCK', detail: text };
  }
  if (text) return { state: 'UNKNOWN', detail: text };
  return { state: 'UNKNOWN', detail: null };
}

// A record is unusable when the browser errored, the HTTP status was not OK, or
// the body was too small to be a product page. That is a statement about the
// REQUEST, which is why it maps to `blocked` and not to any product field.
function isUnusable(record) {
  if (record.error) return true;
  if (record.status && record.status >= 400) return true;
  if ((record.bytes || 0) < 10000 && !record.title) return true;
  return false;
}

function toListing(record) {
  if (isUnusable(record)) {
    return {
      requestedAsin: record.requested || null,
      blocked: true,
      shipBlocked: false,
      resolvedAsin: null,
      title: null,
      brand: null,
      variant: null,
      availability: { state: 'UNREADABLE', detail: record.error || 'unreadable' },
      bytes: record.bytes || 0,
    };
  }

  return {
    requestedAsin: record.requested || null,
    blocked: false,
    shipBlocked: !!record.shipBlocked,
    resolvedAsin: record.resolved ? String(record.resolved).toUpperCase() : null,
    title: tidy(record.title),
    brand: brandFromByline(record.byline),
    variant: tidy(record.variant),
    availability: availabilityFrom(record),
    bytes: record.bytes || 0,
  };
}

// Accepts either the full snippet payload or a bare array of records.
function ingest(payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const records = Array.isArray(parsed) ? parsed : parsed.records || [];
  const byAsin = new Map();
  for (const r of records) {
    if (!r || !r.requested) continue;
    byAsin.set(String(r.requested).toUpperCase(), toListing(r));
  }
  return {
    deliverTo: Array.isArray(parsed) ? null : parsed.deliverTo || null,
    listings: byAsin,
  };
}

module.exports = {
  ingest: ingest,
  toListing: toListing,
  isUnusable: isUnusable,
  brandFromByline: brandFromByline,
  availabilityFrom: availabilityFrom,
};
