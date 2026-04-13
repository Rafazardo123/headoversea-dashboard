const express = require('express');
const OAuthClient = require('intuit-oauth');
const QuickBooks = require('node-quickbooks');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'riolaser-secret-2024',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Serve frontend
app.use(express.static(path.join(__dirname, 'frontend/public')));

// In-memory store for connected companies (use a DB in production)
const connectedCompanies = {};

function createOAuthClient() {
  return new OAuthClient({
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    environment: 'production',
    redirectUri: process.env.REDIRECT_URI || 'http://localhost:3000/callback',
  });
}

// Step 1: Start OAuth login for a new company
app.get('/auth', (req, res) => {
  const oauthClient = createOAuthClient();
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: 'riolaser-' + Date.now(),
  });
  res.redirect(authUri);
});

// Step 2: OAuth callback — save tokens
app.get('/callback', async (req, res) => {
  const oauthClient = createOAuthClient();
  try {
    const authResponse = await oauthClient.createToken(req.url);
    const token = authResponse.getJson();
    const realmId = token.realmId;

    // Get company name
    const qbo = new QuickBooks(
      process.env.QB_CLIENT_ID,
      process.env.QB_CLIENT_SECRET,
      token.access_token,
      false,
      realmId,
      true, // use production
      false,
      null,
      '2.0',
      token.refresh_token
    );

    qbo.getCompanyInfo(realmId, (err, info) => {
      const companyName = info?.CompanyInfo?.CompanyName || 'Empresa ' + realmId;
      connectedCompanies[realmId] = {
        realmId,
        companyName,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenExpiry: Date.now() + (token.expires_in * 1000),
      };
      console.log(`✅ Conectado: ${companyName} (${realmId})`);
      res.redirect('/?connected=' + encodeURIComponent(companyName));
    });
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

// Helper: refresh token if needed
async function getValidToken(company) {
  if (Date.now() < company.tokenExpiry - 60000) return company.accessToken;

  const oauthClient = createOAuthClient();
  oauthClient.setToken({
    access_token: company.accessToken,
    refresh_token: company.refreshToken,
  });

  const response = await oauthClient.refresh();
  const newToken = response.getJson();
  company.accessToken = newToken.access_token;
  company.refreshToken = newToken.refresh_token;
  company.tokenExpiry = Date.now() + (newToken.expires_in * 1000);
  return company.accessToken;
}

// Helper: get MTD date range
function getMTDRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(now) };
}

// API: list connected companies
app.get('/api/companies', (req, res) => {
  const list = Object.values(connectedCompanies).map(c => ({
    realmId: c.realmId,
    companyName: c.companyName,
  }));
  res.json(list);
});

// API: get dashboard data for all companies
app.get('/api/dashboard', async (req, res) => {
  const { start, end } = getMTDRange();
  const results = [];

  for (const company of Object.values(connectedCompanies)) {
    try {
      const token = await getValidToken(company);
      const qbo = new QuickBooks(
        process.env.QB_CLIENT_ID,
        process.env.QB_CLIENT_SECRET,
        token,
        false,
        company.realmId,
        true,
        false,
        null,
        '2.0',
        company.refreshToken
      );

      // P&L report
      const plData = await new Promise((resolve, reject) => {
        qbo.reportProfitAndLoss({ start_date: start, end_date: end }, (err, data) => {
          if (err) reject(err); else resolve(data);
        });
      });

      // Balance sheet for bank balance
      const bsData = await new Promise((resolve, reject) => {
        qbo.reportBalanceSheet({ start_date: start, end_date: end }, (err, data) => {
          if (err) reject(err); else resolve(data);
        });
      });

      // Parse P&L
      let revenue = 0, expenses = 0;
      const rows = plData?.Rows?.Row || [];
      for (const section of rows) {
        const header = section?.Header?.ColData?.[0]?.value || '';
        const summary = section?.Summary?.ColData;
        if (!summary) continue;
        const val = parseFloat(summary[1]?.value || 0);
        if (header.toLowerCase().includes('income') || header.toLowerCase().includes('revenue')) {
          revenue += val;
        } else if (header.toLowerCase().includes('expense') || header.toLowerCase().includes('cost')) {
          expenses += Math.abs(val);
        }
      }

      // Parse bank balance from Balance Sheet
      let bankBalance = null;
      const bsRows = bsData?.Rows?.Row || [];
      for (const section of bsRows) {
        const header = section?.Header?.ColData?.[0]?.value || '';
        if (header.toLowerCase().includes('bank') || header.toLowerCase().includes('checking')) {
          const summary = section?.Summary?.ColData;
          if (summary?.[1]?.value) {
            bankBalance = parseFloat(summary[1].value);
            break;
          }
          // Try rows inside section
          for (const row of section?.Rows?.Row || []) {
            const cols = row?.ColData || [];
            const label = cols[0]?.value || '';
            if (label.toLowerCase().includes('check') || label.toLowerCase().includes('bank')) {
              bankBalance = parseFloat(cols[1]?.value || 0);
              break;
            }
          }
          if (bankBalance !== null) break;
        }
      }

      results.push({
        realmId: company.realmId,
        companyName: company.companyName,
        period: { start, end },
        revenue: Math.round(revenue),
        expenses: Math.round(expenses),
        netIncome: Math.round(revenue - expenses),
        bankBalance: bankBalance !== null ? Math.round(bankBalance) : null,
      });
    } catch (err) {
      console.error(`Error for ${company.companyName}:`, err.message);
      results.push({
        realmId: company.realmId,
        companyName: company.companyName,
        error: 'Erro ao buscar dados',
      });
    }
  }

  res.json({ period: getMTDRange(), companies: results });
});

// API: remove a company
app.delete('/api/companies/:realmId', (req, res) => {
  delete connectedCompanies[req.params.realmId];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Rio Laser Dashboard rodando em http://localhost:${PORT}`));
