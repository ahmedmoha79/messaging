"""End-to-end walkthrough of WAZAMBI against the local fake Supabase.

Prereqs (from the repo root):
  test/setup-local.sh
  node test/fake-supabase/server.mjs &
  SUPABASE_URL=http://127.0.0.1:54321 node server.js &
  python3 test/e2e.py [step ...]

Two browser contexts sign in as different users so messages, reactions,
groups and a real WebRTC video call travel between them.
"""
import json
import struct
import sys
import time
import urllib.request
import zlib
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = "http://localhost:3000"
OUT = Path(__file__).resolve().parent.parent / "test-results"
OUT.mkdir(exist_ok=True)
PASSWORD = "correct horse 42"
AHMED = ("ahmed@example.com", "11111111-1111-4111-8111-111111111111")
MUTALE = ("mutale@example.com", "22222222-2222-4222-8222-222222222222")
CHANDA_ID = "33333333-3333-4333-8333-333333333333"

errors = []
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))


def png_bytes(w=640, h=480):
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            row += bytes(((x * 7) % 256, (y * 3) % 256, 140))
        rows.append(bytes(row))
    data = zlib.compress(b"".join(rows), 6)
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", data) + chunk(b"IEND", b"")


def new_page(browser, viewport, mobile=False):
    ctx = browser.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile,
                              permissions=["microphone", "camera", "notifications"])
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"{viewport['width']}: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console {viewport['width']}: {m.text}"))
    page.on("dialog", lambda d: (errors.append(f"DIALOG (possible XSS): {d.message}"), d.dismiss()))
    return ctx, page


def sign_in(page, email):
    page.goto(BASE + "/")
    page.fill("#email", email)
    page.fill("#password", PASSWORD)
    page.click("#submitBtn")
    page.wait_for_url("**/app**", timeout=10000)
    page.wait_for_selector("#chatList .row", timeout=10000)


