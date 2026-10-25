// Printable proof of delivery: /proof?job=<id>. Uses the signed-in session;
// row-level security decides whether this person may see the job.
import { sb, migrateLegacySession } from './lib/supabase.js';
import { html, escapeHtml } from './lib/dom.js';
import { fullDate } from './lib/format.js';
import { statusLabel } from './lib/jobStatus.js';

migrateLegacySession();
const doc = document.getElementById('doc');
const jobId = new URLSearchParams(location.search).get('job');
document.getElementById('printBtn').addEventListener('click', () => window.print());

function fail(message) {
  doc.innerHTML = html`<h1>Proof of delivery</h1><p>${message}</p>`.value;
}

async function main() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace('/');
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(jobId || '')) return fail('No job was given.');
  document.getElementById('backLink').href = `/app#/jobs/${jobId}`;
  const [{ data: job }, { data: proofs }] = await Promise.all([
    sb.from('jobs').select('*').eq('id', jobId).maybeSingle(),
    sb.from('proofs').select('*').eq('job_id', jobId).order('captured_at', { ascending: false })
  ]);
  if (!job) return fail('This job doesn’t exist, or you don’t have access to it.');
  const p = proofs?.[0];
  if (!p) return fail(`${job.ref} has no proof of delivery yet.`);

  const [org, driver, by, verified, signed] = await Promise.all([
    sb.from('orgs').select('name').eq('id', job.org_id).maybeSingle().then(r => r.data),
    job.driver_id ? sb.from('users').select('name').eq('id', job.driver_id).maybeSingle().then(r => r.data) : null,
    p.created_by ? sb.from('users').select('name').eq('id', p.created_by).maybeSingle().then(r => r.data) : null,
    sb.rpc('verify_proof', { proof: p.id }).then(r => r.data),
    sb.storage.from('chat_media').createSignedUrls([p.photo_path, p.signature_path].filter(Boolean), 3600).then(r => r.data || [])
  ]);
  const url = path => signed.find(s => s.path === path)?.signedUrl;
  document.title = `Proof of delivery ${job.ref} · ${org?.name || 'WAZAMBI'}`;

  doc.innerHTML = html`
    <header class="pd-head">
      <div>
        <div class="pd-org">${org?.name || ''}</div>
        <h1>Proof of delivery</h1>
      </div>
      <div class="pd-ref">${job.ref}</div>
    </header>
    <table class="pd-table">
      <tr><th>Goods</th><td>${job.title}${job.cargo ? ` · ${job.cargo}` : ''}</td></tr>
      ${job.customer_name ? html`<tr><th>Customer</th><td>${job.customer_name}</td></tr>` : ''}
      <tr><th>From</th><td>${job.pickup_name || '—'}</td></tr>
      <tr><th>To</th><td>${job.dropoff_name || '—'}</td></tr>
      <tr><th>Driver</th><td>${driver?.name || '—'}${job.vehicle ? ` · ${job.vehicle}` : ''}</td></tr>
      <tr><th>Received by</th><td><b>${p.receiver_name}</b></td></tr>
      <tr><th>Delivered</th><td>${fullDate(p.captured_at)} (server time)</td></tr>
      ${p.lat != null ? html`<tr><th>Location</th><td>${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}${p.accuracy ? ` (±${Math.round(p.accuracy)} m)` : ''}</td></tr>` : ''}
      ${p.note ? html`<tr><th>Note</th><td>${p.note}</td></tr>` : ''}
      <tr><th>Recorded by</th><td>${by?.name || '—'}</td></tr>
      <tr><th>Job status</th><td>${statusLabel(job.status)}</td></tr>
    </table>
    <div class="pd-media">
      ${url(p.photo_path) ? html`<figure><img src="${url(p.photo_path)}" alt="Photo of the delivered goods"><figcaption>Photo at delivery</figcaption></figure>` : ''}
      ${url(p.signature_path) ? html`<figure><img class="sig" src="${url(p.signature_path)}" alt="Signature of ${p.receiver_name}"><figcaption>Signature of ${p.receiver_name}</figcaption></figure>` : ''}
    </div>
    <section class="pd-seal ${verified ? 'ok' : 'bad'}">
      <b>${verified ? 'Seal intact' : 'Seal does not match'}</b>
      <p>${verified
        ? 'This record has not been changed since it was captured. Each proof is fingerprinted (SHA-256) together with the previous proof, so altering any record breaks the chain.'
        : 'This record differs from the fingerprint taken when it was captured.'}</p>
      <code>${p.hash}</code>
    </section>
    <footer class="pd-foot">Generated ${escapeHtml(fullDate(new Date().toISOString()))} with WAZAMBI</footer>`.value;
  document.getElementById('printBtn').disabled = false;
}

main().catch(err => {
  console.error(err);
  fail('Couldn’t load the proof. Check your connection and reload.');
});

