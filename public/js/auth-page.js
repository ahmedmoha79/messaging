import { sb, migrateLegacySession, getSession, initialUrl } from './lib/supabase.js';
import { hydrateIcons, icon } from './lib/icons.js';

migrateLegacySession();
hydrateIcons();

const APP_URL = `${location.origin}/app`;
// Password-reset emails come back here. No '#' in this address: Supabase adds
// its own '#access_token=…' and two fragments would make the link unreadable.
const RESET_URL = `${location.origin}/?mode=reset-password`;

// Was this page opened from a password-reset email? Supabase can come back in
// three shapes depending on project settings: #access_token…&type=recovery,
// ?token_hash=…&type=recovery, or ?code=… (with our mode flag).
const startHash = new URLSearchParams(initialUrl.hash.slice(1));
const startQuery = initialUrl.searchParams;
let recovering = startHash.get('type') === 'recovery' || startQuery.get('type') === 'recovery' ||
  startQuery.get('mode') === 'reset-password';
sb.auth.onAuthStateChange(event => {
  if (event === 'PASSWORD_RECOVERY') {
    recovering = true;
    setMode('newpassword');
  }
});

async function completeRecoveryLink() {
  try {
    const tokenHash = startQuery.get('token_hash');
    const code = startQuery.get('code');
    if (tokenHash) {
      const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
      if (error) throw error;
    } else if (code) {
      const { error } = await sb.auth.exchangeCodeForSession(code);
      if (error) throw error;
    }
  } catch (err) {
    console.warn('Recovery link failed', err);
  }
  return getSession();
}

// Already signed in? Go straight to the app; no form, no waiting.
// getSession() reads local storage, so this costs no network round trip.
const existing = recovering ? await completeRecoveryLink() : await getSession();
if (existing && !recovering && !new URLSearchParams(location.search).has('signedout')) {
  location.replace('/app');
}

const $ = id => document.getElementById(id);
const form = $('authForm');
const emailInput = $('email');
const passwordInput = $('password');
const nameInput = $('name');
const submitBtn = $('submitBtn');
const submitLabel = $('submitLabel');
const formError = $('formError');

const COPY = {
  signin: { title: 'Welcome back', sub: 'Sign in to pick up your conversations.', submit: 'Sign in' },
  signup: { title: 'Create your account', sub: 'It takes a minute. Your team will see your name and photo.', submit: 'Create account' },
  magic: { title: 'Sign in with a link', sub: "We'll email you a link that signs you in, no password needed.", submit: 'Email me a link' },
  reset: { title: 'Reset your password', sub: "Enter your email and we'll send you a link to choose a new password.", submit: 'Send reset link' },
  newpassword: { title: 'Set a new password', sub: 'Choose a new password for your account. You’ll stay signed in on this device.', submit: 'Save new password' }
};

