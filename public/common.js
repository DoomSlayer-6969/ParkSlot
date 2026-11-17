export const $ = (selector, root = document) => root.querySelector(selector);

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function money(amount, currency) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
}

// localStorage can be unavailable (private mode, blocked storage); the app works without it.
export const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* ignore */ }
  },
};

export async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  // JSON responses are parsed; anything else (such as a QR code SVG) comes back as text. Errors are always JSON.
  const isJson = res.headers.get('content-type')?.includes('application/json');
  let data = {};
  if (res.status !== 204) data = isJson || !res.ok ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * A portal's API client and session: keeps the session token in `storage` under `tokenKey` (each portal
 * has its own key), sends it as a Bearer token, and calls `onSignedOut()` when a signed-in request comes
 * back with one of `signOutStatuses` (the session expired or belongs to the other portal).
 */
export function createApiClient({ tokenKey, signOutStatuses = [401], onSignedOut }) {
  let token = storage.get(tokenKey);
  return {
    get token() { return token; },
    setToken(value) {
      token = value;
      storage.set(tokenKey, value);
    },
    async call(path, options = {}) {
      const sentWith = token;
      try {
        return await request(path, { ...options, headers: sentWith ? { Authorization: `Bearer ${sentWith}` } : {} });
      } catch (err) {
        if (sentWith && sentWith === token && signOutStatuses.includes(err.status)) onSignedOut?.();
        throw err;
      }
    },
  };
}

export const STATUS_TEXT = {
  free: 'Free',
  booked: 'Booked',
  occupied: 'Occupied',
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  lapsed: 'Not used',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const statusBadge = (status) => `<span class="badge status-${esc(status)}">${STATUS_TEXT[status] ?? esc(status)}</span>`;

export const PAYMENT_TEXT = {
  succeeded: 'Paid',
  failed: 'Declined (not charged)',
  refunded: 'Refunded',
};

/** Payment trail of a booking, as returned in a booking's `payments`. */
export function paymentList(payments, formatMoney) {
  if (!payments.length) return '<p class="muted small">No payments.</p>';
  return `
    <ul class="payment-list">
      ${payments.map((p) => `
        <li class="payment ${p.status}">
          <span>${PAYMENT_TEXT[p.status] ?? esc(p.status)}${p.card_last4 ? ` · card ending ${esc(p.card_last4)}` : ''}
            <br><span class="muted small">${fmtDateTime(p.created_at)}</span></span>
          <b>${p.status === 'refunded' ? '−' : ''}${formatMoney(p.amount)}</b>
        </li>`).join('')}
    </ul>`;
}
