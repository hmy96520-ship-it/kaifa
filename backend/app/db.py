from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterable

import pymysql
from pymysql.cursors import DictCursor

from .config import Settings, get_settings


class Database:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        required = {
            "DB_HOST": settings.db_host,
            "DB_PORT": settings.db_port,
            "DB_USER": settings.db_user,
            "DB_PASSWORD": settings.db_password,
            "DB_NAME": settings.db_name,
        }
        missing = [key for key, value in required.items() if value in ("", None)]
        if missing:
            raise RuntimeError(f"Missing required env: {', '.join(missing)}")

    @contextmanager
    def connection(self):
        conn = pymysql.connect(
            host=self.settings.db_host,
            port=self.settings.db_port,
            user=self.settings.db_user,
            password=self.settings.db_password,
            database=self.settings.db_name,
            charset="utf8mb4",
            cursorclass=DictCursor,
            autocommit=False,
        )
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def fetch_all(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                return list(cur.fetchall())

    def fetch_one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        rows = self.fetch_all(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                return cur.lastrowid or 0


db = Database(get_settings())
