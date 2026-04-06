"""
One-off migration: add role + is_approved to users; create admin_requests table.
Run from the backend directory: python migrate_rbac.py
"""
from sqlalchemy import text
from db import engine

with engine.connect() as conn:
    # Add role column to users if it doesn't exist
    try:
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'USER'"
        ))
        print("Added role column to users")
    except Exception as e:
        print(f"role column (skipped): {e}")

    # Add is_approved column to users if it doesn't exist
    try:
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN is_approved TINYINT(1) NOT NULL DEFAULT 0"
        ))
        print("Added is_approved column to users")
    except Exception as e:
        print(f"is_approved column (skipped): {e}")

    # Add must_change_password column to users if it doesn't exist
    try:
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0"
        ))
        print("Added must_change_password column to users")
    except Exception as e:
        print(f"must_change_password column (skipped): {e}")

    # Drop admin_requests table since we now use AdminPanel active directory natively
    try:
        conn.execute(text("DROP TABLE IF EXISTS admin_requests"))
        print("Dropped admin_requests table")
    except Exception as e:
        print(f"admin_requests table drop (skipped): {e}")

    conn.commit()
    print("Migration complete.")
