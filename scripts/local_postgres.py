"""Поднимает только собственный PostgreSQL для локальной разработки на loopback."""

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / ".local/postgres"
PORT = "55581"


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True)


def main() -> None:
    """Создаёт изолированный каталог и две БД; чужие процессы не останавливает."""
    for tool in ("initdb", "pg_ctl", "psql"):
        if not shutil.which(tool):
            raise SystemExit("Нужен PostgreSQL 14+ с initdb/pg_ctl/psql либо Docker Compose.")
    DATA.parent.mkdir(exist_ok=True)
    if not (DATA / "PG_VERSION").exists():
        run("initdb", "-D", str(DATA), "-U", "review", "--auth=trust", "--no-locale", "-E", "UTF8")
    if run("pg_ctl", "-D", str(DATA), "status", check=False).returncode:
        result = run(
            "pg_ctl",
            "-D",
            str(DATA),
            "-l",
            str(DATA.parent / "postgres.log"),
            "-o",
            f"-h 127.0.0.1 -p {PORT} -k {DATA.parent}",
            "-w",
            "start",
            check=False,
        )
        if result.returncode:
            raise SystemExit(
                "Свой PostgreSQL не запущен; см. .local/postgres.log. Чужой порт не освобождается."
            )
    for database in ("review", "review_test"):
        found = run(
            "psql",
            "-h",
            "127.0.0.1",
            "-p",
            PORT,
            "-U",
            "review",
            "-d",
            "postgres",
            "-tAc",
            f"SELECT 1 FROM pg_database WHERE datname='{database}'",
        )
        if found.stdout.strip() != "1":
            run(
                "psql",
                "-h",
                "127.0.0.1",
                "-p",
                PORT,
                "-U",
                "review",
                "-d",
                "postgres",
                "-c",
                f"CREATE DATABASE {database}",
            )
    print(
        "Локальный PostgreSQL готов: 127.0.0.1:55581. Только синтетические данные; auth=trust на loopback."
    )


if __name__ == "__main__":
    main()
