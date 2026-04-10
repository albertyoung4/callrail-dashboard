#!/usr/bin/env node
// Fetch Zoom Phone recordings with transcripts
// Uses OAuth refresh token for automated access

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLIENT_ID = process.env.ZOOM_CLIENT_ID || 'IjdncW6PTdOxoVfmvafXWw';
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || 'dAA8i28TRUq3SAYsnd8sSxwv2XUnrTry';
const TOKEN_FILE = path.join(__dirname, 'zoom-tokens.json');
const OUTPUT_FILE = path.join(__dirname, 'zoom-calls.json');
const MERGE_MODE = process.argv.includes('--merge');

// How many days back to fetch (default 30)
const DAYS_BACK = parseInt(process.env.ZOOM_DAYS || '30', 10);

const PG_CONN = "host=192.168.0.229 port=5432 dbname=rebuilt_prod user=postgres";
const PG_PASS = 'XvcfdCh6M5QeeVn8bWGcBjXeSmrRqXcs';

function fetchZoomDbLookup() {
  console.log('Fetching Zoom call data from database for enrichment...');
  try {
    const sql = `
      SELECT caller_number, callee_number, direction, department, result, date_time
      FROM salmar.zoom_call_logs
      WHERE date_time >= NOW() - INTERVAL '${DAYS_BACK} days'
        AND duration > 60
        AND department IS NOT NULL AND department != ''
    `;
    const result = execSync(
      `PGPASSWORD='${PG_PASS}' /opt/homebrew/bin/psql "${PG_CONN}" -t -A -F '|' -c "${sql.replace(/\n/g, ' ')}"`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 50 * 1024 * 1024 }
    );

    const lookup = {};
    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      const [callerNum, calleeNum, dir, dept, callResult, dateTime] = line.split('|');
      // Key by caller+callee phone combo for matching
      const key = (callerNum || '').replace(/\D/g, '').slice(-10) + '_' + (calleeNum || '').replace(/\D/g, '').slice(-10);
      if (!lookup[key]) lookup[key] = [];
      lookup[key].push({ agentEmail: dept, result: callResult, timestamp: dateTime });
    }
    console.log(`  Loaded ${Object.keys(lookup).length} unique call pairs from zoom_call_logs`);
    return lookup;
  } catch (err) {
    console.warn('  Warning: Could not fetch Zoom DB data:', err.message);
    return {};
  }
}

function matchZoomDb(dbLookup, rec) {
  if (!dbLookup || Object.keys(dbLookup).length === 0) return null;
  const callerPhone = (rec.caller_number || '').replace(/\D/g, '').slice(-10);
  const calleePhone = (rec.callee_number || '').replace(/\D/g, '').slice(-10);
  const key = callerPhone + '_' + calleePhone;
  const entries = dbLookup[key];
  if (!entries) return null;

  const callDate = new Date(rec.date_time);
  let best = null, bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(new Date(e.timestamp) - callDate);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return bestDiff < 3600000 ? best : null;
}

async function refreshToken() {
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));

  const res = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
    },
    body: `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`
  });

  const data = await res.json();
  if (data.error) {
    console.error('Token refresh failed:', data);
    // Try using existing token if it might still be valid
    return tokens.access_token;
  }

  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    scope: data.scope,
    obtained_at: new Date().toISOString()
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(updated, null, 2));
  console.log('Token refreshed');
  return data.access_token;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function parseZoomTranscript(timeline) {
  // Convert Zoom timeline JSON to "Speaker: text" format matching CallRail
  if (!timeline || !Array.isArray(timeline)) return '';
  return timeline.map(entry => {
    const speaker = entry.users?.[0]?.username || 'Unknown';
    return `${speaker}: ${entry.text}`;
  }).join('\n');
}

