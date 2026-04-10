#!/usr/bin/env node
// Build user lookup JSON from dbo.user + dbo.user_role + dbo.role
// Maps email → { name, role, department }
// Also builds Five9 phone→agent and Zoom department→agent lookups

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PG_CONN = "host=192.168.0.229 port=5432 dbname=rebuilt_prod user=postgres";
const PG_PASS = 'XvcfdCh6M5QeeVn8bWGcBjXeSmrRqXcs';
const OUTPUT_FILE = path.join(__dirname, 'user-lookup.json');

function psql(sql) {
  return execSync(
    `PGPASSWORD='${PG_PASS}' /opt/homebrew/bin/psql "${PG_CONN}" -t -A -F '|' -c "${sql.replace(/\n/g, ' ')}"`,
    { encoding: 'utf-8', timeout: 120000, maxBuffer: 100 * 1024 * 1024 }
  ).trim();
}

function buildUserRoles() {
  console.log('Building user→role lookup from dbo.user + user_role...');
  const result = psql(`
    SELECT u.email, TRIM(u.first_name || ' ' || u.last_name) as name, r.role, u.status
    FROM dbo."user" u
    JOIN dbo.user_role ur ON ur.user_id = u.id
    JOIN dbo.role r ON r.id = ur.role_id
    ORDER BY u.email
  `);

  const users = {};
  for (const line of result.split('\n')) {
    if (!line) continue;
    const [email, name, role, status] = line.split('|');
    if (!email) continue;
    const dept = /acquisition|inside sales/i.test(role) ? 'acquisition'
      : /disposition|associate sales/i.test(role) ? 'disposition'
      : 'other';
    // Keep the most specific role if user has multiple
    if (!users[email] || (dept !== 'other' && users[email].department === 'other')) {
      users[email] = { name: name || email.split('@')[0], role, department: dept, active: status === '1' || status === 'active' };
    }
  }
  console.log(`  ${Object.keys(users).length} users with roles`);
  return users;
}

function buildFive9CallLookup() {
  console.log('Building Five9 phone→agent lookup (last 90 days)...');
  const result = psql(`
    SELECT ani, agent_email, agent, disposition, call_timestamp
    FROM salmar.five9_call_data
    WHERE agent IS NOT NULL AND agent != '[None]'
      AND agent_email IS NOT NULL AND agent_email != ''
      AND talk_time > '00:01:00'
      AND call_date >= CURRENT_DATE - INTERVAL '90 days'
  `);

  const lookup = {};
  for (const line of result.split('\n')) {
    if (!line) continue;
    const [ani, agentEmail, agentName, disposition, timestamp] = line.split('|');
    if (!ani || ani.length < 10) continue;
    const phone = ani.replace(/\D/g, '').slice(-10);
    if (!lookup[phone]) lookup[phone] = [];
    lookup[phone].push({ email: agentEmail, name: agentName, disposition, ts: timestamp });
  }
  console.log(`  ${Object.keys(lookup).length} unique phones from Five9`);
  return lookup;
}

function buildCallRailAgentLookup() {
  console.log('Building CallRail call_id→agent lookup (last 90 days)...');
  const result = psql(`
    SELECT id, agent_email
    FROM salmar.callrail_api_data_hist
    WHERE agent_email IS NOT NULL AND agent_email != ''
      AND start_time >= NOW() - INTERVAL '90 days'
  `);

  const lookup = {};
  for (const line of result.split('\n')) {
    if (!line) continue;
    const [id, email] = line.split('|');
    if (id && email) lookup[id] = email;
  }
  console.log(`  ${Object.keys(lookup).length} CallRail calls with agent_email`);
  return lookup;
}

function buildZoomAgentLookup() {
  console.log('Building Zoom caller/callee→agent lookup (last 90 days)...');
  const result = psql(`
    SELECT caller_number, callee_number, department, direction, date_time,
           caller_number_type, callee_number_type, result
    FROM salmar.zoom_call_logs
    WHERE department IS NOT NULL AND department != ''
      AND date_time >= NOW() - INTERVAL '90 days'
      AND duration > 60
  `);

  const lookup = {};
  let internalCount = 0;
  for (const line of result.split('\n')) {
    if (!line) continue;
    const [callerNum, calleeNum, dept, dir, dateTime, callerType, calleeType, callResult] = line.split('|');
    const isInternal = callerType === '1' && calleeType === '1';
    if (isInternal) internalCount++;
    const callerPhone = (callerNum || '').replace(/\D/g, '').slice(-10);
    const calleePhone = (calleeNum || '').replace(/\D/g, '').slice(-10);
    const key = callerPhone + '_' + calleePhone;
    if (!lookup[key]) lookup[key] = [];
    lookup[key].push({ email: dept, ts: dateTime, internal: isInternal, result: callResult });
  }
  console.log(`  ${Object.keys(lookup).length} unique call pairs, ${internalCount} internal`);
  return lookup;
}

function buildProspectPhoneLookup() {
  console.log('Building phone→prospect lookup (Five9 attom_id → prospect)...');
  const result = psql(`
    SELECT f.ani,
           f.property_address || ', ' || f.property_city || ', ' || f.property_state as address,
           p.id as prospect_id, p.as_name, f.attom_id
    FROM salmar.five9_call_data f
    JOIN dbo.prospect_property_registry ppr ON ppr.attom_id = f.attom_id
    JOIN dbo.prospect p ON p.id = ppr.id
    WHERE f.property_address IS NOT NULL AND f.property_address != '' AND f.property_address != '[None]'
      AND f.call_date >= CURRENT_DATE - INTERVAL '90 days'
  `);

  // Build lookup: phone (last 10 digits) → [{prospect_id, address, name, attom_id}]
  const lookup = {};
  for (const line of result.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    const [ani, address, prospectId, name, attomId] = parts;
    if (!ani || ani.length < 10) continue;
    const phone = ani.replace(/\D/g, '').slice(-10);
    if (!lookup[phone]) lookup[phone] = [];
    // Avoid duplicates
    if (!lookup[phone].some(p => p.prospect_id === prospectId)) {
      lookup[phone].push({ prospect_id: prospectId, address, name: name || '', attom_id: attomId });
    }
  }
  console.log(`  ${Object.keys(lookup).length} unique phones with prospect links`);
  return lookup;
}

// Main
console.log('=== Building user lookup for call dashboard ===\n');

const userRoles = buildUserRoles();
const five9Lookup = buildFive9CallLookup();
const callrailLookup = buildCallRailAgentLookup();
const zoomLookup = buildZoomAgentLookup();
const prospectLookup = buildProspectPhoneLookup();

const output = {
  generated_at: new Date().toISOString(),
  users: userRoles,
  five9_phone_lookup: five9Lookup,
  callrail_agent_lookup: callrailLookup,
  zoom_call_lookup: zoomLookup,
  prospect_phone_lookup: prospectLookup
};

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);
console.log(`\nSaved ${sizeMB}MB to ${OUTPUT_FILE}`);
