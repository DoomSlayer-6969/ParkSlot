// The emails ParkSlot sends. Each function returns a message for a mailer's `send()`.
import { config } from '../config.js';

const appUrl = () => `${config.publicUrl}/`;

/** Sent when a driver creates an account. */
export function welcomeEmail(user) {
  return {
    to: user.email,
    subject: 'Welcome to ParkSlot',
    text: [
      `Hi ${user.name},`,
      '',
      `Your ParkSlot account is ready. You can log in at ${appUrl()} with this email address (${user.email}).`,
      '',
      'Booking a slot takes a minute:',
      '  1. Search for where you are going, or click the map.',
      '  2. Pick a free slot and how many hours you need.',
      '  3. Pay online. You get a booking ID such as PK-7F3K-9QX2.',
      '  4. Show the booking ID at the entrance any time within your booked window.',
      '',
      'Your upcoming bookings and booking history are under "My bookings".',
      '',
      "If you didn't create this account, someone else used your email address. You can take the account over",
      `by resetting its password: open ${appUrl()}, choose Log in, then "Forgot password?".`,
    ].join('\n'),
  };
}

/** Sent when a driver asks to reset their password. */
export function passwordResetEmail(user, token) {
  // The token goes in the URL fragment, which browsers never send to servers or in Referer headers.
  const link = `${config.publicUrl}/#reset=${token}`;
  return {
    to: user.email,
    subject: 'Reset your ParkSlot password',
    text: [
      `Hi ${user.name},`,
      '',
      'Someone (hopefully you) asked to reset the password for your ParkSlot account.',
      `Choose a new password with this link. It works once and expires in ${config.resetTokenMinutes} minutes:`,
      '',
      link,
      '',
      "If you didn't ask for this, you can ignore this email. Your password has not changed.",
    ].join('\n'),
  };
}
