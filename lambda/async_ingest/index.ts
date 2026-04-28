import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  const prompt = String(body.prompt ?? '').trim();

  if (!prompt) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: "Missing 'prompt' in request body" }),
    };
  }

  const requestId = randomUUID();
  const submittedAt = Math.floor(Date.now() / 1000);

  await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({ requestId, prompt, submitted_at: submittedAt }),
  }));

  const domain = event.requestContext?.domainName ?? '';
  const stage = event.requestContext?.stage ?? 'demo';
  const pollUrl = domain
    ? `https://${domain}/${stage}/result/${requestId}`
    : `/result/${requestId}`;

  return {
    statusCode: 202,
    headers: CORS,
    body: JSON.stringify({ requestId, status: 'processing', poll_url: pollUrl }),
  };
};
