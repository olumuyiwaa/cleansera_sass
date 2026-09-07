const AWS = require('aws-sdk');

const spaces = new AWS.S3({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  signatureVersion: 'v4',
});

const BUCKET = process.env.DO_SPACES_BUCKET;

function getSignedUploadUrl(key, contentType, expiresSeconds = 300) {
  return spaces.getSignedUrlPromise('putObject', {
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    Expires: expiresSeconds,
    ACL: 'private',
  });
}

function getSignedDownloadUrl(key, expiresSeconds = 300) {
  return spaces.getSignedUrlPromise('getObject', {
    Bucket: BUCKET,
    Key: key,
    Expires: expiresSeconds,
  });
}

function deleteObject(key) {
  return spaces.deleteObject({ Bucket: BUCKET, Key: key }).promise();
}

module.exports = { spaces, BUCKET, getSignedUploadUrl, getSignedDownloadUrl, deleteObject };
