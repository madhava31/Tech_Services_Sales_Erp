// Sending the one-time code as a text message.
//
// Production uses MSG91 (an Indian OTP service) when these are set on the server:
//   MSG91_AUTH_KEY      the account's auth key
//   MSG91_TEMPLATE_ID   the approved OTP template (Indian rules require the template to be registered)
//   MSG91_OTP_VAR       optional, the template's variable name for the code (default "OTP")
// With none of them set, nothing can be sent and smsConfigured() is false: the app then falls back to the
// admin's password reset and never locks anyone out. Outside production only, SMS_PROVIDER=console (and
// tests) keeps the last message in memory instead of sending it.

const isProduction = process.env.NODE_ENV === 'production';
let last = null;

function provider() {
  if (process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID) return 'msg91';
  if (!isProduction && (process.env.SMS_PROVIDER === 'console' || process.env.NODE_ENV === 'test')) return 'memory';
  return null;
}

export const smsConfigured = () => provider() !== null;

// For tests: the last code "sent". Never available in production.
export const lastSms = () => (isProduction ? null : last);

// `phone10` is the ten-digit Indian mobile number; the country code is added here.
export async function sendOtp(phone10, code) {
  const which = provider();
  if (which === 'memory') {
    last = { phone: phone10, code };
    if (process.env.SMS_PROVIDER === 'console') console.log(`[sms:dev] code for ${phone10}: ${code}`);
    return;
  }
  if (which !== 'msg91') throw new Error('Text messages are not set up.');
  let res;
  try {
    res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        template_id: process.env.MSG91_TEMPLATE_ID,
        short_url: '0',
        recipients: [{ mobiles: `91${phone10}`, [process.env.MSG91_OTP_VAR || 'OTP']: code }],
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('The text message service could not be reached.');
  }
  // Never log the key, the code or the number.
  if (!res.ok) throw new Error(`The text message service refused the request (${res.status}).`);
}
