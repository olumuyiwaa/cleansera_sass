const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.DO_SPACES_BUCKET;

const spaces = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY || '',
    secretAccessKey: process.env.DO_SPACES_SECRET || '',
  },
  forcePathStyle: false,
});

async function getSignedUploadUrl(key, contentType, expiresSeconds = 300) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: 'private',
  });
  return getSignedUrl(spaces, command, { expiresIn: expiresSeconds });
}

async function getSignedDownloadUrl(key, expiresSeconds = 300) {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  return getSignedUrl(spaces, command, { expiresIn: expiresSeconds });
}

async function deleteObject(key) {
  return spaces.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
}

module.exports = { spaces, BUCKET, getSignedUploadUrl, getSignedDownloadUrl, deleteObject };
