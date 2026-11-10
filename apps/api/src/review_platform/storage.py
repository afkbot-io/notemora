"""Закрытые изображения: локальная папка разработки либо отдельный S3 bucket."""

import io
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from .config import Settings

MAX_UPLOAD = 5 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 20_000_000


def normalize_image(raw: bytes) -> tuple[bytes, int, int]:
    """Проверяет реальный формат/размер, удаляет метаданные и перекодирует в WebP."""
    if not raw or len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "Снимок должен быть не больше 5 МиБ")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > Image.MAX_IMAGE_PIXELS or image.format not in {
                "PNG",
                "JPEG",
                "WEBP",
            }:
                raise HTTPException(422, "Нужен PNG, JPEG или WebP до 20 мегапикселей")
            image.load()
            target = io.BytesIO()
            image.convert("RGB").save(target, "WEBP", quality=85)
            if target.tell() > MAX_UPLOAD:
                raise HTTPException(413, "Нормализованный снимок больше 5 МиБ")
            return target.getvalue(), image.width, image.height
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        raise HTTPException(422, "Файл не является допустимым изображением") from error


class Storage:
    """Выдаёт байты только после проверки прав в API; публичных URL не создаёт."""

    def __init__(self, settings: Settings):
        self.root: Path = settings.storage_dir.resolve()
        self.bucket = settings.s3_bucket
        self.s3 = None
        if self.bucket:
            import boto3

            self.s3 = boto3.client(
                "s3",
                endpoint_url=settings.s3_endpoint_url or None,
                region_name=settings.s3_region or None,
            )
        else:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    @staticmethod
    def key(identifier: str) -> str:
        from uuid import UUID

        return f"screenshots/{UUID(identifier)}.webp"

    def put(self, identifier: str, value: bytes) -> None:
        """Сохраняет нормализованное изображение; S3 credentials берёт обычная AWS chain."""
        key = self.key(identifier)
        if self.s3:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=value, ContentType="image/webp")
        else:
            target = self.root / key
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            target.write_bytes(value)
            target.chmod(0o600)

    def get(self, identifier: str) -> bytes:
        """Читает ограниченный объём; закрывает S3 body и не принимает произвольные ключи."""
        key = self.key(identifier)
        if self.s3:
            body = self.s3.get_object(Bucket=self.bucket, Key=key)["Body"]
            try:
                return body.read(MAX_UPLOAD + 1)
            finally:
                body.close()
        return (self.root / key).read_bytes()

    def delete(self, identifier: str) -> None:
        key = self.key(identifier)
        if self.s3:
            self.s3.delete_object(Bucket=self.bucket, Key=key)
        else:
            (self.root / key).unlink(missing_ok=True)
