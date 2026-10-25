"""Cross-device calls (with a phone whose live connection died) and the
jobs flow: create, driver progress, proof of delivery, tracking page, invite.
Run with: TEST=test/e2e_calls_jobs.py test/run-local.sh"""
import json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
FAKE = "http://127.0.0.1:54321"
AHMED = "11111111-1111-4111-8111-111111111111"
MUTALE = "22222222-2222-4222-8222-222222222222"
CHANDA = "33333333-3333-4333-8333-333333333333"
PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
results = []
errors = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  ({detail})"))


def backend():
    return json.load(urllib.request.urlopen(FAKE + "/fake/state"))


def last_call():
    calls = backend()["calls"]
    return calls[-1] if calls else None


def open_as(br, email, phone=False):
    kw = dict(permissions=["microphone", "camera", "geolocation"], geolocation={"latitude": -12.97, "longitude": 28.63})
    if phone:
        kw.update(user_agent=PHONE_UA, viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx = br.new_context(**kw)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"{email}: {e}"))
    pg.goto(BASE + "/")
    pg.fill("#email", email)
    pg.fill("#password", "correct horse 42")
    pg.click("#submitBtn")
    pg.wait_for_selector("#chatList .row", timeout=15000)
    pg.wait_for_timeout(400)
    return ctx, pg


def dial(pg, who):
    pg.goto(BASE + f"/app#/chat/u/{who}")
    pg.wait_for_selector("#conversation .composer")
    pg.click('#conversation [data-act="voice"]')
    pg.wait_for_selector(".call-state:has-text('Ringing'), .call-state:has-text('Calling')", timeout=8000)


def incoming(pg, timeout):
    try:
        pg.wait_for_selector(".call [data-call='accept']", timeout=timeout)
        return True
    except Exception:
        return False


def gone(pg, timeout):
    try:
        pg.wait_for_selector(".call", state="detached", timeout=timeout)
        return True
    except Exception:
        return False


def freeze(pg):
    pg.evaluate("window.__fakeRealtime.freeze()")