async function fetchWithRetry(url, token, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '2', 10);
      console.log(`  Rate limited, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    return res;
  }
  return null;
}

async function fetchAllRecordings(token) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - DAYS_BACK);

  let allRecordings = [];
  let nextPageToken = '';
  let page = 1;

  console.log(`Fetching Zoom Phone recordings from ${formatDate(from)} to ${formatDate(to)}...`);

  do {
    const url = `https://api.zoom.us/v2/phone/recordings?page_size=100&from=${formatDate(from)}&to=${formatDate(to)}${nextPageToken ? '&next_page_token=' + nextPageToken : ''}`;
    const res = await fetchWithRetry(url, token);
    if (!res || !res.ok) {
      console.error('Failed to fetch recordings page', page);
      break;
    }

    const data = await res.json();
    allRecordings = allRecordings.concat(data.recordings || []);
    nextPageToken = data.next_page_token || '';
    console.log(`  Page ${page} — ${data.recordings?.length || 0} recordings (total: ${allRecordings.length}/${data.total_records})`);
    page++;
  } while (nextPageToken);

  console.log(`\nTotal recordings: ${allRecordings.length}`);
  return allRecordings;
}

async function fetchTranscript(recording, token) {
  if (!recording.transcript_download_url) return null;

  try {
    const res = await fetchWithRetry(recording.transcript_download_url, token);
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data.timeline || null;
  } catch (err) {
    return null;
  }
}

async function main() {
  // Fetch DB enrichment data
  const dbLookup = fetchZoomDbLookup();

  console.log('Refreshing Zoom token...');
  const token = await refreshToken();

  const recordings = await fetchAllRecordings(token);

  // Filter to recordings with transcripts and minimum duration (60s)
  const withTranscripts = recordings.filter(r => r.transcript_download_url && r.duration >= 60);
  console.log(`Recordings with transcripts (60s+): ${withTranscripts.length}`);

  // Fetch transcripts
  console.log('\nFetching transcripts...');
  const calls = [];
  let fetched = 0;

  for (const rec of withTranscripts) {
    const timeline = await fetchTranscript(rec, token);
    fetched++;
    if (fetched % 25 === 0) console.log(`  ${fetched}/${withTranscripts.length} transcripts fetched...`);

    const transcript = parseZoomTranscript(timeline);
    if (!transcript) continue;

    // Determine agent vs caller
    const ownerName = rec.owner?.name || '';
    const ownerExt = rec.owner?.extension_number?.toString() || '';

    // Enrich from DB
    const dbMatch = matchZoomDb(dbLookup, rec);
    let agentEmail = dbMatch?.agentEmail || '';
    let agentName = ownerName;
    if (agentEmail && !agentName) {
      agentName = agentEmail.split('@')[0].split('.').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    }

    calls.push({
      id: 'zoom_' + rec.id,
      source_system: 'zoom_phone',
      customer_name: rec.direction === 'inbound' ? rec.caller_name : rec.callee_name,
      customer_phone: rec.direction === 'inbound' ? rec.caller_number : rec.callee_number,
      customer_city: '',
      customer_state: '',
      direction: rec.direction,
      duration: rec.duration,
      formatted_duration: `${Math.floor(rec.duration / 60)}m ${rec.duration % 60}s`,
      start_time: rec.date_time,
      source: 'Zoom Phone',
      lead_score: null,
      lead_explanation: '',
      business_phone: rec.direction === 'inbound' ? rec.callee_number : rec.caller_number,
      tracking_phone: '',
      voicemail: false,
      recording: rec.download_url || '',
      agent_email: agentEmail,
      agent_name: agentName,
      five9_disposition: '',
      zoom_result: dbMatch?.result || '',
      transcript: transcript,
      call_summary: '',
      note: '',
      zoom_call_id: rec.call_id,
      zoom_recording_id: rec.id,
      zoom_owner_ext: ownerExt
    });

    // Small delay to avoid rate limits
    if (fetched % 10 === 0) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nCalls with transcripts: ${calls.length}`);

  // Merge mode
  let finalCalls = calls;
  if (MERGE_MODE && fs.existsSync(OUTPUT_FILE)) {
    console.log('\n--merge: Merging with existing zoom-calls.json...');
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      const newIds = new Set(calls.map(c => c.id));
      const oldCalls = (existing.calls || []).filter(c => !newIds.has(c.id));
      finalCalls = [...calls, ...oldCalls];
      console.log(`  Kept ${oldCalls.length} older calls, added ${calls.length} new/updated`);
    } catch (err) {
      console.warn('  Could not merge:', err.message);
    }
  }

  // Sort by start_time descending
  finalCalls.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

  const output = {
    generated_at: new Date().toISOString(),
    total_recordings: recordings.length,
    calls_with_transcripts: finalCalls.length,
    calls: finalCalls
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${finalCalls.length} calls to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