let mode = 'signin';
function setMode(next) {
  mode = next;
  document.body.dataset.mode = next;
  if (COPY[next]) {
    $('authTitle').textContent = COPY[next].title;
    $('authSub').textContent = COPY[next].sub;
    submitLabel.textContent = COPY[next].submit;
  }
  document.querySelectorAll('.auth-tabs [role="tab"]').forEach(tab => {
    const selected = tab.dataset.mode === next || (next !== 'signup' && tab.dataset.mode === 'signin');
    tab.setAttribute('aria-selected', String(selected));
  });
  passwordInput.autocomplete = next === 'signup' || next === 'newpassword' ? 'new-password' : 'current-password';
  passwordInput.required = next === 'signin' || next === 'signup' || next === 'newpassword';
  emailInput.required = next !== 'newpassword' && next !== 'done';
  $('passwordLabel').textContent = next === 'newpassword' ? 'New password' : 'Password';
  $('authDone').hidden = next !== 'done';
  showError('');
  const params = new URLSearchParams(location.search);
  ['mode', 'type', 'token_hash', 'code'].forEach(k => params.delete(k));
  if (next === 'signup') params.set('mode', 'signup');
  if (next === 'newpassword') params.set('mode', 'reset-password');
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
  (next === 'signup' ? nameInput : next === 'newpassword' ? passwordInput : emailInput).focus({ preventScroll: true });
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

function busy(on) {
  submitBtn.disabled = on;
  submitBtn.querySelector('.spinner')?.remove();
  if (on) submitBtn.insertAdjacentHTML('afterbegin', '<span class="spinner" aria-hidden="true"></span>');
}

function done(title, text) {
  $('doneTitle').textContent = title;
  $('doneText').textContent = text;
  setMode('done');
}

// Supabase error messages are written for developers; translate the common ones.
function friendly(error) {
  const msg = String(error?.message || error || '');
  if (/invalid login credentials/i.test(msg)) return 'That email and password don’t match. Check them, or use “Email me a sign-in link”.';
  if (/email not confirmed/i.test(msg)) return 'Confirm your email first. We sent you a link when you signed up.';
  if (/already registered|already been registered|user already exists/i.test(msg)) return 'An account with this email already exists. Sign in instead.';
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  if (/password should be|weak password|pwned|leaked/i.test(msg)) return 'Choose a stronger password: at least 8 characters, and not one used on other sites.';
  if (/provider is not enabled|unsupported provider/i.test(msg)) return 'Google sign-in isn’t switched on for this app yet. Use email instead.';
  if (/failed to fetch|network/i.test(msg)) return 'Can’t reach the server. Check your connection and try again.';
  return msg || 'Something went wrong. Try again.';
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function strength(pw) {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  if (/^(.)\1+$/.test(pw) || /password|123456|qwerty|wazambi/i.test(pw)) score = Math.min(score, 1);
  return Math.min(score, 5);
}

passwordInput.addEventListener('input', () => {
  if (mode !== 'signup' && mode !== 'newpassword') return;
  const s = strength(passwordInput.value);
  const bar = $('strengthBar');
  bar.style.width = `${(s / 5) * 100}%`;
  bar.style.background = s <= 1 ? 'var(--danger)' : s <= 3 ? 'var(--copper)' : 'var(--leaf)';
  $('strengthHint').textContent = !passwordInput.value
    ? 'At least 8 characters. A longer phrase is stronger.'
    : s <= 1 ? 'Too easy to guess.' : s <= 3 ? 'Okay. Longer is better.' : 'Strong password.';
});

$('togglePassword').addEventListener('click', e => {
  const show = passwordInput.type === 'password';
  passwordInput.type = show ? 'text' : 'password';
  e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye', 'sm');
});

document.querySelectorAll('.auth-tabs [role="tab"]').forEach(tab =>
  tab.addEventListener('click', () => setMode(tab.dataset.mode)));
$('magicLinkBtn').addEventListener('click', () => setMode('magic'));
$('usePasswordBtn').addEventListener('click', () => setMode('signin'));
$('forgotBtn').addEventListener('click', () => setMode('reset'));
$('doneBack').addEventListener('click', () => setMode('signin'));

$('googleBtn').addEventListener('click', async () => {
  showError('');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: APP_URL, queryParams: { prompt: 'select_account' } }
  });
  if (error) showError(friendly(error));
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  showError('');
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const name = nameInput.value.trim().replace(/\s+/g, ' ');

  if (mode === 'newpassword') return saveNewPassword(password, $('confirmPassword').value);
  if (!validEmail(email)) return showError('Enter a valid email address.');
  if (mode === 'signup' && name.length < 2) return showError('Enter your name so your team knows who you are.');
  if ((mode === 'signin' || mode === 'signup') && password.length < 8) return showError('Passwords are at least 8 characters.');
  if (mode === 'signup' && strength(password) <= 1) return showError('That password is too easy to guess. Try a longer phrase.');

  busy(true);
  try {
    if (mode === 'signin') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      location.replace('/app');
      return;
    }
    if (mode === 'signup') {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { full_name: name }, emailRedirectTo: APP_URL }
      });
      if (error) throw error;
      // Supabase returns a user with no identities when the email is taken.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error('already registered');
      }
      if (data.session) {
        location.replace('/app');
        return;
      }
      done('Confirm your email', `We sent a link to ${email}. Open it on this device to finish creating your account.`);
      return;
    }
    if (mode === 'magic') {
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: APP_URL, shouldCreateUser: false } });
      if (error) {
        if (/signups not allowed|not found|otp_disabled/i.test(error.message)) {
          throw new Error('No account uses that email yet. Create one first.');
        }
        throw error;
      }
      done('Check your email', `We sent a sign-in link to ${email}. It works once and expires soon.`);
      return;
    }
    if (mode === 'reset') {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: RESET_URL });
      if (error) throw error;
      done('Check your email', `If ${email} has an account, a reset link is on its way.`);
    }
  } catch (err) {
    showError(friendly(err));
  } finally {
    busy(false);
  }
});

async function saveNewPassword(password, confirm) {
  if (password.length < 8) return showError('Use at least 8 characters.');
  if (strength(password) <= 1) return showError('That password is too easy to guess. Try a longer phrase.');
  if (password !== confirm) return showError('The two passwords don’t match.');
  const session = await getSession();
  if (!session) {
    return showError('This reset link has expired or was already used. Request a new one below.');
  }
  busy(true);
  try {
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw error;
    sb.from('users').update({ last_password_change: new Date().toISOString() }).eq('id', session.user.id).then(() => {});
    done('Password updated', 'Your new password is saved. Opening your chats…');
    setTimeout(() => location.replace('/app'), 1200);
  } catch (err) {
    showError(/same|different from the old/i.test(String(err?.message))
      ? 'Choose a password different from your old one.'
      : friendly(err));
  } finally {
    busy(false);
  }
}

if (recovering) {
  if (existing) {
    setMode('newpassword');
  } else {
    setMode('reset');
    showError('This reset link has expired or was already used. Enter your email to get a new one.');
  }
} else {
  setMode(new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin');
}

// Auth errors come back in the URL after a failed magic link / OAuth / expired link.
const hash = new URLSearchParams(location.hash.slice(1));
const query = new URLSearchParams(location.search);
const urlError = hash.get('error_description') || query.get('error_description');
if (urlError) {
  showError(/expired|invalid/i.test(urlError)
    ? 'That link has expired or was already used. Request a new one.'
    : friendly(urlError.replace(/\+/g, ' ')));
  history.replaceState(null, '', location.pathname);
}
