#!/usr/bin/env python3
"""Gina RAG architecture map -> assets/gina-rag-architecture.svg

Original diagram. Every number on it comes from a measurement in this repo
(2026-11-14): offline suite, `pnpm eval`, `scripts/live-check.ts` (sf CLI
transport) and the blind injection corpus v2 (5 runs).

Run:  python3 design/architecture/build_architecture.py
PNG:  node design/architecture/render_png.mjs   (headless Chrome, 2x)
"""
from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "gina-rag-architecture.svg"

W, H = 2000, 1660

# ---- tokens ---------------------------------------------------------------
BG = "#0F172A"
GRID = "#1A2540"
CARD = "#131D33"
CARD_LINE = "#2B3A55"
INK = "#F1F5F9"
TEXT = "#CBD5E1"
MUTED = "#8C9AB3"
LIME = "#A3E635"
CYAN = "#7DD3FC"
RED = "#F87171"
AMBER = "#FBBF24"
SANS = "'Plus Jakarta Sans', 'Inter', 'Helvetica Neue', Arial, sans-serif"
MONO = "'JetBrains Mono', 'SF Mono', Menlo, monospace"

# ---- Lucide-style icons (24x24, stroke) -----------------------------------
ICONS = {
    "cloud": '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    "clipboard": '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    "lock": '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "file": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/>',
    "shield": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    "shieldok": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    "layers": '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    "user": '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "filecheck": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    "key": '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
    "refresh": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    "eraser": '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    "eyeoff": '<path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>',
    "bot": '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    "usercheck": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
    "branch": '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    "scroll": '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    "activity": '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    "x": '<path d="M2.59 16.73A2 2 0 0 1 2 15.31V8.69a2 2 0 0 1 .59-1.41l4.69-4.69A2 2 0 0 1 8.69 2h6.62a2 2 0 0 1 1.41.59l4.69 4.69A2 2 0 0 1 22 8.69v6.62a2 2 0 0 1-.59 1.41l-4.69 4.69a2 2 0 0 1-1.41.59H8.69a2 2 0 0 1-1.41-.59z"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
}

out: list[str] = []
add = out.append


def t(x, y, s, size=15, fill=TEXT, weight=400, family=SANS, anchor="start", ls=0, extra=""):
    add(
        f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
        f'fill="{fill}" text-anchor="{anchor}" letter-spacing="{ls}" {extra}>{escape(s)}</text>'
    )


def icon(name, x, y, size=24, color=INK, sw=1.75):
    s = size / 24
    add(
        f'<g transform="translate({x} {y}) scale({s})" fill="none" stroke="{color}" '
        f'stroke-width="{sw / s:.2f}" stroke-linecap="round" stroke-linejoin="round">{ICONS[name]}</g>'
    )


def rect(x, y, w, h, rx=14, fill=CARD, stroke=CARD_LINE, sw=1.25, dash=None, opacity=1):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" fill-opacity="{opacity}" '
        f'stroke="{stroke}" stroke-width="{sw}"{d}/>'
    )


def chip(x, y, label, color, mono=True, size=12.5, filled=False, dash=None, pad=10, h=24):
    cw = 0.61 * size if mono else 0.56 * size
    w = int(len(label) * cw + pad * 2)
    fill = color if filled else BG
    rect(x, y, w, h, rx=h / 2, fill=fill, stroke=color, sw=1.2, dash=dash, opacity=1 if filled else 0.0 if False else 1)
    t(x + w / 2, y + h / 2 + size * 0.36, label, size=size, fill=BG if filled else color, weight=600,
      family=MONO if mono else SANS, anchor="middle")
    return w


def path(d, color, sw=2, dash=None, marker=None, marker_start=None, opacity=1):
    a = f' stroke-dasharray="{dash}"' if dash else ""
    m = f' marker-end="url(#{marker})"' if marker else ""
    ms = f' marker-start="url(#{marker_start})"' if marker_start else ""
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" '
        f'stroke-linejoin="round" stroke-opacity="{opacity}"{a}{m}{ms}/>')


