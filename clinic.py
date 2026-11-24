"""Clinic data layer: doctors, time slots and appointments stored in SQLite.

Everything here is plain Python with no Pipecat code, so it can be tested on its own:

    python clinic.py
"""

import re
import sqlite3
import unicodedata
from datetime import date, datetime, time, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "clinic.db"

DOCTORS = [
    ("Dr. Khushi Jha", "Pediatrician"),
    ("Dr. Ananya Rao", "General Physician"),
    ("Dr. Vikram Mehta", "Cardiologist"),
    ("Dr. Sara Khan", "Dermatologist"),
]

# Each doctor works the same simple schedule on weekdays.
SLOT_TIMES = [time(10, 0), time(10, 30), time(11, 0), time(11, 30), time(16, 0), time(16, 30), time(17, 0)]
DAYS_AHEAD = 7


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(reset: bool = False) -> None:
    """Create tables and fill them with mock doctors and the next week's slots."""
    if reset and DB_PATH.exists():
        DB_PATH.unlink()

    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS doctors (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                specialty TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS slots (
                id INTEGER PRIMARY KEY,
                doctor_id INTEGER NOT NULL REFERENCES doctors(id),
                starts_at TEXT NOT NULL,
                UNIQUE (doctor_id, starts_at)
            );
            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY,
                slot_id INTEGER NOT NULL REFERENCES slots(id),
                phone TEXT NOT NULL,
                patient_name TEXT,
                status TEXT NOT NULL DEFAULT 'booked',
                created_at TEXT NOT NULL
            );
            """
        )
        if conn.execute("SELECT COUNT(*) FROM doctors").fetchone()[0] == 0:
            conn.executemany("INSERT INTO doctors (name, specialty) VALUES (?, ?)", DOCTORS)

        # Add any missing slots for the coming week (safe to run every start).
        doctor_ids = [row["id"] for row in conn.execute("SELECT id FROM doctors")]
        today = date.today()
        for offset in range(DAYS_AHEAD):
            day = today + timedelta(days=offset)
            if day.weekday() >= 5:  # skip Saturday and Sunday
                continue
            for doctor_id in doctor_ids:
                for slot_time in SLOT_TIMES:
                    starts_at = datetime.combine(day, slot_time)
                    if starts_at <= datetime.now():
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO slots (doctor_id, starts_at) VALUES (?, ?)",
                        (doctor_id, starts_at.isoformat(timespec="minutes")),
                    )


# ---------- helpers ----------


def normalize_phone(phone: str) -> str | None:
    """Keep only the digits of a spoken phone number. Returns None if it can't be a phone number.

    Handles digits in any script, e.g. Devanagari "९८७६" from a Hindi transcript becomes "9876".
    """
    digits = "".join(str(unicodedata.digit(ch)) for ch in (phone or "") if ch.isdigit())
    if len(digits) == 12 and digits.startswith("91"):  # +91 country code
        digits = digits[2:]
    return digits if 7 <= len(digits) <= 15 else None


# Everyday words (English, Hindi, Hinglish, Bengali) callers use instead of the specialty name.
SPECIALTY_SYNONYMS = {
    "cardiologist": ["heart", "cardio", "chest", "dil", "दिल", "हृदय", "हार्ट",
                     "হৃদয়", "হৃদরোগ", "হার্ট", "বুক"],
    "dermatologist": ["skin", "derma", "hair", "acne", "twacha", "त्वचा", "चमड़ी", "स्किन",
                      "চামড়া", "চর্ম", "ত্বক", "স্কিন"],
    "pediatrician": ["child", "children", "kid", "baby", "paediatric", "bachcha", "bacche", "bachche", "bachcho", "bachon", "bacchon","बच्चा", "बच्चे", "बच्चों", "शिशु",
                     "শিশু", "বাচ্চা", "বাচ্চার"],
    "general physician": ["general", "fever", "cold", "physician", "gp", "family", "bukhar", "बुखार", "सामान्य",
                          "জ্বর", "সাধারণ"],
}


def find_doctors(conn: sqlite3.Connection, query: str | None) -> list[sqlite3.Row]:
    """Match a doctor by (part of) their name or by specialty. No query returns everyone."""
    rows = conn.execute("SELECT * FROM doctors ORDER BY id").fetchall()
    if not query:
        return rows
    q = query.lower().replace("dr.", "").replace("doctor", "").replace("डॉक्टर", "").replace("ডাক্তার", "").strip()
    for specialty, words in SPECIALTY_SYNONYMS.items():
        if any(w in q for w in words):
            q = specialty
            break
    words = [w for w in re.split(r"\W+", q) if len(w) > 2]
    return [
        r for r in rows
        if q in r["name"].lower() or q in r["specialty"].lower()
        or any(w in r["name"].lower() or w in r["specialty"].lower() for w in words)
    ]


def _free_slots(conn, doctor_id: int, on_date: str | None, limit: int | None = None):
    sql = """
        SELECT s.* FROM slots s
        WHERE s.doctor_id = ? AND s.starts_at > ?
          AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status = 'booked')
    """
    args: list = [doctor_id, datetime.now().isoformat(timespec="minutes")]
    if on_date:
        sql += " AND substr(s.starts_at, 1, 10) = ?"
        args.append(on_date)
    sql += " ORDER BY s.starts_at"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return conn.execute(sql, args).fetchall()


def speakable(iso: str) -> str:
    """'2026-11-25T10:30' -> 'Wednesday 25 November at 10:30 AM' (easy for TTS to read)."""
    dt = datetime.fromisoformat(iso)
    return dt.strftime("%A %d %B at %I:%M %p").replace(" 0", " ")


# ---------- the three actions the voice agent can take ----------


def check_availability(doctor: str | None = None, on_date: str | None = None) -> dict:
    with connect() as conn:
        doctors = find_doctors(conn, doctor)
        if not doctors:
            return {"ok": False, "error": f"No doctor matches '{doctor}'.",
                    "doctors": [dict(d) for d in find_doctors(conn, None)]}
        result = []
        for d in doctors:
            slots = _free_slots(conn, d["id"], on_date, limit=6)
            result.append({
                "doctor": d["name"],
                "specialty": d["specialty"],
                "free_slots": [{"starts_at": s["starts_at"], "spoken": speakable(s["starts_at"])} for s in slots],
            })
        return {"ok": True, "availability": result}


def book_appointment(doctor: str, starts_at: str, phone: str, patient_name: str | None = None) -> dict:
    digits = normalize_phone(phone)
    if not digits:
        return {"ok": False, "error": "That phone number doesn't look valid. Ask the caller to repeat it."}
    with connect() as conn:
        doctors = find_doctors(conn, doctor)
        if len(doctors) != 1:
            return {"ok": False, "error": "Doctor is unclear. Confirm which doctor the caller wants."}
        d = doctors[0]
        slot = conn.execute(
            "SELECT * FROM slots WHERE doctor_id = ? AND starts_at = ?",
            (d["id"], starts_at[:16]),
        ).fetchone()
        if not slot:
            return {"ok": False, "error": "That time is not one of the doctor's slots. Offer free slots instead."}
        taken = conn.execute(
            "SELECT 1 FROM appointments WHERE slot_id = ? AND status = 'booked'", (slot["id"],)
        ).fetchone()
        if taken:
            return {"ok": False, "error": "That slot was just taken. Offer another free slot."}
        cur = conn.execute(
            "INSERT INTO appointments (slot_id, phone, patient_name, created_at) VALUES (?, ?, ?, ?)",
            (slot["id"], digits, patient_name, datetime.now().isoformat(timespec="seconds")),
        )
        return {"ok": True, "appointment_id": cur.lastrowid, "doctor": d["name"],
                "when": speakable(slot["starts_at"]), "phone": digits}


def find_appointments(phone: str) -> list[dict]:
    digits = normalize_phone(phone)
    if not digits:
        return []
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT a.id, d.name AS doctor, s.starts_at FROM appointments a
            JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = s.doctor_id
            WHERE a.phone = ? AND a.status = 'booked' ORDER BY s.starts_at
            """,
            (digits,),
        ).fetchall()
    return [{"appointment_id": r["id"], "doctor": r["doctor"], "when": speakable(r["starts_at"])} for r in rows]


