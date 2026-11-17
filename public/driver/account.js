// Driver accounts: the header's account area, log in / sign up, and password reset.
import { $, esc } from '../common.js';
import { closeModal, openModal } from './modal.js';
import { showMyBookings } from './my-bookings.js';
import { api, onSessionChange, session, setSession } from './session.js';

// ---------------------------------------------------------------- header

function renderAuthArea() {
  const area = $('#auth-area');
  if (session.user) {
    area.innerHTML = `
      <span class="who">Hi, ${esc(session.user.name)}</span>
      <button class="btn ghost" id="bookings-btn">My bookings</button>
      <button class="btn ghost" id="logout-btn">Log out</button>`;
    $('#bookings-btn').onclick = () => showMyBookings();
    $('#logout-btn').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
    };
  } else {
    area.innerHTML = '<button class="btn primary" id="login-btn">Log in</button>';
    $('#login-btn').onclick = () => showAuth();
  }
}

/** Log in or sign up. `onDone`, when given, continues the flow that needed a login, in the same dialog. */
export function showAuth(onDone, mode = 'login') {
  const isLogin = mode === 'login';
  openModal(`
    <h2>${isLogin ? 'Log in' : 'Create an account'}</h2>
    ${onDone ? '<p class="muted small">Log in to book this slot.</p>' : ''}
    <form id="auth-form" class="form">
      ${isLogin ? '' : '<label>Name <input name="name" required autocomplete="name"></label>'}
      <label>Email <input name="email" type="email" required autocomplete="email"></label>
      <label>Password <input name="password" type="password" required minlength="8"
        autocomplete="${isLogin ? 'current-password' : 'new-password'}"></label>
      ${isLogin ? '<a href="#" class="small inline-link" id="forgot-link">Forgot password?</a>' : ''}
      <p class="error" id="auth-error"></p>
      <div class="actions"><button class="btn primary">${isLogin ? 'Log in' : 'Sign up'}</button></div>
    </form>
    <p class="muted small">
      ${isLogin
        ? 'No account? <a href="#" id="auth-switch">Sign up</a><br>Demo account: demo@parking.test / demo1234'
        : 'Already have an account? <a href="#" id="auth-switch">Log in</a>'}
    </p>`);

  $('#auth-switch').onclick = (e) => {
    e.preventDefault();
    showAuth(onDone, isLogin ? 'register' : 'login');
  };
  if (isLogin) {
    $('#forgot-link').onclick = (e) => {
      e.preventDefault();
      showForgotPassword(onDone, $('#auth-form').email.value);
    };
  }
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const { token, user } = await api(`/api/auth/${isLogin ? 'login' : 'register'}`, { method: 'POST', body });
      setSession(token, user);
      if (onDone) onDone(); // continues in the same dialog
      else closeModal();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  };
}

// ---------------------------------------------------------------- password reset

/** Step 1: ask for a reset link by email. */
function showForgotPassword(onDone, email = '') {
  openModal(`
    <h2>Reset your password</h2>
    <p class="muted small">Enter your account's email and we'll send you a link to choose a new password.</p>
    <form id="forgot-form" class="form">
      <label>Email <input name="email" type="email" required autocomplete="email" value="${esc(email)}"></label>
      <p class="error" id="forgot-error"></p>
      <div class="actions">
        <button type="button" class="btn ghost" id="forgot-back">Back to log in</button>
        <button class="btn primary" id="forgot-send">Send reset link</button>
      </div>
    </form>`);

  $('#forgot-back').onclick = () => showAuth(onDone);
  $('#forgot-form').onsubmit = async (e) => {
    e.preventDefault();
    const sendBtn = $('#forgot-send');
    sendBtn.disabled = true;
    try {
      const { message } = await api('/api/auth/password-reset/request', {
        method: 'POST',
        body: { email: e.target.email.value },
      });
      openModal(`
        <h2>Check your email</h2>
        <p>${esc(message)}</p>
        <p class="muted small">The link works once and expires in ${session.config.resetTokenMinutes} minutes.
          If nothing arrives, check your spam folder or try again in a minute.</p>
        <p class="muted small">Prototype: emails are printed in the server console instead of being sent.</p>
        <div class="actions"><button class="btn primary" id="forgot-done">Back to log in</button></div>`);
      $('#forgot-done').onclick = () => showAuth(onDone);
    } catch (err) {
      $('#forgot-error').textContent = err.message;
      sendBtn.disabled = false;
    }
  };
}

/** Step 2: the emailed link opens the app at /#reset=<token>. */
function showResetPassword(token) {
  openModal(`
    <h2>Choose a new password</h2>
    <form id="reset-form" class="form">
      <label>New password <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Confirm new password <input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>
      <p class="error" id="reset-error"></p>
      <div class="actions"><button class="btn primary" id="reset-btn">Set new password</button></div>
    </form>
    <p class="muted small">This signs you out on every other device.</p>`);

  $('#reset-form').onsubmit = async (e) => {
    e.preventDefault();
    const { password, confirm } = Object.fromEntries(new FormData(e.target));
    const error = $('#reset-error');
    if (password !== confirm) {
      error.textContent = 'The two passwords do not match.';
      return;
    }
    $('#reset-btn').disabled = true;
    try {
      const session = await api('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      setSession(session.token, session.user);
      openModal(`
        <h2>Password updated</h2>
        <p>You're logged in as <b>${esc(session.user.email)}</b>.</p>
        <div class="actions"><button class="btn primary" id="reset-done">Done</button></div>`);
      $('#reset-done').onclick = closeModal;
    } catch (err) {
      error.innerHTML = `${esc(err.message)}${err.data?.reason === 'invalid_reset_token'
        ? ' <a href="#" id="reset-again">Request a new link</a>' : ''}`;
      $('#reset-again')?.addEventListener('click', (ev) => { ev.preventDefault(); showForgotPassword(null); });
      $('#reset-btn').disabled = false;
    }
  };
}

/** Takes a reset token from the URL and removes it, so it is not left in the address bar or history. */
function takeResetToken() {
  const token = new URLSearchParams(location.hash.slice(1)).get('reset');
  if (token) history.replaceState(null, '', location.pathname + location.search);
  return token;
}

/** Draws the header now and after every sign-in/out, and opens emailed reset links (/#reset=…). */
export function initAccount() {
  onSessionChange(renderAuthArea);
  renderAuthArea();

  const openResetFromUrl = () => {
    const resetToken = takeResetToken();
    if (resetToken) showResetPassword(resetToken);
  };
  openResetFromUrl();
  // A reset link pasted into a tab that already has the app open only changes the hash.
  window.addEventListener('hashchange', openResetFromUrl);
}