def label_bg(x, y, s, size=13, color=MUTED, family=MONO, anchor="middle", weight=500):
    cw = 0.61 * size if family == MONO else 0.55 * size
    w = len(s) * cw + 16
    x0 = x - w / 2 if anchor == "middle" else x - 8
    add(f'<rect x="{x0:.1f}" y="{y - size - 3:.1f}" width="{w:.1f}" height="{size + 10}" rx="5" fill="{BG}"/>')
    t(x, y, s, size=size, fill=color, family=family, anchor=anchor, weight=weight)


def node(x, y, w, h, step, ic, title, lines, accent, status=None, status_color=None, dash=None,
         stroke=CARD_LINE, title_size=17):
    rect(x, y, w, h, fill=CARD, stroke=stroke, dash=dash)
    # icon tile
    add(f'<rect x="{x + 16}" y="{y + 16}" width="42" height="42" rx="10" fill="{accent}" fill-opacity="0.12" '
        f'stroke="{accent}" stroke-opacity="0.45" stroke-width="1"/>')
    icon(ic, x + 25, y + 25, 24, accent)
    t(x + w - 16, y + 34, step, size=12.5, fill=MUTED, family=MONO, anchor="end", weight=500)
    t(x + 16, y + 88, title, size=title_size, fill=INK, weight=700)
    for i, ln in enumerate(lines):
        col, txt, fam = TEXT, ln, SANS
        if isinstance(ln, tuple):
            txt, col, fam = ln
        t(x + 16, y + 113 + i * 21, txt, size=14, fill=col, family=fam)
    if status:
        t(x + 16, y + h - 16, status, size=12, fill=status_color or MUTED, family=MONO, weight=600, ls=0.6)


def arrow_h(x1, x2, y, color=LIME, sw=2.2, marker="aLime"):
    path(f"M{x1} {y} H{x2 - 2}", color, sw, marker=marker)


# ---- canvas -----------------------------------------------------------------
add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
    f'role="img" aria-labelledby="title desc">')
add('<title id="title">Gina RAG architecture map</title>')
add('<desc id="desc">Two trails: offline clean ingestion into a vector record contract v1, and online fail-closed '
    'retrieval through contract check, verifyAccess, live re-read with hash check, local sanitization, Trust Layer, '
    'LLM and approval harness. Every gate denies on doubt and writes one audit line.</desc>')
add('<defs>')
for mid, col in (("aLime", LIME), ("aCyan", CYAN), ("aRed", RED), ("aAmber", AMBER), ("aMuted", MUTED)):
    add(f'<marker id="{mid}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{col}"/></marker>')
add(f'<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">'
    f'<path d="M40 0H0V40" fill="none" stroke="{GRID}" stroke-width="1"/></pattern>')
add(f'<pattern id="gridMajor" width="200" height="200" patternUnits="userSpaceOnUse">'
    f'<path d="M200 0H0V200" fill="none" stroke="#22304D" stroke-width="1"/></pattern>')
