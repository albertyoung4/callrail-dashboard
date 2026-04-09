#!/usr/bin/env node

const API_KEY = process.env.CALLRAIL_API_KEY || '423a387918c39793960b61d688bed5cc';
const ACCOUNT_ID = 'ACC925c6f152a33426b9f3767406aab6621';
const BASE_URL = `https://api.callrail.com/v3/a/${ACCOUNT_ID}`;
const fs = require('fs');
const path = require('path');

const FIELDS = [
  'duration', 'start_time', 'direction', 'customer_phone_number', 'customer_name',
  'transcription', 'call_summary', 'source', 'recording', 'note', 'business_phone_number',
  'tracking_phone_number', 'voicemail', 'lead_score', 'lead_explanation',
  'formatted_duration', 'customer_city', 'customer_state', 'agent_email'
].join(',');

async function fetchAllCalls() {
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

  const output = {
    generated_at: new Date().toISOString(),
    total_calls: allCalls.length,
    calls_with_transcripts: withTranscripts.length,
    calls: withTranscripts.map(c => ({
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
      agent_email: c.agent_email,
      transcript: c.transcription,
      call_summary: c.call_summary,
      note: c.note
    }))
  };

  const outPath = path.join(__dirname, 'calls.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

fetchAllCalls().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
