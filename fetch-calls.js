#!/usr/bin/env node
// Fetch CallRail calls and enrich with Five9 agent data + user roles from user-lookup.json

const API_KEY = process.env.CALLRAIL_API_KEY || '423a387918c39793960b61d688bed5cc';
const ACCOUNT_ID = 'ACC925c6f152a33426b9f3767406aab6621';
const BASE_URL = `https://api.callrail.com/v3/a/${ACCOUNT_ID}`;
const fs = require('fs');
const path = require('path');

const MERGE_MODE = process.argv.includes('--merge');
const LOOKUP_FILE = path.join(__dirname, 'user-lookup.json');
const OUTPUT_FILE = path.join(__dirname, 'calls.json');

const FIELDS = [
  'duration', 'start_time', 'direction', 'customer_phone_number', 'customer_name',
  'transcription', 'call_summary', 'source', 'recording', 'note', 'business_phone_number',
  'tracking_phone_number', 'voicemail', 'lead_score', 'lead_explanation',
  'formatted_duration', 'customer_city', 'customer_state', 'agent_email'
].join(',');

function loadLookup() {
  try {
    const data = JSON.parse(fs.readFileSync(LOOKUP_FILE, 'utf-8'));
    console.log(`Loaded user-lookup.json (${Object.keys(data.users).length} users, ${Object.keys(data.five9_phone_lookup).length} Five9 phones)`);
    return data;
  } catch (err) {
    console.warn('Warning: Could not load user-lookup.json:', err.message);
    return { users: {}, five9_phone_lookup: {}, callrail_agent_lookup: {} };
  }
}

function matchFive9(lookup, customerPhone, callTime) {
  if (!customerPhone) return null;
  const phone = customerPhone.replace(/\D/g, '').slice(-10);
  const entries = lookup.five9_phone_lookup[phone];
  if (!entries || entries.length === 0) return null;

  const callDate = new Date(callTime);
  let best = null, bestDiff = Infinity;
  for (const entry of entries) {
    const diff = Math.abs(new Date(entry.ts) - callDate);
    if (diff < bestDiff) { bestDiff = diff; best = entry; }
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

function matchProspect(lookup, customerPhone) {
  if (!customerPhone || !lookup.prospect_phone_lookup) return null;
  const phone = customerPhone.replace(/\D/g, '').slice(-10);
  const prospects = lookup.prospect_phone_lookup[phone];
  if (!prospects || prospects.length === 0) return null;
  return prospects[0]; // Return first match (most relevant)
}

async function fetchAllCalls() {
  const lookup = loadLookup();

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

  const withTranscripts = allCalls.filter(c => c.transcription && c.transcription.trim().length > 0);
  console.log(`\nTotal calls: ${allCalls.length}`);
  console.log(`Calls with transcripts: ${withTranscripts.length}`);

  let five9Matched = 0, dbMatched = 0;
  const calls = withTranscripts.map(c => {
    // Priority 1: Five9 match by phone + timestamp
    const five9 = matchFive9(lookup, c.customer_phone_number, c.start_time);
    // Priority 2: CallRail agent_email from API
    const agentEmail = five9?.email || c.agent_email || '';
    if (five9) five9Matched++;

    // Resolve agent name and department from user roles DB
    const agent = resolveAgent(lookup, agentEmail);
    if (agent.department) dbMatched++;

    // Match prospect for address + prospect link
    const prospect = matchProspect(lookup, c.customer_phone_number);

    return {
      id: c.id,
      source_system: 'callrail',
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
      agent_name: agent.name,
      agent_role: agent.role,
      agent_department: agent.department,
      five9_disposition: five9?.disposition || '',
      prospect_id: prospect?.prospect_id || '',
      prospect_address: prospect?.address || '',
      prospect_name: prospect?.name || '',
      transcript: c.transcription,
      call_summary: c.call_summary,
      note: c.note
    };
  });

  console.log(`Five9 matched: ${five9Matched}/${withTranscripts.length}`);
  console.log(`DB role matched: ${dbMatched}/${withTranscripts.length}`);

  // Merge mode
  let finalCalls = calls;
  if (MERGE_MODE && fs.existsSync(OUTPUT_FILE)) {
    console.log('\n--merge: Merging with existing calls.json...');
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      const existingMap = {};
      for (const c of (existing.calls || [])) existingMap[c.id] = c;
      let preserved = 0;
      finalCalls = calls.map(c => {
        const prev = existingMap[c.id];
        if (prev && prev.agent_name && !c.agent_name) {
          preserved++;
          return { ...c, agent_email: prev.agent_email, agent_name: prev.agent_name, agent_role: prev.agent_role, agent_department: prev.agent_department, five9_disposition: prev.five9_disposition };
        }
        return c;
      });
      console.log(`  Preserved agent data for ${preserved} calls`);
    } catch (err) {
      console.warn('  Warning: Could not merge:', err.message);
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    total_calls: allCalls.length,
    calls_with_transcripts: withTranscripts.length,
    calls: finalCalls
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${finalCalls.length} calls to ${OUTPUT_FILE}`);
}

fetchAllCalls().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
