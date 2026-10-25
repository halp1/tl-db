import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env";

export const s3 = new S3Client({
  region: "auto",
  endpoint: env.S3_ENDPOINT,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export const upload = async (key: string, data: Uint8Array, mimeType: string) =>
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
      Body: data,
      ContentType: mimeType,
    }),
  );

export const fetchObject = async (key: string) => {
  const r = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key }));
  return await r.Body!.transformToByteArray();
};
