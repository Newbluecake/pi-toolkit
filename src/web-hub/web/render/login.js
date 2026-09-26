/**
 * Login-screen DOM helpers (plan §10, package LF — password auth mode).
 *
 * Every function here only ever touches `hidden`, `disabled`, `textContent`
 * and (for the password field, to satisfy "密码不写入 localStorage" plus the
 * "登录成功后清空密码框" requirement) the input's own `.value` — never
 * innerHTML, never a new element. `mountApp`'s `no-innerhtml.test.ts` scans
 * this file like every other one under `web/`.
 *
 * All functions take a `ui` bag of already-looked-up elements (built once by
 * the caller via `doc.getElementById`) so this module never touches `doc`
 * itself and stays trivially testable against the same fake-dom used by the
 * rest of `tests/web-hub/web/**`.
 */

/**
 * @typedef {{
 *   authModeError: any,
 *   loginScreen: any,
 *   plaintextNotice: any,
 *   form: any,
 *   username: any,
 *   password: any,
 *   submit: any,
 *   error: any,
 *   app: any,
 *   signout: any,
 *   initialPasswordBanner: any,
 * }} LoginUi
 */

/**
 * @param {(id: string) => any} $ getElementById-shaped lookup
 * @returns {LoginUi}
 */
export function queryLoginUi($) {
  return {
    authModeError: $("auth-mode-error"),
    loginScreen: $("login-screen"),
    plaintextNotice: $("plaintext-notice"),
    form: $("login"),
    username: $("login-username"),
    password: $("login-password"),
    submit: $("login-submit"),
    error: $("login-error"),
    app: $("app"),
    signout: $("signout"),
    initialPasswordBanner: $("initial-password-banner"),
  };
}

/** Error-mode gate (§10 row 1): show the stale-page message, hide everything else. @param {LoginUi} ui */
export function showAuthModeError(ui) {
  if (ui.authModeError) {
    ui.authModeError.hidden = false;
    ui.authModeError.textContent = "Cannot determine sign-in mode (stale page?). Reload.";
  }
  if (ui.loginScreen) ui.loginScreen.hidden = true;
  if (ui.app) ui.app.hidden = true;
}

/** @param {LoginUi} ui @param {boolean} plaintext `location.protocol === "http:"` */
export function showLoginForm(ui, plaintext) {
  if (ui.authModeError) ui.authModeError.hidden = true;
  if (ui.loginScreen) ui.loginScreen.hidden = false;
  if (ui.plaintextNotice) ui.plaintextNotice.hidden = !plaintext;
  if (ui.form) ui.form.hidden = false;
  if (ui.app) ui.app.hidden = true;
  if (ui.signout) ui.signout.hidden = true;
}

/** @param {LoginUi} ui */
export function hideLoginForm(ui) {
  if (ui.loginScreen) ui.loginScreen.hidden = true;
  if (ui.app) ui.app.hidden = false;
  if (ui.signout) ui.signout.hidden = false;
}

/** @param {LoginUi} ui @param {string} text empty string clears the alert */
export function setLoginError(ui, text) {
  if (ui.error) ui.error.textContent = text;
}

/** Disable the form while a login attempt is in flight (or a countdown is running). @param {LoginUi} ui @param {boolean} busy */
export function setLoginBusy(ui, busy) {
  if (ui.username) ui.username.disabled = busy;
  if (ui.password) ui.password.disabled = busy;
  if (ui.submit) ui.submit.disabled = busy;
}

/** Read the current form values (never persisted anywhere by this module). @param {LoginUi} ui */
export function readLoginForm(ui) {
  return { username: String(ui.username?.value ?? ""), password: String(ui.password?.value ?? "") };
}

/** "登录成功后 … 密码框清空" — never localStorage, only the field's own value. @param {LoginUi} ui */
export function clearPasswordField(ui) {
  if (ui.password) ui.password.value = "";
}

/** @param {LoginUi} ui @param {boolean} show */
export function showInitialPasswordBanner(ui, show) {
  if (ui.initialPasswordBanner) ui.initialPasswordBanner.hidden = !show;
}
