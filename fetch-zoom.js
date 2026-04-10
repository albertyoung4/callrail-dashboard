#!/usr/bin/env node
// Fetch Zoom Phone recordings with transcripts
// Uses OAuth refresh token for automated access
// Enriches with user-lookup.json for agent assignment + internal call detection

const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.ZOOM_CLIENT_ID || 'IjdncW6PTdOxoVfmvafXWw';
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || 'dAA8i28TRUq3SAYsnd8sSxwv2XUnrTry';
const TOKEN_FILE = path.join(__dirname, 'zoom-tokens.json');
const OUTPUT_FILE = path.join(__dirname, 'zoom-calls.json');
const LOOKUP_FILE = path.join(__dirname, 'user-lookup.json');
const MERGE_MODE = process.argv.includes('--merge');

// How many days back to fetch (default 30)
const DAYS_BACK = parseInt(process.env.ZOOM_DAYS || '30', 10);

function loadLookup() {
  try {
    const data = JSON.parse(fs.readFileSync(LOOKUP_FILE, 'utf-8'));
    console.log(`Loaded user-lookup.json (${Object.keys(data.users).length} users, ${Object.keys(data.zoom_call_lookup).length} Zoom call pairs)`);
    return data;
  } catch (err) {
    console.warn('Warning: Could not load user-lookup.json:', err.message);
    return { users: {}, zoom_call_lookup: {} };
  }
}

function matchZoomDb(lookup, rec) {
  const callerPhone = (rec.caller_number || '').replace(/\D/g, '').slice(-10);
  const calleePhone = (rec.callee_number || '').replace(/\D/g, '').slice(-10);
  const key = callerPhone + '_' + calleePhone;
  const entries = lookup.zoom_call_lookup[key];
  if (!entries) return null;

  const callDate = new Date(rec.date_time);
  let best = null, bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(new Date(e.ts) - callDate);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return bestDiff < 3600000 ? best : null;
}

function resolveAgent(lookup, email) {
  if (!email) return { name: '', role: '', department: '' };
  const user = lookup.users[email];
  if (user) return { name: user.name, role: user.role, department: user.department };
  const name = email.split('@')[0].split('.').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  return { name, role: '', department: '' };
}

function matchProspect(lookup, phone) {
  if (!phone || !lookup.prospect_phone_lookup) return null;
  const norm = phone.replace(/\D/g, '').slice(-10);
  const prospects = lookup.prospect_phone_lookup[norm];
  return prospects && prospects.length > 0 ? prospects[0] : null;
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
  // Load user lookup for agent assignment
  const lookup = loadLookup();

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

    // Match to DB for agent email + internal flag
    const dbMatch = matchZoomDb(lookup, rec);
    const ownerEmail = rec.owner?.email || '';
    const agentEmail = dbMatch?.email || ownerEmail;
    const isInternal = dbMatch?.internal || false;

    // Resolve agent from user roles (try DB match email, then owner email)
    const ownerName = rec.owner?.name || '';
    let agent = resolveAgent(lookup, dbMatch?.email || '');
    if (!agent.role && ownerEmail) agent = resolveAgent(lookup, ownerEmail);
    const agentName = agent.name || ownerName;
    const ownerExt = rec.owner?.extension_number?.toString() || '';

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
      agent_role: agent.role,
      agent_department: agent.department,
      five9_disposition: '',
      prospect_id: (matchProspect(lookup, rec.direction === 'inbound' ? rec.caller_number : rec.callee_number))?.prospect_id || '',
      prospect_address: (matchProspect(lookup, rec.direction === 'inbound' ? rec.caller_number : rec.callee_number))?.address || '',
      prospect_name: (matchProspect(lookup, rec.direction === 'inbound' ? rec.caller_number : rec.callee_number))?.name || '',
      zoom_result: dbMatch?.result || '',
      internal: isInternal,
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
  console.log(`Internal calls: ${calls.filter(c => c.internal).length}`);

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
