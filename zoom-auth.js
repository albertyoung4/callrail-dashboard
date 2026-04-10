#!/usr/bin/env node
// One-time OAuth flow to get Zoom Phone API refresh token
// 1. Starts a local server on port 4000
// 2. Opens the Zoom OAuth URL in browser
// 3. Captures the auth code from callback
// 4. Exchanges it for access + refresh tokens
// 5. Saves tokens to zoom-tokens.json

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLIENT_ID = 'IjdncW6PTdOxoVfmvafXWw';
const CLIENT_SECRET = 'dAA8i28TRUq3SAYsnd8sSxwv2XUnrTry';
const REDIRECT_URI = 'http://localhost:4000/callback';
const TOKEN_FILE = path.join(__dirname, 'zoom-tokens.json');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:4000');

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400);
      res.end('No code received');
      return;
    }

    console.log('Got auth code:', code.substring(0, 10) + '...');

    // Exchange code for tokens
    try {
      const tokenRes = await fetch('https://zoom.us/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
        },
        body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      });

      const tokens = await tokenRes.json();

      if (tokens.error) {
        console.error('Token error:', tokens);
        res.writeHead(500);
        res.end('Token exchange failed: ' + JSON.stringify(tokens));
        server.close();
        return;
      }

      // Save tokens
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        obtained_at: new Date().toISOString()
      };

      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
      console.log('\nTokens saved to zoom-tokens.json!');
      console.log('Scopes:', tokens.scope);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Success!</h1><p>Zoom Phone API authorized. You can close this tab.</p><p>Scopes: ' + tokens.scope + '</p>');

      // Test the token with a quick API call
      console.log('\nTesting Zoom Phone API...');
      const testRes = await fetch('https://api.zoom.us/v2/phone/users?page_size=1', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` }
      });
      const testData = await testRes.json();
      if (testData.users) {
        console.log('Zoom Phone API working! Found', testData.total_records, 'phone users');
      } else {
        console.log('API test result:', JSON.stringify(testData));
      }

      setTimeout(() => { server.close(); process.exit(0); }, 2000);

    } catch (err) {
      console.error('Error:', err);
      res.writeHead(500);
      res.end('Error: ' + err.message);
      server.close();
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(4000, () => {
  console.log('Listening on http://localhost:4000');
  console.log('Opening Zoom OAuth URL in browser...\n');

  const authUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  execSync(`open "${authUrl}"`);
});