def cancel_appointment(phone: str, appointment_id: int | None = None) -> dict:
    digits = normalize_phone(phone)
    if not digits:
        return {"ok": False, "error": "That phone number doesn't look valid. Ask the caller to repeat it."}
    existing = find_appointments(digits)
    if not existing:
        return {"ok": False, "error": "No booked appointment found for this phone number."}
    if appointment_id is None:
        if len(existing) > 1:
            return {"ok": False, "error": "This number has several appointments. Ask which one to cancel.",
                    "appointments": existing}
        appointment_id = existing[0]["appointment_id"]
    target = next((a for a in existing if a["appointment_id"] == appointment_id), None)
    if not target:
        return {"ok": False, "error": "That appointment doesn't belong to this phone number.",
                "appointments": existing}
    with connect() as conn:
        conn.execute("UPDATE appointments SET status = 'cancelled' WHERE id = ?", (appointment_id,))
    return {"ok": True, "cancelled": target}


# ---------- read-only views for the dashboard ----------


def dashboard_doctors() -> list[dict]:
    with connect() as conn:
        return [
            {"id": d["id"], "name": d["name"], "specialty": d["specialty"],
             "free_slots": [s["starts_at"] for s in _free_slots(conn, d["id"], None, limit=8)]}
            for d in find_doctors(conn, None)
        ]


def dashboard_appointments() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT a.id, a.phone, a.patient_name, a.status, a.created_at, s.starts_at,
                   d.name AS doctor, d.specialty
            FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = s.doctor_id
            ORDER BY a.id DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def dashboard_stats() -> dict:
    """Headline numbers for the dashboard."""
    today = date.today().isoformat()
    with connect() as conn:
        booked_today = conn.execute(
            "SELECT COUNT(*) FROM appointments WHERE status = 'booked' AND substr(created_at, 1, 10) = ?", (today,)
        ).fetchone()[0]
        cancelled_today = conn.execute(
            "SELECT COUNT(*) FROM appointments WHERE status = 'cancelled' AND substr(created_at, 1, 10) = ?", (today,)
        ).fetchone()[0]
        open_slots = sum(len(_free_slots(conn, d["id"], None)) for d in find_doctors(conn, None))
    return {"booked_today": booked_today, "cancelled_today": cancelled_today, "open_slots": open_slots}


if __name__ == "__main__":
    init_db(reset=True)
    print(check_availability("cardio"))
    first = check_availability("Vikram")["availability"][0]["free_slots"][0]["starts_at"]
    print(book_appointment("Vikram", first, "98765 43210", "Test"))
    print(find_appointments("+91 98765 43210"))
    print(cancel_appointment("9876543210"))
    print(dashboard_appointments())
