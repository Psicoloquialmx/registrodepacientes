const { getInvokerToken, getFunctionUrl } = require('./_gcfProxyCommon');

exports.handler = async (event) => {
  try {
    const query = event.rawQuery || '';
    const targetUrl = getFunctionUrl('googleCalendarCallback', query);
    const invokerAuth = await getInvokerToken(targetUrl);

    const resp = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: invokerAuth,
      },
      redirect: 'manual',
    });

    const location = resp.headers.get('location');
    if (location) {
      return {
        statusCode: 302,
        headers: {
          Location: location,
          'Cache-Control': 'no-store',
        },
        body: '',
      };
    }

    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: text,
    };
  } catch (err) {
    const appUrl = process.env.APP_URL || 'https://registropx.netlify.app';
    return {
      statusCode: 302,
      headers: {
        Location: `${appUrl}?calendar=error&reason=netlify_callback_proxy_failed`,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  }
};
