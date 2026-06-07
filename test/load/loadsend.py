#!/usr/bin/env python3
"""Internal load generator for the NovaMail relay.

Opens CONCURRENCY persistent SMTP submission connections (STARTTLS + AUTH) to the
ingress and sends TOTAL messages as fast as it can. Every message exits via the
relay's configured provider (Mailpit in the test cluster) — the relay never does
direct-to-MX, so nothing leaves the cluster network.

Env: INGRESS, PORT, SMTP_USER, SMTP_PASS, FROM, TO, TOTAL, CONCURRENCY.
"""
import os, ssl, smtplib, threading, time

HOST = os.getenv("INGRESS", "novamail-ingress")
PORT = int(os.getenv("PORT", "587"))
USER = os.getenv("SMTP_USER", "relaytest")
PW = os.getenv("SMTP_PASS", "relaypass")
FROM = os.getenv("FROM", "load@example.com")
TO = os.getenv("TO", "sink@downstream.test")
TOTAL = int(os.getenv("TOTAL", "3000"))
CONC = int(os.getenv("CONCURRENCY", "40"))

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

counter = [0]
errors = [0]
lock = threading.Lock()


def connect():
    s = smtplib.SMTP(HOST, PORT, timeout=30)
    s.starttls(context=ctx)
    s.login(USER, PW)
    return s


def worker(wid):
    try:
        s = connect()
    except Exception as e:
        with lock:
            errors[0] += 1
        print(f"[w{wid}] connect failed: {e}", flush=True)
        return
    while True:
        with lock:
            if counter[0] >= TOTAL:
                break
            counter[0] += 1
            n = counter[0]
        body = f"From: {FROM}\r\nTo: {TO}\r\nSubject: load-{n}\r\n\r\nload test message {n}"
        try:
            s.sendmail(FROM, [TO], body)
        except Exception:
            with lock:
                errors[0] += 1
            try:
                s.quit()
            except Exception:
                pass
            try:
                s = connect()
            except Exception as e:
                print(f"[w{wid}] reconnect failed: {e}", flush=True)
                return
    try:
        s.quit()
    except Exception:
        pass


def main():
    print(f"sending {TOTAL} msgs via {CONC} connections to {HOST}:{PORT} ({FROM} -> {TO})", flush=True)
    t0 = time.time()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(CONC)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    dt = time.time() - t0
    rate = counter[0] / dt if dt > 0 else 0
    print(f"DONE submitted={counter[0]} errors={errors[0]} in {dt:.1f}s = {rate:.0f} msg/s submit rate", flush=True)


if __name__ == "__main__":
    main()
