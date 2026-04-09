#!/usr/bin/env node

const API_KEY = process.env.CALLRAIL_API_KEY || '423a387918c39793960b61d688bed5cc';
const ACCOUNT_ID = 'ACC925c6f152a33426b9f3767406aab6621';
const BASE_URL = `https://api.callrail.com/v3/a/${ACCOUNT_ID}`;
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FIELDS = [
  'duration', 'start_time', 'direction', 'customer_phone_number', 'customer_name',
  'transcription', 'call_summary', 'source', 'recording', 'note', 'business_phone_number',
  'tracking_phone_number', 'voicemail', 'lead_score', 'lead_explanation',
  'formatted_duration', 'customer_city', 'customer_state', 'agent_email'
].join(',');

const PG_CONN = "host=192.168.0.229 port=5432 dbname=rebuilt_prod user=postgres";
const PG_PASS = 'XvcfdCh6M5QeeVn8bWGcBjXeSmrRqXcs';

function fetchFive9Agents() {
  console.log('Fetching Five9 agent data from database...');
  try {
    const sql = `
      SELECT ani, agent_email, disposition, call_timestamp
      FROM salmar.five9_call_data
      WHERE agent IS NOT NULL AND agent != '[None]'
        AND agent_email IS NOT NULL AND agent_email != ''
        AND talk_time > '00:01:00'
        AND call_date >= CURRENT_DATE - INTERVAL '90 days'
    `;
    const result = execSync(
      `PGPASSWORD='${PG_PASS}' /opt/homebrew/bin/psql "${PG_CONN}" -t -A -F '|' -c "${sql.replace(/\n/g, ' ')}"`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 50 * 1024 * 1024 }
    );

    // Build lookup: caller phone (last 10 digits) -> { agent, agent_email, disposition }
    // Use the most recent match per phone number + approximate time
    const lookup = {};
    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      const [ani, agentEmail, disposition, timestamp] = line.split('|');
      if (!ani || ani.length < 10) continue;
      const phone = ani.slice(-10);
      // Store all entries keyed by phone, we'll match by closest timestamp later
      if (!lookup[phone]) lookup[phone] = [];
      lookup[phone].push({ agentEmail, disposition, timestamp });
    }
    console.log(`  Loaded ${Object.keys(lookup).length} unique phone numbers from Five9`);
    return lookup;
  } catch (err) {
    console.warn('  Warning: Could not fetch Five9 data:', err.message);
    return {};
  }
}

function matchAgent(five9Lookup, customerPhone, callTime) {
  if (!customerPhone) return null;
  const phone = customerPhone.replace(/\D/g, '').slice(-10);
  const entries = five9Lookup[phone];
  if (!entries || entries.length === 0) return null;

  // Find closest match by timestamp
  const callDate = new Date(callTime);
  let best = null;
  let bestDiff = Infinity;
  for (const entry of entries) {
    const diff = Math.abs(new Date(entry.timestamp) - callDate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  // Only match if within 1 hour
  if (bestDiff < 3600000) return best;
  return null;
}

async function fetchAllCalls() {
  // Fetch Five9 agent data first
  const five9Lookup = fetchFive9Agents();

  let allCalls = [];
  let page = 1;
  let totalPages = 1;

  console.log('Fetching calls from CallRail...');

  while (page <= totalPages) {
    const url = `${BASE_URL}/calls.json?fields=${FIELDS}&per_page=100&page=${page}&sort=start_time&order=desc`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Token token=${API_KEY}` }
    });
    const data = await res.json();

    if (data.error) {
      console.error('API Error:', data.error);
      process.exit(1);
    }

    totalPages = data.total_pages;
    console.log(`  Page ${page}/${totalPages} — ${data.calls.length} calls`);

    allCalls = allCalls.concat(data.calls);
    page++;
  }

  // Filter to only calls with transcripts
  const withTranscripts = allCalls.filter(c => c.transcription && c.transcription.trim().length > 0);
  console.log(`\nTotal calls: ${allCalls.length}`);
  console.log(`Calls with transcripts: ${withTranscripts.length}`);

  let matched = 0;
  const calls = withTranscripts.map(c => {
    const five9 = matchAgent(five9Lookup, c.customer_phone_number, c.start_time);
    if (five9) matched++;
    const agentEmail = five9?.agentEmail || c.agent_email || '';
    const agentName = agentEmail ? agentEmail.split('@')[0].split('.').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ') : '';
    return {
      id: c.id,
      customer_name: (c.customer_name || '').trim(),
      customer_phone: c.customer_phone_number,
      customer_city: c.customer_city,
      customer_state: c.customer_state,
      direction: c.direction,
      duration: c.duration,
      formatted_duration: c.formatted_duration,
      start_time: c.start_time,
      source: c.source,
      lead_score: c.lead_score,
      lead_explanation: c.lead_explanation,
      business_phone: c.business_phone_number,
      tracking_phone: c.tracking_phone_number,
      voicemail: c.voicemail,
      recording: c.recording,
      agent_email: agentEmail,
      agent_name: agentName,
      five9_disposition: five9?.disposition || '',
      transcript: c.transcription,
      call_summary: c.call_summary,
      note: c.note
    };
  });

  console.log(`Five9 agent matched: ${matched}/${withTranscripts.length} calls`);

  const output = {
    generated_at: new Date().toISOString(),
    total_calls: allCalls.length,
    calls_with_transcripts: withTranscripts.length,
    calls
  };

  const outPath = path.join(__dirname, 'calls.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

fetchAllCalls().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
