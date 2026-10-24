"""Checks for the microphone diagnosis and the password-reset flow.
Run after test/setup-local.sh with the fake backend and app server up
(test/run-local.sh starts them; this file can be run the same way)."""
import sys, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
AHMED = "11111111-1111-4111-8111-111111111111"
MUTALE = "22222222-2222-4222-8222-222222222222"
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  ({detail})"))

ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"

def signed_in(br, init=None, **kw):
    ctx = br.new_context(permissions=["microphone", "camera"], **kw)
    if init:
        ctx.add_init_script(init)
    pg = ctx.new_page()
    pg.goto(BASE + "/"); pg.fill("#email", "ahmed@example.com"); pg.fill("#password", "correct horse 42"); pg.click("#submitBtn")
    pg.wait_for_selector("#chatList .row")
    return ctx, pg

with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])

    # 1. Site permission says "granted" but the OS blocks the browser (Android)
    ctx, pg = signed_in(br, init="""
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied by system', 'NotAllowedError'));
    """, user_agent=ANDROID_UA)
    pg.goto(BASE + f"/app#/chat/u/{MUTALE}"); pg.wait_for_selector("#conversation .msg")
    pg.click('[data-act="voice"]')
    pg.wait_for_selector(".sheet .confirm", timeout=5000)
    title = pg.inner_text(".sheet-head h2"); text = pg.inner_text(".sheet .confirm p")
    check("system-blocked mic gets its own explanation", "blocked by your device" in title, title)
    check("Android users are told where to fix it", "Settings → Apps → Chrome → Permissions → Microphone" in text, text)
    pg.screenshot(path="test-results/13-mic-blocked-by-device.png")
    ctx.close()

    # 2. Mic blocked for the site
    ctx, pg = signed_in(br, init="""
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = d => d.name === 'microphone' ? Promise.resolve({ state: 'denied' }) : q(d);
    """)
    pg.goto(BASE + f"/app#/chat/u/{MUTALE}"); pg.wait_for_selector("#conversation .msg")
    pg.click('[data-act="primary"]')  # voice note
    pg.wait_for_selector(".sheet .confirm", timeout=5000)
    check("site-blocked mic explains the address-bar fix", "Permissions" in pg.inner_text(".sheet .confirm p") and "not allowed" in pg.inner_text(".sheet-head h2"))
    ctx.close()

    # 3. Camera blocked, microphone fine: a video call continues as voice
    ctx, pg = signed_in(br, init="""
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = c => c && c.video ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : real(c);
    """)
    pg.goto(BASE + f"/app#/chat/u/{MUTALE}"); pg.wait_for_selector("#conversation .msg")
    pg.click('[data-act="video"]')
    pg.wait_for_selector(".toast:has-text('Continuing with voice only')", timeout=6000)
    rings = pg.wait_for_selector(".call-state:has-text('Calling'), .call-state:has-text('Ringing')", timeout=6000)
    check("blocked camera falls back to a voice call", bool(rings))
    pg.click(".call [data-call='hangup']")
    # settings check tool
    pg.goto(BASE + "/app#/settings"); pg.wait_for_selector(".settings-me")
    pg.click('[data-s="media-check"]')
    pg.wait_for_selector(".sheet .media-summary", timeout=8000)
    check("Settings check reports mic working, camera blocked", "working" in pg.inner_text(".sheet") and "Video calls will continue as voice calls" in pg.inner_text(".sheet"))
    pg.screenshot(path="test-results/14-media-check.png")
    ctx.close()

    # 4. Password reset: request uses a link without a second '#'
    ctx = br.new_context(); pg = ctx.new_page()
    pg.goto(BASE + "/"); pg.click("#forgotBtn"); pg.fill("#email", "ahmed@example.com"); pg.click("#submitBtn")
    pg.wait_for_selector("#authDone:not([hidden])")
    redirect = pg.evaluate("() => window.__lastReset && window.__lastReset.redirectTo")
    check("reset email returns to /?mode=reset-password (no extra #)", redirect and redirect.endswith("/?mode=reset-password") and "#" not in redirect, redirect)
    ctx.close()

    # 5. Opening the reset link (implicit flow) shows the new-password screen
    ctx = br.new_context(); pg = ctx.new_page()
    pg.goto(BASE + f"/?mode=reset-password#access_token={AHMED}:token&type=recovery")
    pg.wait_for_selector("#confirmPassword", state="visible", timeout=5000)
    check("reset link opens 'Set a new password'", pg.inner_text("#authTitle") == "Set a new password")
    check("email field is hidden while setting a new password", not pg.is_visible("#email"))
    pg.screenshot(path="test-results/15-set-new-password.png")
    pg.fill("#password", "new strong phrase 77"); pg.fill("#confirmPassword", "different one 77"); pg.click("#submitBtn")
    check("mismatched passwords are caught", "don’t match" in pg.inner_text("#formError"))
    pg.fill("#confirmPassword", "new strong phrase 77"); pg.click("#submitBtn")
    pg.wait_for_url("**/app**", timeout=6000)
    check("saving the new password opens the app", "/app" in pg.url)
    ctx.close()

    # 6. Reset link that Supabase sent to the app (old emails / Site URL = /app)
    ctx = br.new_context(); pg = ctx.new_page()
    pg.goto(BASE + f"/app#access_token={AHMED}:token&type=recovery")
    pg.wait_for_url("**/?mode=reset-password", timeout=6000)
    pg.wait_for_selector("#confirmPassword", state="visible", timeout=5000)
    check("reset link landing on /app is redirected to the new-password screen", True)
    ctx.close()

    # 7. token_hash style links, and an expired one
    ctx = br.new_context(); pg = ctx.new_page()
    pg.goto(BASE + f"/?token_hash={AHMED}&type=recovery")
    pg.wait_for_selector("#confirmPassword", state="visible", timeout=5000)
    check("token_hash reset links work", True)
    ctx.close()
    ctx = br.new_context(); pg = ctx.new_page()
    pg.goto(BASE + "/?token_hash=expired&type=recovery")
    pg.wait_for_selector("#formError:not([hidden])", timeout=5000)
    check("expired reset link explains and offers a new one", "expired" in pg.inner_text("#formError") and pg.inner_text("#authTitle") == "Reset your password")
    ctx.close()
    br.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
