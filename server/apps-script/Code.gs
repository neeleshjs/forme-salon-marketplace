const TOKEN_PROPERTY = 'FORME_MAIL_TOKEN';
const MAX_HTML_LENGTH = 30000;

function doPost(event) {
  try {
    const request = JSON.parse(event && event.postData && event.postData.contents || '{}');
    const expectedToken = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '';
    if (!expectedToken || !request.token || request.token !== expectedToken) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    const to = String(request.to || '').trim();
    const subject = String(request.subject || '').trim();
    const html = String(request.html || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !subject || subject.length > 150 || !html || html.length > MAX_HTML_LENGTH) {
      return jsonResponse({ ok: false, error: 'invalid-request' });
    }
    if (MailApp.getRemainingDailyQuota() < 1) {
      return jsonResponse({ ok: false, error: 'daily-quota' });
    }

    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      htmlBody: html,
      name: 'FORME'
    });
    return jsonResponse({ ok: true });
  } catch (_error) {
    return jsonResponse({ ok: false, error: 'send-failed' });
  }
}

function authorizeFormeMail() {
  return MailApp.getRemainingDailyQuota();
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
