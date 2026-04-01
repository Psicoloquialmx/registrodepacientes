const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'registro-de-pacientes-f729f';
const REGION = process.env.GCF_REGION || 'us-central1';

function parseServiceAccount() {
  const raw = process.env.GCP_SA_KEY_JSON;
  if (!raw) {
    throw new Error('Missing GCP_SA_KEY_JSON environment variable in Netlify.');
  }

  try {
    return JSON.parse(raw);
  } catch (_err) {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }
}

async function getInvokerToken(targetUrl) {
  const credentials = parseServiceAccount();
  const auth = new GoogleAuth({ credentials });
  const client = await auth.getIdTokenClient(targetUrl);
  const headers = await client.getRequestHeaders();
  const authHeader = headers.Authorization || headers.authorization;
  if (!authHeader) throw new Error('Failed to generate invoker token.');
  return authHeader;
}

function getFunctionUrl(functionName, queryString) {
  const qs = queryString ? `?${queryString}` : '';
  return `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${functionName}${qs}`;
}

module.exports = {
  getInvokerToken,
  getFunctionUrl,
};
