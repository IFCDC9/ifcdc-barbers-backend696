const SAFE_MESSAGES = {
  email_required: "Enter a valid email address.",
  email_unconfigured: "Password reset email is temporarily unavailable. Please try again later.",
  email_rate_limited: "Too many reset emails were requested. Please wait a few minutes and try again.",
  email_failed:
    "We could not deliver a reset email right now. Check spam, wait a few minutes, then try again. If this continues, contact support.",
  server_error: "Something went wrong starting the reset. Please try again.",
  sms_unconfigured: "Password reset is temporarily unavailable. Please try again later.",
  sms_rate_limited: "Too many reset requests. Please wait a few minutes and try again.",
  sms_failed: "We could not send a reset code right now. Please try again later.",
  invalid_code: "That code is invalid or expired. Try again.",
  code_required: "Enter the 6-digit code from your text message.",
  locked: "Too many incorrect codes. Please wait a few minutes and try again.",
  invalid_token: "That reset session expired. Request a new code.",
  token_expired: "That reset session expired. Request a new code.",
  token_required: "Request a new reset code and try again.",
  weak_password: "Choose a stronger password (12+ characters with mixed case, a number, and a symbol).",
};

export function userFacingForgotPasswordError(err) {
  const code = err?.code || err?.details?.error || null;
  if (code && SAFE_MESSAGES[code]) return SAFE_MESSAGES[code];
  const status = Number(err?.status || err?.details?.status || 0);
  if (status === 429) return SAFE_MESSAGES.sms_rate_limited;
  if (status === 400) {
    const msg = typeof err?.message === "string" ? err.message : "";
    if (/password/i.test(msg)) return SAFE_MESSAGES.weak_password;
    if (/code/i.test(msg)) return SAFE_MESSAGES.invalid_code;
    return SAFE_MESSAGES.email_required;
  }
  if (status === 503) return SAFE_MESSAGES.sms_failed;
  if (status >= 500) return SAFE_MESSAGES.server_error;
  return SAFE_MESSAGES.sms_failed;
}