def wait_status(want, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        c = last_call()
        if c and c["status"] in want:
            return c
        time.sleep(0.2)
    return last_call()


with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    pc_ctx, pc = open_as(br, "ahmed@example.com")
    ph_ctx, ph = open_as(br, "mutale@example.com", phone=True)

    # ------------------------------------------------------------------
    # 1. The bug report: decline on the PC while the phone's connection is dead
    # ------------------------------------------------------------------
    freeze(ph)  # the phone's socket "looks" open but delivers nothing
    dial(ph, AHMED)
    check("PC rings for a call from the phone", incoming(pc, 6000))
    nudges = [n for n in backend()["nudges"] if n["topic"] == f"inbox:{AHMED}"]
    check("caller also nudges the callee's inbox over REST", len(nudges) >= 1, nudges)
    t0 = time.time()
    pc.click(".call [data-call='decline']")
    row = wait_status({"declined"})
    check("decline is stored as 'declined'", row["status"] == "declined", row)
    check("server sets ended_at (not the device clock)", row["ended_at"] and row["ended_at"] >= row["created_at"], row)
    stopped = gone(ph, 6000)
    check("phone stops ringing after the PC declines, even with a dead live connection", stopped)
    print(f"   phone noticed the decline after {time.time() - t0:.1f}s")
    ph.evaluate("window.__fakeRealtime.restore()")
    ph.goto(BASE + "/app#/chats"); ph.reload(); ph.wait_for_selector("#chatList .row")
    pc.wait_for_timeout(500)

    # ------------------------------------------------------------------
    # 2. PC calls the phone while the phone's connection is dead
    # ------------------------------------------------------------------
    freeze(ph)
    t0 = time.time()
    dial(pc, MUTALE)
    rang = incoming(ph, 12000)
    check("phone with a dead connection still rings (safety-net check)", rang)
    print(f"   phone rang after {time.time() - t0:.1f}s")
    # the phone's caller hangs up: the frozen phone must stop ringing
    t0 = time.time()
    pc.click(".call [data-call='hangup']")
    row = wait_status({"cancelled", "missed"})
    check("caller hanging up marks the call cancelled", row["status"] in ("cancelled", "missed"), row)
    check("frozen phone stops ringing when the caller hangs up", gone(ph, 6000))
    print(f"   phone stopped after {time.time() - t0:.1f}s")

    # ------------------------------------------------------------------
    # 3. Phone comes back to the foreground: rings immediately
    # ------------------------------------------------------------------
    ph.evaluate("window.__fakeRealtime.restore()")
    ph.goto(BASE + "/app#/chats"); ph.reload(); ph.wait_for_selector("#chatList .row")
    freeze(ph)
    ph.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
                           document.dispatchEvent(new Event('visibilitychange')); }""")
    dial(pc, MUTALE)
    pc.wait_for_timeout(300)
    t0 = time.time()
    ph.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
                           document.dispatchEvent(new Event('visibilitychange')); }""")
    check("waking the phone shows the ringing call at once", incoming(ph, 2500), f"{time.time() - t0:.1f}s")
    # answer on the phone: both sides connect
    ph.evaluate("window.__fakeRealtime.restore()")
    ph.click(".call [data-call='accept']")
    row = wait_status({"accepted"})
    check("answering stores 'accepted' with a server answered_at", row["status"] == "accepted" and row["answered_at"], row)
    try:
        pc.wait_for_function("() => /Connecting|\\d:\\d\\d/.test(document.querySelector('.call .call-state')?.textContent || '')", timeout=6000)
        ok = True
    except Exception:
        ok = False
    check("caller sees the call answered", ok)
    try:
        pc.wait_for_function("() => /\\d:\\d\\d/.test(document.querySelector('.call .call-state')?.textContent || '')", timeout=10000)
        connected = True
    except Exception:
        connected = False
    check("audio connects between the two devices (WebRTC)", connected, pc.inner_text(".call .call-state"))
    pc.wait_for_timeout(1500)
    pc.click(".call [data-call='hangup']")
    row = wait_status({"ended"})
    check("hanging up ends the call for both", row["status"] == "ended" and gone(ph, 6000), row)

    # ------------------------------------------------------------------
    # 4. Detected drop: the watchdog rebuilds the connection
    # ------------------------------------------------------------------
    gone(pc, 3000)
    ph.evaluate("window.__fakeRealtime.drop()")
    ph.wait_for_timeout(1500)
    ph.evaluate("window.__fakeRealtime.restore()")
    ph.wait_for_timeout(11000)  # one watchdog tick
    healthy = ph.evaluate("""() => import('/js/app/realtime.js').then(m => m.realtimeHealthy())""")
    check("watchdog reconnects after the socket drops", healthy)
    dial(pc, MUTALE)
    check("reconnected phone rings straight away", incoming(ph, 3000))
    ph.click(".call [data-call='decline']")
    check("PC stops ringing when the phone declines", gone(pc, 4000))

    # ------------------------------------------------------------------
    # 5. A finished call can't be revived; only the callee can answer
    # ------------------------------------------------------------------
    c = last_call()
    r = pc.evaluate("""async id => { const { sb } = await import('/js/lib/supabase.js');
        await sb.from('calls').update({ status: 'accepted' }).eq('id', id); return (await sb.rpc('call_state', { call_id: id })).data.status; }""", c["id"])
    check("a declined call stays declined", r == "declined", r)
    pc_ctx.close(); ph_ctx.close()

    # ------------------------------------------------------------------
    # 6. Jobs: dispatcher creates, driver moves it along, proof, tracking
    # ------------------------------------------------------------------
    d_ctx, d = open_as(br, "mutale@example.com")             # dispatcher
    v_ctx, v = open_as(br, "chanda@example.com", phone=True)  # driver
    d.goto(BASE + "/app#/jobs"); d.wait_for_selector("#jobList")
    d.click("#newJobBtn")
    d.wait_for_selector(".sheet [name='title']")
    d.fill(".sheet [name='title']", "30 t copper cathodes")
    d.fill(".sheet [name='customer_name']", "Lubumbashi Metals")
    d.fill(".sheet [name='pickup_name']", "Kitwe depot")
    d.fill(".sheet [name='dropoff_name']", "Lubumbashi yard")
    d.select_option(".sheet [name='driver_id']", CHANDA)
    d.fill(".sheet [name='vehicle']", "ALB 1234")
    d.click(".sheet button[type='submit']")
    d.wait_for_selector(".job-head:has-text('J-0001'), #jobView:has-text('J-0001')", timeout=8000)
    check("dispatcher creates job J-0001", True)
    d.screenshot(path="test-results/20-job-created.png")
    job = backend()["jobs"][0]
    check("job is assigned to the driver with a tracking token", job["driver_id"] == CHANDA and len(job["track_token"]) == 32, job)

    # driver sees it live and moves it along
    v.goto(BASE + "/app#/jobs")
    try:
        v.wait_for_selector("#jobList :text('30 t copper cathodes')", timeout=6000)
        ok = True
    except Exception:
        ok = False
    check("driver sees the new job", ok)
    v.goto(BASE + f"/app#/jobs/{job['id']}")
    for label in ["Start loading", "Leave for delivery", "Arrived at drop-off"]:
        v.wait_for_selector(f"[data-job='next']:has-text('{label}')", timeout=6000)
        v.click("[data-job='next']")
        v.wait_for_timeout(600)
    statuses = [e["status"] for e in backend()["job_events"] if e["kind"] == "status"]
    check("driver's steps land in the timeline", statuses[:3] == ["loading", "in_transit", "arrived"], statuses)
    try:
        d.wait_for_selector("#jobView .pill:has-text('Arrived'), #jobView :text('Arrived')", timeout=5000)
        ok = True
    except Exception:
        ok = False
    check("dispatcher's open job updates live", ok)

    # proof of delivery with a signature
    v.wait_for_selector("[data-job='next']:has-text('Capture proof')")
    v.click("[data-job='next']")
    v.wait_for_selector(".sheet [name='receiver']")
    v.fill(".sheet [name='receiver']", "Jean Kabila")
    box = v.locator(".sheet .sig-pad").bounding_box()
    v.mouse.move(box["x"] + 20, box["y"] + 40); v.mouse.down()
    for i in range(12):
        v.mouse.move(box["x"] + 20 + i * 15, box["y"] + 40 + (i % 3) * 12)
    v.mouse.up()
    v.click(".sheet button[type='submit']")
    v.wait_for_selector(".toast:has-text('Proof sealed')", timeout=8000)
    st = backend()
    pr = st["proofs"][0] if st["proofs"] else {}
    check("proof is sealed with a hash and signature", pr.get("hash") and pr.get("signature_path"), pr)
    check("job becomes delivered", st["jobs"][0]["status"] == "delivered", st["jobs"][0]["status"])
    v.wait_for_selector("#jobView .proof-card, #jobView :text('Seal intact'), #jobView :text('Jean Kabila')", timeout=6000)
    v.screenshot(path="test-results/21-job-delivered-phone.png")

    # printable proof page
    d.goto(BASE + f"/proof?job={job['id']}")
    d.wait_for_selector(".pd-seal", timeout=8000)
    check("printable proof shows receiver and intact seal", "Jean Kabila" in d.inner_text("#doc") and "Seal intact" in d.inner_text(".pd-seal"))
    d.screenshot(path="test-results/22-proof-pdf.png", full_page=True)

    # public tracking page (no account)
    anon = br.new_context(viewport={"width": 390, "height": 844})
    t = anon.new_page()
    t.on("pageerror", lambda e: errors.append(f"track: {e}"))
    t.goto(BASE + f"/t/{job['track_token']}")
    t.wait_for_selector(".t-hero h1", timeout=8000)
    check("tracking page works without an account", "Delivered" in t.inner_text(".t-hero h1"), t.inner_text(".t-hero h1"))
    check("tracking page shows the proof receiver", "Jean Kabila" in t.inner_text("#track"))
    t.fill(".t-form [name='name']", "Jean")
    t.fill(".t-form textarea", "Thanks, all received in good order.")
    t.click(".t-form button[type='submit']")
    t.wait_for_selector(".t-msg:has-text('all received')", timeout=6000)
    msgs = [e for e in backend()["job_events"] if e["kind"] == "customer_message"]
    check("customer message reaches the job timeline", len(msgs) == 1 and msgs[0]["meta"]["name"] == "Jean", msgs)
    t.screenshot(path="test-results/23-tracking-page.png", full_page=True)
    t.goto(BASE + "/t/" + "0" * 32)
    t.wait_for_selector(".track-empty")
    check("unknown tracking token shows 'not active'", "isn’t active" in t.inner_text(".track-empty"))
    anon.close()

    # invite link redirect
    r = urllib.request.Request(BASE + "/join/cbh12345", method="GET")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    try:
        urllib.request.build_opener(NoRedirect).open(r)
        loc = None
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
    check("/join/<code> redirects into the app", loc == "/app#/join/CBH12345", loc)
    d_ctx.close(); v_ctx.close()
    br.close()

print()
if errors:
    print("Page errors:")
    for e in errors:
        print("  ", e)
print(f"{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) and not errors else 1)
