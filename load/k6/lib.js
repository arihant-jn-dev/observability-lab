// Shared helpers for the k6 scenarios.
//
// Each scenario in this directory follows the same shape:
//   1. reset the app to healthy
//   2. run a baseline so you can SEE normal on the graph
//   3. switch on one pathology
//   4. keep the same load running so the change is attributable
//   5. heal, and let the graphs recover
//
// The baseline is not padding. A graph without a "before" is very hard to read:
// you cannot tell an elevated p99 from a normally-high one.

import http from 'k6/http';
import { check } from 'k6';

export const API = __ENV.API || 'http://localhost:8080';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Merge-patch the pathology state. */
export function setPathology(patch) {
  const res = http.post(`${API}/admin/pathologies`, JSON.stringify(patch), {
    headers: JSON_HEADERS,
    tags: { admin: 'true' },       // tagged so admin calls don't pollute your k6 latency stats
  });
  return res.status === 200;
}

export function heal() {
  http.post(`${API}/admin/pathologies/reset`, null, { tags: { admin: 'true' } });
  http.post(`${API}/admin/memory/release`, null, { tags: { admin: 'true' } });
}

export function flushCache() {
  return http.post(`${API}/admin/cache/flush`, null, { tags: { admin: 'true' } });
}

/* ------------------------------------------------------------------ *
 * Request helpers -- each tagged by name so k6 reports per-endpoint
 * ------------------------------------------------------------------ */

export function getProducts(limit = 20) {
  const res = http.get(`${API}/products?limit=${limit}`, { tags: { name: 'GET /products' } });
  check(res, { 'products ok': (r) => r.status === 200 });
  return res;
}

export function getProduct(id) {
  const res = http.get(`${API}/products/${id}`, { tags: { name: 'GET /products/:id' } });
  check(res, { 'product ok': (r) => r.status === 200 || r.status === 404 });
  return res;
}

export function listOrders(limit = 25) {
  const res = http.get(`${API}/orders?limit=${limit}`, { tags: { name: 'GET /orders' } });
  check(res, { 'orders ok': (r) => r.status === 200 });
  return res;
}

export function createOrder() {
  const body = JSON.stringify({
    customerId: 1 + Math.floor(Math.random() * 200),
    items: [{ productId: 1 + Math.floor(Math.random() * 500), quantity: 1 + Math.floor(Math.random() * 3) }],
  });
  const res = http.post(`${API}/orders`, body, { headers: JSON_HEADERS, tags: { name: 'POST /orders' } });
  check(res, { 'order created': (r) => r.status === 201 });
  return res;
}

export function checkout(amountCents) {
  const body = JSON.stringify({
    customerId: 1 + Math.floor(Math.random() * 200),
    amountCents: amountCents ?? 1000 + Math.floor(Math.random() * 20000),
  });
  const res = http.post(`${API}/checkout`, body, { headers: JSON_HEADERS, tags: { name: 'POST /checkout' } });
  check(res, { 'checkout done': (r) => r.status === 201 || r.status === 402 });
  return res;
}

/** A realistic mix: mostly reads, some writes. */
export function browseAndBuy() {
  getProducts(20);
  if (Math.random() < 0.5) getProduct(1 + Math.floor(Math.random() * 500));
  if (Math.random() < 0.3) listOrders(25);
  if (Math.random() < 0.2) checkout();
}
