import { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const bedrock = new BedrockRuntimeClient({});
const dynamo = new DynamoDBClient({});
const MODEL_ID = process.env.BEDROCK_MODEL_ID!;
const TABLE_NAME = process.env.TABLE_NAME!;
const TTL_SECONDS = 24 * 60 * 60;

interface BedrockResponse {
  content: Array<{ text: string }>;
}

interface WorkMessage {
  requestId: string;
  prompt: string;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error(`ERROR processing message ${record.messageId}:`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const { requestId, prompt } = JSON.parse(record.body) as WorkMessage;
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const startMs = Date.now();

  try {
    const response = await bedrock.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    }));

    const result = JSON.parse(new TextDecoder().decode(response.body)) as BedrockResponse;
    const latencyMs = Date.now() - startMs;

    await dynamo.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        requestId: { S: requestId },
        status: { S: 'complete' },
        result: { S: result.content[0].text },
        latency_ms: { N: String(latencyMs) },
        completed_at: { N: String(Math.floor(Date.now() / 1000)) },
        ttl: { N: String(ttl) },
      },
    }));
  } catch (bedrockError) {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        requestId: { S: requestId },
        status: { S: 'error' },
        error_message: { S: String(bedrockError) },
        ttl: { N: String(ttl) },
      },
    }));
    throw bedrockError;
  }
}