def main(steps):
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
        ])

        # ------------------------------------------------------------------
        # Sign-in page
        # ------------------------------------------------------------------
        ctx_a, a = new_page(browser, {"width": 1366, "height": 860})
        a.goto(BASE + "/")
        a.wait_for_selector("#authForm")
        a.screenshot(path=str(OUT / "01-signin-desktop.png"))
        a.fill("#email", AHMED[0])
        a.fill("#password", "wrong password")
        a.click("#submitBtn")
        a.wait_for_selector("#formError:not([hidden])")
        check("wrong password shows a helpful error", "don’t match" in a.inner_text("#formError"))
        a.click("#tab-signup")
        check("create-account tab shows name field", a.is_visible("#name"))
        a.click("#tab-signin")
        a.click("#magicLinkBtn")
        check("magic link mode hides password", not a.is_visible("#password"))
        a.click("#usePasswordBtn")

        t0 = time.time()
        sign_in(a, AHMED[0])
        check("sign in lands on chats", "/app" in a.url, a.url)
        print(f"   sign-in to chat list: {time.time() - t0:.2f}s")

        # chat list
        names = a.locator("#chatList .row-name").all_inner_texts()
        check("chat list shows direct chats and group", {"Mutale Banda", "Chanda Phiri", "Kabwe run"} <= set(names), str(names))
        check("unread badge on Chanda", a.locator('#chatList .row[data-key="direct:%s"] .badge' % CHANDA_ID).count() == 1)
        check("tab title shows unread count", a.title().startswith("("), a.title())
        a.screenshot(path=str(OUT / "02-chats-desktop.png"))

        # returning visit goes straight to the app
        a.goto(BASE + "/")
        a.wait_for_url("**/app**", timeout=5000)
        check("returning user skips the sign-in form", "/app" in a.url)
        a.wait_for_selector("#chatList .row")

        # ------------------------------------------------------------------
        # Conversation + XSS
        # ------------------------------------------------------------------
        a.click(f'#chatList .row[data-key="direct:{MUTALE[1]}"]')
        a.wait_for_selector("#conversation .msg")
        bubble_html = a.locator("#conversation .msg").last.inner_html()
        check("message HTML is escaped (no <b>, no <img onerror>)", "<b>this" not in bubble_html and "onerror" not in a.locator("#conversation .messages-inner").evaluate("e => e.querySelector('img[src=x]') ? 'found' : ''"))
        check("links are clickable", a.locator('#conversation .bubble a[href="https://example.com/notes/14"]').count() == 1)
        check("emoji-only message is large", a.locator("#conversation .bubble.emoji").count() >= 1)
        check("existing reaction is shown", a.locator("#conversation .reaction").count() >= 1)
        check("group-less direct chat has call buttons", a.is_visible('[data-act="voice"]') and a.is_visible('[data-act="video"]'))
        a.screenshot(path=str(OUT / "03-conversation-desktop.png"))

        # ------------------------------------------------------------------
        # Second user, realtime messaging
        # ------------------------------------------------------------------
        ctx_b, b = new_page(browser, {"width": 390, "height": 844}, mobile=True)
        sign_in(b, MUTALE[0])
        b.screenshot(path=str(OUT / "04-chats-mobile.png"))
        b.click(f'#chatList .row[data-key="direct:{AHMED[1]}"]')
        b.wait_for_selector("#conversation .msg")
        check("mobile: chat opens full screen without tabs", not b.is_visible(".rail"))

        a.fill(".composer-input", "Test from Ahmed: are you at the depot?")
        a.keyboard.press("Enter")
        b.wait_for_selector("#conversation .bubble-text:has-text(\'Test from Ahmed: are you at the depot?\')", timeout=5000)
        check("message arrives in real time", True)
        # B has it open, so A should see the double-tick turn to read
        a.wait_for_selector("#conversation .msg.out:last-child .meta .read", timeout=5000)
        check("read receipt reaches the sender", True)

        # typing indicator
        b.fill(".composer-input", "typing…")
        b.dispatch_event(".composer-input", "input")
        try:
            a.wait_for_selector("#conversation .typing-row", timeout=4000)
            check("typing indicator shows for the other person", True)
        except Exception:
            check("typing indicator shows for the other person", False)
        b.fill(".composer-input", "Yes, just arrived 🚚")
        b.click('[data-act="primary"]')
        a.wait_for_selector("#conversation .bubble-text:has-text(\'Yes, just arrived\')", timeout=5000)
        check("typing indicator clears when their message lands", a.locator("#conversation .typing-row").count() == 0)

        # reply via menu + reaction
        last_in = a.locator("#conversation .msg.in").last
        last_in.click(button="right")
        a.wait_for_selector(".menu")
        a.locator(".menu-emojis button", has_text="🙏").click()
        b.wait_for_selector("#conversation .reaction:has-text('🙏')", timeout=5000)
        check("reaction syncs to the other person", True)
        last_in.click(button="right")
        a.locator(".menu-item", has_text="Reply").click()
        a.fill(".composer-input", "Perfect, offload at bay 3")
        a.keyboard.press("Enter")
        b.wait_for_selector(".msg .quote:has-text('Yes, just arrived')", timeout=5000)
        check("reply quote shows for the other person", True)

        # photo
        a.set_input_files(".file-input", files=[{"name": "delivery.png", "mimeType": "image/png", "buffer": png_bytes()}])
        a.wait_for_selector(".attach-preview")
        a.fill(".attach-send textarea", "Proof of delivery")
        a.click(".attach-send .send-btn")
        b.wait_for_selector("#conversation .media-img img", timeout=8000)
        loaded = b.wait_for_function("() => { const i = [...document.querySelectorAll('#conversation .media-img img')].pop(); return i && i.complete && i.naturalWidth > 0; }", timeout=8000)
        check("photo uploads and shows for the other person", bool(loaded))
        b.screenshot(path=str(OUT / "05-conversation-mobile.png"))

        # file
        a.set_input_files(".file-input", files=[{"name": "manifest.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.4 test"}])
        a.click(".attach-send .send-btn")
        b.wait_for_selector(".file-card:has-text('manifest.pdf')", timeout=8000)
        check("files send with name and size", True)

        # voice note (Chromium's fake microphone plays a tone)
        a.click('[data-act="primary"]')  # empty composer: mic button
        a.wait_for_selector(".recorder:not([hidden])", timeout=4000)
        time.sleep(2.2)
        a.click('[data-act="primary"]')  # now the send button
        b.wait_for_selector("#conversation .voice", timeout=8000)
        dur = b.locator("#conversation .voice .voice-time").last.inner_text()
        check("voice note records, uploads and arrives", dur in ("0:02", "0:03"), dur)
        b.locator("#conversation .voice .voice-play").last.click()
        playing = b.wait_for_function("() => [...document.querySelectorAll('#conversation .voice-play')].some(x => /Pause/.test(x.getAttribute('aria-label')))", timeout=5000)
        check("voice note plays", bool(playing))

        # offline outbox: send while offline, it goes out on reconnect
        ctx_a.set_offline(True)
        a.evaluate("() => window.dispatchEvent(new Event('offline'))")
        a.fill(".composer-input", "Sent while offline")
        a.keyboard.press("Enter")
        a.wait_for_selector("#conversation .msg.out:last-child .meta [title='Waiting for connection'], #conversation .msg.out:last-child .meta [title='Sending']", timeout=4000)
        check("offline banner shows", a.is_visible("#netBanner"))
        ctx_a.set_offline(False)
        a.evaluate("() => window.dispatchEvent(new Event('online'))")
        b.wait_for_selector("#conversation .bubble-text:has-text('Sent while offline')", timeout=8000)
        check("queued message sends after reconnecting", True)

        # ------------------------------------------------------------------
        # Group
        # ------------------------------------------------------------------
        a.click("#newGroupBtn")
        a.wait_for_selector(".sheet .people-search")
        a.fill(".sheet .input", "Night shift")
        a.click(f'.sheet .row[data-user="{MUTALE[1]}"]')
        a.click(f'.sheet .row[data-user="{CHANDA_ID}"]')
        a.click(".sheet [data-create]")
        a.wait_for_url("**#/chat/g/**", timeout=5000)
        a.wait_for_selector(".convo-name:has-text('Night shift')")
        a.fill(".composer-input", "Welcome to the night shift group")
        a.keyboard.press("Enter")
        b.click('a.back')
        b.wait_for_selector("#chatList .row-name:has-text('Night shift')", timeout=6000)
        check("new group appears for members in real time", True)
        b.click("#chatList .row:has-text('Night shift')")
        b.wait_for_selector("#conversation .bubble-text:has-text(\'Welcome to the night shift group\')")
        check("group message visible to members, with sender name", b.locator(".msg-sender").count() >= 1)
        a.screenshot(path=str(OUT / "06-group-desktop.png"))
        b.click("a.back")

        # ------------------------------------------------------------------
        # Video call A -> B
        # ------------------------------------------------------------------
        a.goto(BASE + f"/app#/chat/u/{MUTALE[1]}")
        a.wait_for_selector("#conversation .msg")
        a.click('[data-act="video"]')
        b.wait_for_selector(".call [data-call='accept']", timeout=8000)
        check("incoming call rings on the other device", True)
        time.sleep(0.5)
        b.screenshot(path=str(OUT / "07-incoming-call-mobile.png"))
        b.click(".call [data-call='accept']")
        connected = False
        try:
            a.wait_for_function("() => /^\\d+:\\d\\d$/.test(document.querySelector('.call-state')?.textContent || '')", timeout=15000)
            b.wait_for_function("() => /^\\d+:\\d\\d$/.test(document.querySelector('.call-state')?.textContent || '')", timeout=15000)
            connected = True
        except Exception as e:
            print("   call state A:", a.locator(".call-state").inner_text() if a.locator(".call-state").count() else None)
            print("   call state B:", b.locator(".call-state").inner_text() if b.locator(".call-state").count() else None)
        check("video call connects peer to peer", connected)
        time.sleep(2.5)
        video_ok = a.evaluate("() => { const v = document.querySelector('.call-remote-video'); return !!v && !v.hidden && v.videoWidth > 0; }")
        check("remote video is playing", video_ok)
        a.screenshot(path=str(OUT / "08-video-call-desktop.png"))
        b.click(".call [data-call='mute']")
        a.wait_for_selector(".call-quality:has-text('is muted')", timeout=4000)
        check("mute state shows to the other person", True)
        a.click(".call [data-call='hangup']")
        b.wait_for_selector(".call", state="detached", timeout=6000)
        check("hanging up ends the call on both sides", True)

        # declined voice call + history
        a.click('[data-act="voice"]')
        b.wait_for_selector(".call [data-call='decline']", timeout=8000)
        b.click(".call [data-call='decline']")
        a.wait_for_selector(".call-state:has-text('declined')", timeout=6000)
        check("declined call tells the caller", True)
        a.wait_for_selector(".call", state="detached", timeout=6000)
        a.goto(BASE + "/app#/calls")
        a.wait_for_selector("#callList .call-row", timeout=6000)
        check("call history lists calls", a.locator("#callList .call-row").count() >= 2)
        a.screenshot(path=str(OUT / "09-calls-desktop.png"))

        # ------------------------------------------------------------------
        # Map, settings, profile, dark mode
        # ------------------------------------------------------------------
        a.goto(BASE + "/app#/map")
        a.wait_for_selector("#mapCanvas .stub-marker", timeout=8000)
        check("map shows teammates sharing location", a.locator("#mapCanvas .stub-marker").count() >= 1)
        a.goto(BASE + "/app#/settings")
        a.wait_for_selector(".settings-me")
        a.click('[data-theme-choice="dark"]')
        a.screenshot(path=str(OUT / "10-settings-dark.png"))
        a.goto(BASE + f"/app#/chat/u/{MUTALE[1]}")
        a.wait_for_selector("#conversation .msg")
        a.screenshot(path=str(OUT / "11-conversation-dark.png"))
        a.click(".convo-who")
        a.wait_for_selector(".profile .profile-stats")
        check("profile shows bio and follow stats", "Night dispatch" in a.inner_text(".profile"))
        time.sleep(0.4)
        a.screenshot(path=str(OUT / "12-profile-dark.png"))
        a.keyboard.press("Escape")

        # performance snapshot (cached second load)
        a.goto(BASE + "/app#/chats")
        a.wait_for_selector("#chatList .row")
        t = a.evaluate("() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), bytes: performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), 0) + (n.transferSize || 0) }; }")
        print("   repeat load:", t)

        with urllib.request.urlopen("http://127.0.0.1:54321/fake/state") as r:
            print("   backend:", json.loads(r.read())["messages"], "messages")

        browser.close()

    print("\nConsole/page errors:" if errors else "\nNo console or page errors.")
    for e in errors:
        print("  ", e)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed or any("DIALOG" in e for e in errors) else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
