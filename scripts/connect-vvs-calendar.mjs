import { google } from 'googleapis';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const expectedAccount = 'andygdz663@gmail.com';
const calendarId =
  '473e51b5329a173e885c3fe8db7cf83305bda22f5fa09a2441cdda034a823dc4@group.calendar.google.com';
const clientPath = resolve('google-oauth-client.json');
const envPath = resolve('.env.local');
const redirect = 'http://127.0.0.1:8765';
const scopes = [
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/userinfo.email',
];

function setEnvironmentValue(text, key, value) {
  const replacement = key + '=' + value;
  const lines = text.trimEnd().split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(key + '='));
  if (index >= 0) lines[index] = replacement;
  else lines.push(replacement);
  return lines.join('\n') + '\n';
}

async function main() {
  if (!existsSync(clientPath)) {
    throw new Error(
      'Missing google-oauth-client.json in this project. Download a Google Cloud Desktop OAuth client first.',
    );
  }
  if (!existsSync(envPath)) {
    throw new Error('Missing .env.local; this tool updates an existing local environment only.');
  }
  const config = JSON.parse(readFileSync(clientPath, 'utf8'));
  if (!config.installed?.client_id || !config.installed?.client_secret) {
    throw new Error(
      'Expected an OAuth Desktop app client JSON with installed.client_id and installed.client_secret.',
    );
  }
  const { client_id, client_secret } = config.installed;
  const oauth = new google.auth.OAuth2(client_id, client_secret, redirect);
  const state = randomBytes(24).toString('hex');

  const authCode = new Promise((resolveCode, rejectCode) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirect);
      if (url.pathname !== '/') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(403).end('Invalid authorization state');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        response.writeHead(400).end('Google authorization was not completed.');
        server.close();
        rejectCode(new Error(error ?? 'Missing authorization code'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Google authorization received. Return to the terminal.');
      server.close();
      resolveCode(code);
    });
    server.on('error', rejectCode);
    server.listen(8765, '127.0.0.1');
    const timer = setTimeout(
      () => {
        server.close();
        rejectCode(new Error('Authorization timed out. Run the command again.'));
      },
      5 * 60 * 1000,
    );
    timer.unref();
  });

  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
  });
  console.log('Authorize only this Google account:', expectedAccount);
  console.log('If a browser does not open, use this URL on the Windows computer:');
  console.log(authUrl);
  if (process.platform === 'win32') {
    try {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', authUrl], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      // Use printed URL.
    }
  }

  const code = await authCode;
  const result = await oauth.getToken(code);
  const tokens = result.tokens;
  if (!tokens.refresh_token) {
    throw new Error('Google did not provide an offline refresh token. Reauthorize the app.');
  }
  oauth.setCredentials(tokens);
  const identity = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
  if (identity.data.email?.toLowerCase() !== expectedAccount) {
    throw new Error('Wrong Google account authorized. No credentials were saved.');
  }
  const calendar = google.calendar({ version: 'v3', auth: oauth });
  const now = new Date();
  const then = new Date(now.getTime() + 60 * 60 * 1000);
  const availability = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: then.toISOString(),
      items: [{ id: calendarId }],
    },
  });
  const entry = availability.data.calendars?.[calendarId];
  if (!entry || entry.errors?.length) {
    throw new Error(
      'VVS Smilez calendar unavailable to this OAuth client. No credentials were saved.',
    );
  }

  let env = readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries({
    GOOGLE_CLIENT_ID: client_id,
    GOOGLE_CLIENT_SECRET: client_secret,
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
    DENTAL_CALENDAR_ID: calendarId,
    DENTAL_TIMEZONE: 'America/Tijuana',
  })) {
    env = setEnvironmentValue(env, key, value);
  }
  writeFileSync(envPath, env, { encoding: 'utf8', mode: 0o600 });
  console.log('Verified Google account and VVS Smilez free/busy access.');
  console.log('OAuth saved only to the local, ignored .env.local file.');
  console.log('Demo mode unchanged; real booking has NOT been enabled.');
}

main().catch((error) => {
  console.error('Calendar connection failed:', error.message);
  process.exitCode = 1;
});
