"""Bootstrap: promote the first user (id=1) to ADMIN role."""
from sqlalchemy import text
from db import engine

with engine.connect() as conn:
    conn.execute(text("UPDATE users SET role = 'ADMIN', is_approved = 1 WHERE id = 1"))
    conn.commit()
    row = conn.execute(text("SELECT id, email, role FROM users WHERE id = 1")).fetchone()
    print(f"User id={row[0]} ({row[1]}) is now role={row[2]}, is_approved=1.")
