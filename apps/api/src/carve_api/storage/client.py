from typing import BinaryIO

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from carve_api.config import get_settings


class MinioClient:
    def __init__(self, *, endpoint: str, access_key: str, secret_key: str, bucket: str) -> None:
        self.bucket = bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version="s3v4"),
            region_name="us-east-1",
        )

    @classmethod
    def from_settings(cls) -> "MinioClient":
        s = get_settings()
        return cls(
            endpoint=s.minio_endpoint,
            access_key=s.minio_root_user,
            secret_key=s.minio_root_password,
            bucket=s.minio_bucket,
        )

    def ensure_bucket(self) -> None:
        try:
            self._s3.head_bucket(Bucket=self.bucket)
        except ClientError:
            self._s3.create_bucket(Bucket=self.bucket)

    def put_object(self, key: str, body: BinaryIO, length: int, content_type: str) -> None:
        self._s3.put_object(
            Bucket=self.bucket, Key=key, Body=body,
            ContentLength=length, ContentType=content_type,
        )

    def get_object(self, key: str):
        return self._s3.get_object(Bucket=self.bucket, Key=key)["Body"]

    def remove_object(self, key: str) -> None:
        self._s3.delete_object(Bucket=self.bucket, Key=key)

    def presigned_get(self, key: str, expires_seconds: int = 600) -> str:
        return self._s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=expires_seconds,
        )
