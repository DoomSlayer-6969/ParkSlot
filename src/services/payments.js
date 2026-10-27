import { randomBytes } from 'node:crypto';

// Test cards, mirroring the convention used by real gateways' sandboxes.
export const TEST_CARDS = {
  success: '4242424242424242',
  declined: '4000000000000002',
};

function passesLuhn(number) {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function validateCard(card) {
  const number = String(card?.number ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(number) || !passesLuhn(number)) return { error: 'Card number is invalid' };
  const expiry = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(card?.expiry ?? '').trim());
  if (!expiry || Number(expiry[1]) < 1 || Number(expiry[1]) > 12) return { error: 'Expiry must be MM/YY' };
  // Cards are valid through the end of their expiry month.
  if (new Date(2000 + Number(expiry[2]), Number(expiry[1]), 1) <= new Date()) return { error: 'Card has expired' };
  if (!/^\d{3,4}$/.test(String(card?.cvc ?? '').trim())) return { error: 'CVC is invalid' };
  return { number };
}

/**
 * In-process stand-in for an online payment gateway. A real adapter (Stripe,
 * Razorpay, ...) implements the same two async methods. Card details are never
 * stored; only the last 4 digits and the provider reference are kept.
 */
export function createMockGateway() {
  return {
    async charge({ card }) {
      const { number, error } = validateCard(card);
      if (error) return { ok: false, error };
      if (number === TEST_CARDS.declined) return { ok: false, error: 'Your card was declined' };
      return { ok: true, ref: `mock_ch_${randomBytes(8).toString('hex')}`, last4: number.slice(-4) };
    },

    async refund({ ref }) {
      return { ok: true, ref: `mock_rf_${ref}` };
    },
  };
}
