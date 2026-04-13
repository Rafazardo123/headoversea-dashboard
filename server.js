const express = require('express');
const OAuthClient = require('intuit-oauth');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'riolaser-secret-2024',
  resave: true,
  saveUninitialized: true,
  cookie: { secure: false, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'frontend/public')));

// Persist companies to file so they survive server restarts
const DATA_FILE = '/tmp/companies.json';

function loadCompanies() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveCompanies(companies) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(companies), 'utf8'); } catch (e) {}
}

const connectedCompanies = loadCompanies();

function createOAuthClient() {
  return new OAuthClient({
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    environment: 'production',
    redirectUri: process.env.REDIRECT_URI,
  });
}

function getMTDRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(now) };
}

// Helper: call QB API directly with access token
function qbGet(path, accessToken, realmId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'quickbooks.api.intuit.com',
      path: `/v3/company/${realmId}${path}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Helper: call QB Reports API
function qbReport(reportName, params, accessToken, realmId) {
  const query = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
  return qbGet(`/reports/${reportName}?${query}&minorversion=65`, accessToken, realmId);
}

// Refresh token
async function getValidToken(company) {
  if (Date.now() < company.tokenExpiry - 60000) return company.accessToken;
  const oauthClient = createOAuthClient();
  oauthClient.setToken({
    access_token: company.accessToken,
    refresh_token: company.refreshToken,
    token_type: 'bearer',
    realmId: company.realmId,
  });
  const response = await oauthClient.refresh();
  const newToken = response.getJson();
  company.accessToken = newToken.access_token;
  company.refreshToken = newToken.refresh_token || company.refreshToken;
  company.tokenExpiry = Date.now() + ((newToken.expires_in || 3600) * 1000);
  saveCompanies(connectedCompanies);
  return company.accessToken;
}

// Parse P&L rows
function extractPL(rows) {
  let revenue = 0, expenses = 0;
  for (const row of rows || []) {
    const header = (row?.Header?.ColData?.[0]?.value || '').toLowerCase();
    const summary = row?.Summary?.ColData;
    const val = summary ? (parseFloat(summary[1]?.value) || 0) : 0;
    if (header.includes('income') || header.includes('revenue') || header.includes('sales')) {
      revenue += isNaN(val) ? 0 : val;
    } else if (header.includes('expense') || header.includes('cost')) {
      expenses += isNaN(val) ? 0 : Math.abs(val);
    } else if (row?.Rows?.Row) {
      const sub = extractPL(row.Rows.Row);
      revenue += sub.revenue;
      expenses += sub.expenses;
    }
  }
  return { revenue, expenses };
}

// Walk all rows for bank balance
function findBankBalance(rows) {
  for (const row of rows || []) {
    const cols = row?.ColData || [];
    const label = (cols[0]?.value || '').toLowerCase();
    if (label.includes('check') || label.includes('bank') || label.includes('1100')) {
      const v = parseFloat(cols[1]?.value);
      if (!isNaN(v) && v !== 0) return v;
    }
    if (row?.Rows?.Row) {
      const found = findBankBalance(row.Rows.Row);
      if (found !== null) return found;
    }
  }
  return null;
}

// OAuth start
app.get('/auth', (req, res) => {
  const oauthClient = createOAuthClient();
  const authUri = oauthClient.authorizeUri({ scope: [OAuthClient.scopes.Accounting], state: 'rl-' + Date.now() });
  res.redirect(authUri);
});

// OAuth callback
app.get('/callback', async (req, res) => {
  const oauthClient = createOAuthClient();
  try {
    const authResponse = await oauthClient.createToken(req.url);
    const token = authResponse.getJson();
    const realmId = authResponse.token?.realmId || token.realmId;
    if (!realmId) return res.redirect('/?error=no_realm');

    const accessToken = token.access_token;
    const refreshToken = token.refresh_token;

    // Get company name directly from QB API
    let companyName = 'Empresa ' + realmId;
    try {
      const info = await qbGet(`/companyinfo/${realmId}?minorversion=65`, accessToken, realmId);
      companyName = info?.CompanyInfo?.CompanyName || companyName;
    } catch (e) {
      console.log('CompanyInfo error:', e.message);
    }

    connectedCompanies[realmId] = {
      realmId, companyName, accessToken, refreshToken,
      tokenExpiry: Date.now() + ((token.expires_in || 3600) * 1000)
    };
    saveCompanies(connectedCompanies);

    console.log('Connected:', companyName, realmId);
    res.redirect('/?connected=' + encodeURIComponent(companyName));
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/companies', (req, res) => {
  res.json(Object.values(connectedCompanies).map(c => ({ realmId: c.realmId, companyName: c.companyName })));
});

app.get('/api/dashboard', async (req, res) => {
  const { start, end } = getMTDRange();
  const results = [];

  for (const company of Object.values(connectedCompanies)) {
    try {
      const token = await getValidToken(company);

      const [plData, bsData] = await Promise.all([
        qbReport('ProfitAndLoss', { start_date: start, end_date: end }, token, company.realmId),
        qbReport('BalanceSheet', { start_date: start, end_date: end }, token, company.realmId).catch(() => null)
      ]);

      const { revenue, expenses } = extractPL(plData?.Rows?.Row || []);
      const bankBalance = bsData ? findBankBalance(bsData?.Rows?.Row || []) : null;

      results.push({
        realmId: company.realmId,
        companyName: company.companyName,
        revenue: Math.round(revenue),
        expenses: Math.round(expenses),
        netIncome: Math.round(revenue - expenses),
        bankBalance: bankBalance !== null ? Math.round(bankBalance) : null,
      });
    } catch (err) {
      console.error('Error for', company.companyName, ':', err.message);
      results.push({ realmId: company.realmId, companyName: company.companyName, revenue: 0, expenses: 0, netIncome: 0, bankBalance: null, error: err.message });
    }
  }

  res.json({ period: { start, end }, companies: results });
});

app.delete('/api/companies/:realmId', (req, res) => {
  delete connectedCompanies[req.params.realmId];
  saveCompanies(connectedCompanies);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Dashboard running on port', PORT));
