const { getInvokerToken, getFunctionUrl } = require('./_gcfProxyCommon');

exports.handler = async (event) => {
  try {
    const userAuth = event.headers.authorization || event.headers.Authorization || '';
    if (!userAuth.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing Firebase auth token' }) };
    }

    const targetUrl = getFunctionUrl('googleCalendarConnect');
    const invokerAuth = await getInvokerToken(targetUrl);

    const resp = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: invokerAuth,
        'X-Firebase-Auth': userAuth,
      },
    });

    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: text || '{}',
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
};
