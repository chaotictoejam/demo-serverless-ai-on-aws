import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({});
const MODEL_ID = process.env.BEDROCK_MODEL_ID!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

interface BedrockResponse {
  content: Array<{ text: string }>;
}

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

  const startMs = Date.now();

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

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      response: result.content[0].text,
      latency_ms: Date.now() - startMs,
    }),
  };
};
