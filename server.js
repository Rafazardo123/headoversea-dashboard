const express = require('express');
const OAuthClient = require('intuit-oauth');
const QuickBooks = require('node-quickbooks');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
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

const connectedCompanies = {};

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

app.get('/auth', (req, res) => {
  const oauthClient = createOAuthClient();
  const authUri = oauthClient.authorizeUri({ scope: [OAuthClient.scopes.Accounting], state: 'rl-' + Date.now() });
  res.redirect(authUri);
});

app.get('/callback', async (req, res) => {
  const oauthClient = createOAuthClient();
  try {
    const authResponse = await oauthClient.createToken(req.url);
    const token = authResponse.getJson();
    const realmId = authResponse.token?.realmId || token.realmId;
    if (!realmId) return res.redirect('/?error=no_realm');

    const qbo = new QuickBooks(process.env.QB_CLIENT_ID, process.env.QB_CLIENT_SECRET, token.access_token, false, realmId, true, false, null, '2.0', token.refresh_token);

    qbo.getCompanyInfo(realmId, (err, data) => {
      const companyName = data?.CompanyInfo?.CompanyName || data?.QueryResponse?.CompanyInfo?.[0]?.CompanyName || ('Empresa ' + realmId);
      connectedCompanies[realmId] = { realmId, companyName, accessToken: token.access_token, refreshToken: token.refresh_token, tokenExpiry: Date.now() + ((token.expires_in || 3600) * 1000) };
      console.log('Connected:', companyName);
      res.redirect('/?connected=' + encodeURIComponent(companyName));
    });
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

async function getValidToken(company) {
  if (Date.now() < company.tokenExpiry - 60000) return company.accessToken;
  const oauthClient = createOAuthClient();
  oauthClient.setToken({ access_token: company.accessToken, refresh_token: company.refreshToken, token_type: 'bearer', realmId: company.realmId });
  const response = await oauthClient.refresh();
  const newToken = response.getJson();
  company.accessToken = newToken.access_token;
  company.refreshToken = newToken.refresh_token || company.refreshToken;
  company.tokenExpiry = Date.now() + ((newToken.expires_in || 3600) * 1000);
  return company.accessToken;
}

function parsePL(rows) {
  let revenue = 0, expenses = 0;
  for (const section of rows) {
    const header = (section?.Header?.ColData?.[0]?.value || '').toLowerCase();
    const summary = section?.Summary?.ColData;
    const val = summary ? (parseFloat(summary[1]?.value) || 0) : 0;
    if (header.includes('income') || header.includes('revenue') || header.includes('sales')) revenue += val;
    else if (header.includes('expense') || header.includes('cost')) expenses += Math.abs(val);
    if (section?.Rows?.Row && !header.includes('income') && !header.includes('expense')) {
      const sub = parsePL(section.Rows.Row);
      revenue += sub.revenue; expenses += sub.expenses;
    }
  }
  return { revenue, expenses };
}

app.get('/api/companies', (req, res) => {
  res.json(Object.values(connectedCompanies).map(c => ({ realmId: c.realmId, companyName: c.companyName })));
});

app.get('/api/dashboard', async (req, res) => {
  const { start, end } = getMTDRange();
  const results = [];
  for (const company of Object.values(connectedCompanies)) {
    try {
      const token = await getValidToken(company);
      const qbo = new QuickBooks(process.env.QB_CLIENT_ID, process.env.QB_CLIENT_SECRET, token, false, company.realmId, true, false, null, '2.0', company.refreshToken);

      const plData = await new Promise((resolve, reject) => {
        qbo.reportProfitAndLoss({ start_date: start, end_date: end }, (err, data) => err ? reject(err) : resolve(data));
      });

      const { revenue, expenses } = parsePL(plData?.Rows?.Row || []);

      let bankBalance = null;
      try {
        const bsData = await new Promise((resolve, reject) => {
          qbo.reportBalanceSheet({ start_date: start, end_date: end }, (err, data) => err ? reject(err) : resolve(data));
        });
        const walkRows = (rows) => {
          for (const row of rows || []) {
            const cols = row?.ColData || [];
            const label = (cols[0]?.value || '').toLowerCase();
            if ((label.includes('check') || label.includes('bank') || label.includes('1100')) && bankBalance === null) {
              const v = parseFloat(cols[1]?.value);
              if (!isNaN(v)) bankBalance = v;
            }
            if (row?.Rows?.Row) walkRows(row.Rows.Row);
          }
        };
        walkRows(bsData?.Rows?.Row || []);
      } catch (e) {}

      results.push({ realmId: company.realmId, companyName: company.companyName, revenue: Math.round(revenue), expenses: Math.round(expenses), netIncome: Math.round(revenue - expenses), bankBalance: bankBalance !== null ? Math.round(bankBalance) : null });
    } catch (err) {
      results.push({ realmId: company.realmId, companyName: company.companyName, revenue: 0, expenses: 0, netIncome: 0, bankBalance: null, error: err.message });
    }
  }
  res.json({ period: { start, end }, companies: results });
});

app.delete('/api/companies/:realmId', (req, res) => {
  delete connectedCompanies[req.params.realmId];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Dashboard running on port', PORT));
