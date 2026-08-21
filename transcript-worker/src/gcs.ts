import { Storage } from '@google-cloud/storage';
import logger from './logger.js';

export interface GcsClient {
  upload(objectKey: string, content: string, contentType: string): Promise<void>;
}

export class StorageGcsClient implements GcsClient {
  private storage: Storage;
  private bucketName: string;

  constructor(bucketName: string, projectId: string, storage?: Storage) {
    this.bucketName = bucketName;
    this.storage = storage ?? new Storage({ projectId: projectId || undefined });
  }

  async upload(objectKey: string, content: string, contentType: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(objectKey).save(content, {
      contentType,
      resumable: false,
    });
    logger.info({ objectKey, bytes: Buffer.byteLength(content) }, 'gcs: artifact uploaded');
  }
}

/** No-op GCS client used when artifacts are disabled (local dev). */
export class NoopGcsClient implements GcsClient {
  async upload(objectKey: string, _content: string, _contentType: string): Promise<void> {
    logger.info({ objectKey }, 'gcs: disabled, skipping upload (dev mode)');
  }
}