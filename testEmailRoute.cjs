/**
 * Diagnostic test-email routes. They must not send mail.
 */
function refuseDiagnosticTestEmail(_req, res) {
  return res.status(410).json({
    success: false,
    sendingDisabled: true,
    error: "test_email_disabled",
    message: "Diagnostic test email sending is disabled.",
  });
}

module.exports = { refuseDiagnosticTestEmail };
