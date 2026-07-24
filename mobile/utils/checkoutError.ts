/** User-visible checkout error from API / network failures. */
export function formatCheckoutError(err: unknown): string {
  const e = err as {
    message?: string;
    code?: string;
    status?: number | string;
    url?: string;
    details?: {
      error?: string;
      message?: string;
      paypal?: { environment?: string };
      paypalDetail?: {
        name?: string;
        message?: string;
        debug_id?: string | null;
        details?: Array<{ issue?: string; description?: string }>;
      };
    };
  };
  const parts: string[] = [];
  const detail = e?.details?.paypalDetail;
  const issue = detail?.details?.[0]?.issue;
  const desc = detail?.details?.[0]?.description || detail?.message;
  const msg = String(desc || e?.details?.message || e?.message || e || "").trim();
  if (msg) parts.push(msg);
  const code = issue || e?.code;
  if (code && code !== msg) parts.push(`Code: ${code}`);
  if (e?.status != null) parts.push(`HTTP ${e.status}`);
  if (detail?.debug_id) parts.push(`PayPal debug_id: ${detail.debug_id}`);
  const paypalEnv = e?.details?.paypal?.environment;
  if (paypalEnv) parts.push(`PayPal env: ${paypalEnv}`);
  if (parts.length) return parts.join("\n");
  return "Payment system unavailable. Please try again.";
}