add('</defs>')
add(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
add(f'<rect width="{W}" height="{H}" fill="url(#grid)"/>')
add(f'<rect width="{W}" height="{H}" fill="url(#gridMajor)"/>')

# ---- header -----------------------------------------------------------------
t(80, 74, "GINA RAG  ·  ARCHITECTURE MAP  ·  MEASURED 2026-11-14", 14, LIME, 600, MONO, ls=2)
t(80, 126, "Who may read what, before any text reaches a model", 42, INK, 800, ls=-0.5)
t(80, 164, "Two trails. Every gate fails closed: an error, a timeout or a doubtful answer means deny. "
   "The index holds pointers and hashes, never the text.", 18, MUTED)

# legend
lx, ly = 1500, 52
rect(lx, ly, 420, 124, rx=12, fill=CARD, stroke=CARD_LINE)
t(lx + 20, ly + 28, "LEGEND", 12, MUTED, 600, MONO, ls=1.5)
path(f"M{lx + 20} {ly + 52} h44", LIME, 2.2, marker="aLime")
t(lx + 78, ly + 57, "ALLOW: passes to the next gate", 14, TEXT)
path(f"M{lx + 20} {ly + 78} h44", RED, 2, dash="6 5", marker="aRed")
t(lx + 78, ly + 83, "DENY: fail closed, nothing served", 14, TEXT)
path(f"M{lx + 20} {ly + 104} h44", CYAN, 1.75, marker="aCyan")
t(lx + 78, ly + 109, "data flow / live read from the org", 14, TEXT)

# ---- PART 1: offline ingestion ----------------------------------------------
P1Y = 206
rect(40, P1Y, 1920, 258, rx=18, fill="none", stroke="#3A4A68", sw=1.25, dash="8 7")
chip(64, P1Y + 18, "PART 1", LIME, size=12.5, filled=True)
t(152, P1Y + 36, "Offline trail · clean ingestion", 19, INK, 700)
t(452, P1Y + 36, "Module 1 · done", 13, LIME, 600, MONO)

cy1 = P1Y + 58
cw1, gap1 = 270, 44
cards1 = [
    ("1.1", "cloud", "Salesforce org", ["minha-org-agentforce", "Developer Edition · API v68.0",
                                         ("the only source of served text", CYAN, SANS)], CYAN),
    ("1.2", "clipboard", "Hygiene audit first", ["DBA approval is checked before", "the CRM is even read",
                                                  ("else hygiene_unapproved", RED, MONO)], CYAN),
    ("1.3", "lock", "Allowlist read", ["fieldAllowlist + SystemModstamp", ("WITH USER_MODE", LIME, MONO),
                                        ("else source_mismatch", RED, MONO)], CYAN),
    ("1.4", "filecheck", "buildVectorRecord", ["contract v1 (Part 3), same", "validation as retrieval",
                                                ("chunkHash = sha256(...)", TEXT, MONO)], CYAN),
    ("1.5", "shield", "Injection quarantine", ["a poisoned record is held", "back and never enters", "the ranking"], CYAN),
    ("1.6", "layers", "Embed + index write", ["row = pointer + fields + hash", "blue/green embeddingModelId",
                                              ("embedder + store: simulated", AMBER, SANS)], CYAN),
]
xs1 = [80 + i * (cw1 + gap1) for i in range(6)]
for x, (step, ic, title, lines, acc) in zip(xs1, cards1):
    node(x, cy1, cw1, 178, step, ic, title, lines, acc)
for i in range(5):
    arrow_h(xs1[i] + cw1 + 4, xs1[i + 1] - 4, cy1 + 89, CYAN, 2, "aCyan")

# ---- PART 2: online retrieval -----------------------------------------------
P2Y = 556
rect(40, P2Y, 1920, 548, rx=18, fill="none", stroke="#3A4A68", sw=1.25, dash="8 7")
chip(64, P2Y + 18, "PART 2", LIME, size=12.5, filled=True)
t(152, P2Y + 36, "Online trail", 19, INK, 700)

NY, NH = P2Y + 108, 196
cols = {
    "query": (80, 140), "search": (248, 160),
    "g1": (452, 180), "g2": (652, 210), "g3": (882, 210), "g4": (1112, 180),
    "trust": (1336, 200), "llm": (1564, 130), "appr": (1722, 198),
}
# group boxes
rect(436, NY - 44, 872, 344, rx=14, fill="none", stroke=LIME, sw=1.1, dash="5 6", opacity=1)
t(452, NY - 18, "FAIL-CLOSED RETRIEVER · M2 DONE", 12, LIME, 600, MONO, ls=1.2)
rect(1320, NY - 44, 232, 344, rx=14, fill="none", stroke=CYAN, sw=1.1, dash="5 6")
t(1336, NY - 18, "TRUST LAYER · M3 DONE", 12, CYAN, 600, MONO, ls=1.2)

def cx(k):
    x, w = cols[k]
    return x + w / 2

nodes2 = {
    "query": ("2.1", "user", "User query", ["userId +", "question"], CYAN),
    "search": ("2.2", "search", "Vector search", ["returns pointers:", "record, fields,", "hash. No text."], CYAN),
    "g1": ("G1", "filecheck", "Contract check", ["schema · tenant ·", "model · allowlist", "· hygiene"], LIME),
    "g2": ("G2", "key", "verifyAccess", ["object · field (FLS)", "· record (sharing)", "· object prefix"], LIME),
    "g3": ("G3", "refresh", "Live re-read", [("WITH USER_MODE", LIME, MONO), "declared fields only", "+ chunkHash check"], LIME),
    "g4": ("G4", "eraser", "Local sanitizer", ["Unicode tags, zero-", "width, bidi, hidden", "HTML, split payloads"], LIME),
    "trust": ("2.7", "eyeoff", "Classifier + PII", [("qwen2.5:7b", TEXT, MONO), "local, via Ollama", "+ PII masking"], CYAN),
    "llm": ("2.8", "bot", "LLM", ["reads only", "re-read,", "clean text"], CYAN),
    "appr": ("2.9", "usercheck", "Approval Harness", ["one write: a Task", "a human approves", "the exact payload"], LIME),
}
for k, (step, ic, title, lines, acc) in nodes2.items():
    x, w = cols[k]
    status = {"appr": ("M5 · DONE", LIME)}.get(k)
    node(x, NY, w, NH, step, ic, title, lines, acc,
         status=status[0] if status else None, status_color=status[1] if status else None,
         dash=None, stroke=CARD_LINE,
         title_size=16 if w < 190 else 17)

order = ["query", "search", "g1", "g2", "g3", "g4", "trust", "llm", "appr"]
midy = NY + NH / 2
for a, b in zip(order, order[1:]):
    xa, wa = cols[a]
    xb, _ = cols[b]
    col, mk = (CYAN, "aCyan") if a in ("query",) else (LIME, "aLime")
    arrow_h(xa + wa + 3, xb - 3, midy, col, 2.2, mk)
# ALLOW badge on the G4 -> trust arrow

# deny drops + bus
BUS = P2Y + 498
denies = {
    "g1": ["fls_denied", "undeclared_field", "hygiene_unapproved"],
    "g2": ["fls_denied", "field/record_denied", "fls_unreadable, timeout"],
    "g3": ["fls_denied", "stale_chunk", "fls_unreadable (mismatch)"],
    "g4": ["injection_detected", "embedded_instruction", "hidden_payload"],
    "trust": ["injection_detected", "classifier_flagged", "safety_unverified"],
}
for k, lines in denies.items():
    x, w = cols[k]
    dx = x + 22
    path(f"M{dx} {NY + NH + 4} V{BUS - 4}", RED, 1.8, dash="6 5")
    add(f'<circle cx="{dx}" cy="{BUS}" r="4" fill="{RED}"/>')
    for i, ln in enumerate(lines):
        t(dx + 12, NY + NH + 38 + i * 22, ln, 12.5, RED if i == 0 else "#FCA5A5", 700 if i == 0 else 500, MONO)
g1x = cols["g1"][0] + 22
audit_x = 1564
path(f"M{g1x} {BUS} H{audit_x - 4}", RED, 2, dash="6 5", marker="aRed")
t(1000, BUS + 30, "DENY · the chunk is dropped and the decision is logged", 13, RED, 700, MONO, anchor="middle")


# router (proposed)
rx0, ry0, rw0, rh0 = 80, NY + NH + 30, 328, 144
rect(rx0, ry0, rw0, rh0, fill=CARD, stroke=AMBER, dash="6 5")
add(f'<rect x="{rx0 + 16}" y="{ry0 + 16}" width="36" height="36" rx="9" fill="{AMBER}" fill-opacity="0.12" '
    f'stroke="{AMBER}" stroke-opacity="0.45"/>')
icon("branch", rx0 + 23, ry0 + 23, 22, AMBER)
t(rx0 + 64, ry0 + 32, "Query router", 16, INK, 700)
t(rx0 + 64, ry0 + 50, "PROPOSED · NOT BUILT", 11.5, AMBER, 600, MONO, ls=0.8)
t(rx0 + 16, ry0 + 82, "SOQL for structured questions, RAG", 14, TEXT)
t(rx0 + 16, ry0 + 103, "otherwise; in doubt, RAG. Same", 14, TEXT)
t(rx0 + 16, ry0 + 124, "verifyAccess gates on both paths.", 14, TEXT)
qx = cx("query")
path(f"M{qx} {NY + NH + 4} V{ry0 - 3}", AMBER, 1.6, dash="5 5", marker="aAmber")

# audit card
ax, ay, aw, ah = audit_x, NY + NH + 30, 356, 196
rect(ax, ay, aw, ah, fill=CARD, stroke=CARD_LINE)
add(f'<rect x="{ax + 16}" y="{ay + 16}" width="36" height="36" rx="9" fill="{CYAN}" fill-opacity="0.12" '
    f'stroke="{CYAN}" stroke-opacity="0.45"/>')
icon("scroll", ax + 23, ay + 23, 22, CYAN)
t(ax + 64, ay + 32, "Audit log", 16, INK, 700)
t(ax + 64, ay + 50, "ONE LINE PER DECISION", 11.5, CYAN, 600, MONO, ls=0.8)
for i, ln in enumerate(["{ decision, reason, detail,", "  userId, recordId,", "  latencyMs }"]):
    t(ax + 16, ay + 86 + i * 21, ln, 13.5, LIME, 500, MONO)
t(ax + 16, ay + 160, "never chunk text, never field values", 13, MUTED)
t(ax + 16, ay + 180, "reason derived from detail in code", 13, MUTED)
# allow path also logs
path(f"M{cx('appr')} {NY + NH + 4} V{ay - 3}", LIME, 1.6, dash="2 5", marker="aLime")
t(cx("appr") - 10, NY + NH + 22, "allow is logged too", 12, LIME, 500, MONO, anchor="end")

# ---- cross-band connectors (between Part 1 and Part 2) -----------------------
org_cx = xs1[0] + cw1 / 2          # 215
idx_cx = xs1[5] + cw1 / 2          # index card center
search_x = cols["search"][0] + cols["search"][1] - 26
y_index = P1Y + 258 + 26           # upper lane
y_live = P1Y + 258 + 60            # lower lane
p1_bottom = cy1 + 178
# index -> search (pointers only)
path(f"M{idx_cx} {p1_bottom + 3} V{y_index} H{search_x} V{NY - 3}", CYAN, 1.8, marker="aCyan")
label_bg(1300, y_index + 5, "index row: pointer + fields + chunkHash, never the text", 13, CYAN, MONO)
# live read loop: G2 and G3 query the org
g2x, g3x = cx("g2"), cx("g3")
hop = 9
d = (f"M{g3x} {NY - 47} V{y_live} H{search_x + hop} "
     f"A{hop} {hop} 0 0 0 {search_x - hop} {y_live} H{org_cx} V{p1_bottom + 3}")
path(d, CYAN, 1.8, marker="aCyan")
path(f"M{g2x} {NY - 47} V{y_live}", CYAN, 1.8)
add(f'<circle cx="{g2x}" cy="{y_live}" r="4" fill="{CYAN}"/>')
label_bg(560, y_live + 5, "live: verifyAccess + re-read query the org", 13, CYAN, MONO)
# these verticals cross the retriever group-box top edge; small arrowheads into the box
path(f"M{g2x} {NY - 47} V{NY - 3}", CYAN, 1.8, marker="aCyan")
path(f"M{g3x} {NY - 47} V{NY - 3}", CYAN, 1.8, marker="aCyan")

# ---- PART 3: contract, audit, telemetry --------------------------------------
P3Y = 1132
rect(40, P3Y, 1920, 500, rx=18, fill="none", stroke="#3A4A68", sw=1.25, dash="8 7")
chip(64, P3Y + 18, "PART 3", LIME, size=12.5, filled=True)
t(152, P3Y + 36, "Contract, reasons and measured telemetry", 19, INK, 700)
# module status strip (right)
sx = 1920
for label, col, dash in reversed([("M1 done", LIME, None), ("M2 done", LIME, None), ("M3 done", LIME, None),
                                  ("M4 done", LIME, None), ("M5 done", LIME, None),
                                  ("MCP gateway planned", MUTED, "4 4")]):
    w = int(len(label) * 0.61 * 12 + 20)
    sx -= w
    chip(sx, P3Y + 18, label, col, size=12, dash=dash)
    sx -= 8

CY3, CH3 = P3Y + 70, 404
# A. contract
ax3, aw3 = 80, 560
rect(ax3, CY3, aw3, CH3)
icon("filecheck", ax3 + 20, CY3 + 20, 22, LIME)
t(ax3 + 54, CY3 + 38, "Vector record contract v1", 17, INK, 700)
t(ax3 + aw3 - 18, CY3 + 38, "3.A", 12.5, MUTED, 500, MONO, anchor="end")
rows = [
    ("schemaVersion", "literal 1"),
    ("tenantId", "18-char org id, matches policy"),
    ("fields", "each one in fieldAllowlist"),
    ("chunkHash", "sha256(object, recordId,"),
    ("", "sorted field/value pairs)"),
    ("embeddingModelId", "in accepted set (blue/green)"),
    ("sourceModifiedAt", "SystemModstamp, ISO UTC"),
    ("hygiene", "approved · auditedBy · auditedAt"),
]
for i, (k, v) in enumerate(rows):
    yy = CY3 + 82 + i * 30
    if k:
        add(f'<line x1="{ax3 + 20}" y1="{yy - 21}" x2="{ax3 + aw3 - 20}" y2="{yy - 21}" stroke="{CARD_LINE}"/>')
    t(ax3 + 20, yy, k, 13.5, LIME, 600, MONO)
    t(ax3 + 214, yy, v, 13.5, TEXT, 400, MONO)
t(ax3 + 20, CY3 + CH3 - 50, "Policy comes from config, never from the index.", 14, TEXT, 600)
t(ax3 + 20, CY3 + CH3 - 26, "Any failure: fls_denied, before any org query.", 14, MUTED)

# B. reasons + real decisions
bx3, bw3 = 664, 556
rect(bx3, CY3, bw3, CH3)
icon("x", bx3 + 20, CY3 + 20, 22, RED)
t(bx3 + 54, CY3 + 38, "Closed reason enum · real decisions", 17, INK, 700)
t(bx3 + bw3 - 18, CY3 + 38, "3.B", 12.5, MUTED, 500, MONO, anchor="end")
enum_rows = [
    [("allowed", LIME, None), ("fls_denied", RED, None), ("fls_unreadable", RED, None)],
    [("timeout", RED, None), ("retriever_error", RED, None), ("malformed_request", RED, None)],
    [("injection_detected", RED, None), ("safety_unverified", AMBER, None), ("toxicity · reserved", MUTED, "4 4")],
]
for r, row in enumerate(enum_rows):
    xx = bx3 + 20
    for label, col, dash in row:
        xx += chip(xx, CY3 + 60 + r * 34, label, col, size=12, dash=dash) + 8
t(bx3 + 20, CY3 + 186, "decision / reason / detail", 12, MUTED, 600, MONO, ls=0.8)
decisions = [
    ("allow", "allowed", "ok", "Account.Name + Industry", LIME),
    ("deny", "fls_denied", "undeclared_field", "AnnualRevenue row · 0 queries", RED),
    ("deny", "fls_denied", "field_denied", "restricted · AnnualRevenue", RED),
    ("deny", "fls_denied", "record_denied", "note owned by another user", RED),
    ("deny", "fls_denied", "stale_chunk", "CRM changed after ingestion", RED),
    ("deny", "injection_detected", "embedded_instruction", "split Industry + Name*", RED),
]
for i, (dcs, rsn, det, what, col) in enumerate(decisions):
    yy = CY3 + 212 + i * 26
    add(f'<circle cx="{bx3 + 26}" cy="{yy - 4.5}" r="4" fill="{col}"/>')
    t(bx3 + 38, yy, f"{dcs} / {rsn} / {det}", 12.5, col, 600, MONO)
    t(bx3 + bw3 - 18, yy, what, 12.5, MUTED, 400, SANS, anchor="end")
t(bx3 + 20, CY3 + CH3 - 18, "Live, minha-org-agentforce, sf CLI. *Offline suite.", 12.5, MUTED)

# C. telemetry
tx3, tw3 = 1244, 676
rect(tx3, CY3, tw3, CH3, stroke=LIME)
icon("activity", tx3 + 20, CY3 + 20, 22, LIME)
t(tx3 + 54, CY3 + 38, "Telemetry · measured 2026-11-14", 17, INK, 700)
t(tx3 + tw3 - 18, CY3 + 38, "3.C", 12.5, MUTED, 500, MONO, anchor="end")
tiles = [
    ("231/231", "offline tests · tsc clean"),
    ("0", "leakage · 36 scenarios"),
    ("57/57", "detail accuracy (eval)"),
    ("18/18", "live checks · real org"),
    ("2,465 / 3,449", "verifyAccess P50/P95 ms"),
    ("4,627 / 5,709", "1-chunk read P50/P95 ms"),
]
tw, th = 204, 78
for i, (big, small) in enumerate(tiles):
    c, r = i % 3, i // 3
    x0 = tx3 + 20 + c * (tw + 10)
    y0 = CY3 + 56 + r * (th + 10)
    rect(x0, y0, tw, th, rx=10, fill="#0F182C", stroke=CARD_LINE)
    t(x0 + 14, y0 + 36, big, 24 if len(big) < 9 else 20, LIME, 700, MONO, ls=-0.5)
    t(x0 + 14, y0 + 60, small, 12.5, TEXT)
t(tx3 + 20, CY3 + 250, "Live latency: sf CLI transport, 20 samples. Leakage per independent oracle.", 12.5, MUTED)

# injection bars
iy = CY3 + 278
t(tx3 + 20, iy, "Prompt injection · blind corpus v2 (80 attacks / 80 benign) · 5 runs", 13, INK, 600)
bar_x, bar_w = tx3 + 236, 400
def pct_x(p):
    return bar_x + bar_w * p / 100
bars = [
    ("patterns alone", 30.0, 30.0, "30.0%"),
    ("patterns + classifier", 76.3, 81.3, "76.3–81.3%"),
    ("caught in every run", 71.3, 71.3, "71.3%"),
]
for i, (name, lo, hi, lab) in enumerate(bars):
    yy = iy + 26 + i * 26
    t(tx3 + 20, yy + 4, name, 13, TEXT)
    add(f'<rect x="{bar_x}" y="{yy - 7}" width="{bar_w}" height="12" rx="6" fill="#1E293B"/>')
    col = LIME if i else MUTED
    if lo == hi:
        add(f'<rect x="{bar_x}" y="{yy - 7}" width="{pct_x(hi) - bar_x:.1f}" height="12" rx="6" fill="{col}" fill-opacity="0.85"/>')
    else:
        add(f'<rect x="{bar_x}" y="{yy - 7}" width="{pct_x(lo) - bar_x:.1f}" height="12" rx="6" fill="{col}" fill-opacity="0.85"/>')
        add(f'<rect x="{pct_x(lo):.1f}" y="{yy - 7}" width="{pct_x(hi) - pct_x(lo):.1f}" height="12" fill="{col}" fill-opacity="0.4"/>')
        add(f'<line x1="{pct_x(80.0):.1f}" y1="{yy - 11}" x2="{pct_x(80.0):.1f}" y2="{yy + 9}" stroke="{INK}" stroke-width="2"/>')
    t(pct_x(hi) + 8, yy + 4, lab, 12.5, INK, 600, MONO)
t(tx3 + 20, iy + 104, "median 80.0% (white tick) · false positives 0–1.3% · a layer, not a barrier", 12.5, MUTED)

add("</svg>")
OUT.write_text("\n".join(out), encoding="utf-8")
print(f"wrote {OUT}")
